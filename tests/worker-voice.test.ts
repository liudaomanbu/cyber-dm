import test from 'node:test';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {bridgeStt} from '../src/server/voice-stt.js';
import {defaultConfig} from '../src/server/store.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import assert from 'node:assert/strict';
import OpusScript from 'opusscript';
import WorkerOpusScript from '../src/worker/opus.js';
import WorkerWebSocket from '../src/worker/socket.js';

class NativeSocket extends EventTarget {
 binaryType='blob';readyState=1;accepted=false;sent:Array<string|ArrayBuffer|ArrayBufferView>=[];closed?:number;
 accept(){this.accepted=true;}
 send(data:string|ArrayBuffer|ArrayBufferView){this.sent.push(data);}
 close(code?:number){this.closed=code;}
 message(data:string|ArrayBuffer|Blob){this.dispatchEvent(new MessageEvent('message',{data}));}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('Workers socket preserves upgrade credentials and ws message semantics',async t=>{
 const native=new NativeSocket();let request:RequestInit|undefined;let address='';
 t.mock.method(globalThis,'fetch',async(url:URL,init:RequestInit)=>{address=String(url);request=init;return {webSocket:native};});
 const socket=new WorkerWebSocket('wss://voice.example/audio',{headers:{Authorization:'Bearer test-only','Device-Id':'device'},maxPayload:8});
 const messages:Array<[Buffer,boolean]>=[];socket.on('message',(data,binary)=>messages.push([data,binary]));
 await new Promise<void>(resolve=>socket.on('open',resolve));
 assert.equal(address,'https://voice.example/audio');assert.equal((request?.headers as any).Authorization,'Bearer test-only');assert.equal((request?.headers as any).Upgrade,'websocket');assert.equal(request?.redirect,'manual');
 native.message('hello');native.message(new Uint8Array([0,255]).buffer);
 assert.deepEqual(messages.map(([data,binary])=>[...data,binary]),[[104,101,108,108,111,false],[0,255,true]]);
 socket.send(Buffer.from([1,2]),{binary:true});assert.deepEqual(native.sent,[Buffer.from([1,2])]);
 native.message('oversized');assert.equal(native.closed,1009);assert.equal(socket.readyState,WorkerWebSocket.CLOSED);
});

test('cancelled upgrade cannot reopen or emit stale audio',async t=>{
 const native=new NativeSocket();let resolve!:(value:unknown)=>void;
 t.mock.method(globalThis,'fetch',()=>new Promise(r=>{resolve=r;}));
 const socket=new WorkerWebSocket('wss://voice.example/audio');let opens=0;let closes=0;
 socket.on('open',()=>opens++);socket.on('close',()=>closes++);socket.terminate();resolve({webSocket:native});await tick();
 assert.equal(opens,0);assert.equal(closes,1);assert.equal(native.accepted,true);assert.equal(native.closed,1000);
});

test('inbound Workers sockets accept and release exactly once',()=>{
 const native=new NativeSocket();const socket=WorkerWebSocket.fromNative(native);let closes=0;
 socket.on('close',()=>closes++);assert.equal(native.accepted,true);assert.equal(socket.readyState,1);
 socket.close();native.dispatchEvent(new Event('close'));assert.equal(closes,1);
});

test('Worker Opus decodes the same audio as Node without runtime code generation',()=>{
 const encoder=new OpusScript(24000,1,OpusScript.Application.AUDIO);
 const reference=new OpusScript(24000,1,OpusScript.Application.AUDIO);
 const pcm=Buffer.alloc(960);for(let i=0;i<480;i++)pcm.writeInt16LE(Math.round(Math.sin(i*0.1)*10000),i*2);
 const packet=encoder.encode(pcm,480);const expected=reference.decode(packet);
 const original=globalThis.Function;
 globalThis.Function=new Proxy(original,{apply(){throw new Error('Runtime code generation forbidden');},construct(){throw new Error('Runtime code generation forbidden');}});
 let decoder:WorkerOpusScript|undefined;
 try{decoder=new WorkerOpusScript(24000);assert.deepEqual(decoder.decode(packet),expected);decoder.delete();decoder.delete();assert.throws(()=>decoder!.decode(packet));}
 finally{globalThis.Function=original;decoder?.delete();encoder.delete();reference.delete();}
});

test('native socket events retain the owning Durable Object storage context',()=>{
 const storage=new AsyncLocalStorage<string>();const native=new NativeSocket();let socket!:WorkerWebSocket;const observed:Array<string|undefined>=[];
 storage.run('room-a',()=>{socket=WorkerWebSocket.fromNative(native);socket.on('message',()=>observed.push(storage.getStore()));socket.on('close',()=>observed.push(storage.getStore()));});
 storage.run('room-b',()=>{native.message('hello');native.dispatchEvent(new Event('close'));});
 assert.deepEqual(observed,['room-a','room-a']);
});

test('STT intentional cancellation tolerates synchronous transport close',async t=>{
 const upstream=new WebSocketServer({port:0});await once(upstream,'listening');
 const native=new NativeSocket();const browser=WorkerWebSocket.fromNative(native);
 const config=structuredClone(defaultConfig);Object.assign(config.linx,{inputMode:'stt',deviceId:'input',wsToken:'test',wsUrl:`ws://127.0.0.1:${(upstream.address() as {port:number}).port}`});
 bridgeStt(browser as unknown as WebSocket,{config,sessionId:'test',respond:async()=>[],voiceFor:()=>({})});
 const original=WebSocket.prototype.terminate;
 t.mock.method(WebSocket.prototype,'terminate',function(this:WebSocket){this.emit('close',1000,Buffer.alloc(0));original.call(this);});
 try{
  const connected=once(upstream,'connection');native.message(JSON.stringify({type:'start'}));await connected;
  native.message(JSON.stringify({type:'abort'}));
  const messages=native.sent.filter((value):value is string=>typeof value==='string').map(value=>JSON.parse(value));
  assert.equal(messages.filter(message=>message.type==='error').length,0);
  assert.equal(messages.filter(message=>message.type==='capture_stopped').length,1);
 }finally{browser.close();t.mock.restoreAll();for(const socket of upstream.clients)socket.terminate();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});

test('native binaryType is set and Blob fallback preserves PCM/control ordering',async()=>{
 const native=new NativeSocket();const socket=WorkerWebSocket.fromNative(native);assert.equal(native.binaryType,'arraybuffer');
 let release!:(data:ArrayBuffer)=>void;class SlowBlob extends Blob {override arrayBuffer(){return new Promise<ArrayBuffer>(resolve=>{release=resolve;});}}
 const messages:Array<[number[],boolean]>=[];socket.on('message',(data:Buffer,binary:boolean)=>messages.push([[...data],binary]));
 native.message(new SlowBlob(['pcm']));native.message('stop');await tick();assert.equal(messages.length,0);
 release(new Uint8Array([1,2]).buffer);await tick();assert.deepEqual(messages,[[[1,2],true],[[115,116,111,112],false]]);socket.close();
});

test('closing during Blob conversion discards pending PCM and controls',async()=>{
 const native=new NativeSocket();const socket=WorkerWebSocket.fromNative(native);let release!:(data:ArrayBuffer)=>void;
 class SlowBlob extends Blob {override arrayBuffer(){return new Promise<ArrayBuffer>(resolve=>{release=resolve;});}}
 let messages=0;socket.on('message',()=>messages++);native.message(new SlowBlob(['pcm']));native.message('stop');await tick();
 socket.close();release(new Uint8Array([1,2]).buffer);await tick();assert.equal(messages,0);
});
