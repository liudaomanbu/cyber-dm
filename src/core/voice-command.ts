import type {Script} from './script.js';
import {RuleError} from './engine.js';
export type CriticalAction={kind:'advance'|'discover'|'vote';target?:string};
export type ParsedVoice={kind:'confirm'}|{kind:'cancel'}|{kind:'proposal';action:CriticalAction;description:string}|{kind:'private_invite';participants:string[]}|{kind:'private_leave'}|{kind:'speech';text:string};
export function parseVoiceCommand(text:string,script:Script):ParsedVoice{
 // Questions, quotations and reported speech are testimony, never executable commands.
 const command=text.trim().replace(/[。！!]+$/,'').trim();
 const speech:ParsedVoice={kind:'speech',text};
 if(/[？?“”「」『』"‘’]/.test(command)||/[吗么呢]$/.test(command))return speech;
 if(['确认','确认投票','确认执行','是的，确认','是的,确认'].includes(command))return {kind:'confirm'};
 if(['取消','取消投票','取消操作'].includes(command))return {kind:'cancel'};
 if(['结束私聊','回到大厅'].includes(command))return {kind:'private_leave'};
 if(['下一阶段','进入下一阶段'].includes(command))return {kind:'proposal',action:{kind:'advance'},description:'请求进入下一阶段'};
 const invitation=command.match(/^(?:我想和|邀请)(.+)私聊$/);
 if(invitation){
  const names=invitation[1].trim().split(/[、，,]|和|及/).map(name=>name.trim());
  if(names.some(name=>!name)||new Set(names).size!==names.length)throw new RuleError('请说出不重复的私聊角色全名');
  const participants=names.map(name=>{
   const matches=script.roles.filter(r=>r.name===name);
   if(matches.length!==1)throw new RuleError(`私聊对象“${name}”无法唯一识别，请使用角色全名`);
   return matches[0].id;
  });
  return {kind:'private_invite',participants};
 }
 const search=command.match(/^(?:我要搜查|搜查|查看)\s*(.+)$/);
 if(search){
  const matches=script.clues.filter(c=>c.title===search[1].trim());
  if(matches.length!==1)throw new RuleError('请说“搜查”加页面显示的完整线索名称');
  const clue=matches[0];
  return {kind:'proposal',action:{kind:'discover',target:clue.id},description:`搜查“${clue.title}”`};
 }
 const vote=command.match(/^(?:我投票给|我投|我选|投票)\s*(.+)$/);
 if(vote){
  const matches=script.roles.filter(r=>r.name===vote[1].trim());
  if(matches.length!==1)throw new RuleError('请说“我投票给”加角色全名');
  const role=matches[0];
  return {kind:'proposal',action:{kind:'vote',target:role.id},description:`投票给${role.name}`};
 }
 return speech;
}
