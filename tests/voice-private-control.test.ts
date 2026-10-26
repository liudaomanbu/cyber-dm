import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {bridgeStt} from '../src/server/voice-stt.js';
import {defaultConfig} from '../src/server/store.js';
import type {VoiceReply} from '../src/server/voice.js';
async function until(check:()=>boolean,label:string){const deadline=Date.now()+3000;while(!check()){if(Date.now()>deadline)throw new Error(`Timed out: ${label}`);await new Promise(r=>setTimeout(r,5));}}
async function setup(control:(id:string,participants:string[]|null,current:()=>boolean)=>Promise<VoiceReply[]>){
 const upstream=new WebSocketServer({port:0});await once(upstream,'listening');const gateway=new WebSocketServer({port:0});await once(gateway,'listening');
 const requests:any[]=[];const voices:{id:string;speaker:string}[]=[];const pcm=Buffer.from([1,0,2,0]);
 upstream.on('connection',socket=>socket.on('message',(raw,binary)=>{if(binary)return;const msg=JSON.parse(raw.toString());if(msg.type==='hello')socket.send(JSON.stringify({type:'hello',session_id:'synthesis',audio_params:{format:'pcm',sample_rate:16000,channels:1}}));if(msg.text_response){requests.push(msg);socket.send(JSON.stringify({type:'tts',state:'start'}));socket.send(pcm);socket.send(JSON.stringify({type:'tts',state:'stop'}));}}));
 const config=structuredClone(defaultConfig);Object.assign(config.linx,{inputMode:'stt',wsUrl:`ws://127.0.0.1:${(upstream.address() as {port:number}).port}`,speechWsUrl:'',deviceId:'input',wsToken:'in',speechDeviceId:'output',speechWsToken:'out'});
 gateway.on('connection',socket=>bridgeStt(socket,{config,sessionId:'authorized-room',respond:async()=>[],privateControl:control,voiceFor:(id,speaker)=>{voices.push({id,speaker});return {voiceId:'voice-'+speaker};}}));
 const browser=new WebSocket(`ws://127.0.0.1:${(gateway.address() as {port:number}).port}`);const messages:any[]=[],audio:Buffer[]=[];
 browser.on('message',(raw,binary)=>binary?audio.push(Buffer.from(raw as Buffer)):messages.push(JSON.parse(raw.toString())));await until(()=>messages.some(m=>m.type==='ready'),'ready');
 return {browser,messages,audio,requests,voices,pcm,send:(msg:unknown)=>browser.send(JSON.stringify(msg)),barrier:async()=>{const pong=once(browser,'pong');browser.ping();await pong;},close:async()=>{browser.terminate();for(const s of gateway.clients)s.terminate();for(const s of upstream.clients)s.terminate();await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);}};
}
test('private invite and leave use ticket session, send session_updated and play each returned speaker in order',{timeout:10000},async()=>{
 const calls:{id:string;participants:string[]|null}[]=[];
 const h=await setup(async(id,participants,current)=>{assert(current());calls.push({id,participants});return participants?[{eventId:'invite',speaker:'dm',text:'进入私聊'},{eventId:'accepted',speaker:'zhou',text:'可以聊聊'}]:[{eventId:'leave',speaker:'dm',text:'返回大厅'}];});
 try{h.send({type:'private_invite',participants:['zhou','chen'],sessionId:'attacker-room'});await until(()=>h.messages.some(m=>m.type==='tts'&&m.state==='stop'),'invite playback');
  assert.deepEqual(calls,[{id:'authorized-room',participants:['zhou','chen']}]);assert.equal(h.messages.filter(m=>m.type==='session_updated').length,1);
  assert.deepEqual(h.requests.map(r=>[r.text_response,r.agent_params.voice.id]),[['进入私聊','voice-dm'],['可以聊聊','voice-zhou']]);
  assert.deepEqual(h.messages.filter(m=>m.type==='tts'&&m.state==='start').map(m=>m.speaker),['dm','zhou']);
  h.send({type:'private_leave',sessionId:'other-room',participants:['forged']});await until(()=>h.messages.filter(m=>m.type==='tts'&&m.state==='stop').length===2,'leave playback');
  assert.deepEqual(calls[1],{id:'authorized-room',participants:null});assert.equal(h.messages.filter(m=>m.type==='session_updated').length,2);
  assert(h.voices.every(v=>v.id==='authorized-room'));assert.deepEqual(Buffer.concat(h.audio),Buffer.concat([h.pcm,h.pcm,h.pcm]));
 }finally{await h.close();}
});
for(const cancellation of ['abort','close'] as const)test(`pending private control is invalidated by ${cancellation} and late results cannot play`,{timeout:10000},async()=>{
 let release!:()=>void,current!:()=>boolean,finished=false;
 const h=await setup(async(_id,_participants,isCurrent)=>{current=isCurrent;await new Promise<void>(r=>{release=r;});finished=true;return [{eventId:'late',speaker:'zhou',text:'不能播放'}];});
 try{h.send({type:'private_invite',participants:['zhou']});await until(()=>!!release,'pending invitation');assert(current());
  if(cancellation==='abort'){h.send({type:'abort'});await until(()=>h.messages.some(m=>m.isAborted),'abort acknowledged');}else{const closed=once(h.browser,'close');h.browser.close();await closed;}
  await until(()=>!current(),'current revoked');release();await until(()=>finished,'callback returns');
  if(cancellation==='abort')await h.barrier();
  assert.equal(h.requests.length,0);assert.equal(h.audio.length,0);assert(!h.messages.some(m=>m.type==='session_updated'||m.type==='synthesizing'));
 }finally{release?.();await h.close();}
});
test('malformed private participants never reach privateControl or produce speech',{timeout:10000},async()=>{
 let calls=0;const h=await setup(async()=>{calls++;return [];});
 try{for(const participants of [undefined,'zhou',[],[1],[{}],['x'.repeat(65)],Array(12).fill('zhou')]){const count=h.messages.filter(m=>m.type==='error').length;h.send({type:'private_invite',participants});await until(()=>h.messages.filter(m=>m.type==='error').length===count+1,'invalid participants rejected');}
  assert.equal(calls,0);assert.equal(h.requests.length,0);assert.equal(h.audio.length,0);
 }finally{await h.close();}
});
test('service rejection of unknown participants reports error without publishing session update',{timeout:10000},async()=>{
 const h=await setup(async(_id,participants,current)=>{assert(current());assert.deepEqual(participants,['unknown']);throw new Error('私聊对象无效');});
 try{h.send({type:'private_invite',participants:['unknown']});await until(()=>h.messages.some(m=>m.type==='error'),'rejection');assert(!h.messages.some(m=>m.type==='session_updated'));assert.equal(h.requests.length,0);}finally{await h.close();}
});
