import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {defaultConfig} from '../src/server/store.js';
import {LinxSpeech} from '../src/server/linx-speech.js';

test('first PCM arrives before synthesis ends; clean sequential voices reuse one connection', {timeout:10000},async()=>{
 const server=new WebSocketServer({port:0});await once(server,'listening');
 const config=structuredClone(defaultConfig);Object.assign(config.linx,{deviceId:'stream-device',wsToken:'token',wsUrl:`ws://127.0.0.1:${(server.address() as any).port}`});
 let connections=0;let finish:()=>void=()=>{};const voices:string[]=[];
 server.on('connection',ws=>{connections++;ws.on('message',d=>{
  const msg=JSON.parse(d.toString());
  if(msg.type==='hello')ws.send(JSON.stringify({type:'hello',session_id:'s',audio_params:{format:'pcm',sample_rate:16000,channels:1}}));
  else{voices.push(msg.agent_params.voice.id);ws.send(JSON.stringify({type:'tts',state:'start'}));ws.send(Buffer.from([1,0,2,0]));finish=()=>{ws.send(Buffer.from([3,0,4,0]));ws.send(JSON.stringify({type:'tts',state:'stop'}));};}
 });});
 const speech=new LinxSpeech(config);
 try{
  for(const voice of ['dm-voice','zhou-voice']){
   const frames:Buffer[]=[];let first!:()=>void;const firstFrame=new Promise<void>(r=>{first=r;});let completed=false;
   const task=speech.speak(voice,'批准的角色台词',{onFormat:rate=>assert.equal(rate,16000),onPcm:pcm=>{frames.push(pcm);first();}}).then(timing=>{completed=true;return timing;});
   await firstFrame;assert.equal(completed,false,'must deliver audio while upstream is still synthesizing');assert.equal(frames.length,1);
   finish();const timing=await task;assert.deepEqual(Buffer.concat(frames),Buffer.from([1,0,2,0,3,0,4,0]));assert.equal(timing.pcmBytes,8);assert(timing.firstAudioMs<=timing.totalMs);
  }
  assert.equal(connections,1);assert.deepEqual(voices,['dm-voice','zhou-voice']);
 }finally{speech.close();for(const ws of server.clients)ws.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});

test('aborting partial audio closes its transport; later synthesis cannot receive old frames', {timeout:10000},async()=>{
 const server=new WebSocketServer({port:0});await once(server,'listening');
 const config=structuredClone(defaultConfig);Object.assign(config.linx,{deviceId:'device',wsToken:'token',wsUrl:`ws://127.0.0.1:${(server.address() as any).port}`});
 let connections=0;
 server.on('connection',ws=>{const index=++connections;ws.on('message',d=>{
  const msg=JSON.parse(d.toString());if(msg.type==='hello')ws.send(JSON.stringify({type:'hello',session_id:`s${index}`,audio_params:{format:'pcm',sample_rate:16000}}));
  else{ws.send(JSON.stringify({type:'tts',state:'start'}));ws.send(Buffer.from([index,0]));if(index>1)ws.send(JSON.stringify({type:'tts',state:'stop'}));}
 });});
 const speech=new LinxSpeech(config);const abort=new AbortController();let first!:()=>void;const firstFrame=new Promise<void>(r=>{first=r;});
 try{
  const task=speech.speak('old','旧台词',{onFormat:()=>{},onPcm:()=>first()},abort.signal);const rejected=assert.rejects(task,/取消/);
  await firstFrame;abort.abort();await rejected;
  const output:Buffer[]=[];await speech.speak('new','新台词',{onFormat:()=>{},onPcm:p=>output.push(p)});
  assert.equal(connections,2);assert.deepEqual(Buffer.concat(output),Buffer.from([2,0]));
 }finally{speech.close();for(const ws of server.clients)ws.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});
