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
import { generate,selectUtterance,selectVote } from './models.js';
import { compile,verifySources,type Draft } from './compiler.js';
import { registerVoice } from './voice.js';

const app=Fastify({logger:true,bodyLimit:2*1024*1024});
await app.register(multipart,{limits:{fileSize:15*1024*1024,files:1}});
let config= configSchema.parse(await load('config',defaultConfig));
const sample=parseScript(JSON.parse(await readFile(resolve('examples/after-hours.json'),'utf8')));
const scripts=await load<Record<string,Script>>('scripts',{[sample.id]:sample});
const sessions=await load<Record<string,game.Session>>('sessions',{});
const drafts=await load<Record<string,Draft>>('drafts',{});
const key=await load('browser-key',{value:randomBytes(32).toString('hex')});await save('browser-key',key);
// Same-origin browser capability protects the locally configured API from cross-site requests.
app.addHook('onRequest',async(req,reply)=>{
 if(!req.url.startsWith('/api/'))return;
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
app.get('/api/drafts',async()=>Object.values(drafts));
app.put('/api/drafts/:id',async req=>{const d=drafts[(req.params as any).id];if(!d)throw new game.RuleError('草稿不存在');d.script=parseScript(req.body);d.warnings=verifySources(d.script,d.source);await save('drafts',drafts);return d;});
app.post('/api/drafts/:id/publish',async req=>{
 const d=drafts[(req.params as any).id];if(!d)throw new game.RuleError('草稿不存在');
 if((req.body as any)?.reviewed!==true)throw new game.RuleError('请先核对原文和角色权限');
 const issues=verifySources(d.script,d.source);if(issues.length)throw new game.RuleError(issues.join('；'));
 const s=parseScript(d.script);s.id=createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0,24);scripts[s.id]=s;await save('scripts',scripts);delete drafts[d.id];await save('drafts',drafts);return {id:s.id};
});
app.post('/api/sessions',async req=>{const body=z.object({scriptId:z.string(),roleId:z.string()}).parse(req.body);const script=scripts[body.scriptId];if(!script)throw new game.RuleError('剧本不存在');const s=game.createSession(script,body.roleId);sessions[s.id]=s;await save('sessions',sessions);return game.playerView(s,script);});
app.get('/api/sessions',async()=>Object.values(sessions).map(s=>({id:s.id,title:scripts[s.scriptId]?.title,status:s.status,roleId:s.playerRoleId})));
app.get('/api/sessions/:id',async req=>{const s=sessions[(req.params as any).id];if(!s)throw new game.RuleError('房间不存在');return game.playerView(s,scripts[s.scriptId]);});
const busy=new Set<string>();
app.post('/api/sessions/:id/action',async req=>{
 const id=(req.params as any).id;
 if(busy.has(id))throw new game.RuleError('角色正在响应，请稍候');
 const current=sessions[id];if(!current)throw new game.RuleError('房间不存在');
 const a=z.object({kind:z.enum(['speak','discover','advance','npc','vote']),text:z.string().optional(),target:z.string().optional(),requestId:z.string().min(1)}).parse(req.body);
 const script=scripts[current.scriptId];
 if(current.processedRequests.includes(a.requestId))return game.playerView(current,script);
 busy.add(id);
 try{
  const s=structuredClone(current);
  if(a.kind==='speak')game.playerSpeech(s,script,a.text??'',a.target);
  if(a.kind==='discover')game.discover(s,script,a.target??'');
  if(a.kind==='advance')game.advance(s,script);
  if(a.kind==='npc'){
   const role=a.target??'dm';if(role===s.playerRoleId)throw new game.RuleError('不能让 AI 代替玩家');
   const p=config.providers.find(p=>p.id===config.roleModels[role]);
   if(!p)throw new game.RuleError('请先在设置中为该角色配置模型；不会伪装成已连接 AI');
   const ctx=game.roleContext(s,script,role);const result=await selectUtterance(p,ctx);
   game.speak(s,script,role,result.action.utteranceId,s.version);
  }
  if(a.kind==='vote'){
   game.vote(s,script,s.playerRoleId,a.target??'');
   for(const r of script.roles.filter(r=>r.id!==s.playerRoleId)){
    const p=config.providers.find(p=>p.id===config.roleModels[r.id]);if(!p)throw new game.RuleError(`请为${r.name}配置模型`);
    const result=await selectVote(p,game.roleContext(s,script,r.id),script.roles.map(r=>r.id));game.vote(s,script,r.id,result.action.target);
   }
  }
  s.processedRequests.push(a.requestId);sessions[id]=s;await save('sessions',sessions);return game.playerView(s,script);
 }finally{busy.delete(id);}
});
await registerVoice(app,{config:()=>config,hasSession:id=>!!sessions[id],respond:async(id,text,isCurrent)=>{
 if(busy.has(id))throw new game.RuleError('本局正在处理另一个动作，请稍候重试');
 busy.add(id);
 try{
  const s=structuredClone(sessions[id]);const script=scripts[s.scriptId];const start=s.events.length;
  const voiceReplies=async(role:string)=>{
   const p=config.providers.find(p=>p.id===config.roleModels[role]);if(!p)throw new game.RuleError(`请为 ${role} 配置模型`);
   const v=config.roleVoices[role];if(!v?.provider||!v.voiceType)throw new game.RuleError(`请为 ${role} 配置音色`);
   const result=await selectUtterance(p,game.roleContext(s,script,role));game.speak(s,script,role,result.action.utteranceId,s.version);
  };
  // Only exact, explicit commands mutate game state. Everything else remains testimony.
  const command=text.trim().replace(/[。！!？?]$/,'');
  if(command==='下一阶段'||command==='进入下一阶段')game.advance(s,script);
  else if(command.startsWith('搜查')){const clue=script.clues.find(c=>c.title===command.slice(2).trim());if(!clue)throw new game.RuleError('请说“搜查”加页面显示的线索名称');game.discover(s,script,clue.id);}
  else if(command.startsWith('确认投票')){
   const target=script.roles.find(r=>r.name===command.slice(4).trim());if(!target)throw new game.RuleError('请说“确认投票”加角色全名');
   game.vote(s,script,s.playerRoleId,target.id);
   for(const r of script.roles.filter(r=>r.id!==s.playerRoleId)){
    const p=config.providers.find(p=>p.id===config.roleModels[r.id]);if(!p)throw new game.RuleError(`请为${r.name}配置模型`);
    const result=await selectVote(p,game.roleContext(s,script,r.id),script.roles.map(r=>r.id));game.vote(s,script,r.id,result.action.target);
   }
  }else{
   game.playerSpeech(s,script,text);
   const addressed=script.roles.find(r=>r.id!==s.playerRoleId&&text.includes(r.name));
   const role=addressed?.id??script.roles.filter(r=>r.id!==s.playerRoleId)[s.events.filter(e=>e.kind==='speech'&&e.speaker===s.playerRoleId).length% (script.roles.length-1)].id;
   await voiceReplies(role);
  }
  const replies=s.events.slice(start).filter(e=>e.speaker!==s.playerRoleId&&e.audience.includes(s.playerRoleId)&&e.kind!=='vote').map(e=>({speaker:e.speaker,text:e.text}));
  for(const r of replies){const v=config.roleVoices[r.speaker];if(!v?.provider||!v.voiceType)throw new game.RuleError(`请为 ${r.speaker} 配置音色`);}
  if(!isCurrent())throw new game.RuleError('语音轮次已取消，未提交本轮结果');
  sessions[id]=s;await save('sessions',sessions);return replies;
 }finally{busy.delete(id);}
}});
try{await access(resolve('dist/index.html'));await app.register(staticPlugin,{root:resolve('dist')});}catch{}
await app.listen({port:Number(process.env.PORT??3001),host:process.env.HOST??'127.0.0.1'});
