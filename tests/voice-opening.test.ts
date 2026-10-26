import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {bridgeStt} from '../src/server/voice-stt.js';
import {defaultConfig} from '../src/server/store.js';
import type {VoiceReply} from '../src/server/voice.js';

async function until(check:()=>boolean,label:string){
 const deadline=Date.now()+3000;
 while(!check()){if(Date.now()>deadline)throw new Error(`Timed out: ${label}`);await new Promise(resolve=>setTimeout(resolve,5));}
}
const opening:VoiceReply={eventId:'opening',speaker:'dm',text:'主持人开场'};
async function setup(){
 const upstream=new WebSocketServer({port:0});await once(upstream,'listening');
 const gateway=new WebSocketServer({port:0});await once(gateway,'listening');
 const connections:{socket:WebSocket;messages:any[];device:string}[]=[];
 upstream.on('connection',(socket,request)=>{
  const connection={socket,messages:[] as any[],device:String(request.headers['device-id'])};connections.push(connection);
  socket.on('message',(raw,binary)=>{if(!binary)connection.messages.push(JSON.parse(raw.toString()));});
 });
 const config=structuredClone(defaultConfig);
 Object.assign(config.linx,{inputMode:'stt',wsUrl:`ws://127.0.0.1:${(upstream.address() as {port:number}).port}`,speechWsUrl:'',deviceId:'input',wsToken:'input-token',speechDeviceId:'output',speechWsToken:'output-token'});
 let beginCalls=0,commits=0,started=false;const beginOptions:any[]=[];
 const voiceRequests:string[]=[];
 gateway.on('connection',socket=>bridgeStt(socket,{
  config,sessionId:'room',respond:async()=>[],eventsFor:()=>started?[opening]:[],
  beginSession:async(id,current,options)=>{beginOptions.push(options);
   beginCalls++;assert.equal(id,'room');assert(current());
   // Mirrors the service contract: repeated begin requests return no new events.
   if(started)return [];started=true;commits++;return [opening];
  },
  voiceFor:(id,speaker)=>{assert.equal(id,'room');voiceRequests.push(speaker);return {voiceId:`voice-${speaker}`};},
 }));
 const browser=new WebSocket(`ws://127.0.0.1:${(gateway.address() as {port:number}).port}`);
 const messages:any[]=[],audio:Buffer[]=[];
 browser.on('message',(raw,binary)=>binary?audio.push(Buffer.from(raw as Buffer)):messages.push(JSON.parse(raw.toString())));
 await until(()=>messages.some(m=>m.type==='ready'),'ready');
 return {browser,messages,audio,connections,voiceRequests,beginOptions,get beginCalls(){return beginCalls;},get commits(){return commits;},
  send:(msg:unknown)=>browser.send(JSON.stringify(msg)),
  hello:()=>connections[0].socket.send(JSON.stringify({type:'hello',session_id:'speech-session',audio_params:{format:'pcm',sample_rate:16000,channels:1}})),
  close:async()=>{browser.terminate();for(const s of gateway.clients)s.terminate();for(const s of upstream.clients)s.terminate();await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);},
 };
}

test('ready alone never begins the game or generates opening speech',{timeout:10000},async()=>{
 const h=await setup();try{
  // A ping/pong round trip is a transport barrier after ready, without begin_game.
  const pong=once(h.browser,'pong');h.browser.ping();await pong;
  assert.equal(h.beginCalls,0);assert.equal(h.connections.length,0);assert.equal(h.audio.length,0);
  assert.deepEqual(h.messages.map(m=>m.type),['ready']);
 }finally{await h.close();}
});

test('opening waits for speech hello, uses DM voice, reports pending and deduplicates repeated begin',{timeout:10000},async()=>{
 const h=await setup();try{
  h.send({type:'begin_game'});h.send({type:'begin_game'});
  await until(()=>h.connections[0]?.messages.some(m=>m.type==='hello'),'outgoing hello');
  assert.equal(h.beginCalls,0);assert.equal(h.commits,0);assert.equal(h.audio.length,0);
  assert(!h.messages.some(m=>m.type==='game_started'||m.type==='session_updated'));
  h.hello();
  await until(()=>h.connections[0].messages.some(m=>m.text_response),'opening synthesis requested');
  await until(()=>h.messages.some(m=>m.type==='game_started'),'game started acknowledgment');
  assert.equal(h.beginCalls,1);assert.equal(h.commits,1);
  assert.equal(h.messages.find(m=>m.type==='game_started').pending,true);
  assert(h.messages.findIndex(m=>m.type==='session_updated')<h.messages.findIndex(m=>m.type==='game_started'));
  assert.equal(h.connections[0].device,'output');
  assert.deepEqual(h.voiceRequests,['dm']);
  const request=h.connections[0].messages.find(m=>m.text_response);
  assert.equal(request.text_response,opening.text);assert.equal(request.agent_params.voice.id,'voice-dm');
  const pcm=Buffer.from([1,0,2,0]);
  h.connections[0].socket.send(JSON.stringify({type:'tts',state:'start'}));h.connections[0].socket.send(pcm);h.connections[0].socket.send(JSON.stringify({type:'tts',state:'stop'}));
  await until(()=>h.messages.some(m=>m.type==='tts'&&m.state==='stop'),'opening playback complete');
  assert.deepEqual(Buffer.concat(h.audio),pcm);
  h.send({type:'begin_game'});
  await until(()=>h.messages.filter(m=>m.type==='game_started').length===2,'repeat acknowledged');
  assert.equal(h.beginCalls,2);assert.equal(h.commits,1);
  assert.equal(h.messages.filter(m=>m.type==='game_started')[1].pending,false);
  assert.equal(h.connections[0].messages.filter(m=>m.text_response).length,1);
 }finally{await h.close();}
});

for(const failure of ['invalid hello','upstream disconnect','browser disconnect'] as const){
 test(`${failure} before speech handshake never begins the game`,{timeout:10000},async()=>{
  const h=await setup();try{
   h.send({type:'begin_game'});
   await until(()=>h.connections[0]?.messages.some(m=>m.type==='hello'),'outgoing hello');
   if(failure==='invalid hello')h.connections[0].socket.send(JSON.stringify({type:'hello'}));
   else if(failure==='upstream disconnect')h.connections[0].socket.close();
   else {h.browser.close();await once(h.browser,'close');}
   if(failure!=='browser disconnect')await until(()=>h.messages.some(m=>m.type==='error'),'handshake failure reported');
   await until(()=>h.connections[0].socket.readyState===WebSocket.CLOSED,'speech transport closed');
   assert.equal(h.beginCalls,0);assert.equal(h.commits,0);assert.equal(h.audio.length,0);
   assert(!h.messages.some(m=>m.type==='game_started'||m.type==='session_updated'));
  }finally{await h.close();}
 });
}

test('readingComplete is validated and forwarded only after output handshake',async()=>{
 const h=await setup();try{
  h.send({type:'begin_game',readingComplete:'yes'});await until(()=>h.messages.some(m=>m.type==='error'),'invalid reading flag');assert.equal(h.beginCalls,0);
  h.send({type:'begin_game',readingComplete:true});await until(()=>h.connections[0]?.messages.some(m=>m.type==='hello'),'hello');assert.equal(h.beginCalls,0);
  h.hello();await until(()=>h.beginCalls===1,'start');assert.deepEqual(h.beginOptions,[{readingComplete:true}]);
 }finally{await h.close();}
});
