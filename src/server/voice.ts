import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { randomBytes,timingSafeEqual,createHash } from 'node:crypto';
import OpusScript from 'opusscript';
import type { Config } from './store.js';
import {z} from 'zod';
import {catalogVoices,linxRequest} from './linx-api.js';
import {bridgeStt} from './voice-stt.js';
import {synthesizePreview} from './voice-preview.js';
import {registerVoicePreviewStream} from './voice-preview-stream.js';
export type VoiceReply={speaker:string;text:string;eventId?:string};
type VoiceBinding={voiceId?:string;provider?:string;voiceType?:string};
export async function registerVoice(app:FastifyInstance,options:{config:()=>Config;hasSession:(id:string)=>boolean;eventsFor?:(id:string)=>VoiceReply[];beginSession?:(id:string,isCurrent:()=>boolean,options?:{readingComplete?:boolean})=>Promise<VoiceReply[]>;privateControl?:(id:string,participants:string[]|null,current:()=>boolean)=>Promise<VoiceReply[]>;respond:(id:string,text:string,isCurrent:()=>boolean,target?:string)=>Promise<VoiceReply[]>;voiceFor:(id:string,role:string)=>VoiceBinding}){
 const tickets=new Map<string,{sessionId:string;expires:number}>();
 type CallbackEntry={link:VoiceLink;generation:number;promise:Promise<string>};
 type SpeechItem={text:string;voiceId:string};
 type VoiceLink={sessionId:string;linxSessionId:string;deviceId:string;socket:WebSocket;upstream:WebSocket;generation:number;active:boolean;approvedAudio:boolean;target?:string;speechQueue:SpeechItem[];speaking:boolean;playedEvents:Set<string>};
 const callbackCache=new Map<string,CallbackEntry>();
 const links=new Map<string,VoiceLink>();
 const occupiedDevices=new Set<string>();
 app.post('/api/linx/voices/preview',async(req,reply)=>{
  const {voiceId,text}=z.object({voiceId:z.string().min(1).max(200),text:z.string().trim().min(1).max(200)}).parse(req.body);
  const config=options.config();const device=config.linx.inputMode==='stt'?config.linx.speechDeviceId:config.linx.deviceId;
  if(occupiedDevices.has(device))return reply.code(409).send({error:'该设备正在语音打本或生成试听，请先结束当前连接'});
  occupiedDevices.add(device);
  try{
   const [catalog,clones]=await Promise.all([linxRequest(config,'/v1/voices'),linxRequest(config,'/v1/voice-clones')]);
   if(!Array.isArray(clones?.voices))throw new Error('无法确认复刻音色状态，请刷新后重试');
   const clone=clones.voices.find((v:any)=>v.id===voiceId);
   if(clone?clone.state!=='Success':!catalogVoices(catalog).some(v=>v.id===voiceId))throw new Error('该音色尚不可用，请等待复刻成功或选择默认音色');
   return {audio:(await synthesizePreview(config,voiceId,text)).toString('base64')};
  }finally{occupiedDevices.delete(device);}
 });
 const pumpSpeech=(link:VoiceLink)=>{
  if(link.speaking||!link.speechQueue.length||link.upstream.readyState!==WebSocket.OPEN)return;
  const item=link.speechQueue.shift();if(!item)return;
  link.speaking=true;link.approvedAudio=true;
  if(link.socket.readyState===WebSocket.OPEN)link.socket.send(JSON.stringify({type:'synthesizing'}));
  link.upstream.send(JSON.stringify({type:'listen',session_id:link.linxSessionId,state:'detect',text_response:item.text,agent_params:{voice:{id:item.voiceId}}}));
 };
 const clearSpeech=(link:VoiceLink)=>{link.speechQueue=[];link.speaking=false;};
 app.post('/api/voice/ticket',async(req)=>{
  const id=(req.body as any)?.sessionId;if(typeof id!=='string'||!options.hasSession(id))throw new Error('房间不存在');
  const c=options.config().linx;if(!c.deviceId||!c.wsToken||!c.callbackToken)throw new Error('请先配置灵矽设备 ID、连接 Token 和业务回调 Token');
  for(const [k,v]of tickets)if(v.expires<=Date.now())tickets.delete(k);
  const ticket=randomBytes(32).toString('hex');tickets.set(ticket,{sessionId:id,expires:Date.now()+30000});return {ticket};
 });
 await app.register(websocket,{options:{maxPayload:256*1024}});
 registerVoicePreviewStream(app,options.config,occupiedDevices);
 app.get('/voice/socket',{websocket:true},(browser,req)=>{
  const origin=req.headers.origin;
  let originHost:string|undefined;
  try{originHost=origin?new URL(origin).host:undefined;}catch{originHost=undefined;}
  if(!originHost||originHost!==req.headers.host){browser.close(1008,'Origin rejected');return;}
  const ticket=(req.query as any).ticket;const grant=tickets.get(ticket);tickets.delete(ticket);
  if(!grant||grant.expires<=Date.now()){browser.close(1008,'Ticket expired');return;}
  const c=options.config().linx;
  const send=(data:unknown)=>{if(browser.readyState===WebSocket.OPEN)browser.send(JSON.stringify(data));};
  if(occupiedDevices.has(c.deviceId)||(c.inputMode==='stt'&&occupiedDevices.has(c.speechDeviceId))){send({type:'error',message:'该灵矽设备已有语音连接或正在试听，请先结束原连接'});browser.close();return;}
  if(c.inputMode==='stt'){
   if(!c.speechDeviceId||!c.speechWsToken||c.speechDeviceId===c.deviceId){send({type:'error',message:'请先完成独立播报设备配置'});browser.close();return;}
   occupiedDevices.add(c.deviceId);occupiedDevices.add(c.speechDeviceId);
   browser.on('close',()=>{occupiedDevices.delete(c.deviceId);occupiedDevices.delete(c.speechDeviceId);});
   bridgeStt(browser,{...options,config:options.config(),sessionId:grant.sessionId});return;
  }
  let upstream:WebSocket;let sid='';let decoder:any;let outputRate=24000;let outputFormat='opus';let ready=false;
  try{upstream=new WebSocket(c.wsUrl,{headers:{Authorization:`Bearer ${c.wsToken}`,'Device-Id':c.deviceId,'Client-Id':c.clientId,'Protocol-Version':'1',...(c.agentId?{'X-Agent-ID':c.agentId}:{})},handshakeTimeout:10000,maxPayload:1024*1024});}
  catch{send({type:'error',message:'灵矽连接配置无效'});browser.close();return;}
  occupiedDevices.add(c.deviceId);
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
     if(outputFormat==='opus')decoder=new OpusScript(outputRate as ConstructorParameters<typeof OpusScript>[0],1,OpusScript.Application.AUDIO);
     ready=true;clearTimeout(timeout);links.set(sid,{sessionId:grant.sessionId,linxSessionId:sid,deviceId:c.deviceId,socket:browser,upstream,generation:0,active:false,approvedAudio:false,speechQueue:[],speaking:false,playedEvents:new Set()});send({type:'ready',sampleRate:outputRate});
    }else if(msg.type==='stt')send({type:'transcript',text:msg.text});
    else if(msg.type==='tts'){
     const link=links.get(sid);
     if(msg.state==='stop'&&link){link.speaking=false;pumpSpeech(link);}
     if(link?.approvedAudio&&!(msg.state==='stop'&&link.speaking))send({type:'tts',state:msg.state,isAborted:msg.is_aborted});
    }
   }catch(e){send({type:'error',message:(e as Error).message});upstream.close();browser.close();}
  });
  browser.on('message',(data,isBinary)=>{
   if(!ready||upstream.readyState!==WebSocket.OPEN)return;
   try{
    const link=links.get(sid);if(!link)return;
    if(isBinary){const bytes=Array.isArray(data)?Buffer.concat(data):Buffer.from(data as ArrayBuffer);if(link.active&&bytes.byteLength<=12800)upstream.send(bytes,{binary:true});return;}
    const msg=JSON.parse(data.toString());
     if(msg.type==='begin_game'){
    if(msg.readingComplete!==undefined&&typeof msg.readingComplete!=='boolean')throw new Error('阅读确认参数无效');
      const generation=link.generation;
      void (async()=>{try{
       const lines=await options.beginSession?.(grant.sessionId,()=>links.get(sid)===link&&generation===link.generation,{readingComplete:msg.readingComplete===true})??[];
       if(links.get(sid)!==link||generation!==link.generation)return;
       for(const line of lines){if(line.eventId&&link.playedEvents.has(line.eventId))continue;const voiceId=options.voiceFor(grant.sessionId,line.speaker).voiceId;if(!voiceId)throw new Error('角色尚未绑定音色 ID');if(line.eventId)link.playedEvents.add(line.eventId);link.speechQueue.push({text:line.text,voiceId});}
       pumpSpeech(link);send({type:'session_updated'});send({type:'game_started',pending:link.speaking||link.speechQueue.length>0});
      }catch(error){send({type:'error',message:(error as Error).message});}})();
     }else if(msg.type==='play_events'){
      if(!Array.isArray(msg.eventIds)||!msg.eventIds.length||msg.eventIds.length>200||msg.eventIds.some((id:unknown)=>typeof id!=='string'||id.length>100)||msg.replay!==undefined&&typeof msg.replay!=='boolean')throw new Error('无效的台词播放请求');
      const visible=new Map((options.eventsFor?.(grant.sessionId)??[]).map(e=>[e.eventId,e]));const ids=[...new Set<string>(msg.eventIds)];
      if(ids.some(id=>!visible.has(id)))throw new Error('台词不存在或无权播放');
      const fresh=ids.filter(id=>msg.replay===true||!link.playedEvents.has(id));
      const speech=fresh.map(id=>{const line=visible.get(id)!;const voiceId=options.voiceFor(grant.sessionId,line.speaker).voiceId;if(!voiceId)throw new Error('角色尚未绑定音色 ID');return {text:line.text,voiceId};});
      if(link.speechQueue.length+speech.length>1000)throw new Error('待播放台词过多');
      fresh.forEach(id=>link.playedEvents.add(id));link.speechQueue.push(...speech);pumpSpeech(link);send({type:'events_synced',pending:link.speaking||link.speechQueue.length>0});
     }else if(msg.type==='start'){
     if(msg.target!==undefined&&(typeof msg.target!=='string'||!msg.target.length||msg.target.length>64))throw new Error('无效的私聊对象');
     link.target=msg.target;link.generation++;link.active=true;link.approvedAudio=false;clearSpeech(link);
     upstream.send(JSON.stringify({type:'abort',session_id:sid,reason:'wake_word_detected'}));
     upstream.send(JSON.stringify({type:'listen',session_id:sid,state:'start',mode:'manual'}));
    }else if(msg.type==='stop'){
     // Finishing capture submits this turn. Preserve its generation and private
     // target until recognition/callback completes; only abort/start cancels it.
     if(!link.active)return;
     link.active=false;
     upstream.send(JSON.stringify({type:'listen',session_id:sid,state:'stop',mode:'manual'}));
    }
    else if(msg.type==='abort'){link.generation++;link.active=false;link.approvedAudio=false;link.target=undefined;clearSpeech(link);upstream.send(JSON.stringify({type:'abort',session_id:sid,reason:'wake_word_detected'}));send({type:'tts',state:'stop',isAborted:true});}
   }catch{send({type:'error',message:'音频控制消息无效'});}
  });
  upstream.on('error',()=>send({type:'error',message:'灵矽连接失败，请检查设备绑定和连接 Token'}));
  upstream.on('close',()=>{send({type:'disconnected'});browser.close();});
  browser.on('close',()=>{occupiedDevices.delete(c.deviceId);clearTimeout(timeout);if(sid)links.delete(sid);upstream.close();decoder?.delete();});
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
   responses=responses.filter(r=>!r.eventId||!link.playedEvents.has(r.eventId));
   const bindings=responses.map(r=>options.voiceFor(link.sessionId,r.speaker));
   const hasDirect=bindings.some(v=>Boolean(v.voiceId));
   if(hasDirect&&bindings.some(v=>!v.voiceId))throw new Error('本轮角色音色配置不完整，不能混用音色协议');
   if(hasDirect){
    if(isCurrent()){
     responses.forEach(r=>{if(r.eventId)link.playedEvents.add(r.eventId);});
     link.approvedAudio=responses.length>0;
     link.speechQueue.push(...responses.map((r,i)=>({text:r.text,voiceId:bindings[i].voiceId!})));
     pumpSpeech(link);
    }
    if(isCurrent()&&link.socket.readyState===WebSocket.OPEN)link.socket.send(JSON.stringify({type:'session_updated'}));
    return `data: ${JSON.stringify({event:'message_end',session_id:sid})}\n\n`;
   }
   const chunks=responses.map((r,i)=>{
    const voice=bindings[i];
    if(!voice?.provider||!voice.voiceType)throw new Error(`角色 ${r.speaker} 尚未配置灵矽音色 ID`);
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
