import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseScript} from '../src/core/script.js';
import {createSession,begin,finishReading,playerView,playerSpeech,hostNarration,discover,openPrivateRoom,vote,advance,generatedSpeech,speak,host} from '../src/core/engine.js';
const script=parseScript(JSON.parse(readFileSync('examples/after-hours.json','utf8')));
test('new deferred session connects into reading without scene or turn order',()=>{
 const s=createSession(script,'lin',{deferStart:true});assert.equal(playerView(s,script).preparation,'reading');assert.equal(s.events.length,0);
 assert.throws(()=>finishReading(s,script));const version=s.version;begin(s,script);assert.equal(s.started,true);assert.equal(s.version,version+1);assert.equal(s.events.length,0);
 begin(s,script);assert.equal(s.version,version+1);assert.equal(s.events.length,0);
 hostNarration(s,script,'请先阅读自己的材料，读完告诉我。');assert.equal(s.events.length,1);assert.equal(s.events[0].kind,'speech');
});
test('finishing reading introduces the first scene exactly once and enables gameplay',()=>{
 const s=createSession(script,'lin',{deferStart:true});begin(s,script);hostNarration(s,script,'阅读指导');const version=s.version;
 finishReading(s,script);assert.equal(s.preparation,'ready');assert.equal(s.stageIndex,0);assert.equal(s.version,version+1);assert.equal(s.events.at(-1)?.text,script.stages[0].introduction);
 const after=structuredClone(s);finishReading(s,script);assert.deepEqual(s,after);playerSpeech(s,script,'我已准备好讨论');
});
test('reading material contains only selected role public fields and their unlocked known facts',()=>{
 for(const role of script.roles){const s=createSession(script,role.id,{deferStart:true});const material=playerView(s,script).readingMaterial;
  assert.deepEqual(material.role,{id:role.id,name:role.name,description:role.description,voiceHint:role.voiceHint});
  const expected=script.facts.filter(f=>f.knownBy.includes(role.id)&&f.unlockStage===script.stages[0].id).map(f=>({id:f.id,text:f.text}));assert.deepEqual(material.facts,expected);
  for(const fact of script.facts.filter(f=>!expected.some(e=>e.id===f.id)))assert(!material.facts.some(f=>f.id===fact.id));
  assert(!('script' in material));assert(!('solution' in material));assert.equal(s.events.length,0);
 }
});
test('all actual game mutations reject during reading without partial state changes',()=>{
 const allowed=structuredClone(script);allowed.stages[0].privateChat={enabled:true,maxParticipants:3,durationSeconds:60,allowRefusal:true};
 const s=createSession(allowed,'lin',{deferStart:true});begin(s,allowed);const before=structuredClone(s);
 const actions=[()=>playerSpeech(s,allowed,'skip'),()=>openPrivateRoom(s,allowed,['zhou'],0),()=>advance(s,allowed),()=>discover(s,allowed,'door'),()=>vote(s,allowed,'lin','zhou'),()=>generatedSpeech(s,allowed,'zhou','skip',[],s.version,'public'),()=>speak(s,allowed,'zhou','zhou_intro',s.version),()=>host(s,allowed,'order')];
 for(const action of actions){assert.throws(action,/阅读/);assert.deepEqual(s,before);}
});
test('legacy sessions without preparation remain ready and keep historical begin behavior',()=>{
 const old=createSession(script,'lin');delete old.preparation;const before=structuredClone(old);begin(old,script);finishReading(old,script);assert.deepEqual(old,before);assert.equal(playerView(old,script).preparation,'ready');playerSpeech(old,script,'继续旧局');
 const pending=createSession(script,'lin',{deferStart:true});delete pending.preparation;begin(pending,script,{announceOrder:false});assert.equal(pending.events.length,1);assert.equal(pending.events[0].text,script.stages[0].introduction);assert.equal(playerView(pending,script).preparation,'ready');
});
