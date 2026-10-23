import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { randomBytes,timingSafeEqual,createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Config } from './store.js';
const require=createRequire(import.meta.url);
const OpusScript=require('opusscript');
export type VoiceReply={speaker:string;text:string};
export async function registerVoice(app:FastifyInstance,options:{config:()=>Config;hasSession:(id:string)=>boolean;respond:(id:string,text:string,isCurrent:()=>boolean,target?:string)=>Promise<VoiceReply[]>;voiceFor:(id:string,role:string)=>{provider:string;voiceType:string}}){
 const tickets=new Map<string,{sessionId:string;expires:number}>();
 type CallbackEntry={link:VoiceLink;generation:number;promise:Promise<string>};
 type VoiceLink={sessionId:string;deviceId:string;socket:WebSocket;generation:number;active:boolean;approvedAudio:boolean;target?:string};
 const callbackCache=new Map<string,CallbackEntry>();
 const links=new Map<string,VoiceLink>();
 app.post('/api/voice/ticket',async(req)=>{
  const id=(req.body as any)?.sessionId;if(typeof id!=='string'||!options.hasSession(id))throw new Error('房间不存在');
  const c=options.config().linx;if(!c.deviceId||!c.wsToken||!c.callbackToken)throw new Error('请先配置灵矽设备 ID、连接 Token 和业务回调 Token');
  for(const [k,v]of tickets)if(v.expires<=Date.now())tickets.delete(k);
  const ticket=randomBytes(32).toString('hex');tickets.set(ticket,{sessionId:id,expires:Date.now()+30000});return {ticket};
 });
 await app.register(websocket,{options:{maxPayload:256*1024}});
 app.get('/voice/socket',{websocket:true},(browser,req)=>{
  const origin=req.headers.origin;
  let originHost:string|undefined;
  try{originHost=origin?new URL(origin).host:undefined;}catch{originHost=undefined;}
  if(!originHost||originHost!==req.headers.host){browser.close(1008,'Origin rejected');return;}
  const ticket=(req.query as any).ticket;const grant=tickets.get(ticket);tickets.delete(ticket);
  if(!grant||grant.expires<=Date.now()){browser.close(1008,'Ticket expired');return;}
  const c=options.config().linx;
  const send=(data:unknown)=>{if(browser.readyState===WebSocket.OPEN)browser.send(JSON.stringify(data));};
  if([...links.values()].some(x=>x.deviceId===c.deviceId)){send({type:'error',message:'该灵矽设备已有语音连接，请先断开原连接'});browser.close();return;}
  let upstream:WebSocket;let sid='';let decoder:any;let outputRate=24000;let outputFormat='opus';let ready=false;
  try{upstream=new WebSocket(c.wsUrl,{headers:{Authorization:`Bearer ${c.wsToken}`,'Device-Id':c.deviceId,'Client-Id':c.clientId,'Protocol-Version':'1',...(c.agentId?{'X-Agent-ID':c.agentId}:{})},handshakeTimeout:10000,maxPayload:1024*1024});}
  catch{send({type:'error',message:'灵矽连接配置无效'});browser.close();return;}
  const timeout=setTimeout(()=>{if(!ready){send({type:'error',message:'灵矽握手超时'});upstream.close();browser.close();}},15000);
  upstream.on('open',()=>upstream.send(JSON.stringify({type:'hello',version:1,transport:'websocket',audio_params:{format:'pcm',sample_rate:16000,channels:1,bit_depth:16,endianness:'little',frame_duration:20,frame_size:320,sample_format:'signed_int16',play_buffer_duration:200}})));
  upstream.on('message',(data,isBinary)=>{
   try{
    if(isBinary){
     if(!ready||!links.get(sid)?.approvedAudio)return;const pcm=outputFormat==='opus'?decoder.decode(Buffer.from(data as Buffer)):Buffer.from(data as Buffer);
     if(browser.readyState===WebSocket.OPEN)browser.send(pcm,{binary:true});return;
    }
    const msg=JSON.parse(data.toString());
    if(msg.type==='hello'){
     if(typeof msg.session_id!=='string'||!msg.session_id)throw new Error('灵矽未提供会话 ID，无法安全绑定房间');
     sid=msg.session_id;outputRate=msg.audio_params?.sample_rate??24000;outputFormat=msg.audio_params?.format??'opus';
     if(![8000,12000,16000,24000,48000].includes(outputRate)||!['pcm','opus'].includes(outputFormat))throw new Error('灵矽返回不支持的音频格式');
     if(outputFormat==='opus')decoder=new OpusScript(outputRate,1,OpusScript.Application.AUDIO);
     ready=true;clearTimeout(timeout);links.set(sid,{sessionId:grant.sessionId,deviceId:c.deviceId,socket:browser,generation:0,active:false,approvedAudio:false});send({type:'ready',sampleRate:outputRate});
    }else if(msg.type==='stt')send({type:'transcript',text:msg.text});
    else if(msg.type==='tts'){if(links.get(sid)?.approvedAudio)send({type:'tts',state:msg.state,isAborted:msg.is_aborted});}
   }catch(e){send({type:'error',message:(e as Error).message});upstream.close();browser.close();}
  });
  browser.on('message',(data,isBinary)=>{
   if(!ready||upstream.readyState!==WebSocket.OPEN)return;
   try{
    const link=links.get(sid);if(!link)return;
    if(isBinary){const bytes=Array.isArray(data)?Buffer.concat(data):Buffer.from(data as ArrayBuffer);if(link.active&&bytes.byteLength<=12800)upstream.send(bytes,{binary:true});return;}
    const msg=JSON.parse(data.toString());
     if(msg.type==='start'){
     if(msg.target!==undefined&&(typeof msg.target!=='string'||!msg.target.length||msg.target.length>64))throw new Error('无效的私聊对象');
     link.target=msg.target;link.generation++;link.active=true;link.approvedAudio=false;
     upstream.send(JSON.stringify({type:'abort',session_id:sid,reason:'wake_word_detected'}));
     upstream.send(JSON.stringify({type:'listen',session_id:sid,state:'start',mode:'manual'}));
    }else if(msg.type==='stop'){
     // A stop invalidates every in-flight callback and any TTS frames already queued upstream.
     link.generation++;link.active=false;link.approvedAudio=false;link.target=undefined;
     upstream.send(JSON.stringify({type:'abort',session_id:sid,reason:'user_stop'}));
     upstream.send(JSON.stringify({type:'listen',session_id:sid,state:'stop',mode:'manual'}));
    }
    else if(msg.type==='abort'){link.generation++;link.active=false;link.approvedAudio=false;upstream.send(JSON.stringify({type:'abort',session_id:sid,reason:'wake_word_detected'}));send({type:'tts',state:'stop',isAborted:true});}
   }catch{send({type:'error',message:'音频控制消息无效'});}
  });
  upstream.on('error',()=>send({type:'error',message:'灵矽连接失败，请检查设备绑定和连接 Token'}));
  upstream.on('close',()=>{send({type:'disconnected'});browser.close();});
  browser.on('close',()=>{clearTimeout(timeout);if(sid)links.delete(sid);upstream.close();decoder?.delete();});
 });
 app.post('/integrations/linx/chat/stream',async(req,reply)=>{
  const expected=options.config().linx.callbackToken;const supplied=(req.headers.authorization??'').replace(/^Bearer /,'');
  if(!expected||Buffer.byteLength(expected)!==Buffer.byteLength(supplied)||!timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)))return reply.code(401).send({error:'Unauthorized'});
  const body=req.body as any;const details=body?.details;const sid=details?.session_id;const link=links.get(sid);
  if(!link||body?.auth?.device_id!==link.deviceId)return reply.code(403).send({error:'Unbound voice session'});
  if(body.type!=='chat')return reply.type('text/event-stream').send(`data: ${JSON.stringify({event:'message_end',session_id:sid})}\n\n`);
  const msg=details?.msg;if(typeof msg!=='string'||!msg.trim()||msg.length>4000)return reply.code(400).send({error:'Invalid utterance'});
  const generation=link.generation;const target=link.target;
  // Timestamp and text identify a Linx event. Keep generation in the cache entry
  // so a replay after start/stop can never resurrect an older TTS response.
  const cacheKey=createHash('sha256').update(JSON.stringify([sid,target,details.timestamp??null,msg])).digest('hex');
  const existing=callbackCache.get(cacheKey);
  if(existing){
   if(existing.link!==link||existing.generation!==generation){
    const end=`data: ${JSON.stringify({event:'message_end',session_id:sid})}\n\n`;
    return reply.header('Cache-Control','no-cache').type('text/event-stream').send(end);
   }
   return reply.header('Cache-Control','no-cache').type('text/event-stream').send(await existing.promise);
  }
  const isCurrent=()=>links.get(sid)===link&&generation===link.generation;
  const job=(async()=>{
   let responses:VoiceReply[];
   try{responses=await options.respond(link.sessionId,msg,isCurrent,target);}
   catch(e){if(link.socket.readyState===WebSocket.OPEN)link.socket.send(JSON.stringify({type:'error',message:(e as Error).message}));responses=[];}
   if(!isCurrent())responses=[];
   const chunks=responses.map(r=>{
    const voice=options.voiceFor(link.sessionId,r.speaker);
    if(!voice?.provider||!voice.voiceType)throw new Error(`角色 ${r.speaker} 尚未配置灵矽音色`);
    return `data: ${JSON.stringify({event:'message',type:'chat',session_id:sid,details:{answer:r.text,tts_provider:voice.provider,voice_type:voice.voiceType,speed_ratio:1,pitch_ratio:1}})}\n\n`;
   });
   if(isCurrent())link.approvedAudio=responses.length>0;
   if(link.socket.readyState===WebSocket.OPEN)link.socket.send(JSON.stringify({type:'session_updated'}));
   chunks.push(`data: ${JSON.stringify({event:'message_end',session_id:sid})}\n\n`);
   return chunks.join('');
  })();
  callbackCache.set(cacheKey,{link,generation,promise:job});
  if(callbackCache.size>500)callbackCache.delete(callbackCache.keys().next().value!);
  try{return reply.header('Cache-Control','no-cache').type('text/event-stream').send(await job);}
  catch(e){callbackCache.delete(cacheKey);throw e;}
 });
}
