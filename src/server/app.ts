import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import { parseScript, type Script } from '../core/script.js';
import * as game from '../core/engine.js';
import { configSchema,defaultConfig,load,save,publicConfig,mergeSecrets,type Config } from './store.js';
import { generate } from './models.js';
import { compile,generateDraft,modifyDraft,verifySources,type Draft } from './compiler.js';
import { registerAccess } from './auth.js';
import { registerLinxApi } from './linx-api.js';
import { GameService,actionSchema } from './game-service.js';
import { bindingKey } from '../core/bindings.js';
import { registerLinxNoop } from './linx-noop.js';
import type { registerVoice } from './voice.js';
import sampleJson from '../../examples/after-hours.json';
import liveSampleJson from '../../examples/after-hours-live.json';
import { readiness } from './readiness.js';
import {registerScriptPackages} from './script-packages.js';

export type VoiceOptions=Parameters<typeof registerVoice>[1];
export interface AppOptions {
 accessCode?:string;
 publicOrigin?:string;
 fastifyOptions?:FastifyServerOptions & {https?:import('node:https').ServerOptions};
 registerVoice?:(app:FastifyInstance,options:VoiceOptions)=>Promise<void>;
}
/** Build routes and state without opening sockets or reading deployment files. */
export async function createApp(options:AppOptions={}) {
const app=Fastify({logger:{serializers:{req:req=>({method:req.method,url:req.url?.split('?')[0]?.replace(/(\/voice-samples\/[^/]+)\/.*/, '$1/[redacted]')})}},bodyLimit:2*1024*1024,...options.fastifyOptions});
await registerAccess(app,{accessCode:options.accessCode,publicOrigin:options.publicOrigin});
await app.register(multipart,{limits:{fileSize:15*1024*1024,files:1}});
let config= configSchema.parse(await load('config',defaultConfig));
if(!config.linx.clientId)config.linx.clientId=randomUUID();
const sample=parseScript(sampleJson);
const scripts=await load<Record<string,Script>>('scripts',{[sample.id]:sample});
const liveSample=parseScript(liveSampleJson);
if(!scripts[liveSample.id]){scripts[liveSample.id]=liveSample;await save('scripts',scripts);}
for(const map of [config.roleModels,config.roleVoices])for(const role of ['dm',...sample.roles.map(r=>r.id)]){const from=bindingKey(sample.id,role),to=bindingKey(liveSample.id,role);if(map[to]===undefined&&map[from]!==undefined)map[to]=map[from] as never;}
const sessions=await load<Record<string,game.Session>>('sessions',{});
const drafts=await load<Record<string,Draft>>('drafts',{});
// One-time migration of legacy unscoped bindings applies only to the built-in script.
for(const map of [config.roleModels,config.roleVoices])for(const role of ['dm',...sample.roles.map(r=>r.id)])if(map[role]!==undefined){map[bindingKey(sample.id,role)]=map[role] as never;delete map[role];}
await save('config',config);
const key=await load('browser-key',{value:randomBytes(32).toString('hex')});await save('browser-key',key);
// Same-origin browser capability protects the locally configured API from cross-site requests.
app.addHook('onRequest',async(req,reply)=>{
 if(!req.url.startsWith('/api/')||req.url.startsWith('/api/access/'))return;
 const origin=req.headers.origin;
 if(origin&&new URL(origin).host!==req.headers.host)return reply.code(403).send({error:'不允许跨站请求'});
 if(req.url==='/api/bootstrap'){
  if(req.headers['sec-fetch-site']==='cross-site')return reply.code(403).send({error:'不允许跨站请求'});
  return;
 }
 if(req.headers['x-cyber-key']!==key.value)return reply.code(401).send({error:'请刷新页面重新连接'});
});
app.setErrorHandler((error,_req,reply)=>{const e=error as Error;reply.code(e instanceof game.RuleError||e instanceof z.ZodError?400:500).send({error:e.message});});
app.get('/api/bootstrap',async()=>({key:key.value}));
// Public, secret-free probe for Caddy and external uptime checks. The host
// guard still applies, so it cannot be used to bypass deployment allowlists.
app.get('/healthz',async()=>({ok:true,service:'cyber-dm'}));
app.get('/api/config',async()=>publicConfig(config));
app.get('/api/readiness',async()=>readiness(config,scripts));
app.put('/api/config',async req=>{const next=mergeSecrets(configSchema.parse(req.body),config);await save('config',next);config=next;return publicConfig(config);});
app.post('/api/providers/:id/test',async req=>{
 const p=config.providers.find(p=>p.id===(req.params as any).id);if(!p)throw new game.RuleError('服务配置不存在');
 const r=await generate(p,'仅回复 OK。','连接测试');return {ok:true,text:r.text,usage:r.usage};
});
app.get('/api/scripts',async()=>Object.values(scripts)
 .filter(s=>s.id!=='after-hours')
 .map(s=>s.id==='after-hours-live'?{id:s.id,title:'闭馆之后',introduction:s.introduction,roles:s.roles}:{id:s.id,title:s.title,introduction:s.introduction,roles:s.roles}));
app.post('/api/scripts/import',async req=>{
 const part=await req.file();if(!part)throw new game.RuleError('请选择剧本文件');
 const bytes=await part.toBuffer();
 if(!part.filename.toLowerCase().endsWith('.json')){
  const provider=config.providers.find(p=>p.id===config.compilerProviderId);
  if(!provider)throw new game.RuleError('请先在设置中选择剧本解析模型');
  const draft=await compile(part.filename,bytes,provider);drafts[draft.id]=draft;await save('drafts',drafts);return {draftId:draft.id};
 }
 const s=parseScript(JSON.parse(bytes.toString('utf8')));
 s.id=createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0,24);scripts[s.id]=s;await save('scripts',scripts);
 return {id:s.id,title:s.title};
});
app.post('/api/scripts/generate',async req=>{
 const body=z.object({prompt:z.string(),providerId:z.string().optional()}).parse(req.body);
 const provider=config.providers.find(p=>p.id===(body.providerId??config.compilerProviderId));
 if(!provider)throw new game.RuleError('请先配置并选择生成模型');
 const draft=await generateDraft(body.prompt,provider);drafts[draft.id]=draft;await save('drafts',drafts);return {draftId:draft.id};
});
app.post('/api/scripts/:id/modify',async req=>{
 const script=scripts[(req.params as any).id];if(!script)throw new game.RuleError('剧本不存在');
 const body=z.object({prompt:z.string(),providerId:z.string().optional()}).parse(req.body);
 const provider=config.providers.find(p=>p.id===(body.providerId??config.compilerProviderId));
 if(!provider)throw new game.RuleError('请先配置并选择修改模型');
 const draft=await modifyDraft(script,body.prompt,provider);drafts[draft.id]=draft;await save('drafts',drafts);return {draftId:draft.id};
});
await registerScriptPackages(app,{config:()=>config,addDraft:async draft=>{drafts[draft.id]=draft;await save('drafts',drafts);}});
app.get('/api/drafts',async()=>Object.values(drafts));
app.put('/api/drafts/:id',async req=>{const d=drafts[(req.params as any).id];if(!d)throw new game.RuleError('草稿不存在');d.script=parseScript(req.body);d.warnings=d.sourceMode==='generated'?['这是AI生成草稿，发布前必须人工核对。']:verifySources(d.script,d.source,true);await save('drafts',drafts);return d;});
app.post('/api/drafts/:id/publish',async req=>{
 const d=drafts[(req.params as any).id];if(!d)throw new game.RuleError('草稿不存在');
 if((req.body as any)?.reviewed!==true)throw new game.RuleError('请先核对原文和角色权限');
 const issues=d.sourceMode==='generated'?[]:verifySources(d.script,d.source,true);if(issues.length)throw new game.RuleError(issues.join('；'));
 const s=parseScript(d.script);s.id=createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0,24);scripts[s.id]=s;await save('scripts',scripts);delete drafts[d.id];await save('drafts',drafts);return {id:s.id};
});
app.post('/api/sessions',async req=>{const body=z.object({scriptId:z.string(),roleId:z.string()}).parse(req.body);const script=scripts[body.scriptId];if(!script)throw new game.RuleError('剧本不存在');const s=game.createSession(script,body.roleId,{deferStart:true});sessions[s.id]=s;await save('sessions',sessions);return game.playerView(s,script);});
app.get('/api/sessions',async()=>Object.values(sessions).map(s=>({id:s.id,title:scripts[s.scriptId]?.title,status:s.status,roleId:s.playerRoleId})));
app.get('/api/sessions/:id',async req=>{const s=sessions[(req.params as any).id];if(!s)throw new game.RuleError('房间不存在');return game.playerView(s,scripts[s.scriptId]);});
const service=new GameService({sessions,scripts,config:()=>config,persist:()=>save('sessions',sessions)});
app.post('/api/sessions/:id/action',async req=>service.action((req.params as {id:string}).id,actionSchema.parse(req.body)));
await registerLinxApi(app,{getConfig:()=>config,setConfig:async c=>{await save('config',c);config=c;},scripts:()=>scripts});
await registerLinxNoop(app,{config:()=>config});
const voiceOptions:VoiceOptions={config:()=>config,hasSession:id=>!!sessions[id],eventsFor:id=>service.eventsFor(id),beginSession:(id,current,options)=>service.begin(id,current,options),privateControl:(id,participants,current)=>service.privateControl(id,participants,current),voiceFor:(id,role)=>service.voiceFor(id,role),respond:(id,text,isCurrent,target)=>service.voice(id,text,isCurrent,target)};
if(options.registerVoice)await options.registerVoice(app,voiceOptions);
return {app,service,voiceOptions,getConfig:()=>config,scripts,sessions};
}
