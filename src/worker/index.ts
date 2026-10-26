import type {DurableObjectState,DurableObjectNamespace,Fetcher} from '@cloudflare/workers-types';
import {DurableObject} from 'cloudflare:workers';
import {Buffer} from 'node:buffer';
import {timingSafeEqual} from 'node:crypto';
import {createApp} from '../server/app.js';
import {registerVoice} from '../server/voice.js';
import {configSchema,runWithStorage} from '../server/store.js';
import {parseScript} from '../core/script.js';
import {WorkersSqliteStorage} from './storage.js';
import WorkerWebSocket from './socket.js';
import {readBoundedBody,BodyTooLargeError} from './request-body.js';

declare const WebSocketPair:{new():{0:any;1:any}};
interface Env {
 GAME:DurableObjectNamespace;ASSETS:Fetcher;
 CYBER_DM_ACCESS_CODE:string;CYBER_DM_MIGRATION_TOKEN:string;
 CYBER_DM_PUBLIC_ORIGIN:string;
}
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const authorized=(supplied:string|null,secret:string)=>Boolean(secret&&supplied&&Buffer.byteLength(supplied)===Buffer.byteLength(secret)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(secret)));

/** One state owner matches the first release's single player / shared voice devices.
 * All persistence and all upstream AI/audio traffic run here, without a Mac origin. */
export class CyberGame extends DurableObject<Env> {
 private backend:WorkersSqliteStorage;
 private application?:Promise<Awaited<ReturnType<typeof createApp>>>;
 private upgrades=new Map<string,(socket:any,request:any)=>void>();
 private migrating=false;
 constructor(private state:DurableObjectState,env:Env){
  super(state,env);
  this.backend=new WorkersSqliteStorage(state.storage as any);
 }
 private async initialize(){
  if(!this.application)this.application=runWithStorage(this.backend,async()=>{
   const result=await createApp({accessCode:this.env.CYBER_DM_ACCESS_CODE,publicOrigin:this.env.CYBER_DM_PUBLIC_ORIGIN,fastifyOptions:{logger:false},registerVoice:async(app,options)=>{
    const registry=new Proxy(app,{get:(target,key)=>{
     if(key==='register')return async()=>{};
     if(key==='get')return (path:string,...args:any[])=>{
      if(args[0]?.websocket){
       this.upgrades.set(path,args[1]);
       // Apply the same host, origin and authenticated-cookie hooks before upgrade.
       target.get(path,async()=>({ok:true}));return target;
      }
      return (target.get as any)(path,...args);
     };
     const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    await registerVoice(registry,options);
   }});
   await result.app.ready();return result;
  }).catch(error=>{this.application=undefined;this.upgrades.clear();throw error;});
  return this.application;
 }
 private async migrate(request:Request){
  if(request.method!=='POST'||!authorized(request.headers.get('Authorization')?.replace(/^Bearer /,'')??null,this.env.CYBER_DM_MIGRATION_TOKEN))return json({error:'Unauthorized'},401);
  if(this.migrating)return json({error:'Migration in progress'},409);
  this.migrating=true;
  try{
   if(await this.backend.load('migration-completed',false))return json({error:'Migration already completed'},409);
   const raw=new TextDecoder().decode(await readBoundedBody(request,24*1024*1024));
   const data=JSON.parse(raw);const config=configSchema.parse(data.config);
   for(const script of Object.values(data.scripts??{}))parseScript(script);
   if(!data.scripts||!data.sessions||!data['browser-key']?.value)throw new Error('Incomplete migration');
   for(const s of Object.values(data.sessions) as any[])if(!data.scripts[s.scriptId]||!Array.isArray(s.events))throw new Error('Invalid migrated session');
   const keys=['config','scripts','sessions','drafts','browser-key','voice-samples','voice-clone-attempts'];
   const records=Object.fromEntries(keys.map(key=>[key,key==='config'?config:data[key]??{}]));
   const binary:Record<string,Uint8Array>={};
   for(const [key,value] of Object.entries(data.binary??{})){
    if(!/^voice-samples\/[a-f0-9-]{36}$/.test(key)||typeof value!=='string')throw new Error('Invalid migration binary key');
    binary[key]=Buffer.from(value,'base64');
   }
   this.backend.importSnapshot({...records,'migration-completed':true},binary);
   return json({ok:true,sessions:Object.keys(data.sessions).length,scripts:Object.keys(data.scripts).length});
  }catch(error){return json({error:error instanceof BodyTooLargeError?'Migration too large':'Migration failed validation or persistence'},error instanceof BodyTooLargeError?413:400);}
  finally{this.migrating=false;}
 }
 async fetch(request:Request):Promise<Response>{
  const url=new URL(request.url);
  if(url.pathname==='/__migration/import')return this.migrate(request);
  if(!await this.backend.load('migration-completed',false))return json({error:'Deployment initialization pending'},503);
  return runWithStorage(this.backend,async()=>{
   const {app}=await this.initialize();
   const headers=Object.fromEntries(request.headers);headers.host=url.host;
   // The temporary workers.dev endpoint is used for deployment verification.
   // Rewrite only this deployment's own hostname, never an arbitrary host.
   const staging='cyber-dm.caotiancheng1992.workers.dev';
   if(url.hostname===staging||url.hostname==='localhost'||url.hostname==='127.0.0.1'){
    headers.host=new URL(this.env.CYBER_DM_PUBLIC_ORIGIN).host;
    if(headers.origin===url.origin)headers.origin=this.env.CYBER_DM_PUBLIC_ORIGIN;
   }
   const isUpgrade=request.headers.get('upgrade')?.toLowerCase()==='websocket';
   const handler=this.upgrades.get(url.pathname);
   let body:Buffer|undefined;
   try{if(!['GET','HEAD'].includes(request.method))body=Buffer.from(await readBoundedBody(request,request.headers.get('content-type')?.startsWith('multipart/form-data')?16*1024*1024:2*1024*1024));}
   catch(error){if(error instanceof BodyTooLargeError)return json({error:'请求内容过大'},413);throw error;}
   const response=await app.inject({method:request.method as any,url:url.pathname+url.search,headers,payload:body});
   if(isUpgrade&&handler&&response.statusCode===200){
    const pair=new WebSocketPair();
    const browser=WorkerWebSocket.fromNative(pair[1],{maxPayload:256*1024});
    browser.on('error',()=>browser.close(1011,'Transport error'));
    try{handler(browser,{headers,query:Object.fromEntries(url.searchParams)});}
    catch{browser.close(1011,'Voice initialization failed');}
    return new Response(null,{status:101,webSocket:pair[0]} as ResponseInit);
   }
   const out=new Headers();
   for(const [name,value] of Object.entries(response.headers))if(value!==undefined){
    if(Array.isArray(value))value.forEach(v=>out.append(name,String(v)));else out.set(name,String(value));
   }
   out.set('Cache-Control','no-store');out.set('X-Cyber-Hosting','cloudflare-workers');
   return new Response(request.method==='HEAD'||response.statusCode===204?null:new Uint8Array(response.rawPayload),{status:response.statusCode,headers:out});
  });
 }
}

export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(path==='/healthz'||/^\/(api|voice|voice-samples|integrations|__migration)(\/|$)/.test(path)){
   const object=env.GAME.get(env.GAME.idFromName('single-player-v1'));
   return await object.fetch(request as any) as unknown as Response;
  }
  return await env.ASSETS.fetch(request as any) as unknown as Response;
 },
};
