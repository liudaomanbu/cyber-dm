import WebSocket from 'ws';
import OpusScript from 'opusscript';
import type {Config} from './store.js';
export type SpeechSink={onFormat:(sampleRate:number)=>void;onPcm:(pcm:Buffer)=>void};
export type SpeechTiming={firstAudioMs:number;totalMs:number;pcmBytes:number};
type Job={sink:SpeechSink;requested:boolean;playing:boolean;bytes:number;started:number;firstAudioMs?:number;resolve:(timing:SpeechTiming)=>void;reject:(e:Error)=>void;cleanup:()=>void};

/** One output device, serial utterances. Reuse only cleanly completed connections;
 * cancellation/error destroys the transport so old audio cannot enter a new turn. */
export class LinxSpeech {
 private ws?:WebSocket;private decoder:any;private sampleRate=16000;private format='pcm';private sid='';
 private connecting?:Promise<void>;private rejectConnect?: (e:Error)=>void;private job?:Job;
 private idle?:ReturnType<typeof setTimeout>;
 constructor(private config:Config){}
 private reset(){
  clearTimeout(this.idle);this.idle=undefined;
  const ws=this.ws;this.ws=undefined;this.sid='';this.connecting=undefined;
  const reject=this.rejectConnect;this.rejectConnect=undefined;reject?.(new Error('语音连接已关闭'));
  ws?.terminate();this.decoder?.delete();this.decoder=undefined;
 }
 close(){this.fail(new Error('语音合成已取消'));}
 private fail(error:Error){
  const job=this.job;this.job=undefined;job?.cleanup();this.reset();job?.reject(error);
 }
 private connect():Promise<void>{
  if(this.ws?.readyState===WebSocket.OPEN&&this.sid)return Promise.resolve();
  if(this.connecting)return this.connecting;
  const base=this.config.linx;
  const c=base.inputMode==='stt'?{...base,deviceId:base.speechDeviceId,wsToken:base.speechWsToken,clientId:base.speechClientId||base.clientId,wsUrl:base.speechWsUrl||base.wsUrl}:base;
  if(!c.deviceId||!c.wsToken)return Promise.reject(new Error('请先配置灵矽播报设备和连接 Token'));
  const ws=new WebSocket(c.wsUrl,{headers:{Authorization:`Bearer ${c.wsToken}`,'Device-Id':c.deviceId,'Client-Id':c.clientId,'Protocol-Version':'1',...(c.agentId?{'X-Agent-ID':c.agentId}:{})},handshakeTimeout:10000,maxPayload:1024*1024});
  this.ws=ws;
  this.connecting=new Promise<void>((resolve,reject)=>{
   this.rejectConnect=reject;
   ws.on('open',()=>{if(this.ws===ws)ws.send(JSON.stringify({type:'hello',version:1,transport:'websocket',audio_params:{format:'pcm',sample_rate:16000,channels:1,bit_depth:16,frame_duration:20}}));});
   ws.on('error',()=>{if(this.ws===ws)this.fail(new Error('灵矽语音连接失败，请检查设备绑定和连接 Token'));});
   ws.on('close',()=>{if(this.ws===ws)this.fail(new Error('灵矽语音连接提前断开'));});
   ws.on('message',(data,binary)=>{
    if(this.ws!==ws)return;
    try{
     if(binary){
      const job=this.job;if(!job?.playing)return;
      const pcm=this.format==='opus'?Buffer.from(this.decoder.decode(Buffer.from(data as Buffer))):Buffer.from(data as Buffer);
      if(pcm.length%2)throw new Error('灵矽音频格式无效');
      if(!pcm.length)return;
      job.bytes+=pcm.length;if(job.bytes>8*1024*1024)throw new Error('音频过长，请缩短输入文字');
      job.firstAudioMs??=Math.round(performance.now()-job.started);
      job.sink.onPcm(pcm);return;
     }
     const msg=JSON.parse(data.toString());
     if(msg.type==='hello'&&!this.sid){
      if(!msg.session_id)throw new Error('灵矽未返回语音会话 ID');
      this.sampleRate=msg.audio_params?.sample_rate??24000;this.format=msg.audio_params?.format??'opus';
      if(![8000,12000,16000,24000,48000].includes(this.sampleRate)||!['pcm','opus'].includes(this.format)||(msg.audio_params?.channels??1)!==1)throw new Error('灵矽返回不支持的音频格式');
      if(this.format==='opus')this.decoder=new OpusScript(this.sampleRate as ConstructorParameters<typeof OpusScript>[0],1,OpusScript.Application.AUDIO);
      this.sid=msg.session_id;this.rejectConnect=undefined;resolve();
     }else if(msg.type==='tts'&&this.job?.requested){
      const job=this.job;
      if(msg.state==='start')job.playing=true;
      if(msg.state==='stop'){
       if(msg.is_aborted)throw new Error('语音合成被中断，请重试');
       if(!job.playing||!job.bytes)throw new Error('灵矽未返回音频，请检查音色状态');
       this.job=undefined;job.cleanup();
       this.idle=setTimeout(()=>this.reset(),45000);this.idle.unref?.();
       job.resolve({firstAudioMs:job.firstAudioMs!,totalMs:Math.round(performance.now()-job.started),pcmBytes:job.bytes});
      }
     }else if(msg.type==='error')throw new Error('灵矽拒绝了语音请求，请检查音色与设备配置');
    }catch(error){this.fail(error as Error);}
   });
  });
  return this.connecting;
 }
 async prepare():Promise<void>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([this.connect(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{this.close();reject(new Error('灵矽播报连接准备超时'));},15000);})]);}
  finally{clearTimeout(timer);}
 }
 async speak(voiceId:string,text:string,sink:SpeechSink,signal?:AbortSignal):Promise<SpeechTiming>{
  if(signal?.aborted)throw new Error('语音合成已取消');
  if(this.job)throw new Error('播报设备仍在处理上一条台词');
  clearTimeout(this.idle);this.idle=undefined;
  return new Promise<SpeechTiming>((resolve,reject)=>{
   const abort=()=>this.fail(new Error('语音合成已取消'));
   const timer=setTimeout(()=>this.fail(new Error('灵矽语音合成超过 45 秒，请稍后重试')),45000);
   const job:Job={sink,requested:false,playing:false,bytes:0,started:performance.now(),resolve,reject,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
   this.job=job;signal?.addEventListener('abort',abort,{once:true});
   void Promise.resolve().then(()=>this.connect()).then(()=>{
    if(this.job!==job)return;
    sink.onFormat(this.sampleRate);job.requested=true;
    this.ws!.send(JSON.stringify({type:'listen',session_id:this.sid,state:'detect',text:'音色试听',text_response:text,agent_params:{voice:{id:voiceId}}}));
   }).catch(error=>{if(this.job===job)this.fail(error as Error);});
  });
 }
}
