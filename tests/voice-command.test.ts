import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseScript} from '../src/core/script.js';
import {parseVoiceCommand} from '../src/core/voice-command.js';
const script=parseScript(JSON.parse(readFileSync('examples/after-hours.json','utf8')));
const role=script.roles.find(r=>r.id==='zhou')!,other=script.roles.find(r=>r.id==='chen')!;
test('natural vote commands propose a ballot and confirmation and cancellation are exact',()=>{
 for(const text of [`我投${role.name}`,`我投票给${role.name}`,`我选${role.name}`,`投票${role.name}。`]){
  const parsed=parseVoiceCommand(text,script);assert.equal(parsed.kind,'proposal');
  if(parsed.kind==='proposal')assert.deepEqual(parsed.action,{kind:'vote',target:role.id});
 }
 for(const text of ['确认','确认投票','确认执行','是的，确认'])assert.equal(parseVoiceCommand(text,script).kind,'confirm');
 for(const text of ['取消','取消投票','取消操作'])assert.equal(parseVoiceCommand(text,script).kind,'cancel');
});
test('negations, questions, quotations and commands embedded in statements do not trigger actions',()=>{
 for(const text of [`我不投${role.name}`,`我投${role.name}吗`,`我投${role.name}？`,`他说我投${role.name}`,`“我投${role.name}”`,'我还没有确认','我觉得下一阶段很重要','我听说搜查会有收获'])assert.equal(parseVoiceCommand(text,script).kind,'speech',text);
 assert.throws(()=>parseVoiceCommand(`我投${role.name}但是还没决定`,script));
});
test('private invitation resolves all and only uniquely named participants',()=>{
 assert.deepEqual(parseVoiceCommand(`我想和${role.name}、${other.name}私聊`,script),{kind:'private_invite',participants:[role.id,other.id]});
 assert.deepEqual(parseVoiceCommand(`邀请${role.name}私聊`,script),{kind:'private_invite',participants:[role.id]});
 for(const text of ['结束私聊','回到大厅'])assert.deepEqual(parseVoiceCommand(text,script),{kind:'private_leave'});
 assert.throws(()=>parseVoiceCommand('邀请未知角色私聊',script));
 assert.throws(()=>parseVoiceCommand(`邀请${role.name}、${role.name}私聊`,script));
 const ambiguous=structuredClone(script);ambiguous.roles[0].name=role.name;
 assert.throws(()=>parseVoiceCommand(`邀请${role.name}私聊`,ambiguous));
 assert.equal(parseVoiceCommand(`他说邀请${role.name}私聊`,script).kind,'speech');
});
test('search requires a full clue title and advancing remains a proposal',()=>{
 const clue=script.clues[0];
 for(const prefix of ['我要搜查','搜查','查看']){
  const parsed=parseVoiceCommand(prefix+clue.title,script);
  assert.equal(parsed.kind,'proposal');if(parsed.kind==='proposal')assert.deepEqual(parsed.action,{kind:'discover',target:clue.id});
 }
 assert.throws(()=>parseVoiceCommand('搜查不存在的线索',script));
 assert.deepEqual(parseVoiceCommand('进入下一阶段',script),{kind:'proposal',action:{kind:'advance'},description:'请求进入下一阶段'});
});
test('ASR homophones resolve full names and titles but votes remain proposals',()=>{
 assert.deepEqual(parseVoiceCommand('我想和沉默私聊。',script),{kind:'private_invite',participants:['chen']});
 const vote=parseVoiceCommand('我投周琦。',script);
 assert.deepEqual(vote,{kind:'proposal',action:{kind:'vote',target:'zhou'},description:'投票给周启'});
 assert.deepEqual(parseVoiceCommand('我头周起。',script),vote);
 assert.deepEqual(parseVoiceCommand('我头票给周起。',script),vote);
 const search=parseVoiceCommand('搜查蓝色器材带。',script);
 assert.deepEqual(search,{kind:'proposal',action:{kind:'discover',target:'bag'},description:'搜查“蓝色器材袋”'});
 for(const text of ['我投周','我投zhouqi','我投周琦但是不确定','搜查器材袋','邀请沉默、陈墨私聊'])assert.throws(()=>parseVoiceCommand(text,script),text);
 for(const text of ['我不投周琦','我投周琦吗','他说我投周琦','“我投周琦”'])assert.equal(parseVoiceCommand(text,script).kind,'speech',text);
 assert.equal(parseVoiceCommand('确任投票',script).kind,'speech');
});
test('ambiguous homophones cannot silently choose a role or clue, including exact ASR spelling',()=>{
 const ambiguous=structuredClone(script);ambiguous.roles[0].name='沉默';
 for(const name of ['陈墨','沉默','陈莫']){
  assert.throws(()=>parseVoiceCommand('我投'+name,ambiguous));
  assert.throws(()=>parseVoiceCommand('邀请'+name+'私聊',ambiguous));
 }
 ambiguous.clues.push({...ambiguous.clues[0],id:'bag2',title:'蓝色器材带'});
 assert.throws(()=>parseVoiceCommand('搜查蓝色器材袋',ambiguous));
});
