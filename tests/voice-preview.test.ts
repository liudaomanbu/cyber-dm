import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import Fastify from 'fastify';
import {defaultConfig} from '../src/server/store.js';
import {registerVoice} from '../src/server/voice.js';
import {synthesizePreview} from '../src/server/voice-preview.js';

test('custom text preview uses requested voice and exact text, returns WAV and locks the device',async()=>{
 const server=new WebSocketServer({port:0});await once(server,'listening');
 const config=structuredClone(defaultConfig);Object.assign(config.linx,{apiKey:'test',deviceId:'device-preview',wsToken:'token',wsUrl:`ws://127.0.0.1:${(server.address() as any).port}`});
 let release:()=>void=()=>{};let signal:()=>void=()=>{};const listening=new Promise<void>(r=>{signal=r;});
 server.on('connection',ws=>ws.on('message',data=>{const m=JSON.parse(data.toString());if(m.type==='hello')ws.send(JSON.stringify({type:'hello',session_id:'preview',audio_params:{format:'pcm',sample_rate:16000,channels:1}}));else{
  assert.equal(m.text_response,'验证这句文字。');assert.equal(m.agent_params.voice.id,'clone-ok');assert.equal(m.text,'音色试听');
  release=()=>{ws.send(JSON.stringify({type:'tts',state:'start'}));ws.send(Buffer.from([1,0,2,0]));ws.send(JSON.stringify({type:'tts',state:'stop'}));};signal();
 }}));
 const original=globalThis.fetch;globalThis.fetch=(async input=>Response.json({code:0,data:String(input).endsWith('/voice-clones')?{voices:[{id:'clone-ok',state:'Success'},{id:'clone-init',state:'Init'}]}:{voices:[]}})) as typeof fetch;
 const app=Fastify();await registerVoice(app,{config:()=>config,hasSession:()=>false,respond:async()=>[],voiceFor:()=>({})});
 try{
  const blocked=await app.inject({method:'POST',url:'/api/linx/voices/preview',payload:{voiceId:'clone-init',text:'测试'}});assert.match(blocked.body,/尚不可用/);
  const pending=app.inject({method:'POST',url:'/api/linx/voices/preview',payload:{voiceId:'clone-ok',text:'验证这句文字。'}});const task=pending.then(r=>r);await listening;
  const conflict=await app.inject({method:'POST',url:'/api/linx/voices/preview',payload:{voiceId:'clone-ok',text:'冲突'}});assert.equal(conflict.statusCode,409);
  release();const response=await task;assert.equal(response.statusCode,200);const wav=Buffer.from(response.json().audio,'base64');assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);assert.deepEqual(wav.subarray(44),Buffer.from([1,0,2,0]));
 }finally{globalThis.fetch=original;await app.close();for(const c of server.clients)c.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});

test('preview rejects interrupted synthesis instead of presenting it as success',async()=>{
 const server=new WebSocketServer({port:0});await once(server,'listening');const config=structuredClone(defaultConfig);Object.assign(config.linx,{deviceId:'device',wsToken:'token',wsUrl:`ws://127.0.0.1:${(server.address() as any).port}`});
 server.on('connection',ws=>ws.on('message',d=>{const m=JSON.parse(d.toString());if(m.type==='hello')ws.send(JSON.stringify({type:'hello',session_id:'p',audio_params:{format:'pcm',sample_rate:16000}}));else{ws.send(JSON.stringify({type:'tts',state:'start'}));ws.send(Buffer.from([0,0]));ws.send(JSON.stringify({type:'tts',state:'stop',is_aborted:true}));}}));
 try{await assert.rejects(synthesizePreview(config,'v','测试'),/中断/);}finally{for(const c of server.clients)c.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});
