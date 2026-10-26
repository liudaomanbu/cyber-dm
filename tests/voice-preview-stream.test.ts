import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import Fastify from 'fastify';
import {defaultConfig} from '../src/server/store.js';
import {registerVoice} from '../src/server/voice.js';

test('authenticated preview tickets stream before stop, cache voice checks and cannot be replayed', {timeout:10000},async()=>{
 const upstream=new WebSocketServer({port:0});await once(upstream,'listening');
 const config=structuredClone(defaultConfig);Object.assign(config.linx,{apiKey:'test',deviceId:'preview-device',wsToken:'token',wsUrl:`ws://127.0.0.1:${(upstream.address() as any).port}`});
 let finish:()=>void=()=>{};const expected=Buffer.from([1,0,2,0]);
 upstream.on('connection',ws=>ws.on('message',raw=>{
  const m=JSON.parse(raw.toString());if(m.type==='hello')ws.send(JSON.stringify({type:'hello',session_id:'preview',audio_params:{format:'pcm',sample_rate:16000}}));
  else{assert.equal(m.text_response,'指定台词');assert.equal(m.agent_params.voice.id,'clone-ready');ws.send(JSON.stringify({type:'tts',state:'start'}));ws.send(expected);finish=()=>ws.send(JSON.stringify({type:'tts',state:'stop'}));}
 }));
 const original=globalThis.fetch;let queries=0;
 globalThis.fetch=(async input=>{queries++;return Response.json({code:0,data:String(input).endsWith('/voice-clones')?{voices:[{id:'clone-ready',state:'Success'}]}:{voices:[]}});}) as typeof fetch;
 const app=Fastify();await registerVoice(app,{config:()=>config,hasSession:()=>false,respond:async()=>[],voiceFor:()=>({})});await app.listen({host:'127.0.0.1',port:0});
 const port=(app.server.address() as {port:number}).port;const endpoint=`ws://127.0.0.1:${port}/voice/preview`;const headers={Origin:`http://127.0.0.1:${port}`};
 let ws:WebSocket|undefined;
 try{
  const ticket=await app.inject({method:'POST',url:'/api/linx/voices/preview-ticket',payload:{voiceId:'clone-ready',text:'指定台词'}});assert.equal(ticket.statusCode,200);assert.equal(queries,2);
  const next=await app.inject({method:'POST',url:'/api/linx/voices/preview-ticket',payload:{voiceId:'clone-ready',text:'指定台词'}});assert.equal(next.statusCode,200);assert.equal(queries,2,'warm preview must not repeat catalog calls');
  const messages:any[]=[];let first!:()=>void;const audioArrived=new Promise<void>(r=>{first=r;});
  ws=new WebSocket(`${endpoint}?ticket=${ticket.json().ticket}`,{headers});
  ws.on('message',(data,binary)=>{if(binary){assert.deepEqual(Buffer.from(data as Buffer),expected);first();}else messages.push(JSON.parse(data.toString()));});
  await audioArrived;assert(messages.some(m=>m.type==='format'));assert(!messages.some(m=>m.type==='complete'),'must be audible before upstream completion');
  const conflict=await app.inject({method:'POST',url:'/api/linx/voices/preview-ticket',payload:{voiceId:'clone-ready',text:'指定台词'}});assert.equal(conflict.statusCode,409);
  const closed=once(ws,'close');finish();await closed;assert(messages.some(m=>m.type==='complete'&&m.pcmBytes===4));
  const replay=new WebSocket(`${endpoint}?ticket=${ticket.json().ticket}`,{headers});assert.equal((await once(replay,'close'))[0],1008);
  const wrongOrigin=new WebSocket(`${endpoint}?ticket=${next.json().ticket}`,{headers:{Origin:'https://another.example'}});assert.equal((await once(wrongOrigin,'close'))[0],1008);
 }finally{globalThis.fetch=original;ws?.terminate();for(const c of upstream.clients)c.terminate();await app.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});
