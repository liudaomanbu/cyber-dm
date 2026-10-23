import {z} from 'zod';
import * as game from '../core/engine.js';
import type {Script} from '../core/script.js';
import {bindingKey} from '../core/bindings.js';
import {parseVoiceCommand,type CriticalAction} from '../core/voice-command.js';
import type {Config,Provider} from './store.js';
import {selectUtterance,selectVote} from './models.js';
export const actionSchema=z.object({kind:z.enum(['speak','discover','advance','npc','vote']),text:z.string().optional(),target:z.string().optional(),channel:z.enum(['public','private']).default('public'),requestId:z.string().min(1).max(200)}).strict();
export type Action=z.infer<typeof actionSchema>;
export type Reply={speaker:string;text:string};
type Pending={action:CriticalAction;description:string;version:number;expires:number};
type Dependencies={
 sessions:Record<string,game.Session>;scripts:Record<string,Script>;config:()=>Config;
 persist:()=>Promise<void>;now?:()=>number;
 utterance?:(p:Provider,context:ReturnType<typeof game.roleContext>)=>Promise<{action:{utteranceId:string}}>;
 ballot?:(p:Provider,context:ReturnType<typeof game.roleContext>,candidates:string[])=>Promise<{action:{target:string}}>;
};
export class GameService{
 private busy=new Set<string>();private pending=new Map<string,Pending>();
 constructor(private deps:Dependencies){}
 private now(){return this.deps.now?.()??Date.now();}
 private provider(script:Script,role:string,c:Config){
  if(role!=='dm'&&!script.roles.some(r=>r.id===role))throw new game.RuleError('未知角色');
  const p=c.providers.find(p=>p.id===c.roleModels[bindingKey(script.id,role)]);
  if(!p)throw new game.RuleError(`请为${role==='dm'?'主持人':script.roles.find(r=>r.id===role)?.name??role}配置模型`);return p;
 }
 private requireVoice(script:Script,role:string,c:Config){
  if(role!=='dm'&&!script.roles.some(r=>r.id===role))throw new game.RuleError('未知角色');
  const v=c.roleVoices[bindingKey(script.id,role)];
  if(!v?.voiceId&&(!v?.provider||!v.voiceType))throw new game.RuleError(`请为 ${role} 绑定灵矽音色 ID`);return v;
 }
 voiceFor(sessionId:string,role:string){const s=this.deps.sessions[sessionId];if(!s)throw new game.RuleError('房间不存在');const script=this.deps.scripts[s.scriptId];if(!script)throw new game.RuleError('剧本不存在');return this.requireVoice(script,role,this.deps.config());}
 private async npc(s:game.Session,script:Script,role:string,channel:'public'|'private',config:Config){
  if(role===s.playerRoleId)throw new game.RuleError('AI 不能代替玩家发言');
  const ctx=game.roleContext(s,script,role,channel);
  if(!ctx.allowedUtterances.length)throw new game.RuleError(`${role} 当前没有经审核的可用台词，请完善剧本`);
  const result=await (this.deps.utterance??selectUtterance)(this.provider(script,role,config),ctx);
  game.speak(s,script,role,result.action.utteranceId,s.version,channel);
 }
 private async apply(s:game.Session,script:Script,a:Omit<Action,'requestId'>,config:Config){
  if(a.kind==='speak'){
   if(a.channel==='private'&&!a.target)throw new game.RuleError('私聊需要指定对象');
   game.playerSpeech(s,script,a.text??'',a.target);
   if(a.target)await this.npc(s,script,a.target,'private',config);
   else{
    const actors=script.roles.filter(r=>r.id!==s.playerRoleId);
    const addressed=actors.find(r=>(a.text??'').includes(r.name));
    const turns=s.events.filter(e=>e.kind==='speech'&&e.speaker===s.playerRoleId).length;
    await this.npc(s,script,addressed?.id??actors[(turns-1)%actors.length].id,'public',config);
   }
  }
  if(a.kind==='npc')await this.npc(s,script,a.target??'dm',a.channel,config);
  if(a.kind==='discover')game.discover(s,script,a.target??'');
  if(a.kind==='advance')game.advance(s,script);
  if(a.kind==='vote'){
   game.vote(s,script,s.playerRoleId,a.target??'');
   for(const r of script.roles.filter(r=>r.id!==s.playerRoleId)){
    const result=await (this.deps.ballot??selectVote)(this.provider(script,r.id,config),game.roleContext(s,script,r.id),script.roles.map(r=>r.id));
    game.vote(s,script,r.id,result.action.target);
   }
  }
 }
 private async locked<T>(id:string,work:(s:game.Session,script:Script,config:Config)=>Promise<T>){
  if(this.busy.has(id))throw new game.RuleError('本局正在处理另一个动作，请稍候重试');
  const current=this.deps.sessions[id];if(!current)throw new game.RuleError('房间不存在');
  this.busy.add(id);
  const script=this.deps.scripts[current.scriptId];if(!script)throw new game.RuleError('剧本不存在');
  try{return await work(structuredClone(current),script,structuredClone(this.deps.config()));}finally{this.busy.delete(id);}
 }
 private async commit(s:game.Session){
  const old=this.deps.sessions[s.id];this.deps.sessions[s.id]=s;
  try{await this.deps.persist();}catch(e){this.deps.sessions[s.id]=old;throw e;}
 }
 async action(id:string,a:Action){return this.locked(id,async(s,script,config)=>{
  if(s.processedRequests.includes(a.requestId))return game.playerView(s,script);
  this.pending.delete(id);await this.apply(s,script,a,config);s.processedRequests.push(a.requestId);
  await this.commit(s);return game.playerView(s,script);
 });}
 async voice(id:string,text:string,isCurrent:()=>boolean,target?:string):Promise<Reply[]>{return this.locked(id,async(s,script,config)=>{
  if(s.status!=='playing')throw new game.RuleError('本局已经结束');
  if(target&&target!=='dm'&&!script.roles.some(r=>r.id===target&&r.id!==s.playerRoleId))throw new game.RuleError('私聊对象无效');
  const parsed=parseVoiceCommand(text,script);const start=s.events.length;
  if(parsed.kind==='cancel'){this.pending.delete(id);this.requireVoice(script,'dm',config);return [{speaker:'dm',text:'已取消待确认操作。'}];}
  if(parsed.kind==='proposal'){
   if(target)throw new game.RuleError('请切换到公开讨论后再操作游戏进度');
   // Validate stage, actor and evidence before asking for confirmation; no changes are committed.
   const probe=structuredClone(s);
   if(parsed.action.kind==='advance')game.advance(probe,script);
   if(parsed.action.kind==='discover')game.discover(probe,script,parsed.action.target!);
   if(parsed.action.kind==='vote')game.vote(probe,script,s.playerRoleId,parsed.action.target!);
   this.requireVoice(script,'dm',config);if(!isCurrent())throw new game.RuleError('本轮语音已取消');
   this.pending.set(id,{action:parsed.action,description:parsed.description,version:s.version,expires:this.now()+60000});
   return [{speaker:'dm',text:`你要${parsed.description}。请在一分钟内说“确认执行”，或说“取消操作”。`}];
  }
  if(parsed.kind==='confirm'){
   const pending=this.pending.get(id);this.pending.delete(id);
   if(!pending||pending.expires<=this.now()||pending.version!==s.version)throw new game.RuleError('没有有效的待确认操作，请重新提出请求');
   if(target)throw new game.RuleError('请在公开讨论中确认操作');
   await this.apply(s,script,{...pending.action,channel:'public'},config);
  }else{
   this.pending.delete(id);await this.apply(s,script,{kind:'speak',text:parsed.text,target,channel:target?'private':'public'},config);
  }
  let replies=s.events.slice(start).filter(e=>e.speaker!==s.playerRoleId&&e.audience.includes(s.playerRoleId)&&e.kind!=='vote').map(e=>({speaker:e.speaker,text:e.text}));
  if(!replies.length&&parsed.kind==='confirm')replies=[{speaker:'dm',text:'操作已完成。'}];
  for(const r of replies)this.requireVoice(script,r.speaker,config);
  if(!isCurrent())throw new game.RuleError('语音轮次已取消，未提交本轮结果');
  await this.commit(s);return replies;
 });}
}
