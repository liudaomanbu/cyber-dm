import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScript } from '../src/core/script.js';
import { createSession, openPrivateRoom, playerSpeech, roleContext, type Session } from '../src/core/engine.js';
import { chooseDmAction, acceptPrivateInvite } from '../src/server/dm-director.js';
import type { Provider } from '../src/server/store.js';
const provider:Provider={id:'p',name:'p',protocol:'chat-completions',baseUrl:'https://invalid.test',modelId:'m',apiKey:'',timeoutMs:1000};
function fixture(){ const script=parseScript(JSON.parse(readFileSync('examples/after-hours.json','utf8')));return {script,s:createSession(script,'lin')}; }
function publicSpeech(s:Session,speaker:string,all:string[]){s.events.push({id:String(s.events.length),sequence:s.events.length+1,kind:'speech',speaker,audience:all,text:'继续讨论',factIds:[]});}
function ready(f:ReturnType<typeof fixture>,rounds=1){const all=[...f.script.roles.map(r=>r.id),'dm'];for(const r of f.script.roles)publicSpeech(f.s,r.id,all);for(let i=1;i<rounds;i++)publicSpeech(f.s,'lin',all);}
async function mock(reply:unknown,run:(calls:any[])=>Promise<void>){const original=globalThis.fetch;const calls:any[]=[];globalThis.fetch=(async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(reply)}}]}));}) as typeof fetch;try{await run(calls);}finally{globalThis.fetch=original;}}
const action={advance:true,speakers:['zhou'],task:'summarize'};

test('director reads full canon and public events but never private transcript',async()=>{
 const f=fixture();f.script.solution.explanation='CANON_SENTINEL';f.script.stages[0].privateChat={enabled:true,maxParticipants:3,durationSeconds:60,allowRefusal:true};
 openPrivateRoom(f.s,f.script,['zhou'],1000);playerSpeech(f.s,f.script,'PRIVATE_SENTINEL','zhou',1001);
 ready(f);
 await mock(action,async calls=>{assert.equal((await chooseDmAction(provider,f.s,f.script,1002)).advance,false);const input=JSON.stringify(calls[0]);assert(input.includes('CANON_SENTINEL'));assert(!input.includes('PRIVATE_SENTINEL'));});
});
test('missing investigation clues block advancement even at max rounds',async()=>{
 const f=fixture();f.s.stageIndex=f.script.stages.findIndex(s=>s.kind==='investigation');ready(f,4);
 await mock(action,async()=>{assert.equal((await chooseDmAction(provider,f.s,f.script,0)).advance,false);f.s.revealedClues=f.script.clues.map(c=>c.id);assert.equal((await chooseDmAction(provider,f.s,f.script,0)).advance,true);});
});
test('valid scheduling respects readiness, current-stage rounds, and maximum-round fallback',async()=>{
 const f=fixture();await mock(action,async()=>{assert.equal((await chooseDmAction(provider,f.s,f.script,0)).advance,false);ready(f);assert.equal((await chooseDmAction(provider,f.s,f.script,0)).advance,true);});
 await mock({...action,advance:false},async()=>{assert.equal((await chooseDmAction(provider,f.s,f.script,0)).advance,false);ready(f,4);assert.equal((await chooseDmAction(provider,f.s,f.script,0)).advance,true);f.s.events.push({id:'boundary',sequence:f.s.events.length+1,kind:'stage',speaker:'dm',audience:[...f.script.roles.map(r=>r.id),'dm'],text:'新阶段',factIds:[]});assert.equal((await chooseDmAction(provider,f.s,f.script,0)).advance,false);});
});
test('player, unknown speakers and freeform task instructions are rejected',async()=>{
 const f=fixture();for(const invalid of [{...action,speakers:['lin']},{...action,speakers:['missing']},{...action,task:'秘密凶手是周'}])await mock(invalid,async()=>{await assert.rejects(chooseDmAction(provider,f.s,f.script,0),/主持调度/);});
});
test('vote waits for every ballot without requiring a new speech round',async()=>{
 const f=fixture();f.s.stageIndex=f.script.stages.findIndex(s=>s.kind==='vote');await mock(action,async()=>{assert.equal((await chooseDmAction(provider,f.s,f.script,0)).advance,false);for(const r of f.script.roles)f.s.votes[r.id]='zhou';assert.equal((await chooseDmAction(provider,f.s,f.script,0)).advance,true);});
});
test('private invitations permit refusal with only role-visible context',async()=>{
 const f=fixture();const ctx={...roleContext(f.s,f.script,'chen'),script:{...f.script,solution:{...f.script.solution,explanation:'CANON_SENTINEL'}}};
 await mock({accept:false},async calls=>{assert.equal(await acceptPrivateInvite(provider,ctx as ReturnType<typeof roleContext>,['林','陈']),false);assert(!JSON.stringify(calls).includes('CANON_SENTINEL'));});
 await mock({accept:'yes'},async()=>{await assert.rejects(acceptPrivateInvite(provider,roleContext(f.s,f.script,'chen'),['林']),/格式无效/);});
});
