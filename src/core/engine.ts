import { randomUUID } from 'node:crypto';
import type { Script } from './script.js';

export type Event = {id:string;sequence:number;kind:'speech'|'clue'|'stage'|'vote';speaker:string;audience:string[];text:string;factIds:string[]};
export type PrivateRoom = {id:string;participants:string[];openedAt:number;expiresAt:number;stageId:string};
export type Session = {preparation?:'reading'|'ready';privateRoom?:PrivateRoom;started?:boolean;id:string;scriptId:string;playerRoleId:string;stageIndex:number;version:number;events:Event[];
  revealedClues:string[];votes:Record<string,string>;processedRequests:string[];status:'playing'|'finished'};
export class RuleError extends Error {}
function ensure(ok:unknown,message:string):asserts ok {if(!ok)throw new RuleError(message);}
export function createSession(script:Script,playerRoleId:string,options:{deferStart?:boolean}={}):Session {
  if(!script.roles.some(r=>r.id===playerRoleId))throw new RuleError('请选择有效的玩家角色');
  const session:Session={preparation:options.deferStart?'reading':'ready',started:!options.deferStart,id:randomUUID(),scriptId:script.id,playerRoleId,stageIndex:0,version:0,events:[],revealedClues:[],votes:{},processedRequests:[],status:'playing'};
  if(!options.deferStart)addEvent(session,script,{kind:'stage',speaker:'dm',text:script.stages[0].introduction,factIds:[]});return session;
}
function addEvent(s:Session,script:Script,event:Omit<Event,'id'|'sequence'|'audience'> & {audience?:string[]}) {
  s.events.push({...event,id:randomUUID(),sequence:s.events.length+1,audience:event.audience??[...script.roles.map(r=>r.id),'dm']});s.version++;
}
export function requireStarted(s:Session) {ensure(s.started!==false,'请先连接语音，等待主持人开场');}
export function requireReady(s:Session) {requireStarted(s);ensure(s.preparation!=='reading','请先阅读自己的角色材料，并确认阅读完成');}
export function finishReading(s:Session,script:Script) {
  requireStarted(s);
  if(s.preparation!=='reading')return;
  ensure(s.status==='playing'&&s.stageIndex===0,'当前不能结束阅读');
  s.preparation='ready';
  addEvent(s,script,{kind:'stage',speaker:'dm',text:script.stages[0].introduction,factIds:[]});
}
export function begin(s:Session,script:Script,options:{announceOrder?:boolean}={}) {
  if(s.started!==false)return;
  ensure(s.events.length===0,'未开始的房间包含历史记录');
  s.started=true;
  if(s.preparation==='reading'){s.version++;return;}
  addEvent(s,script,{kind:'stage',speaker:'dm',text:script.stages[s.stageIndex].introduction,factIds:[]});
  if(options.announceOrder!==false)host(s,script,'order');
}
/** Fixed procedural cues carry no authored mystery facts and never advance stages. */
export function host(s:Session,script:Script,cue:'order'|'handoff'|'return',roleId?:string) {
  requireReady(s);
  const player=script.roles.find(r=>r.id===s.playerRoleId)!;
  const others=script.roles.filter(r=>r.id!==s.playerRoleId);
  let text:string;
  if(cue==='handoff'){
    const role=others.find(r=>r.id===roleId);ensure(role,'交接角色无效');
    text=`谢谢。${role.name}，接下来请你说说。`;
  }else if(cue==='order'){
    text=`先请${player.name}说，${others.map((r,i)=>`${i===others.length-1?'最后':'接着是'}${r.name}`).join('，')}，大家说完我再接着主持。大家先听完彼此的陈述，再一起追问。${player.name}，你先来。`;
  }else{
    const kind=script.stages[s.stageIndex].kind;
    const next=kind==='investigation'?'你可以继续公开讨论，或选择可搜查的线索。':kind==='vote'?'你可以继续讨论，或提交投票。':'你可以追问、补充自己的发言，准备好后再请求进入下一阶段。';
    const rounds=s.events.filter(e=>e.kind==='speech'&&e.speaker===s.playerRoleId&&e.audience.length===script.roles.length+1).length;
    text=`${rounds%2?'好，大家都说过了。':'谢谢大家的补充。'}${player.name}，你有没有想追问的地方？${next}`;
  }
  addEvent(s,script,{kind:'speech',speaker:'dm',text,factIds:[]});
}
/** Room membership is fixed until explicitly closed; clocks are milliseconds. */
export function activePrivateRoom(s:Session,script:Script,now:number=Date.now()):PrivateRoom|undefined {
  const room=s.privateRoom,stage=script.stages[s.stageIndex];
  if(!Number.isFinite(now)||!room||s.status!=='playing'||s.started===false||s.preparation==='reading'||!stage.privateChat?.enabled||room.stageId!==stage.id||now<room.openedAt||now>=room.expiresAt)return undefined;
  if(room.participants.length<2||room.participants.length>stage.privateChat.maxParticipants||!room.participants.includes(s.playerRoleId)||new Set(room.participants).size!==room.participants.length||room.participants.some(id=>!script.roles.some(r=>r.id===id)))return undefined;
  return room;
}
export function openPrivateRoom(s:Session,script:Script,npcIds:string[],now:number=Date.now()):PrivateRoom {
  requireReady(s);ensure(s.status==='playing','本局已结束');
  const stage=script.stages[s.stageIndex],policy=stage.privateChat;
  ensure(policy?.enabled,'当前阶段不允许私聊');ensure(Number.isFinite(now),'私聊时间无效');
  ensure(!activePrivateRoom(s,script,now),'请先结束当前私聊');
  ensure(npcIds.length>=1&&npcIds.length+1<=policy.maxParticipants,'私聊人数超出阶段限制');
  ensure(new Set(npcIds).size===npcIds.length&&npcIds.every(id=>id!==s.playerRoleId&&script.roles.some(r=>r.id===id)),'私聊对象无效');
  const room:PrivateRoom={id:randomUUID(),participants:[s.playerRoleId,...npcIds],openedAt:now,expiresAt:now+policy.durationSeconds*1000,stageId:stage.id};
  s.privateRoom=room;s.version++;return room;
}
export function closePrivateRoom(s:Session) {if(s.privateRoom){delete s.privateRoom;s.version++;}}
function privateAudience(s:Session,script:Script,role:string,now:number,target?:string|string[]) {
  const room=activePrivateRoom(s,script,now);ensure(room,'当前没有有效的私聊房间');
  ensure(room.participants.includes(role),'角色不是私聊参与者');
  if(target!==undefined){const targets=typeof target==='string'?[target]:target;
    const expected=room.participants.filter(id=>id!==s.playerRoleId);
    ensure(targets.length===expected.length&&new Set(targets).size===targets.length&&targets.every(id=>expected.includes(id)),'私聊对象与房间成员不符');
  }
  return [...room.participants];
}
export function hostNarration(s:Session,script:Script,text:string) {
  requireStarted(s);ensure(s.status==='playing','本局已结束');ensure(text.trim().length>0&&text.length<=4000,'主持内容需要在 1–4000 字之间');
  addEvent(s,script,{kind:'speech',speaker:'dm',text:text.trim(),factIds:[]});
}
export function dmContext(s:Session,script:Script) {
  return {sessionId:s.id,version:s.version,script:structuredClone(script),stage:script.stages[s.stageIndex],
    publicEvents:s.events.filter(e=>e.audience.includes('dm')&&script.roles.every(r=>e.audience.includes(r.id))).map(e=>structuredClone(e))};
}
export function generatedSpeech(s:Session,script:Script,role:string,text:string,factIds:string[],expectedVersion:number,channel:'public'|'private',now:number=Date.now()) {
  requireReady(s);ensure(s.status==='playing','本局已结束');ensure(s.version===expectedVersion,'状态已更新，请重新生成');
  ensure(role!==s.playerRoleId&&script.roles.some(r=>r.id===role),'AI 发言角色无效');
  ensure(script.stages[s.stageIndex]&&script.stages[s.stageIndex].kind!=='reveal','当前阶段不能生成角色讨论');
  ensure(channel==='public'||channel==='private','发言频道无效');
  ensure(text.trim().length>0&&text.length<=4000,'发言需要在 1–4000 字之间');
  const known=knownFactIds(s,script,role);ensure(factIds.every(id=>known.has(id)),'生成内容引用了未知事实');
  const audience=channel==='private'?privateAudience(s,script,role,now):undefined;
  addEvent(s,script,{kind:'speech',speaker:role,text:text.trim(),factIds:[],audience});
}
export function knownFactIds(s:Session,script:Script,roleId:string):Set<string> {
  const visibleEvents=s.events.filter(e=>e.audience.includes(roleId));
  return new Set([...script.facts.filter(f=>f.knownBy.includes(roleId)&&script.stages.findIndex(st=>st.id===f.unlockStage)<=s.stageIndex).map(f=>f.id),...visibleEvents.filter(e=>e.kind==='clue').flatMap(e=>e.factIds)]);
}
export function allowedUtterances(s:Session,script:Script,roleId:string,channel:'public'|'private'='public') {
  const known=knownFactIds(s,script,roleId); const stage=script.stages[s.stageIndex].id;
  return script.utterances.filter(u=>u.roleId===roleId&&u.stageIds.includes(stage)&&u.audience===channel&&u.factIds.every(f=>known.has(f)));
}
export function roleContext(s:Session,script:Script,roleId:string,channel:'public'|'private'='public') {
  if(roleId!=='dm'&&!script.roles.some(r=>r.id===roleId))throw new RuleError('未知角色');
  const known=knownFactIds(s,script,roleId);
  return {sessionId:s.id,version:s.version,role:roleId==='dm'?{id:'dm',name:'主持人',description:'引导当前阶段，不能提前揭晓'}:script.roles.find(r=>r.id===roleId),
    cast:script.roles.map(r=>({id:r.id,name:r.name})),
    ...(roleId==='dm'?{script:structuredClone(script),publicEvents:dmContext(s,script).publicEvents}:{}),
    stage:script.stages[s.stageIndex],facts:script.facts.filter(f=>known.has(f.id)).map(f=>({id:f.id,text:f.text})),
    heard:s.events.filter(e=>e.audience.includes(roleId)).map(e=>({speaker:e.speaker,kind:e.kind,text:e.text})),
    allowedUtterances:allowedUtterances(s,script,roleId,channel).map(u=>({id:u.id,text:u.text,kind:u.kind})),
  };
}
export function speak(s:Session,script:Script,roleId:string,utteranceId:string,expectedVersion:number,channel:'public'|'private'='public',now:number=Date.now()) {
  requireReady(s);
  ensure(s.status==='playing','本局已结束');ensure(s.version===expectedVersion,'状态已更新，请重新生成');
  ensure(roleId!==s.playerRoleId,'AI 不能代替玩家发言');
  const u=allowedUtterances(s,script,roleId,channel).find(u=>u.id===utteranceId);ensure(u,'台词不可用或越权');
  addEvent(s,script,{kind:'speech',speaker:roleId,text:u.text,factIds:[],audience:channel==='private'?privateAudience(s,script,roleId,now):undefined});
}
export function playerSpeech(s:Session,script:Script,text:string,target?:string|string[],now:number=Date.now()) {
  requireReady(s);
  ensure(s.status==='playing','本局已结束');ensure(text.trim().length>0&&text.length<=4000,'发言需要在 1–4000 字之间');
  addEvent(s,script,{kind:'speech',speaker:s.playerRoleId,text:text.trim(),factIds:[],audience:target!==undefined?privateAudience(s,script,s.playerRoleId,now,target):undefined});
}
export function discover(s:Session,script:Script,clueId:string) {
  requireReady(s);
  ensure(s.status==='playing','本局已结束');
  const c=script.clues.find(c=>c.id===clueId);ensure(c,'不存在该线索');
  ensure(script.stages[s.stageIndex].kind==='investigation','当前阶段不能搜证');
  ensure(c.discoverableBy.includes(s.playerRoleId),'无权搜查该线索');
  ensure(script.stages.findIndex(st=>st.id===c.unlockStage)<=s.stageIndex,'线索尚未解锁');
  ensure(!s.revealedClues.includes(c.id),'该线索已发现');
  s.revealedClues.push(c.id);
  const f=script.facts.find(f=>f.id===c.factId)!;
  addEvent(s,script,{kind:'clue',speaker:'dm',text:`${c.title}：${f.text}`,factIds:[f.id]});
}
export function vote(s:Session,script:Script,actor:string,target:string) {
  requireReady(s);
  ensure(script.stages[s.stageIndex].kind==='vote'&&s.status==='playing','现在不能投票');
  ensure(script.roles.some(r=>r.id===actor)&&script.roles.some(r=>r.id===target),'投票角色无效');
  ensure(!s.votes[actor],'该角色已投票');s.votes[actor]=target;
  // Ballots remain private until the reveal.
  addEvent(s,script,{kind:'vote',speaker:actor,text:'已提交投票',factIds:[],audience:[actor]});
}
export function advance(s:Session,script:Script) {
  requireReady(s);
  ensure(s.status==='playing','本局已结束');
  if(script.stages[s.stageIndex].kind==='vote')ensure(script.roles.every(r=>s.votes[r.id]),'所有角色投票后才能揭晓');
  ensure(s.stageIndex<script.stages.length-1,'已经是最后阶段');s.stageIndex++;delete s.privateRoom;
  const next=script.stages[s.stageIndex];
  addEvent(s,script,{kind:'stage',speaker:'dm',text:next.introduction,factIds:[]});
  if(next.kind==='reveal'){
    addEvent(s,script,{kind:'stage',speaker:'dm',text:script.solution.explanation,factIds:[]});s.status='finished';
  }
}
export function playerView(s:Session,script:Script,now:number=Date.now()) {
  const ctx=roleContext(s,script,s.playerRoleId);
  const role=script.roles.find(r=>r.id===s.playerRoleId)!;
  return {preparation:s.preparation??'ready',readingMaterial:{role:{id:role.id,name:role.name,description:role.description,voiceHint:role.voiceHint},facts:ctx.facts},started:s.started!==false,id:s.id,version:s.version,status:s.status,title:script.title,playerRoleId:s.playerRoleId,roles:script.roles,
    privateChatPolicy:ctx.stage.privateChat??{enabled:false,maxParticipants:2,durationSeconds:0,allowRefusal:true},privateRoom:activePrivateRoom(s,script,now),
    stage:ctx.stage,stageIndex:s.stageIndex,stageCount:script.stages.length,facts:ctx.facts,
    events:s.events.filter(e=>e.audience.includes(s.playerRoleId)),
    clues:script.stages[s.stageIndex].kind==='investigation'?script.clues.filter(c=>c.discoverableBy.includes(s.playerRoleId)&&script.stages.findIndex(st=>st.id===c.unlockStage)<=s.stageIndex).map(c=>({id:c.id,title:c.title,found:s.revealedClues.includes(c.id)})):[],
    voted:!!s.votes[s.playerRoleId],votes:s.status==='finished'?s.votes:undefined,
    solution:s.status==='finished'?script.solution:undefined};
}
