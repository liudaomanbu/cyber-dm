import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseScript} from '../src/core/script.js';
import {createSession,roleContext} from '../src/core/engine.js';
import {bindingKey} from '../src/core/bindings.js';
import {GameService} from '../src/server/game-service.js';
import {defaultConfig} from '../src/server/store.js';
const base=parseScript(JSON.parse(readFileSync('examples/after-hours.json','utf8')));
function fixture(role='lin',deferStart=false){
 const script=structuredClone(base);const search=script.stages.find(st=>st.kind==='investigation')!;
 search.privateChat={enabled:true,maxParticipants:3,durationSeconds:60,allowRefusal:true};
 search.flow={minPublicRounds:1,maxPublicRounds:4,requiredClueIds:script.clues.map(c=>c.id)};
 const s=createSession(script,role,{deferStart});const sessions={[s.id]:s};const config=structuredClone(defaultConfig);
 config.providers=[{id:'fake',name:'test',protocol:'chat-completions',baseUrl:'https://invalid.example/v1',modelId:'fake',apiKey:'',timeoutMs:1000}];
 for(const id of ['dm',...script.roles.map(r=>r.id)]){config.roleModels[bindingKey(script.id,id)]='fake';config.roleVoices[bindingKey(script.id,id)]={provider:'test',voiceType:id};}
 const contexts:ReturnType<typeof roleContext>[]=[];const ballots:string[]=[];const invitations:string[]=[];
 const handoffs:unknown[]=[];const control={speakers:[] as string[],directorCalls:0,now:0,advance:false,accept:true,failRole:'',cancelAfterRole:'',current:true,count:0};
 const service=new GameService({sessions,scripts:{[script.id]:script},config:()=>config,persist:async()=>{},now:()=>control.now,
  dialogue:async(_p,ctx,options)=>{handoffs.push(options?.handoffTo);contexts.push(structuredClone(ctx));const id=ctx.role!.id;if(control.failRole===id)throw new Error('dialogue failed');if(control.cancelAfterRole===id)control.current=false;return {text:`即兴${id}第${++control.count}句`,factIds:[]};},
  director:async()=>{control.directorCalls++;return {advance:control.advance,speakers:control.speakers,task:'question'};},
  invitation:async(_p,ctx)=>{invitations.push(ctx.role!.id);return control.accept;},
  ballot:async(_p,ctx)=>{ballots.push(ctx.role!.id);return {action:{target:'zhou'}};}});
 return {service,sessions,s,script,config,contexts,ballots,invitations,handoffs,control,state:()=>sessions[s.id],search:()=>{sessions[s.id].stageIndex=script.stages.findIndex(st=>st.kind==='investigation');},voting:()=>{sessions[s.id].stageIndex=script.stages.findIndex(st=>st.kind==='vote');}};
}
test('deferred sessions reject speech and cancelled opening; begin is idempotent for every player',async()=>{
 for(const role of base.roles){const f=fixture(role.id,true);
  await assert.rejects(f.service.voice(f.s.id,'你好',()=>true));await assert.rejects(f.service.begin(f.s.id,()=>false,{readingComplete:true}));assert.deepEqual(f.state().events,[]);
  const results=await Promise.all([f.service.begin(f.s.id,()=>true,{readingComplete:true}),f.service.begin(f.s.id,()=>true,{readingComplete:true})]);
  assert.equal(results.flat().length,2);assert.equal(f.state().started,true);assert.equal(f.state().preparation,'ready');assert.deepEqual(f.handoffs,[[{id:role.id,name:role.name}]]);assert.equal(results.flat()[1].text,'即兴dm第1句');assert.equal(f.contexts[0].role!.id,'dm');
  assert.deepEqual(await f.service.begin(f.s.id,()=>true,{readingComplete:true}),[]);assert.equal(f.state().events.length,2);
 }
});
test('begin requires all NPC and host model/voice bindings, never legacy unscoped bindings',async()=>{
 for(const id of ['dm','zhou','chen']){const f=fixture('lin',true);delete f.config.roleModels[bindingKey(f.script.id,id)];f.config.roleModels[id]='fake';await assert.rejects(f.service.begin(f.s.id,()=>true,{readingComplete:true}));assert.deepEqual(f.state().events,[]);}
 const f=fixture('lin',true);delete f.config.roleVoices[bindingKey(f.script.id,'zhou')];await assert.rejects(f.service.begin(f.s.id,()=>true,{readingComplete:true}));assert.deepEqual(f.state().events,[]);
});
test('public first round generates each NPC then host, with sequential scoped contexts',async()=>{
 for(const player of base.roles){const f=fixture(player.id);const actors=base.roles.filter(r=>r.id!==player.id).map(r=>r.id);
  const replies=await f.service.voice(f.s.id,'请大家介绍',()=>true);
  assert.deepEqual(replies.map(r=>r.speaker),[...actors,'dm']);assert.deepEqual(f.contexts.map(c=>c.role!.id),[...actors,'dm']);
  assert(f.contexts[1].heard.some(e=>e.speaker===actors[0]&&e.text.startsWith('即兴')));
  assert(replies.every(r=>r.text.startsWith('即兴')));assert.equal(f.state().stageIndex,0);
  assert(f.contexts.filter(c=>c.role!.id!=='dm').every(c=>!('script' in c)));
 }
});
test('repeated turns generate different speech instead of selecting prewritten utterances',async()=>{
 const f=fixture();const a=await f.service.voice(f.s.id,'你怎么看',()=>true);const b=await f.service.voice(f.s.id,'再说说',()=>true);
 assert.notEqual(a.find(r=>r.speaker==='zhou')?.text,b.find(r=>r.speaker==='zhou')?.text);
 assert(!f.contexts.find(c=>c.role!.id==='chen')!.facts.some(f=>f.id==='zhou_truth'));
 assert(f.state().events.filter(e=>e.kind==='speech').every(e=>e.factIds.length===0));
});
test('private rooms require stage permission and can be refused before opening',async()=>{
 const f=fixture();await assert.rejects(f.service.privateControl(f.s.id,['zhou'],()=>true));assert.equal(f.invitations.length,0);
 f.search();f.control.accept=false;const replies=await f.service.privateControl(f.s.id,['zhou'],()=>true);
 assert.equal(f.state().privateRoom,undefined);assert(replies[0].text.includes('没有接受'));assert.deepEqual(f.invitations,['zhou']);
});
test('multi-person invitation and private speech target exactly room participants without host generation',async()=>{
 const f=fixture();f.search();await f.service.voice(f.s.id,'我想和周启、陈墨私聊',()=>true);
 assert.deepEqual(f.state().privateRoom?.participants,['lin','zhou','chen']);
 const replies=await f.service.voice(f.s.id,'PRIVATE_GROUP',()=>true);
 assert.deepEqual(replies.map(r=>r.speaker),['zhou','chen']);assert.deepEqual(f.contexts.map(c=>c.role!.id),['zhou','chen']);
 for(const e of f.state().events.filter(e=>e.text==='PRIVATE_GROUP'||e.text.startsWith('即兴')))assert.deepEqual(e.audience,['lin','zhou','chen']);
 assert(!JSON.stringify(roleContext(f.state(),f.script,'dm')).includes('PRIVATE_GROUP'));
});
test('private transcript is absent from outside NPC and host contexts after returning public',async()=>{
 const f=fixture();f.search();await f.service.privateControl(f.s.id,['zhou'],()=>true);await f.service.voice(f.s.id,'PRIVATE_SENTINEL',()=>true);
 assert(!JSON.stringify(roleContext(f.state(),f.script,'chen')).includes('PRIVATE_SENTINEL'));
 await f.service.voice(f.s.id,'结束私聊',()=>true);await f.service.voice(f.s.id,'大家继续',()=>true);
 for(const c of f.contexts.filter(c=>c.role!.id==='chen'||c.role!.id==='dm'))assert(!JSON.stringify(c).includes('PRIVATE_SENTINEL'));
});
test('expired private input is discarded instead of silently becoming public',async()=>{
 const f=fixture();f.search();await f.service.privateControl(f.s.id,['zhou'],()=>true);f.control.now=60000;
 const replies=await f.service.voice(f.s.id,'EXPIRED_SECRET',()=>true);
 assert.equal(f.state().privateRoom,undefined);assert(!JSON.stringify(f.state().events).includes('EXPIRED_SECRET'));assert.equal(f.contexts.length,0);assert(replies[0].text.includes('重新说一次'));
});
test('text private chat and manual advance, vote, NPC controls are rejected',async()=>{
 const f=fixture();const before=structuredClone(f.state());
 for(const kind of ['advance','vote','npc'] as const)await assert.rejects(f.service.action(f.s.id,{kind,target:'zhou',channel:'public',requestId:kind}));
 await assert.rejects(f.service.action(f.s.id,{kind:'speak',text:'secret',target:'zhou',channel:'private',requestId:'private'}));
 await assert.rejects(f.service.voice(f.s.id,'secret',()=>true,'zhou'));assert.deepEqual(f.state(),before);
});
test('spoken advance requests obey director decision instead of jumping stages',async()=>{
 const f=fixture();await f.service.voice(f.s.id,'下一阶段',()=>true);assert.equal(f.state().stageIndex,0);
 f.control.advance=true;await f.service.voice(f.s.id,'进入下一阶段',()=>true);assert.equal(f.state().stageIndex,1);
});
test('voice vote proposal makes no ballot until confirmation, then all NPCs vote before reveal',async()=>{
 const f=fixture();f.voting();const before=structuredClone(f.state());const prompt=await f.service.voice(f.s.id,'我投周启',()=>true);
 assert(prompt[0].text.includes('确认投票'));assert.deepEqual(f.state(),before);assert.deepEqual(f.ballots,[]);
 await f.service.voice(f.s.id,'确认投票',()=>true);assert.equal(f.state().status,'finished');assert.deepEqual(f.ballots,['zhou','chen']);assert.equal(Object.keys(f.state().votes).length,3);
 assert.equal(f.state().events.filter(e=>e.kind==='vote').length,3);
});
test('confirmation expires exactly at deadline without recording a ballot',async()=>{
 const f=fixture();f.voting();await f.service.voice(f.s.id,'我投周启',()=>true);f.control.now=60000;
 await assert.rejects(f.service.voice(f.s.id,'确认',()=>true));assert.deepEqual(f.state().votes,{});assert.deepEqual(f.ballots,[]);
});
test('intervening public action or explicit cancellation invalidates vote confirmation',async()=>{
 for(const cancel of [false,true]){const f=fixture();f.voting();await f.service.voice(f.s.id,'我选周启',()=>true);
  if(cancel)await f.service.voice(f.s.id,'取消投票',()=>true);else await f.service.action(f.s.id,{kind:'speak',text:'我还想问问',channel:'public',requestId:'intervene'});
  await assert.rejects(f.service.voice(f.s.id,'确认投票',()=>true));assert.deepEqual(f.state().votes,{});
 }
});
test('cancelling during generated dialogue rolls back player and all generated events',async()=>{
 const f=fixture();const before=structuredClone(f.state());f.control.cancelAfterRole='chen';
 await assert.rejects(f.service.voice(f.s.id,'你好',()=>f.control.current));assert.deepEqual(f.state(),before);assert.equal(f.contexts.length,2);
});
test('a later NPC generation failure rolls back the whole public round',async()=>{
 const f=fixture();const before=structuredClone(f.state());f.control.failRole='chen';
 await assert.rejects(f.service.voice(f.s.id,'大家说明',()=>true));assert.deepEqual(f.state(),before);assert.equal(f.contexts.length,2);
});
test('speech replay contains only committed visible nonplayer nonballot events',async()=>{
 const f=fixture();const replies=await f.service.voice(f.s.id,'大家好',()=>true);
 assert(replies.every(r=>r.eventId&&f.service.eventsFor(f.s.id).some(e=>e.eventId===r.eventId)));
 f.state().events.push({id:'hidden',sequence:999,kind:'speech',speaker:'chen',audience:['chen'],text:'hidden',factIds:[]},{id:'ballot',sequence:1000,kind:'vote',speaker:'zhou',audience:['lin'],text:'vote',factIds:[]});
 assert(!f.service.eventsFor(f.s.id).some(e=>e.speaker==='lin'||e.eventId==='hidden'||e.eventId==='ballot'));
});

