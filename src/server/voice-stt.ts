import WebSocket from 'ws';
import type {Config} from './store.js';
import type {VoiceReply} from './voice.js';
import {LinxSpeech} from './linx-speech.js';

type Options={config:Config;sessionId:string;eventsFor?:(id:string)=>VoiceReply[];beginSession?:(id:string,current:()=>boolean,options?:{readingComplete?:boolean})=>Promise<VoiceReply[]>;privateControl?:(id:string,participants:string[]|null,current:()=>boolean)=>Promise<VoiceReply[]>;respond:(id:string,text:string,current:()=>boolean,target?:string)=>Promise<VoiceReply[]>;voiceFor:(id:string,role:string)=>{voiceId?:string}};
/** Each recording has a fresh upstream identity. Recognition audio is never played;
 * only approved game lines are synthesized on the independent output device. */
export function bridgeStt(browser:WebSocket,options:Options){
 const c=options.config.linx;
 const speech=new LinxSpeech(options.config);
 type Turn={input:WebSocket;controller:AbortController;active:boolean;ready:boolean;sid?:string;claimed:boolean;processing:boolean;target?:string;frames:Buffer[];bytes:number;timer:ReturnType<typeof setTimeout>};
 let turn:Turn|undefined;let beginning=false;let generation=0;
 const send=(data:unknown)=>{if(browser.readyState===WebSocket.OPEN)browser.send(JSON.stringify(data));};
 const seenEvents=new Set<string>();
 let queue:VoiceReply[]=[];let speechAbort=new AbortController();let pumping=false;
 const pump=async()=>{
  if(pumping||!queue.length||turn&&(!turn.claimed||turn.processing))return;
  pumping=true;const controller=speechAbort;
  try{
   while(queue.length&&!controller.signal.aborted&&browser.readyState===WebSocket.OPEN){
    const line=queue.shift()!;
    try{
     const voiceId=options.voiceFor(options.sessionId,line.speaker).voiceId;
     if(!voiceId)throw new Error('角色尚未绑定灵矽音色 ID');
     send({type:'synthesizing',speaker:line.speaker,eventId:line.eventId});
     let started=false;
     await speech.speak(voiceId,line.text,{
      onFormat:sampleRate=>send({type:'audio_format',sampleRate}),
      onPcm:pcm=>{
       if(controller.signal.aborted||browser.readyState!==WebSocket.OPEN)return;
       if(browser.bufferedAmount>1024*1024)throw new Error('音频网络传输过慢，请重播');
       if(!started){started=true;send({type:'tts',state:'start',speaker:line.speaker,eventId:line.eventId});}
       browser.send(pcm,{binary:true});
      },
     },controller.signal);
    }catch(error){if(!controller.signal.aborted)send({type:'error',message:`语音播放失败，可点击台词重播：${(error as Error).message}`});}
   }
   if(!controller.signal.aborted)send({type:'tts',state:'stop'});
  }finally{pumping=false;if(queue.length&&!speechAbort.signal.aborted)void pump();}
 };
 const enqueue=(lines:VoiceReply[],replay=false)=>{
  const fresh=lines.filter(line=>replay||!line.eventId||!seenEvents.has(line.eventId));
  if(queue.length+fresh.length>1000)throw new Error('待播放台词过多，请停止播放后逐条重播');
  for(const line of fresh){if(line.eventId)seenEvents.add(line.eventId);queue.push(line);}
  void pump();
 };
 const cancel=()=>{generation++;speechAbort.abort();speechAbort=new AbortController();queue=[];if(turn){const previous=turn;turn=undefined;clearTimeout(previous.timer);previous.controller.abort();previous.input.terminate();}};
 const fail=(t:Turn,message:string)=>{if(turn!==t)return;cancel();send({type:'error',message});send({type:'capture_stopped'});};
 const finishCapture=(t:Turn)=>{if(t.ready)t.input.send(JSON.stringify({type:'listen',session_id:t.sid,state:'stop',mode:'manual'}));};
 const processTranscript=async(t:Turn,text:string)=>{
  if(turn!==t||t.claimed)return;
  t.claimed=true;t.processing=true;t.active=false;clearTimeout(t.timer);
  // Closing the input socket ensures delayed STT/TTS cannot affect later turns.
  t.input.close();send({type:'capture_stopped'});send({type:'transcript',text});
  const current=()=>turn===t&&!t.controller.signal.aborted&&browser.readyState===WebSocket.OPEN;
  try{
   const responses=await options.respond(options.sessionId,text,current,t.target);
   if(!current())return;
   t.processing=false;enqueue(responses);send({type:'session_updated'});
   if(!pumping&&!queue.length)send({type:'tts',state:'stop'});
  }catch(error){if(current())fail(t,(error as Error).message);}
 };
 browser.on('message',(data,binary)=>{
  try{
   if(binary){
    const t=turn;if(!t||!t.active)return;
    const frame=Buffer.from(data as Buffer);if(frame.length>12800||frame.length%2)throw new Error('无效音频帧');
    if(t.ready)t.input.send(frame,{binary:true});
    else{t.bytes+=frame.length;if(t.bytes>640000)throw new Error('语音连接超时，请重新录音');t.frames.push(frame);}
    return;
   }
   const msg=JSON.parse(data.toString());
   if(msg.type==='begin_game'){
    if(msg.readingComplete!==undefined&&typeof msg.readingComplete!=='boolean')throw new Error('阅读确认参数无效');
    if(beginning)return;beginning=true;const currentGeneration=generation;
    const current=()=>browser.readyState===WebSocket.OPEN&&currentGeneration===generation;
    void (async()=>{try{
     await speech.prepare();if(!current())return;
     const lines=await options.beginSession?.(options.sessionId,current,{readingComplete:msg.readingComplete===true})??[];if(!current())return;
     enqueue(lines);send({type:'session_updated'});send({type:'game_started',pending:pumping||queue.length>0});
    }catch(error){if(current())send({type:'error',message:(error as Error).message});}finally{beginning=false;}})();return;
   }
   if(msg.type==='private_invite'||msg.type==='private_leave'){
    if(beginning)throw new Error('主持人正在处理请求，请稍候');
    if(!options.privateControl)throw new Error('当前语音模式不支持小组私聊');
    const participants=msg.type==='private_leave'?null:msg.participants;
    if(participants!==null&&(!Array.isArray(participants)||participants.length<1||participants.length>11||participants.some((id:unknown)=>typeof id!=='string'||id.length>64)))throw new Error('私聊成员无效');
    cancel();beginning=true;const currentGeneration=generation;const current=()=>browser.readyState===WebSocket.OPEN&&generation===currentGeneration;
    void (async()=>{try{
     const lines=await options.privateControl!(options.sessionId,participants,current);if(!current())return;
     enqueue(lines);send({type:'session_updated'});if(!pumping&&!queue.length)send({type:'tts',state:'stop'});
    }catch(error){if(current())send({type:'error',message:(error as Error).message});}finally{beginning=false;}})();return;
   }
   if(msg.type==='play_events'){
    if(!Array.isArray(msg.eventIds)||!msg.eventIds.length||msg.eventIds.length>200||msg.eventIds.some((id:unknown)=>typeof id!=='string'||id.length>100)||msg.replay!==undefined&&typeof msg.replay!=='boolean')throw new Error('无效的台词播放请求');
    const visible=new Map((options.eventsFor?.(options.sessionId)??[]).map(e=>[e.eventId,e]));
    const ids=[...new Set<string>(msg.eventIds)];
    if(ids.some(id=>!visible.has(id)))throw new Error('台词不存在或无权播放');
    enqueue(ids.map(id=>visible.get(id)!),msg.replay===true);send({type:'events_synced',pending:pumping||queue.length>0||Boolean(turn&&(!turn.claimed||turn.processing))});return;
   }
   if(msg.type==='abort'){cancel();send({type:'capture_stopped'});send({type:'tts',state:'stop',isAborted:true});return;}
   if(msg.type==='stop'){if(turn?.active){turn.active=false;finishCapture(turn);}return;}
   if(msg.type!=='start')return;
   if(beginning)throw new Error('主持人正在准备开场，请稍候');
   if(msg.target!==undefined&&(typeof msg.target!=='string'||!msg.target.length||msg.target.length>64))throw new Error('无效的私聊对象');
   cancel();
   const input=new WebSocket(c.wsUrl,{headers:{Authorization:`Bearer ${c.wsToken}`,'Device-Id':c.deviceId,'Client-Id':c.clientId,'Protocol-Version':'1',...(c.agentId?{'X-Agent-ID':c.agentId}:{})},handshakeTimeout:10000,maxPayload:1024*1024});
   const t:Turn={input,controller:new AbortController(),active:true,ready:false,claimed:false,processing:false,target:msg.target,frames:[],bytes:0,timer:setTimeout(()=>fail(t,'本轮录音识别超时，请重试'),120000)};turn=t;
   input.on('error',()=>fail(t,'灵矽识别连接失败，请检查设备凭据'));
   input.on('close',()=>{if(turn===t&&!t.claimed)fail(t,'灵矽识别连接断开，请重新录音');});
   input.on('open',()=>{if(turn!==t)return;input.send(JSON.stringify({type:'hello',version:1,transport:'websocket',audio_params:{format:'pcm',sample_rate:16000,channels:1,bit_depth:16,frame_duration:20}}));});
   input.on('message',(raw,isBinary)=>{
    if(turn!==t||t.claimed||isBinary)return; // Never forward recognition-device audio.
    try{
     const event=JSON.parse(raw.toString());
     if(event.type==='hello'&&!t.ready){
      if(!event.session_id)throw new Error('灵矽未返回识别会话 ID');
      t.ready=true;t.sid=event.session_id;input.send(JSON.stringify({type:'listen',session_id:event.session_id,state:'start',mode:'manual'}));
      for(const frame of t.frames)input.send(frame,{binary:true});t.frames=[];t.bytes=0;
      if(!t.active)finishCapture(t);
     }else if(event.type==='stt'&&t.ready){
      if(event.session_id&&event.session_id!==t.sid)return;
      if(typeof event.text!=='string'||!event.text.trim()||event.text.length>4000)throw new Error('未识别到有效发言，请重试');
      void processTranscript(t,event.text);
     }else if(event.type==='error')throw new Error('灵矽识别服务返回错误，请重试');
    }catch(error){fail(t,(error as Error).message);}
   });
  }catch(error){cancel();send({type:'capture_stopped'});send({type:'error',message:(error as Error).message});}
 });
 browser.on('close',()=>{cancel();speech.close();});
 send({type:'ready',sampleRate:16000});
}
