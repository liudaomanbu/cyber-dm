import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import WebSocket,{WebSocketServer} from 'ws';
import {once} from 'node:events';
import {registerVoice} from '../src/server/voice.js';
import {defaultConfig} from '../src/server/store.js';

test('voice bridge binds a one-use ticket, scopes callbacks and speaks with the catalog voice ID',async()=>{
 const upstream=new WebSocketServer({port:0});await once(upstream,'listening');
 const address=upstream.address() as {port:number};
 const config=structuredClone(defaultConfig);config.linx={...config.linx,wsUrl:`ws://127.0.0.1:${address.port}`,wsToken:'test-device-token',deviceId:'device-1',callbackToken:'test-callback'};config.roleVoices.chen={provider:'',voiceType:'',voiceId:'voice-chen'};
 let invocations=0;let hello:any;const upstreamMessages:any[]=[];
 upstream.on('connection',ws=>ws.on('message',(data,binary)=>{if(binary)return;const msg=JSON.parse(data.toString());upstreamMessages.push(msg);if(msg.type==='hello'){hello=msg;ws.send(JSON.stringify({type:'hello',session_id:'linx-1',audio_params:{format:'pcm',sample_rate:16000}}));}}));
 const app=Fastify();await registerVoice(app,{config:()=>config,hasSession:id=>id==='game-1',voiceFor:(_id,role)=>config.roleVoices[role],respond:async(id,text)=>{assert.equal(id,'game-1');assert.equal(text,'你好');invocations++;return [{speaker:'chen',text:'核对已经公开的线索。'}];}});
 await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as {port:number}).port;
 let ws:WebSocket|undefined;
 try{
  const ticket=(await app.inject({method:'POST',url:'/api/voice/ticket',payload:{sessionId:'game-1'}})).json().ticket;
  ws=new WebSocket(`ws://127.0.0.1:${port}/voice/socket?ticket=${ticket}`,{headers:{Origin:`http://127.0.0.1:${port}`}});
  const message=await once(ws,'message');assert.equal(JSON.parse(message[0].toString()).type,'ready');assert.equal(hello.audio_params.format,'pcm');
  const body={auth:{device_id:'device-1'},type:'chat',details:{session_id:'linx-1',msg:'你好'}};
  const unauthorized=await app.inject({method:'POST',url:'/integrations/linx/chat/stream',payload:body});assert.equal(unauthorized.statusCode,401);
  const wrongRoom=await app.inject({method:'POST',url:'/integrations/linx/chat/stream',headers:{authorization:'Bearer test-callback'},payload:{...body,details:{...body.details,session_id:'different'}}});assert.equal(wrongRoom.statusCode,403);
  const reply=await app.inject({method:'POST',url:'/integrations/linx/chat/stream',headers:{authorization:'Bearer test-callback'},payload:body});assert.equal(reply.statusCode,200);assert(reply.body.includes('message_end'));assert.equal(invocations,1);
  await new Promise<void>(resolve=>setImmediate(resolve));const speech=upstreamMessages.find((msg)=>msg.type==='listen'&&msg.text_response==='核对已经公开的线索。');assert.deepEqual(speech?.agent_params?.voice,{id:'voice-chen'});assert.equal(speech?.session_id,'linx-1');
  const duplicate=await app.inject({method:'POST',url:'/integrations/linx/chat/stream',headers:{authorization:'Bearer test-callback'},payload:body});assert.equal(duplicate.body,reply.body);assert.equal(invocations,1);
  // A stop/start generation invalidates an already cached callback. Replays of
  // the old Linx event must not return its TTS payload to the device.
  ws.send(JSON.stringify({type:'start'}));ws.send(JSON.stringify({type:'stop'}));
  await new Promise<void>(resolve=>setImmediate(resolve));
  const stale=await app.inject({method:'POST',url:'/integrations/linx/chat/stream',headers:{authorization:'Bearer test-callback'},payload:body});
  assert(stale.body.includes('message_end'));assert(!stale.body.includes('核对已经公开的线索'));assert.equal(invocations,1);
  const second=new WebSocket(`ws://127.0.0.1:${port}/voice/socket?ticket=${ticket}`,{headers:{Origin:`http://127.0.0.1:${port}`}});const close=await once(second,'close');assert.equal(close[0],1008);
 }finally{ws?.close();for(const client of upstream.clients)client.terminate();await app.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});

test('native Linx voice ids use listen text_response and do not require legacy TTS fields',async()=>{
 const upstream=new WebSocketServer({port:0});await once(upstream,'listening');
 const address=upstream.address() as {port:number};
 const config=structuredClone(defaultConfig);config.linx={...config.linx,wsUrl:`ws://127.0.0.1:${address.port}`,wsToken:'test-device-token',deviceId:'device-native',callbackToken:'test-callback'};
 config.roleVoices.chen={provider:'',voiceType:'',voiceId:'native-voice-123'};
 const seen:any[]=[];
 upstream.on('connection',ws=>ws.on('message',(data,binary)=>{if(binary)return;const msg=JSON.parse(data.toString());seen.push(msg);if(msg.type==='hello')ws.send(JSON.stringify({type:'hello',session_id:'linx-native',audio_params:{format:'pcm',sample_rate:16000}}));}));
 const app=Fastify();await registerVoice(app,{config:()=>config,hasSession:id=>id==='game-native',voiceFor:(_id,role)=>config.roleVoices[role],respond:async()=>[{speaker:'chen',text:'原生音色回复。'}]});
 await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as {port:number}).port;
 let ws:WebSocket|undefined;
 try{
  const ticket=(await app.inject({method:'POST',url:'/api/voice/ticket',payload:{sessionId:'game-native'}})).json().ticket;
  ws=new WebSocket(`ws://127.0.0.1:${port}/voice/socket?ticket=${ticket}`,{headers:{Origin:`http://127.0.0.1:${port}`} });
  await once(ws,'message');
  const reply=await app.inject({method:'POST',url:'/integrations/linx/chat/stream',headers:{authorization:'Bearer test-callback'},payload:{auth:{device_id:'device-native'},type:'chat',details:{session_id:'linx-native',msg:'你好',timestamp:1}}});
  assert.equal(reply.statusCode,200);assert(reply.body.includes('message_end'));assert(!reply.body.includes('tts_provider'));
  await new Promise<void>(resolve=>setImmediate(resolve));
  const listen=seen.find(x=>x.type==='listen'&&x.state==='detect');assert.equal(listen.text_response,'原生音色回复。');assert.equal(listen.agent_params.voice.id,'native-voice-123');
 }finally{ws?.close();for(const client of upstream.clients)client.terminate();await app.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});
