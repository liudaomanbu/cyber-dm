import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { readFile,access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { z } from 'zod';
import { parseScript, type Script } from '../core/script.js';
import * as game from '../core/engine.js';
import { configSchema,defaultConfig,load,save,publicConfig,mergeSecrets,type Config } from './store.js';
import { generate } from './models.js';
import { compile,generateDraft,verifySources,type Draft } from './compiler.js';
import { registerAccess } from './auth.js';
import { registerLinxApi } from './linx-api.js';
import { GameService,actionSchema } from './game-service.js';
import { bindingKey } from '../core/bindings.js';
import { registerVoice } from './voice.js';
import { readiness } from './readiness.js';

const certPath=process.env.CYBER_DM_TLS_CERT;
const keyPath=process.env.CYBER_DM_TLS_KEY;
if(Boolean(certPath)!==Boolean(keyPath))throw new Error('CYBER_DM_TLS_CERT 与 CYBER_DM_TLS_KEY 必须同时配置');
const httpsOptions=certPath&&keyPath?{cert:await readFile(resolve(certPath)),key:await readFile(resolve(keyPath))}:undefined;
const app=Fastify({...(httpsOptions?{https:httpsOptions}:{}),logger:{serializers:{req:req=>({method:req.method,url:req.url?.split('?')[0]?.replace(/(\/voice-samples\/[^/]+)\/.*/, '$1/[redacted]')})}},bodyLimit:2*1024*1024});
await registerAccess(app,{accessCode:process.env.CYBER_DM_ACCESS_CODE,publicOrigin:process.env.CYBER_DM_PUBLIC_ORIGIN});
await app.register(multipart,{limits:{fileSize:15*1024*1024,files:1}});
let config= configSchema.parse(await load('config',defaultConfig));
const sample=parseScript(JSON.parse(await readFile(resolve('examples/after-hours.json'),'utf8')));
const scripts=await load<Record<string,Script>>('scripts',{[sample.id]:sample});
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
app.get('/api/config',async()=>publicConfig(config));
app.get('/api/readiness',async()=>readiness(config,scripts));
app.put('/api/config',async req=>{const next=mergeSecrets(configSchema.parse(req.body),config);await save('config',next);config=next;return publicConfig(config);});
app.post('/api/providers/:id/test',async req=>{
 const p=config.providers.find(p=>p.id===(req.params as any).id);if(!p)throw new game.RuleError('服务配置不存在');
 const r=await generate(p,'仅回复 OK。','连接测试');return {ok:true,text:r.text,usage:r.usage};
});
app.get('/api/scripts',async()=>Object.values(scripts).map(s=>({id:s.id,title:s.title,introduction:s.introduction,roles:s.roles})));
app.post('/api/scripts/import',async req=>{
 const part=await req.file();if(!part)throw new game.RuleError('请选择剧本文件');
 const bytes=await part.toBuffer();
 if(!part.filename.toLowerCase().endsWith('.json')){
  const provider=config.providers.find(p=>p.id===config.compilerProviderId);
  if(!provider)throw new game.RuleError('请先在设置中选择剧本解析模型');
  const draft=await compile(part.filename,bytes,provider);drafts[draft.id]=draft;await save('drafts',drafts);return {draftId:draft.id};
 }
 const s=parseScript(JSON.parse(bytes.toString('utf8')));
 // Content-addressed IDs prevent an upload from mutating scripts used by existing sessions.
 s.id=createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0,24);scripts[s.id]=s;await save('scripts',scripts);
 return {id:s.id,title:s.title};
});
app.post('/api/scripts/generate',async req=>{
 const body=z.object({prompt:z.string(),providerId:z.string().optional()}).parse(req.body);
 const provider=config.providers.find(p=>p.id===(body.providerId??config.compilerProviderId));
 if(!provider)throw new game.RuleError('请先配置并选择生成模型');
 const draft=await generateDraft(body.prompt,provider);drafts[draft.id]=draft;await save('drafts',drafts);return {draftId:draft.id};
});
app.get('/api/drafts',async()=>Object.values(drafts));
app.put('/api/drafts/:id',async req=>{const d=drafts[(req.params as any).id];if(!d)throw new game.RuleError('草稿不存在');d.script=parseScript(req.body);d.warnings=d.sourceMode==='generated'?['这是AI生成草稿，发布前必须人工核对。']:verifySources(d.script,d.source,true);await save('drafts',drafts);return d;});
app.post('/api/drafts/:id/publish',async req=>{
 const d=drafts[(req.params as any).id];if(!d)throw new game.RuleError('草稿不存在');
 if((req.body as any)?.reviewed!==true)throw new game.RuleError('请先核对原文和角色权限');
 const issues=d.sourceMode==='generated'?[]:verifySources(d.script,d.source,true);if(issues.length)throw new game.RuleError(issues.join('；'));
 const s=parseScript(d.script);s.id=createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0,24);scripts[s.id]=s;await save('scripts',scripts);delete drafts[d.id];await save('drafts',drafts);return {id:s.id};
});
app.post('/api/sessions',async req=>{const body=z.object({scriptId:z.string(),roleId:z.string()}).parse(req.body);const script=scripts[body.scriptId];if(!script)throw new game.RuleError('剧本不存在');const s=game.createSession(script,body.roleId);sessions[s.id]=s;await save('sessions',sessions);return game.playerView(s,script);});
app.get('/api/sessions',async()=>Object.values(sessions).map(s=>({id:s.id,title:scripts[s.scriptId]?.title,status:s.status,roleId:s.playerRoleId})));
app.get('/api/sessions/:id',async req=>{const s=sessions[(req.params as any).id];if(!s)throw new game.RuleError('房间不存在');return game.playerView(s,scripts[s.scriptId]);});
const service=new GameService({sessions,scripts,config:()=>config,persist:()=>save('sessions',sessions)});
app.post('/api/sessions/:id/action',async req=>service.action((req.params as {id:string}).id,actionSchema.parse(req.body)));
await registerLinxApi(app,{getConfig:()=>config,setConfig:async c=>{await save('config',c);config=c;},scripts:()=>scripts});
await registerVoice(app,{config:()=>config,hasSession:id=>!!sessions[id],voiceFor:(id,role)=>service.voiceFor(id,role),respond:(id,text,isCurrent,target)=>service.voice(id,text,isCurrent,target)});
try{await access(resolve('dist/index.html'));await app.register(staticPlugin,{root:resolve('dist')});}catch{}
await app.listen({port:Number(process.env.PORT??3001),host:process.env.HOST??'127.0.0.1'});
