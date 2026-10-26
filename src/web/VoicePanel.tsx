import React,{forwardRef,useCallback,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {SpeechEndpoint} from './speech-endpoint';

type Props={sessionId:string;started:boolean;finished:boolean;preparing?:boolean;eventIds:string[];roles:{id:string;name:string}[];onConnection?:(connected:boolean)=>void;privateRoom?:{id:string;participants:string[];expiresAt:string|number};api:(path:string,options?:RequestInit)=>Promise<any>;onUpdate:()=>void;onError:(s:string)=>void};
export type VoicePanelHandle={playEvent:(id:string)=>void;invitePrivate:(participants:string[])=>void;leavePrivate:()=>void};
type AudioContextCtor = new () => AudioContext;
declare global { interface Window { webkitAudioContext?: AudioContextCtor } }
const contextConstructor=():AudioContextCtor|undefined=>window.AudioContext??window.webkitAudioContext;

export const VoicePanel=forwardRef<VoicePanelHandle,Props>(function VoicePanel(props,ref){
 const {sessionId,eventIds,api,onError}=props;
 const latest=useRef(props);latest.current=props;
 const [status,setStatus]=useState('未连接语音');
 const [ready,setReady]=useState(false);
 const [recording,setRecording]=useState(false);
 const [automatic,setAutomatic]=useState(true);
 const [inputLevel,setInputLevel]=useState(0);
 const [transcript,setTranscript]=useState('');
 const [responding,setResponding]=useState(false);const [interactionPaused,setInteractionPaused]=useState(false);
 const processing=useRef(false);const awaitingReply=useRef(false);const readingConfirmed=useRef(false);
 const setReplyPending=(value:boolean)=>{awaitingReply.current=value;setResponding(value);};
 const socket=useRef<WebSocket|null>(null);
 const audio=useRef<AudioContext|null>(null);
 const stream=useRef<MediaStream|null>(null);
 const node=useRef<AudioWorkletNode|null>(null);
 const sources=useRef<AudioBufferSourceNode[]>([]);
 const playAt=useRef(0);const rate=useRef(24000);
 const gameReady=useRef(props.started);const beginning=useRef(false);
 const [startingGame,setStartingGame]=useState(false);
 const rec=useRef(false);const connecting=useRef(false);const connected=useRef(false);
 const auto=useRef(true);const paused=useRef(false);const waiting=useRef(false);
 const requested=useRef(new Set<string>());const endpoint=useRef(new SpeechEndpoint());
 const captureEpoch=useRef(0);
 const expiredRooms=useRef(new Set<string>());
 const autoTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const wasConnected=useRef(false);const mounted=useRef(true);const connectionEpoch=useRef(0);
 const clearAuto=()=>{clearTimeout(autoTimer.current);autoTimer.current=undefined;};
 const stopPlayback=useCallback(()=>{
  for(const source of sources.current){try{source.stop();}catch{}}
  sources.current=[];playAt.current=0;
 },[]);
 const disconnect=useCallback((message='语音已断开')=>{
  connectionEpoch.current++;captureEpoch.current++;clearAuto();rec.current=false;connecting.current=false;connected.current=false;waiting.current=false;beginning.current=false;processing.current=false;awaitingReply.current=false;
  socket.current?.close();socket.current=null;
  stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;
  node.current?.disconnect();node.current=null;stopPlayback();
  const ctx=audio.current;audio.current=null;if(ctx)void ctx.close().catch(()=>{});
  latest.current.onConnection?.(false);
  if(mounted.current){setReady(false);setResponding(false);setInteractionPaused(false);setStartingGame(false);setRecording(false);setInputLevel(0);setStatus(message);}
 },[stopPlayback]);
 const startCapture=async()=>{
  clearAuto();if(processing.current||awaitingReply.current||waiting.current||latest.current.preparing||latest.current.finished||!gameReady.current||beginning.current||!connected.current||socket.current?.readyState!==WebSocket.OPEN)return;
  const ws=socket.current;const epoch=++captureEpoch.current;await audio.current?.resume();if(processing.current||awaitingReply.current||waiting.current||epoch!==captureEpoch.current||socket.current!==ws||!connected.current||latest.current.preparing||latest.current.finished||!gameReady.current||beginning.current)return;
  stopPlayback();waiting.current=false;paused.current=false;setInteractionPaused(false);endpoint.current.reset(performance.now());
  ws.send(JSON.stringify({type:'start'}));
  rec.current=true;setRecording(true);setStatus(auto.current?'正在听，停顿后自动发送':'正在听，点击结束');
 };
 const scheduleListening=()=>{
  clearAuto();
  if(processing.current||awaitingReply.current||latest.current.preparing||latest.current.finished||!gameReady.current||beginning.current||!auto.current||paused.current||waiting.current||rec.current||sources.current.length||!connected.current)return;
  autoTimer.current=setTimeout(()=>{
   if(!processing.current&&!awaitingReply.current&&!latest.current.preparing&&!latest.current.finished&&gameReady.current&&!beginning.current&&auto.current&&!paused.current&&!waiting.current&&!rec.current&&!sources.current.length&&connected.current)void startCapture().catch(e=>{paused.current=true;onError((e as Error).message);});
  },400);
 };
 const stopCapture=()=>{
  if(!rec.current||socket.current?.readyState!==WebSocket.OPEN)return;
  rec.current=false;processing.current=true;waiting.current=true;setReplyPending(true);socket.current.send(JSON.stringify({type:'stop'}));setRecording(false);setStatus('正在识别');
 };
 const pause=()=>{
  captureEpoch.current++;
  if(beginning.current){disconnect('开场准备已取消，请重新连接');return;}
  clearAuto();paused.current=true;setInteractionPaused(true);processing.current=false;setReplyPending(false);waiting.current=false;rec.current=false;setRecording(false);setInputLevel(0);stopPlayback();
  if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({type:'abort'}));
  setStatus(connected.current?'互动已暂停，点击恢复互动重新收音':'未连接语音');
 };
 const sendEvents=(ids:string[],replay=false)=>{
  const ws=socket.current;if(latest.current.preparing||processing.current||awaitingReply.current||!gameReady.current||beginning.current||!connected.current||ws?.readyState!==WebSocket.OPEN)return false;
  if(!ids.length)return false;clearAuto();waiting.current=true;
  if(rec.current){rec.current=false;setRecording(false);ws.send(JSON.stringify({type:'abort'}));}
  for(let i=0;i<ids.length;i+=200)ws.send(JSON.stringify({type:'play_events',eventIds:ids.slice(i,i+200),replay}));
  for(const id of ids)requested.current.add(id);return true;
 };
 const flushEvents=()=>sendEvents(latest.current.eventIds.filter(id=>!requested.current.has(id)));
 const privateAction=(type:'private_invite'|'private_leave',participants?:string[])=>{
  const ws=socket.current;if(!connected.current||ws?.readyState!==WebSocket.OPEN){onError('请先连接语音，再邀请私聊');return;}
  if(beginning.current){onError('请等待主持人开场结束');return;}
  captureEpoch.current++;clearAuto();rec.current=false;setRecording(false);setInputLevel(0);stopPlayback();processing.current=true;setReplyPending(true);waiting.current=true;paused.current=false;setInteractionPaused(false);
  ws.send(JSON.stringify({type:'abort'}));ws.send(JSON.stringify({type,...(participants?{participants}:{})}));setStatus('主持人正在安排私聊');
 };
 useEffect(()=>{
  if(!props.finished)return;
  captureEpoch.current++;clearAuto();paused.current=true;setInputLevel(0);
  if(rec.current){rec.current=false;setRecording(false);if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({type:'abort'}));}
  setStatus('本局已结束，可重播对话');
 },[props.finished]);
 useEffect(()=>{
  const room=props.privateRoom;if(!ready||startingGame||!room)return;
  const remaining=new Date(room.expiresAt).getTime()-Date.now();if(!Number.isFinite(remaining))return;
  const timer=setTimeout(()=>{
   const current=latest.current.privateRoom;
   if(!connected.current||!current||current.id!==room.id||expiredRooms.current.has(room.id)||latest.current.finished)return;
   expiredRooms.current.add(room.id);privateAction('private_leave');
  },Math.min(2147483647,Math.max(0,remaining)));
  return()=>clearTimeout(timer);
 },[ready,startingGame,props.privateRoom?.id,props.privateRoom?.expiresAt,props.finished]);
 useImperativeHandle(ref,()=>({invitePrivate:ids=>privateAction('private_invite',ids),leavePrivate:()=>privateAction('private_leave'),playEvent:(id:string)=>{
  if(!connected.current){onError('请先连接语音，再点击台词重播');return;}
  void audio.current?.resume();sendEvents([id],true);
 }}));
 useEffect(()=>{if(ready)flushEvents();},[eventIds.join('|'),ready,props.preparing]);
 useEffect(()=>{if(!props.preparing)scheduleListening();},[props.preparing]);

 const beginGame=()=>{
  const ws=socket.current;if(ws?.readyState!==WebSocket.OPEN)return;
  if(latest.current.preparing&&!readingConfirmed.current)return;
  beginning.current=true;setStartingGame(true);waiting.current=true;setStatus('正在准备主持人开场');
  ws.send(JSON.stringify({type:'begin_game',...(readingConfirmed.current?{readingComplete:true}:{})}));
 };
 const connect=async()=>{
  if(connecting.current||socket.current)return;
  connecting.current=true;paused.current=false;const epoch=++connectionEpoch.current;
  const current=()=>mounted.current&&epoch===connectionEpoch.current;
  try{
   if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前浏览器不支持麦克风，请使用最新版 Safari 或 Chrome');
   if(!window.isSecureContext)throw new Error('麦克风需要 HTTPS 安全连接；请使用 HTTPS 地址在手机上打开');
   const Ctx=contextConstructor();if(!Ctx)throw new Error('当前浏览器不支持 Web Audio，请更新 Safari 或 Chrome');
   setStatus('正在请求麦克风权限');const ctx=audio.current??new Ctx();audio.current=ctx;
   if(!ctx.audioWorklet)throw new Error('当前浏览器不支持 AudioWorklet，请更新 Safari 或 Chrome');
   await ctx.resume();if(!current())return;
   const media=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
   if(!current()){media.getTracks().forEach(t=>t.stop());return;}stream.current=media;
   await ctx.audioWorklet.addModule('/mic-worklet.js');if(!current())return;
   const mic=new AudioWorkletNode(ctx,'microphone');node.current=mic;const gain=ctx.createGain();gain.gain.value=0;
   ctx.createMediaStreamSource(media).connect(mic);mic.connect(gain).connect(ctx.destination);
   mic.port.onmessage=e=>{
    if(e.data&&typeof e.data==='object'&&e.data.type==='level'){
     const level=Number(e.data.value)||0;setInputLevel(level);
     if(rec.current&&auto.current){
      const result=endpoint.current.update(performance.now(),level/2.5);
      if(result==='end')stopCapture();
      if(result==='no-speech'){pause();setStatus('未检测到发言，互动已暂停；点击恢复互动继续');}
     }
     return;
    }
    if(rec.current&&socket.current?.readyState===WebSocket.OPEN&&socket.current.bufferedAmount<128000)socket.current.send(e.data);
   };
   const ticket=await api('/voice/ticket',{method:'POST',body:JSON.stringify({sessionId})});if(!current())return;
   const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/voice/socket?ticket=${encodeURIComponent(ticket.ticket)}`);
   ws.binaryType='arraybuffer';socket.current=ws;setStatus('正在连接灵矽');
   ws.onmessage=e=>{
    if(socket.current!==ws)return;
    if(e.data instanceof ArrayBuffer){
     if(rec.current)return;const context=audio.current;if(!context)return;
     const ints=new Int16Array(e.data);const buffer=context.createBuffer(1,ints.length,rate.current);const values=buffer.getChannelData(0);
     for(let i=0;i<ints.length;i++)values[i]=ints[i]/32768;
     const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);sources.current.push(source);
     source.onended=()=>{sources.current=sources.current.filter(item=>item!==source);if(!sources.current.length){if(!waiting.current&&!rec.current)setStatus(paused.current?'互动已暂停':'语音已就绪');scheduleListening();}};
     playAt.current=Math.max(context.currentTime+.03,playAt.current);source.start(playAt.current);playAt.current+=buffer.duration;return;
    }
    let msg:any;try{msg=JSON.parse(e.data);}catch{return;}
    if(msg.type==='ready'){
     rate.current=Number(msg.sampleRate)||24000;connected.current=true;latest.current.onConnection?.(true);setReady(true);setStatus('语音已就绪');connecting.current=false;wasConnected.current=true;
     beginGame();
    }
    if(msg.type==='game_started'){
     beginning.current=false;setStartingGame(false);gameReady.current=true;waiting.current=awaitingReply.current||processing.current||Boolean(msg.pending);
     if(!flushEvents()&&!msg.pending)scheduleListening();
    }
    if(msg.type==='audio_format')rate.current=Number(msg.sampleRate)||16000;
    if(msg.type==='capture_stopped'){rec.current=false;setRecording(false);setInputLevel(0);}
    if(msg.type==='synthesizing'){if(msg.eventId)requested.current.add(msg.eventId);waiting.current=true;clearAuto();setStatus('正在合成角色语音');}
    if(msg.type==='transcript'){processing.current=true;setReplyPending(true);clearAuto();waiting.current=true;setTranscript(msg.text);setStatus('角色正在思考');}
    if(msg.type==='session_updated'){processing.current=false;latest.current.onUpdate();}
    if(msg.type==='events_synced'&&!msg.pending&&!beginning.current&&!processing.current&&!awaitingReply.current){waiting.current=false;scheduleListening();}
    if(msg.type==='tts'){
     if(msg.state==='start'){if(msg.eventId)requested.current.add(msg.eventId);setStatus(`${msg.speaker==='dm'?'主持人':latest.current.roles.find(r=>r.id===msg.speaker)?.name??'角色'}正在发言`);}
     if(msg.state==='stop'){
      if(msg.isAborted){stopPlayback();return;}
      if(processing.current)return;
      setReplyPending(false);waiting.current=false;
      if(!sources.current.length){setStatus(paused.current?'互动已暂停':'语音已就绪');scheduleListening();}
     }
    }
    if(msg.type==='error'){processing.current=false;setReplyPending(false);beginning.current=false;setStartingGame(false);paused.current=true;waiting.current=false;clearAuto();onError(msg.message);setStatus('语音发生错误，可重播或重新开始');}
   };
   ws.onerror=()=>{if(socket.current!==ws)return;onError('语音连接失败，请检查网络、HTTPS/WSS 地址与灵矽配置');setStatus('语音连接失败');};
   ws.onclose=()=>{if(socket.current!==ws)return;disconnect('连接已断开，点击重新连接');};
  }catch(e){if(!current())return;disconnect();const error=e as Error;onError(error.name==='NotAllowedError'?'麦克风权限被拒绝，请在浏览器设置中允许此站点使用麦克风':error.name==='NotFoundError'?'未找到可用麦克风，请检查手机权限与蓝牙设备':error.message);}
 };
 useEffect(()=>{
  mounted.current=true;requested.current.clear();
  const visibility=()=>{
   if(document.hidden){wasConnected.current=connected.current;if(wasConnected.current)disconnect('切到后台，互动已暂停');}
   else if(wasConnected.current){wasConnected.current=false;void connect();}
  };
  document.addEventListener('visibilitychange',visibility);
  return()=>{mounted.current=false;document.removeEventListener('visibilitychange',visibility);disconnect();};
 },[sessionId,disconnect]);
 const toggle=()=>{if(latest.current.finished||processing.current||awaitingReply.current)return;if(!gameReady.current&&socket.current?.readyState===WebSocket.OPEN){paused.current=false;beginGame();return;}if(rec.current)stopCapture();else void startCapture().catch(e=>onError((e as Error).message));};
 const completeReading=()=>{
  readingConfirmed.current=true;
  if(connected.current&&socket.current?.readyState===WebSocket.OPEN){
   captureEpoch.current++;clearAuto();rec.current=false;setRecording(false);stopPlayback();processing.current=false;setReplyPending(false);
   socket.current.send(JSON.stringify({type:'abort'}));beginGame();
  }else void connect();
 };
 if(props.preparing)return <section className="voice-panel"><button disabled={connecting.current||startingGame} onClick={completeReading}>{startingGame?'主持人准备中…':connecting.current?'正在连接语音…':'阅读完毕，连接语音并开始'}</button>{(connecting.current||startingGame)&&<p role="status">{status}</p>}</section>;
 return <div className="voice-panel"><div className="voice-heading"><strong>◉ 语音房间</strong><small role="status" aria-live="polite">{props.finished?'本局已结束，可重播对话':status}</small></div><p className="voice-hint">手机端请使用 HTTPS；首次连接会请求麦克风权限。</p>
 <label className="check"><input type="checkbox" checked={automatic} disabled={props.finished} onChange={e=>{auto.current=e.target.checked;setAutomatic(e.target.checked);if(auto.current){paused.current=false;endpoint.current.reset(performance.now());scheduleListening();}else clearAuto();}}/>自动接话：说完停顿约 1.8 秒发送，角色播放完继续听</label>
 <p className="voice-hint">{props.privateRoom?'当前在私聊房间，语音仅对房间成员可见。':'当前在公共讨论，由主持人安排发言和阶段。'}</p>
 <div className="voice-meter" role="meter" aria-label="麦克风输入音量" aria-valuemin={0} aria-valuemax={1} aria-valuenow={inputLevel}><span style={{width:`${Math.round(inputLevel*100)}%`}}/></div><small className="voice-meter-label">麦克风输入 {inputLevel>0.04?'已收到声音':'等待声音'}</small>
 <div className="voice-buttons">{!ready?<button onClick={()=>void connect()} disabled={connecting.current}>{connecting.current?'连接中…':props.started?'连接语音':'连接语音并开始'}</button>:<><button disabled={startingGame||props.finished||responding} className={recording?'recording':''} onClick={toggle}>{props.finished?'本局已结束':startingGame?'主持人准备中…':!props.started?'重试开场':responding?'正在等待回应…':recording?'■ 结束录音':interactionPaused?'恢复互动':'● 开始说话'}</button><button className="secondary" onClick={pause}>暂停互动</button><button className="secondary" onClick={()=>disconnect()}>断开</button></>}</div>
 {transcript&&<p>识别：{transcript}</p>}<p className="muted">开场和语音回复均按角色音色播放；台词旁可单独重播。自动接话根据音量和停顿判断，需长时间思考或环境嘈杂时可关闭；20 秒未检测到发言会暂停互动。播放期间暂停收音，避免把角色声音识别成你的发言。“暂停互动”会停止收音和播报，并取消尚未完成的回应；恢复互动会重新收音，不会续播。</p><p className="muted">阶段由主持人自动推进。投票阶段可说“我投周启”，听完主持人复述后再说“确认投票”；也可说“取消操作”。搜证时可说“搜查＋线索名”。</p></div>;
});
