import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScript } from '../src/core/script.js';
import { createSession,openPrivateRoom,closePrivateRoom,activePrivateRoom,playerSpeech,playerView,roleContext,dmContext,generatedSpeech,advance,knownFactIds } from '../src/core/engine.js';
const base=JSON.parse(readFileSync('examples/after-hours.json','utf8'));
function fixture(){const input=structuredClone(base);input.stages[0].privateChat={enabled:true,maxParticipants:3,durationSeconds:60};const script=parseScript(input);return {script,s:createSession(script,'lin')};}
test('private voice rooms enforce stage permission, membership, exact audience and deadline',()=>{
 const {s,script}=fixture();const disabled=parseScript(base);
 assert.throws(()=>openPrivateRoom(s,disabled,['zhou'],100));
 assert.throws(()=>playerSpeech(s,script,'no room','zhou',100));
 assert.throws(()=>openPrivateRoom(s,script,['dm'],100));
 assert.throws(()=>openPrivateRoom(s,script,['zhou','zhou'],100));
 openPrivateRoom(s,script,['zhou','chen'],100);
 assert.throws(()=>playerSpeech(s,script,'wrong room','zhou',101));
 playerSpeech(s,script,'PRIVATE_SENTINEL',['chen','zhou'],101);
 assert.deepEqual(s.events.at(-1)?.audience,['lin','zhou','chen']);
 assert(!JSON.stringify(dmContext(s,script)).includes('PRIVATE_SENTINEL'));
 assert(!JSON.stringify(roleContext(s,script,'dm')).includes('PRIVATE_SENTINEL'));
 assert.equal(activePrivateRoom(s,script,60100),undefined);
 assert.equal(playerView(s,script,60100).privateRoom,undefined);
 assert.throws(()=>playerSpeech(s,script,'expired',['zhou','chen'],60100));
 closePrivateRoom(s);assert.equal(s.privateRoom,undefined);
});
test('generated speech cannot invent canon or leak unknown facts and expired/private nonmember output is rejected',()=>{
 const {s,script}=fixture();openPrivateRoom(s,script,['zhou'],100);
 assert.throws(()=>generatedSpeech(s,script,'chen','secret',[],s.version,'private',101));
 assert.throws(()=>generatedSpeech(s,script,'lin','impersonation',[],s.version,'public',101));
 assert.throws(()=>generatedSpeech(s,script,'zhou','fiction',['invented'],s.version,'private',101));
 const before=[...knownFactIds(s,script,'zhou')];
 generatedSpeech(s,script,'zhou','PRIVATE_TESTIMONY',before,s.version,'private',101);
 assert.deepEqual(s.events.at(-1)?.factIds,[]);
 assert.deepEqual([...knownFactIds(s,script,'zhou')],before);
 assert(!JSON.stringify(roleContext(s,script,'chen')).includes('PRIVATE_TESTIMONY'));
 assert.throws(()=>generatedSpeech(s,script,'zhou','late',[],s.version,'private',60100));
 assert.throws(()=>generatedSpeech(s,script,'zhou','stale',[],s.version-1,'public',101));
 advance(s,script);assert.equal(s.privateRoom,undefined);
});
test('schema validates private chat limits and flow clue references and supplies defaults',()=>{
 const {script}=fixture();assert.equal(script.stages[0].privateChat?.allowRefusal,true);
 const input=structuredClone(base);input.stages[0].flow={};
 assert.deepEqual(parseScript(input).stages[0].flow,{minPublicRounds:1,maxPublicRounds:4});
 input.stages[0].flow={requiredClueIds:['nonexistent']};assert.throws(()=>parseScript(input));
 input.stages[0].flow={minPublicRounds:5,maxPublicRounds:4};assert.throws(()=>parseScript(input));
});
