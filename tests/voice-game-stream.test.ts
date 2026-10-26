import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import Fastify from 'fastify';
import WebSocket,{WebSocketServer} from 'ws';
import {registerVoice} from '../src/server/voice.js';
import {defaultConfig} from '../src/server/store.js';

test('game event audio reaches the browser before its utterance is complete', {timeout:10000},async()=>{
 const upstream=new WebSocketServer({port:0});await once(upstream,'listening');
 const config=structuredClone(defaultConfig);Object.assign(config.linx,{inputMode:'stt',wsUrl:`ws://127.0.0.1:${(upstream.address() as any).port}`,deviceId:'input',wsToken:'in-token',speechDeviceId:'output',speechWsToken:'out-token',callbackToken:'callback'});
 let finish:()=>void=()=>{};
 upstream.on('connection',ws=>ws.on('message',raw=>{
  const m=JSON.parse(raw.toString());if(m.type==='hello')ws.send(JSON.stringify({type:'hello',session_id:'s',audio_params:{format:'pcm',sample_rate:16000}}));
  else{assert.equal(m.text_response,'主持人开场');assert.equal(m.agent_params.voice.id,'dm-voice');ws.send(JSON.stringify({type:'tts',state:'start'}));ws.send(Buffer.from([1,0]));finish=()=>{ws.send(Buffer.from([2,0]));ws.send(JSON.stringify({type:'tts',state:'stop'}));};}
 }));
 const app=Fastify();await registerVoice(app,{config:()=>config,hasSession:id=>id==='room',voiceFor:()=>({voiceId:'dm-voice'}),eventsFor:()=>[{eventId:'opening',speaker:'dm',text:'主持人开场'}],respond:async()=>[]});await app.listen({host:'127.0.0.1',port:0});
 const port=(app.server.address() as any).port;let browser:WebSocket|undefined;
 try{
  const grant=(await app.inject({method:'POST',url:'/api/voice/ticket',payload:{sessionId:'room'}})).json();
  const messages:any[]=[];const frames:Buffer[]=[];let first!:()=>void,done!:()=>void;
  const firstFrame=new Promise<void>(r=>{first=r;}),completed=new Promise<void>(r=>{done=r;});
  browser=new WebSocket(`ws://127.0.0.1:${port}/voice/socket?ticket=${grant.ticket}`,{headers:{Origin:`http://127.0.0.1:${port}`}});
  browser.on('message',(raw,binary)=>{if(binary){frames.push(Buffer.from(raw as Buffer));first();return;}const m=JSON.parse(raw.toString());messages.push(m);if(m.type==='ready')browser!.send(JSON.stringify({type:'play_events',eventIds:['opening']}));if(m.type==='tts'&&m.state==='stop')done();});
  const wait=async(promise:Promise<void>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([promise,new Promise<void>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('No audio progress: '+JSON.stringify(messages))),5000);})]);}finally{clearTimeout(timer);}};
  await wait(firstFrame);assert(!messages.some(m=>m.type==='tts'&&m.state==='stop'));assert.equal(frames.length,1);
  finish();await wait(completed);assert.deepEqual(Buffer.concat(frames),Buffer.from([1,0,2,0]));
 }finally{browser?.terminate();for(const c of upstream.clients)c.terminate();await app.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});
