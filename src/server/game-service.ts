import {z} from 'zod';
import * as game from '../core/engine.js';
import type {Script} from '../core/script.js';
import {bindingKey} from '../core/bindings.js';
import {parseVoiceCommand,type CriticalAction} from '../core/voice-command.js';
import type {Config,Provider} from './store.js';
import {selectVote} from './models.js';
import {generateRoleDialogue} from './role-dialogue.js';
import {chooseDmAction,acceptPrivateInvite} from './dm-director.js';
export const actionSchema=z.object({kind:z.enum(['speak','discover','advance','npc','vote']),text:z.string().optional(),target:z.string().optional(),channel:z.enum(['public','private']).default('public'),requestId:z.string().min(1).max(200)}).strict();
export type Action=z.infer<typeof actionSchema>;
export type Reply={speaker:string;text:string;eventId?:string};
type Pending={action:CriticalAction;description:string;version:number;expires:number};
type Dependencies={sessions:Record<string,game.Session>;scripts:Record<string,Script>;config:()=>Config;persist:()=>Promise<void>;now?:()=>number;
 dialogue?:typeof generateRoleDialogue;director?:typeof chooseDmAction;invitation?:typeof acceptPrivateInvite;
 ballot?:(p:Provider,context:ReturnType<typeof game.roleContext>,candidates:string[])=>Promise<{action:{target:string}}>;
};
export class GameService{
 private starts=new Map<string,Promise<Reply[]>>();private busy=new Set<string>();private pending=new Map<string,Pending>();
 constructor(private deps:Dependencies){}
 private now(){return this.deps.now?.()??Date.now();}
 private provider(script:Script,role:string,c:Config){
  if(role!=='dm'&&!script.roles.some(r=>r.id===role))throw new game.RuleError('未知角色');
  const p=c.providers.find(p=>p.id===c.roleModels[bindingKey(script.id,role)]);
  if(!p)throw new game.RuleError(`请为${role==='dm'?'主持人':script.roles.find(r=>r.id===role)?.name??role}配置模型`);return p;
 }
 private requireVoice(script:Script,role:string,c:Config){
  const v=c.roleVoices[bindingKey(script.id,role)];if(!v?.voiceId&&(!v?.provider||!v.voiceType))throw new game.RuleError(`请为 ${role} 绑定灵矽音色 ID`);return v;
 }
 voiceFor(id:string,role:string){const s=this.deps.sessions[id];if(!s)throw new game.RuleError('房间不存在');return this.requireVoice(this.deps.scripts[s.scriptId],role,this.deps.config());}
 eventsFor(id:string):Reply[]{const s=this.deps.sessions[id];if(!s)throw new game.RuleError('房间不存在');return this.replies(s,0);}
 private replies(s:game.Session,from:number){return s.events.slice(from).filter(e=>e.speaker!==s.playerRoleId&&e.kind!=='vote'&&e.audience.includes(s.playerRoleId)).map(e=>({eventId:e.id,speaker:e.speaker,text:e.text}));}
 private async npc(s:game.Session,script:Script,role:string,channel:'public'|'private',config:Config,task:string,current:()=>boolean){
  if(!current())throw new game.RuleError('本轮已取消');
  const ctx=game.roleContext(s,script,role,channel);
  const result=await (this.deps.dialogue??generateRoleDialogue)(this.provider(script,role,config),ctx,{task,reviewer:{provider:this.provider(script,'dm',config),script,stageIndex:s.stageIndex}});
  if(!current())throw new game.RuleError('本轮已取消');
  game.generatedSpeech(s,script,role,result.text,result.factIds,s.version,channel,this.now());
 }
 private async host(s:game.Session,script:Script,config:Config,task:string,current:()=>boolean,recipients:string[]=[s.playerRoleId]){
  // The director/reviewer can read the full script. Public narration is generated
  // separately from only unlocked public evidence; private-room transcripts never enter it.
  const ctx=game.roleContext(s,script,'dm');
  ctx.facts=script.facts.filter(f=>s.revealedClues.some(id=>script.clues.find(c=>c.id===id)?.factId===f.id)).map(f=>({id:f.id,text:f.text}));
  ctx.allowedUtterances=[];
  const reading=s.preparation==='reading';
  const handoffTo=reading?[]:recipients.map(id=>{const role=script.roles.find(r=>r.id===id);if(!role)throw new game.RuleError('主持交接对象无效');return {id:role.id,name:role.name};});
  const floor=reading?'所有人同时、各自默读，阅读没有先后顺序，不点名谁先读，不让人朗读，也不要求立即接话。读完的人再报准备完成。':`本次把话交给${handoffTo.map(r=>r.name).join('、')}，不要要求其他人接话。`;
  const result=await (this.deps.dialogue??generateRoleDialogue)(this.provider(script,'dm',config),ctx,{handoffTo,task:`你是正在带本的主持人。${task} ${floor} 只用当前公开信息提示，不认定角色陈述为证据；玩家提出剧本未支持的新物件/目击等时明确说明它目前只是说法，不能作为关键线索。不要读出幕后规则或未公开的真相。`,reviewer:{provider:this.provider(script,'dm',config),script,stageIndex:s.stageIndex}});
  if(!current())throw new game.RuleError('本轮已取消');game.hostNarration(s,script,result.text);
 }
 private stageRoundCount(s:game.Session,script:Script){
  const start=s.events.findLast(e=>e.kind==='stage')?.sequence??0;
  return s.events.filter(e=>e.sequence>start&&e.kind==='speech'&&e.speaker===s.playerRoleId&&script.roles.every(r=>e.audience.includes(r.id))).length;
 }
 private async moderate(s:game.Session,script:Script,c:Config,current:()=>boolean,decision?:Awaited<ReturnType<typeof chooseDmAction>>){
  if(game.activePrivateRoom(s,script,this.now())||s.status!=='playing')return;
  const d=decision??await (this.deps.director??chooseDmAction)(this.provider(script,'dm',c),s,script,this.now());
  if(!current())throw new game.RuleError('本轮已取消');
  if(d.advance){
   game.advance(s,script);
   if(script.stages[s.stageIndex].kind==='reveal')return;
   const stage=script.stages[s.stageIndex];
   const clues=script.clues.filter(cl=>cl.unlockStage===stage.id&&cl.discoverableBy.includes(s.playerRoleId)).map(cl=>cl.title);
   await this.host(s,script,c,`你已决定进入当前阶段，现在自然交代怎么玩。${stage.kind==='vote'?'请玩家说“我投某角色”，你会复述并等待确认；不要要求点击投票按钮。':stage.kind==='investigation'?`可搜查项目只有：${clues.join('、')}。邀请玩家说出想搜查的项目。${stage.privateChat?.enabled?`当前允许${stage.privateChat.maxParticipants}人以内（含玩家）私聊，每次${stage.privateChat.durationSeconds}秒，可以口头邀请。`:'此阶段不开放私聊。'}`:'引导当前讨论。'}`,current);
  }else{
   const actors=[...new Set(d.speakers)];
   if(actors.length>2||actors.some(id=>id===s.playerRoleId||!script.roles.some(r=>r.id===id)))throw new game.RuleError('主持调度选择了无效角色');
   await this.host(s,script,c,`继续当前阶段，接住刚才的讨论，提一个有帮助的问题。${d.task==='clarify'?'区分未经证实的角色说法和正式线索。':''}不要宣布阶段切换。${actors.length?'点名指定的角色补充，他们会立即依次回应。':'请真人玩家表达意见或选择接下来的搜证。'}${script.stages[s.stageIndex].kind==='vote'?'提醒玩家语音投票并确认。':''}`,current,actors.length?actors:[s.playerRoleId]);
   for(const actor of actors)await this.npc(s,script,actor,'public',c,'主持人刚刚点名请你回应。直接接住最新问题，不要再问是否轮到自己；可以自然回答、回避或反问，但不能编造行踪或新线索。',current);
   if(actors.length)await this.host(s,script,c,'被点名的角色已经回应。简短承接后把话交还真人玩家，请他对刚才的回答表达判断或提出下一步；不要再向任何NPC发起新问题，不要宣布阶段切换。',current);
  }
 }
 private async discuss(s:game.Session,script:Script,text:string,c:Config,current:()=>boolean){
  const room=game.activePrivateRoom(s,script,this.now());
  if(s.privateRoom&&!room){game.closePrivateRoom(s);game.hostNarration(s,script,'刚才的私聊时间到了，大家回到公开讨论。请重新说一次，未把这句话转发到大厅。');return;}
  const participants=room?.participants.filter(id=>id!==s.playerRoleId);
  game.playerSpeech(s,script,text,participants,this.now());
  if(room){
   for(const role of participants!)await this.npc(s,script,role,'private',c,'你正在限时的小组私聊中。回应玩家和在场参与者最新的话，能交换自己的信息、试探或拒绝，不要知道不在场者的秘密。',current);
   return;
  }
  const first=this.stageRoundCount(s,script)===1;
  let actors=script.roles.filter(r=>r.id!==s.playerRoleId).map(r=>r.id);
  let decision:Awaited<ReturnType<typeof chooseDmAction>>|undefined;
  if(!first){
   decision=await (this.deps.director??chooseDmAction)(this.provider(script,'dm',c),s,script,this.now());
   await this.moderate(s,script,c,current,decision);return;
  }
  for(const actor of actors)await this.npc(s,script,actor,'public',c,first?'现在明确轮到你完成本阶段第一轮陈述，不要询问是不是轮到自己。结合主持人要求和刚才大家的发言，用自己的口吻交代与当前问题有关的情况；不要念预写台词。':'接住最新对话，仅在相关时回应、质疑或提出推测。避免重复自己已经说过的话，不知道的具体事实不要编。',current);
  await this.moderate(s,script,c,current,decision);
 }
 private async locked<T>(id:string,work:(s:game.Session,script:Script,config:Config)=>Promise<T>){
  if(this.busy.has(id))throw new game.RuleError('本局正在处理另一个动作，请稍候');
  const s=this.deps.sessions[id];if(!s)throw new game.RuleError('房间不存在');const script=this.deps.scripts[s.scriptId];if(!script)throw new game.RuleError('剧本不存在');
  this.busy.add(id);try{return await work(structuredClone(s),script,structuredClone(this.deps.config()));}finally{this.busy.delete(id);}
 }
 private async commit(s:game.Session){const old=this.deps.sessions[s.id];this.deps.sessions[s.id]=s;try{await this.deps.persist();}catch(e){this.deps.sessions[s.id]=old;throw e;}}
 private async finish(s:game.Session,script:Script,c:Config,start:number,current:()=>boolean){
  if(!current())throw new game.RuleError('本轮已取消，未提交结果');const replies=this.replies(s,start);for(const r of replies)this.requireVoice(script,r.speaker,c);await this.commit(s);return replies;
 }
 async begin(id:string,current:()=>boolean,options:{readingComplete?:boolean}={}):Promise<Reply[]>{
  const existing=this.starts.get(id);if(existing){await existing;return this.begin(id,current,options);}
  const work=this.locked(id,async(s,script,c)=>{
   if(s.started!==false&&s.preparation!=='reading')return [];if(s.preparation==='reading'&&options.readingComplete!==true)throw new game.RuleError('请先阅读角色资料，再点击“阅读完毕，连接语音并开始”');if(!current())throw new game.RuleError('连接已取消');
   for(const role of ['dm',...script.roles.filter(r=>r.id!==s.playerRoleId).map(r=>r.id)]){this.provider(script,role,c);this.requireVoice(script,role,c);}
   const start=s.events.length;game.begin(s,script,{announceOrder:false});
   game.finishReading(s,script);
   const order=[s.playerRoleId,...script.roles.filter(r=>r.id!==s.playerRoleId).map(r=>r.id)].map(id=>script.roles.find(r=>r.id===id)!.name);
   await this.host(s,script,c,`游戏刚开始。结合已经播报的当前场景自然欢迎玩家，本次只请${order[0]}先说明自己的行踪，其他人先听。自然说明先交流、再由你安排搜证，不向其他角色布置发言。只介绍当前已公开场景，不透露幕后答案。`,current);
   return this.finish(s,script,c,start,current);
  });this.starts.set(id,work);try{return await work;}finally{this.starts.delete(id);}
 }
 async action(id:string,a:Action){return this.locked(id,async(s,script,c)=>{
  game.requireStarted(s);if(s.processedRequests.includes(a.requestId))return game.playerView(s,script,this.now());
  game.requireReady(s);
  if(a.kind==='advance'||a.kind==='vote'||a.kind==='npc')throw new game.RuleError('由主持人控场；投票请使用语音说出人选并确认');
  if(a.channel==='private'||a.target&&a.kind==='speak'||game.activePrivateRoom(s,script,this.now()))throw new game.RuleError('私聊请在允许的阶段邀请参与者，用语音交流');
  this.pending.delete(id);
  if(a.kind==='discover'){game.discover(s,script,a.target??'');await this.moderate(s,script,c,()=>true);}
  else await this.discuss(s,script,a.text??'',c,()=>true);
  s.processedRequests.push(a.requestId);await this.commit(s);return game.playerView(s,script,this.now());
 });}
 private async invite(s:game.Session,script:Script,c:Config,participants:string[],current:()=>boolean){
  // Validate on a copy before asking any character, without reserving a room early.
  game.openPrivateRoom(structuredClone(s),script,participants,this.now());
  const names=participants.map(id=>script.roles.find(r=>r.id===id)!.name);
  if(script.stages[s.stageIndex].privateChat?.allowRefusal!==false){
   for(const id of participants){const accepted=await (this.deps.invitation??acceptPrivateInvite)(this.provider(script,id,c),game.roleContext(s,script,id),[script.roles.find(r=>r.id===s.playerRoleId)!.name,...names]);
    if(!current())throw new game.RuleError('邀请已取消');if(!accepted){game.hostNarration(s,script,`${script.roles.find(r=>r.id===id)!.name}这次没有接受私聊邀请，先继续公开讨论吧。`);return;}}
  }
  game.openPrivateRoom(s,script,participants,this.now());
  game.hostNarration(s,script,`可以，请${[script.roles.find(r=>r.id===s.playerRoleId)!.name,...names].join('、')}进入私聊。${script.stages[s.stageIndex].privateChat!.durationSeconds}秒后回到大厅，其他角色听不到你们的交流。`);
 }
 async privateControl(id:string,participants:string[]|null,current:()=>boolean){return this.locked(id,async(s,script,c)=>{
  game.requireStarted(s);const start=s.events.length;this.pending.delete(id);
  if(participants)await this.invite(s,script,c,participants,current);
  else{if(!s.privateRoom)throw new game.RuleError('当前没有私聊');game.closePrivateRoom(s);game.hostNarration(s,script,'私聊结束，大家回到公开讨论。私聊里说过什么，由参与者自己决定是否公开。');}
  return this.finish(s,script,c,start,current);
 });}
 async voice(id:string,text:string,current:()=>boolean,target?:string):Promise<Reply[]>{return this.locked(id,async(s,script,c)=>{
  game.requireStarted(s);if(s.status!=='playing')throw new game.RuleError('本局已经结束');
  if(target)throw new game.RuleError('请先在允许私聊时邀请参与者，不能直接指定私聊目标');
  game.requireReady(s);
  const start=s.events.length;const room=game.activePrivateRoom(s,script,this.now());
  if(s.privateRoom&&!room){game.closePrivateRoom(s);game.hostNarration(s,script,'私聊时间到了，先回到大厅。刚才这句没有转为公开发言，请重新说一次。');return this.finish(s,script,c,start,current);}
  const parsed=parseVoiceCommand(text,script);
  if(parsed.kind==='private_invite'){await this.invite(s,script,c,parsed.participants,current);return this.finish(s,script,c,start,current);}
  if(parsed.kind==='private_leave'){game.closePrivateRoom(s);game.hostNarration(s,script,'私聊结束，回到公开讨论。');return this.finish(s,script,c,start,current);}
  if(room&&(parsed.kind!=='speech'))throw new game.RuleError('请先结束私聊，再进行公开搜证或投票');
  if(parsed.kind==='cancel'){this.pending.delete(id);return [{speaker:'dm',text:'好，刚才的操作先取消。'}];}
  if(parsed.kind==='proposal'){
   if(parsed.action.kind==='advance'){
    game.playerSpeech(s,script,text);await this.moderate(s,script,c,current);return this.finish(s,script,c,start,current);
   }
   if(parsed.action.kind==='discover'){
    game.discover(s,script,parsed.action.target!);await this.moderate(s,script,c,current);return this.finish(s,script,c,start,current);
   }
   game.vote(structuredClone(s),script,s.playerRoleId,parsed.action.target!);
   if(!current())throw new game.RuleError('本轮已取消');
   this.pending.set(id,{action:parsed.action,description:parsed.description,version:s.version,expires:this.now()+60000});
   return [{speaker:'dm',text:`你准备${parsed.description}，对吗？请说“确认投票”，或者重新告诉我你选谁。`}];
  }
  if(parsed.kind==='confirm'){
   const pending=this.pending.get(id);this.pending.delete(id);
   if(!pending||pending.expires<=this.now()||pending.version!==s.version||pending.action.kind!=='vote')throw new game.RuleError('目前没有待确认的投票，请先说“我投”加角色名');
   game.vote(s,script,s.playerRoleId,pending.action.target!);
   for(const role of script.roles.filter(r=>r.id!==s.playerRoleId)){
    const result=await (this.deps.ballot??selectVote)(this.provider(script,role.id,c),game.roleContext(s,script,role.id),script.roles.map(r=>r.id));
    if(!current())throw new game.RuleError('本轮已取消');game.vote(s,script,role.id,result.action.target);
   }
   // Voting is complete; the host reveals only after every ballot is submitted.
   game.advance(s,script);
  }else{this.pending.delete(id);await this.discuss(s,script,text,c,current);}
  return this.finish(s,script,c,start,current);
 });}
}