test('DM handoff is followed by the selected NPC automatically and finally yields to the player',async()=>{
 const f=fixture();f.control.speakers=['zhou'];
 const replies=await f.service.voice(f.s.id,'请大家说说',()=>true);
 assert.deepEqual(replies.map(r=>r.speaker),['zhou','chen','dm','zhou','dm']);
 assert.deepEqual(f.handoffs[2],[{id:'zhou',name:'周启'}]);
 assert.deepEqual(f.handoffs[4],[{id:'lin',name:'林岚'}]);
 assert(f.contexts[3].heard.some(e=>e.speaker==='dm'&&e.text===replies[2].text));
 assert.equal(f.control.directorCalls,1);
 const next=await f.service.voice(f.s.id,'周启再解释一下',()=>true);
 assert.deepEqual(next.map(r=>r.speaker),['dm','zhou','dm']);
 assert.equal(f.control.directorCalls,2);
});
test('DM can call two NPCs in order and never waits for player to trigger them',async()=>{
 const f=fixture();f.control.speakers=['chen','zhou'];
 const replies=await f.service.voice(f.s.id,'请继续',()=>true);
 assert.deepEqual(replies.map(r=>r.speaker),['zhou','chen','dm','chen','zhou','dm']);
 const called=f.contexts.at(-2)!;
 assert(called.heard.some(e=>e.speaker==='chen'&&e.text===replies.at(-3)!.text));
});
test('offline reading has no events and cannot finish by speech or an unconfirmed connection',async()=>{
 const f=fixture('lin',true);
 await assert.rejects(f.service.begin(f.s.id,()=>true),/阅读/);
 await assert.rejects(f.service.voice(f.s.id,'我读完了',()=>true));
 assert.equal(f.state().preparation,'reading');assert.equal(f.state().started,false);assert.deepEqual(f.state().events,[]);assert.equal(f.contexts.length,0);
 const replies=await f.service.begin(f.s.id,()=>true,{readingComplete:true});
 assert.equal(f.state().preparation,'ready');assert.equal(replies.length,2);assert.equal(f.state().events.filter(e=>e.kind==='stage').length,1);
 await f.service.voice(f.s.id,'我是林岚，先介绍自己的行踪',()=>true);assert(f.contexts.some(c=>c.role!.id==='zhou'));
});
test('cancelled combined start keeps offline reading and publishes no scene',async()=>{
 const f=fixture('lin',true);const before=structuredClone(f.state());f.control.cancelAfterRole='dm';
 await assert.rejects(f.service.begin(f.s.id,()=>f.control.current,{readingComplete:true}));assert.deepEqual(f.state(),before);
});
test('previously connected reading room accepts combined start without replaying the old reading message',async()=>{
 const f=fixture('lin',true);f.state().started=true;f.state().events.push({id:'old',sequence:1,kind:'speech',speaker:'dm',audience:['lin','zhou','chen','dm'],text:'旧阅读提示',factIds:[]});
 const replies=await f.service.begin(f.s.id,()=>true,{readingComplete:true});assert.equal(f.state().preparation,'ready');assert.equal(replies.length,2);assert(!replies.some(r=>r.text==='旧阅读提示'));
});
