import { randomUUID } from 'node:crypto';
import type { Script } from './script.js';

export type Event = {id:string;sequence:number;kind:'speech'|'clue'|'stage'|'vote';speaker:string;audience:string[];text:string;factIds:string[]};
export type Session = {id:string;scriptId:string;playerRoleId:string;stageIndex:number;version:number;events:Event[];
  revealedClues:string[];votes:Record<string,string>;processedRequests:string[];status:'playing'|'finished'};
export class RuleError extends Error {}
function ensure(ok:unknown,message:string):asserts ok {if(!ok)throw new RuleError(message);}
export function createSession(script:Script,playerRoleId:string):Session {
  if(!script.roles.some(r=>r.id===playerRoleId))throw new RuleError('请选择有效的玩家角色');
  const session:Session={id:randomUUID(),scriptId:script.id,playerRoleId,stageIndex:0,version:0,events:[],revealedClues:[],votes:{},processedRequests:[],status:'playing'};
  addEvent(session,script,{kind:'stage',speaker:'dm',text:script.stages[0].introduction,factIds:[]});return session;
}
function addEvent(s:Session,script:Script,event:Omit<Event,'id'|'sequence'|'audience'> & {audience?:string[]}) {
  s.events.push({...event,id:randomUUID(),sequence:s.events.length+1,audience:event.audience??[...script.roles.map(r=>r.id),'dm']});s.version++;
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
    stage:script.stages[s.stageIndex],facts:script.facts.filter(f=>known.has(f.id)).map(f=>({id:f.id,text:f.text})),
    heard:s.events.filter(e=>e.audience.includes(roleId)).map(e=>({speaker:e.speaker,kind:e.kind,text:e.text})),
    allowedUtterances:allowedUtterances(s,script,roleId,channel).map(u=>({id:u.id,text:u.text,kind:u.kind})),
  };
}
export function speak(s:Session,script:Script,roleId:string,utteranceId:string,expectedVersion:number,channel:'public'|'private'='public') {
  ensure(s.status==='playing','本局已结束');ensure(s.version===expectedVersion,'状态已更新，请重新生成');
  ensure(roleId!==s.playerRoleId,'AI 不能代替玩家发言');
  const u=allowedUtterances(s,script,roleId,channel).find(u=>u.id===utteranceId);ensure(u,'台词不可用或越权');
  addEvent(s,script,{kind:'speech',speaker:roleId,text:u.text,factIds:[],audience:channel==='private'?[roleId,s.playerRoleId]:undefined});
}
export function playerSpeech(s:Session,script:Script,text:string,target?:string) {
  ensure(s.status==='playing','本局已结束');ensure(text.trim().length>0&&text.length<=4000,'发言需要在 1–4000 字之间');
  if(target)ensure(target==='dm'||script.roles.some(r=>r.id===target&&r.id!==s.playerRoleId),'私聊对象无效');
  addEvent(s,script,{kind:'speech',speaker:s.playerRoleId,text:text.trim(),factIds:[],audience:target?[s.playerRoleId,target]:undefined});
}
export function discover(s:Session,script:Script,clueId:string) {
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
  ensure(script.stages[s.stageIndex].kind==='vote'&&s.status==='playing','现在不能投票');
  ensure(script.roles.some(r=>r.id===actor)&&script.roles.some(r=>r.id===target),'投票角色无效');
  ensure(!s.votes[actor],'该角色已投票');s.votes[actor]=target;
  // Ballots remain private until the reveal.
  addEvent(s,script,{kind:'vote',speaker:actor,text:'已提交投票',factIds:[],audience:[actor]});
}
export function advance(s:Session,script:Script) {
  ensure(s.status==='playing','本局已结束');
  if(script.stages[s.stageIndex].kind==='vote')ensure(script.roles.every(r=>s.votes[r.id]),'所有角色投票后才能揭晓');
  ensure(s.stageIndex<script.stages.length-1,'已经是最后阶段');s.stageIndex++;
  const next=script.stages[s.stageIndex];
  addEvent(s,script,{kind:'stage',speaker:'dm',text:next.introduction,factIds:[]});
  if(next.kind==='reveal'){
    addEvent(s,script,{kind:'stage',speaker:'dm',text:script.solution.explanation,factIds:[]});s.status='finished';
  }
}
export function playerView(s:Session,script:Script) {
  const ctx=roleContext(s,script,s.playerRoleId);
  return {id:s.id,version:s.version,status:s.status,title:script.title,playerRoleId:s.playerRoleId,roles:script.roles,
    stage:ctx.stage,stageIndex:s.stageIndex,stageCount:script.stages.length,facts:ctx.facts,
    events:s.events.filter(e=>e.audience.includes(s.playerRoleId)),
    clues:script.stages[s.stageIndex].kind==='investigation'?script.clues.filter(c=>c.discoverableBy.includes(s.playerRoleId)&&script.stages.findIndex(st=>st.id===c.unlockStage)<=s.stageIndex).map(c=>({id:c.id,title:c.title,found:s.revealedClues.includes(c.id)})):[],
    voted:!!s.votes[s.playerRoleId],votes:s.status==='finished'?s.votes:undefined,
    solution:s.status==='finished'?script.solution:undefined};
}
