import type {FastifyInstance} from 'fastify';
import WebSocket from 'ws';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {Config} from './store.js';
import {catalogVoices,linxRequest} from './linx-api.js';
import {LinxSpeech} from './linx-speech.js';

/** Same authenticated, single-use ticket pattern as game audio. No credentials in URLs. */
export function registerVoicePreviewStream(app:FastifyInstance,config:()=>Config,occupied:Set<string>){
 const tickets=new Map<string,{voiceId:string;text:string;expires:number}>();
 let catalogCache:{key:string;expires:number;ids:Set<string>}|undefined;
 const validate=async(c:Config,voiceId:string)=>{
  if(catalogCache?.key===c.linx.apiKey&&catalogCache.expires>Date.now()&&catalogCache.ids.has(voiceId))return;
  const [catalog,clones]=await Promise.all([linxRequest(c,'/v1/voices'),linxRequest(c,'/v1/voice-clones')]);
  if(!Array.isArray(clones?.voices))throw new Error('无法确认复刻音色状态，请刷新后重试');
  const ids=new Set<string>(catalogVoices(catalog).map(v=>v.id));
  for(const voice of clones.voices){if(voice.state==='Success')ids.add(voice.id);else ids.delete(voice.id);}
  catalogCache={key:c.linx.apiKey,expires:Date.now()+60000,ids};
  if(!ids.has(voiceId))throw new Error('该音色尚不可用，请等待复刻成功或选择默认音色');
 };
 app.post('/api/linx/voices/preview-ticket',async(req,reply)=>{
  const {voiceId,text}=z.object({voiceId:z.string().min(1).max(200),text:z.string().trim().min(1).max(200)}).parse(req.body);
  const c=config();const device=c.linx.inputMode==='stt'?c.linx.speechDeviceId:c.linx.deviceId;
  if(occupied.has(device))return reply.code(409).send({error:'该设备正在语音打本或生成试听，请先结束当前连接'});
  await validate(c,voiceId);
  for(const [id,grant] of tickets)if(grant.expires<=Date.now())tickets.delete(id);
  if(tickets.size>=200)return reply.code(429).send({error:'试听请求过多，请稍后重试'});
  const ticket=randomBytes(32).toString('hex');tickets.set(ticket,{voiceId,text,expires:Date.now()+30000});return {ticket};
 });
 app.get('/voice/preview',{websocket:true},(browser,req)=>{
  let originHost:string|undefined;try{originHost=new URL(req.headers.origin??'').host;}catch{}
  if(!originHost||originHost!==req.headers.host){browser.close(1008,'Origin rejected');return;}
  const ticket=(req.query as {ticket?:string}).ticket;const grant=ticket?tickets.get(ticket):undefined;if(ticket)tickets.delete(ticket);
  if(!grant||grant.expires<=Date.now()){browser.close(1008,'Ticket expired');return;}
  const c=config();const device=c.linx.inputMode==='stt'?c.linx.speechDeviceId:c.linx.deviceId;
  const send=(value:unknown)=>{if(browser.readyState===WebSocket.OPEN)browser.send(JSON.stringify(value));};
  if(occupied.has(device)){send({type:'error',message:'该设备已有语音连接，请先结束原连接'});browser.close();return;}
  occupied.add(device);const speech=new LinxSpeech(c);let released=false;
  const release=()=>{if(!released){released=true;occupied.delete(device);}};
  browser.on('close',()=>{speech.close();release();});
  void speech.speak(grant.voiceId,grant.text,{
   onFormat:sampleRate=>send({type:'format',sampleRate}),
   onPcm:pcm=>{
    if(browser.readyState!==WebSocket.OPEN)throw new Error('试听已取消');
    if(browser.bufferedAmount>1024*1024)throw new Error('试听网络传输过慢，请重试');
    browser.send(pcm,{binary:true});
   },
  }).then(timing=>send({type:'complete',...timing})).catch(error=>send({type:'error',message:(error as Error).message})).finally(()=>{speech.close();release();browser.close();});
 });
}
