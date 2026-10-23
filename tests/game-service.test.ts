import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseScript} from '../src/core/script.js';
import {createSession,roleContext} from '../src/core/engine.js';
import {bindingKey} from '../src/core/bindings.js';
import {GameService} from '../src/server/game-service.js';
import {defaultConfig} from '../src/server/store.js';
const script=parseScript(JSON.parse(readFileSync('examples/after-hours.json','utf8')));
function fixture(){
 const s=createSession(script,'lin');const sessions={[s.id]:s};const config=structuredClone(defaultConfig);
 config.providers=[{id:'fake',name:'test',protocol:'chat-completions',baseUrl:'https://invalid.example/v1',modelId:'fake',apiKey:'',timeoutMs:1000}];
 for(const role of ['dm',...script.roles.map(r=>r.id)]){config.roleModels[bindingKey(script.id,role)]='fake';config.roleVoices[bindingKey(script.id,role)]={provider:'test',voiceType:role};}
 let now=0;const contexts:ReturnType<typeof roleContext>[]=[];
 const service=new GameService({sessions,scripts:{[script.id]:script},config:()=>config,persist:async()=>{},now:()=>now,utterance:async(_p,ctx)=>{contexts.push(ctx);return {action:{utteranceId:ctx.allowedUtterances[0].id}};},ballot:async()=>({action:{target:'zhou'}})});
 return {service,sessions,s,config,contexts,setTime:(v:number)=>{now=v;}};
}
test('voice commands require a separate confirmation and expire without mutating state',async()=>{
 const f=fixture();const initial=f.s.version;
 const reply=await f.service.voice(f.s.id,'下一阶段',()=>true);assert(reply[0].text.includes('确认执行'));
 assert.equal(f.sessions[f.s.id].stageIndex,0);assert.equal(f.sessions[f.s.id].version,initial);
 f.setTime(60000);await assert.rejects(f.service.voice(f.s.id,'确认执行',()=>true));assert.equal(f.sessions[f.s.id].stageIndex,0);
 await f.service.voice(f.s.id,'下一阶段',()=>true);await f.service.voice(f.s.id,'确认执行',()=>true);assert.equal(f.sessions[f.s.id].stageIndex,1);
});
test('voice and text private replies remain private and use private allowed utterances',async()=>{
 const f=fixture();await f.service.voice(f.s.id,'PRIVATE_VOICE_SENTINEL',()=>true,'zhou');
 const s=f.sessions[f.s.id];assert(f.contexts[0].heard.some(e=>e.text.includes('PRIVATE_VOICE_SENTINEL')));
 assert(!JSON.stringify(roleContext(s,script,'chen')).includes('PRIVATE_VOICE_SENTINEL'));
 assert(s.events.at(-1)?.audience.includes('zhou'));assert(!s.events.at(-1)?.audience.includes('dm'));
 await f.service.action(s.id,{kind:'speak',text:'PRIVATE_TEXT_SENTINEL',target:'chen',channel:'private',requestId:'test-1'});
 assert(!JSON.stringify(roleContext(f.sessions[s.id],script,'zhou')).includes('PRIVATE_TEXT_SENTINEL'));
});
test('cancelled model turn never commits and a different script cannot reuse unscoped bindings',async()=>{
 const f=fixture();const before=structuredClone(f.s);
 await assert.rejects(f.service.voice(f.s.id,'你好',()=>false));assert.deepEqual(f.sessions[f.s.id],before);
 delete f.config.roleModels[bindingKey(script.id,'zhou')];f.config.roleModels.zhou='fake';
 await assert.rejects(f.service.voice(f.s.id,'周启你好',()=>true));assert.deepEqual(f.sessions[f.s.id],before);
});
test('intervening text action invalidates a pending voice confirmation',async()=>{
 const f=fixture();await f.service.voice(f.s.id,'下一阶段',()=>true);
 await f.service.action(f.s.id,{kind:'npc',target:'dm',channel:'public',requestId:'intervene'});
 await assert.rejects(f.service.voice(f.s.id,'确认执行',()=>true));assert.equal(f.sessions[f.s.id].stageIndex,0);
});
