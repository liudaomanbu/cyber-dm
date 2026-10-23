import type {Script} from './script.js';
import {RuleError} from './engine.js';
export type CriticalAction={kind:'advance'|'discover'|'vote';target?:string};
export type ParsedVoice={kind:'confirm'}|{kind:'cancel'}|{kind:'proposal';action:CriticalAction;description:string}|{kind:'speech';text:string};
export function parseVoiceCommand(text:string,script:Script):ParsedVoice{
 const command=text.trim().replace(/[。！!？?]+$/,'').trim();
 if(command==='确认执行')return {kind:'confirm'};
 if(command==='取消操作')return {kind:'cancel'};
 if(['下一阶段','进入下一阶段'].includes(command))return {kind:'proposal',action:{kind:'advance'},description:'进入下一阶段'};
 if(command.startsWith('搜查')){
  const clue=script.clues.find(c=>c.title===command.slice(2).trim());
  if(!clue)throw new RuleError('请说“搜查”加页面显示的完整线索名称');
  return {kind:'proposal',action:{kind:'discover',target:clue.id},description:`搜查“${clue.title}”`};
 }
 if(command.startsWith('投票')||command.startsWith('确认投票')){
  const name=command.replace(/^(确认)?投票/,'').trim();const role=script.roles.find(r=>r.name===name);
  if(!role)throw new RuleError('请说“投票”加角色全名');
  return {kind:'proposal',action:{kind:'vote',target:role.id},description:`投票给${role.name}`};
 }
 return {kind:'speech',text};
}
