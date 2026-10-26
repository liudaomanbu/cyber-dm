import {EventEmitter} from 'node:events';
import {AsyncResource} from 'node:async_hooks';
import {Buffer} from 'node:buffer';

type NativeSocket={readyState:number;binaryType?:string;bufferedAmount?:number;accept():void;send(data:string|ArrayBuffer|ArrayBufferView):void;close(code?:number,reason?:string):void;addEventListener(type:string,listener:(event:any)=>void):void};
type SocketOptions={headers?:Record<string,string>;handshakeTimeout?:number;maxPayload?:number};
/** The ws subset used by the voice bridges, backed by Workers' native sockets. */
export default class WorkerWebSocket extends EventEmitter {
 static readonly CONNECTING=0;static readonly OPEN=1;static readonly CLOSING=2;static readonly CLOSED=3;
 private native?:NativeSocket;private state=0;private timer?:ReturnType<typeof setTimeout>;private abort?:AbortController;
 private maxPayload:number;
 get readyState(){return this.state;}
 get bufferedAmount(){return this.native?.bufferedAmount??0;}
 constructor(url?:string|URL,options:SocketOptions={}){
  super();this.maxPayload=options.maxPayload??1024*1024;
  if(url!==undefined)void this.connect(String(url),options);
 }
 static fromNative(socket:NativeSocket,options:SocketOptions={}){
  const result=new WorkerWebSocket(undefined,options);result.attach(socket);return result;
 }
 private attach(socket:NativeSocket){
  this.native=socket;
  // Workers currently defaults to Blob; the bridges expect byte buffers.
  socket.binaryType='arraybuffer';
  let pending:Promise<void>|undefined;
  const deliver=(value:string|ArrayBuffer|ArrayBufferView)=>{
   if(this.state!==WorkerWebSocket.OPEN)return;
   const binary=typeof value!=='string';
   const data=binary?Buffer.from(value as ArrayBuffer):Buffer.from(value as string,'utf8');
   if(data.byteLength>this.maxPayload){this.close(1009,'Message too large');return;}
   this.emit('message',data,binary);
  };
  socket.addEventListener('message',AsyncResource.bind((event:any)=>{
   if(this.state!==WorkerWebSocket.OPEN)return;
   const value=event.data;
   if(value instanceof Blob||pending){
    // Keep following control messages behind an asynchronous Blob conversion.
    const next=(pending??Promise.resolve()).then(async()=>{
     if(this.state!==WorkerWebSocket.OPEN)return;
     if(value instanceof Blob&&value.size>this.maxPayload){this.close(1009,'Message too large');return;}
     deliver(value instanceof Blob?await value.arrayBuffer():value);
    }).catch(()=>{if(this.state!==WorkerWebSocket.CLOSED){this.emit('error',new Error('WebSocket message decoding failed'));this.terminate();}});
    pending=next;void next.then(()=>{if(pending===next)pending=undefined;});
   }else deliver(value);
  }));
  socket.addEventListener('error',AsyncResource.bind(()=>{if(this.state!==WorkerWebSocket.CLOSED){this.emit('error',new Error('WebSocket transport failed'));this.terminate();}}));
  socket.addEventListener('close',AsyncResource.bind((event:any)=>this.finish(event.code??1006,event.reason??'')));
  socket.accept();this.state=WorkerWebSocket.OPEN;
 }
 private async connect(address:string,options:SocketOptions){
  this.abort=new AbortController();
  this.timer=setTimeout(()=>{if(this.state===WorkerWebSocket.CONNECTING){this.emit('error',new Error('WebSocket handshake timed out'));this.terminate();}},options.handshakeTimeout??10000);
  try{
   const url=new URL(address);if(url.protocol!=='wss:'&&url.protocol!=='ws:')throw new Error('Invalid WebSocket protocol');
   url.protocol=url.protocol==='wss:'?'https:':'http:';
   const response=await fetch(url,{headers:{...options.headers,Upgrade:'websocket'},signal:this.abort.signal,redirect:'manual'});
   const socket=(response as Response&{webSocket?:NativeSocket}).webSocket;
   if(!socket)throw new Error('WebSocket upgrade rejected');
   if(this.state!==WorkerWebSocket.CONNECTING){socket.accept();socket.close(1000,'Cancelled');return;}
   clearTimeout(this.timer);this.attach(socket);this.emit('open');
  }catch{
   if(this.state===WorkerWebSocket.CONNECTING){this.emit('error',new Error('WebSocket connection failed'));this.terminate();}
  }
 }
 send(data:string|Buffer|ArrayBuffer|ArrayBufferView,options?:{binary?:boolean},callback?:(error?:Error)=>void){
  if(this.state!==WorkerWebSocket.OPEN){const error=new Error('WebSocket is not open');if(callback){callback(error);return;}throw error;}
  try{this.native!.send(options?.binary===false&&typeof data!=='string'?Buffer.from(data as Uint8Array).toString():data);callback?.();}
  catch(error){if(callback)callback(error as Error);else throw error;}
 }
 close(code=1000,reason=''){
  if(this.state===WorkerWebSocket.CLOSED)return;
  clearTimeout(this.timer);this.abort?.abort();this.state=WorkerWebSocket.CLOSING;
  try{this.native?.close(code,reason);}finally{this.finish(code,reason);}
 }
 terminate(){this.close(1000,'');}
 private finish(code:number,reason:string){
  if(this.state===WorkerWebSocket.CLOSED)return;
  clearTimeout(this.timer);this.state=WorkerWebSocket.CLOSED;this.emit('close',code,Buffer.from(reason));
 }
}
export {WorkerWebSocket as WebSocket};
