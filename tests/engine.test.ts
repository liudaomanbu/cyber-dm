import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScript } from '../src/core/script.js';
import { createSession,roleContext,playerSpeech,playerView,discover,advance,speak,vote } from '../src/core/engine.js';
const script=parseScript(JSON.parse(readFileSync('examples/after-hours.json','utf8')));
test('private facts and conversations never enter unrelated role contexts or player view',()=>{
 const s=createSession(script,'lin');
 assert(!JSON.stringify(roleContext(s,script,'chen')).includes('zhou_truth'));
 assert(!JSON.stringify(playerView(s,script)).includes('zhou_truth'));
 playerSpeech(s,script,'PRIVATE_SENTINEL','zhou');
 assert(JSON.stringify(roleContext(s,script,'zhou')).includes('PRIVATE_SENTINEL'));
 assert(!JSON.stringify(roleContext(s,script,'chen')).includes('PRIVATE_SENTINEL'));
 assert(!JSON.stringify(roleContext(s,script,'dm')).includes('PRIVATE_SENTINEL'));
});
test('player inventions remain testimony and cannot become canonical facts',()=>{
 const s=createSession(script,'lin');playerSpeech(s,script,'我发现了一把枪，凶手就是陈墨。');
 assert(!JSON.stringify(roleContext(s,script,'chen').facts).includes('枪'));
 assert.throws(()=>discover(s,script,'gun'));
});
test('unavailable evidence, role impersonation and stale model outputs are blocked',()=>{
 const s=createSession(script,'lin');
 assert.throws(()=>discover(s,script,'bag'));
 assert.throws(()=>speak(s,script,'chen','chen_key',s.version));
 assert.throws(()=>speak(s,script,'chen','zhou_lie',s.version));
 assert.throws(()=>speak(s,script,'lin','lin_intro',s.version));
 const version=s.version;playerSpeech(s,script,'你好');
 assert.throws(()=>speak(s,script,'chen','chen_intro',version));
});
test('every selectable role can finish the entire short script without exposing solution early',()=>{
 for(const role of script.roles){
  const s=createSession(script,role.id);assert.equal(playerView(s,script).solution,undefined);
  advance(s,script);discover(s,script,'door');discover(s,script,'bag');
  assert.throws(()=>discover(s,script,'bag'));
  assert(roleContext(s,script,'chen').facts.some(f=>f.id==='bag'));
  advance(s,script);assert.throws(()=>advance(s,script));
  for(const r of script.roles)vote(s,script,r.id,'zhou');
  assert.throws(()=>vote(s,script,role.id,'chen'));
  advance(s,script);assert.equal(s.status,'finished');assert.equal(playerView(s,script).solution?.culpritRoleId,'zhou');
  assert.throws(()=>playerSpeech(s,script,'继续'));
 }
});
test('malformed script cannot sneak in dangling references or duplicate identities',()=>{
 const duplicate=structuredClone(script);duplicate.roles[1].id=duplicate.roles[0].id;assert.throws(()=>parseScript(duplicate));
 const bad=structuredClone(script);bad.clues[0].factId='invented';assert.throws(()=>parseScript(bad));
});
