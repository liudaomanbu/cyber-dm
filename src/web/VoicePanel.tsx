import React,{useCallback,useEffect,useRef,useState} from 'react';

type Props={sessionId:string;target:string;roles:{id:string;name:string}[];onTarget:(id:string)=>void;api:(path:string,options?:RequestInit)=>Promise<any>;onUpdate:()=>void;onError:(s:string)=>void};
type AudioContextCtor = new () => AudioContext;
declare global { interface Window { webkitAudioContext?: AudioContextCtor } }

const contextConstructor=():AudioContextCtor|undefined=>window.AudioContext??window.webkitAudioContext;

export function VoicePanel({sessionId,target,roles,onTarget,api,onUpdate,onError}:Props){
 const [status,setStatus]=useState('未连接语音');
 const [ready,setReady]=useState(false);
 const [recording,setRecording]=useState(false);
 const [inputLevel,setInputLevel]=useState(0);
 const [transcript,setTranscript]=useState('');
 const socket=useRef<WebSocket|null>(null);
 const audio=useRef<AudioContext|null>(null);
 const stream=useRef<MediaStream|null>(null);
 const node=useRef<AudioWorkletNode|null>(null);
 const sources=useRef<AudioBufferSourceNode[]>([]);
 const playAt=useRef(0);
 const rate=useRef(24000);
 const rec=useRef(false);
 const connecting=useRef(false);
 const wasConnected=useRef(false);
 const mounted=useRef(true);

 const stopPlayback=useCallback(()=>{
  for(const source of sources.current){try{source.stop();}catch{}}
  sources.current=[];playAt.current=0;
 },[]);

 const disconnect=useCallback((message='语音已断开')=>{
  rec.current=false;connecting.current=false;
  socket.current?.close();socket.current=null;
  stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;
  node.current?.disconnect();node.current=null;
  stopPlayback();
  const ctx=audio.current;audio.current=null;
  if(ctx)void ctx.close().catch(()=>{});
  if(mounted.current){setReady(false);setRecording(false);setInputLevel(0);setStatus(message);}
 },[stopPlayback]);

 const connect=async()=>{
  if(connecting.current||socket.current)return;
  connecting.current=true;
  try{
   if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前浏览器不支持麦克风，请使用最新版 Safari 或 Chrome');
   if(!window.isSecureContext)throw new Error('麦克风需要 HTTPS 安全连接；请使用 HTTPS 地址在手机上打开');
   const Ctx=contextConstructor();
   if(!Ctx)throw new Error('当前浏览器不支持 Web Audio，请更新 Safari 或 Chrome');
   setStatus('正在请求麦克风权限');
   const ctx=audio.current??new Ctx();audio.current=ctx;
   if(!ctx.audioWorklet)throw new Error('当前浏览器不支持 AudioWorklet，请更新 Safari 或 Chrome');
   await ctx.resume();
   stream.current=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
   await ctx.audioWorklet.addModule('/mic-worklet.js');
   const mic=new AudioWorkletNode(ctx,'microphone');node.current=mic;
   const gain=ctx.createGain();gain.gain.value=0;
   ctx.createMediaStreamSource(stream.current).connect(mic);mic.connect(gain).connect(ctx.destination);
   mic.port.onmessage=e=>{
    if(e.data&&typeof e.data==='object'&&e.data.type==='level'){setInputLevel(Number(e.data.value)||0);return;}
    if(rec.current&&socket.current?.readyState===WebSocket.OPEN&&socket.current.bufferedAmount<128000)socket.current.send(e.data);
   };
   const ticket=await api('/voice/ticket',{method:'POST',body:JSON.stringify({sessionId})});
   const wsScheme=location.protocol==='https:'?'wss:':'ws:';
   const ws=new WebSocket(`${wsScheme}//${location.host}/voice/socket?ticket=${encodeURIComponent(ticket.ticket)}`);
   ws.binaryType='arraybuffer';socket.current=ws;setStatus('正在连接灵矽');
   ws.onmessage=e=>{
    if(e.data instanceof ArrayBuffer){
     if(rec.current)return;
     const context=audio.current;if(!context)return;
     const ints=new Int16Array(e.data);const buffer=context.createBuffer(1,ints.length,rate.current);const values=buffer.getChannelData(0);
     for(let i=0;i<ints.length;i++)values[i]=ints[i]/32768;
     const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);sources.current.push(source);
     source.onended=()=>{sources.current=sources.current.filter(item=>item!==source);};
     playAt.current=Math.max(context.currentTime+.03,playAt.current);source.start(playAt.current);playAt.current+=buffer.duration;return;
    }
    let msg:any;try{msg=JSON.parse(e.data);}catch{return;}
    if(msg.type==='ready'){rate.current=Number(msg.sampleRate)||24000;setReady(true);setStatus('语音已就绪');connecting.current=false;wasConnected.current=true;}
    if(msg.type==='transcript'){setTranscript(msg.text);setStatus('角色正在思考');}
    if(msg.type==='session_updated')onUpdate();
    if(msg.type==='tts'){if(msg.state==='start')setStatus('角色正在发言');if(msg.state==='stop'){if(msg.isAborted)stopPlayback();setStatus('语音已就绪');}}
    if(msg.type==='error'){onError(msg.message);setStatus('语音发生错误');}
   };
   ws.onerror=()=>{if(socket.current!==ws)return;onError('语音连接失败，请检查网络、HTTPS/WSS 地址与灵矽配置');setStatus('语音连接失败');};
   ws.onclose=()=>{if(socket.current!==ws)return;socket.current=null;rec.current=false;connecting.current=false;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;node.current?.disconnect();node.current=null;stopPlayback();if(mounted.current){setReady(false);setRecording(false);setInputLevel(0);setStatus('连接已断开，点击重新连接');}};
  }catch(e){disconnect();const error=e as Error;onError(error.name==='NotAllowedError'?'麦克风权限被拒绝，请在浏览器设置中允许此站点使用麦克风':error.name==='NotFoundError'?'未找到可用麦克风，请检查手机权限与蓝牙设备':error.message);}
 };

 useEffect(()=>{
  mounted.current=true;
  const visibility=()=>{
   if(document.hidden){
    wasConnected.current=Boolean(socket.current||ready);
    if(wasConnected.current)disconnect('切到后台，语音已暂停');
   }else if(wasConnected.current){
    wasConnected.current=false;setStatus('正在恢复语音，请稍候');void connect();
   }
  };
  document.addEventListener('visibilitychange',visibility);
  return()=>{mounted.current=false;document.removeEventListener('visibilitychange',visibility);disconnect();};
 },[sessionId,disconnect]);

 const toggle=async()=>{
  if(!ready||!socket.current||socket.current.readyState!==WebSocket.OPEN)return;
  await audio.current?.resume();stopPlayback();
  if(rec.current){rec.current=false;socket.current.send(JSON.stringify({type:'stop'}));setRecording(false);setStatus('正在识别');}
  else{socket.current.send(JSON.stringify({type:'start',...(target?{target}:{})}));rec.current=true;setRecording(true);setStatus('正在听，点击结束');}
 };

 const abort=()=>{rec.current=false;setRecording(false);stopPlayback();if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({type:'abort'}));setStatus(ready?'语音已就绪':'未连接语音');};
 return <div className="voice-panel"><div className="voice-heading"><strong>◉ 语音房间</strong><small role="status" aria-live="polite">{status}</small></div><p className="voice-hint">手机端请使用 HTTPS；首次连接会请求麦克风权限，浏览器地址栏需显示安全锁。</p><label>语音发言对象<select value={target} disabled={recording} onChange={e=>onTarget(e.target.value)}><option value="">公开讨论</option><option value="dm">私聊主持人</option>{roles.map(r=><option key={r.id} value={r.id}>私聊 {r.name}</option>)}</select></label><div className="voice-meter" role="meter" aria-label="麦克风输入音量" aria-valuemin={0} aria-valuemax={1} aria-valuenow={inputLevel}><span style={{width:`${Math.round(inputLevel*100)}%`}}/></div><small className="voice-meter-label">麦克风输入 {inputLevel>0.04?'已收到声音':'等待声音'}</small><div className="voice-buttons">{!ready?<button onClick={()=>void connect()} disabled={connecting.current}>{connecting.current?'连接中…':'连接麦克风'}</button>:<><button className={recording?'recording':''} onClick={()=>void toggle()}>{recording?'■ 结束录音':'● 开始说话'}</button><button className="secondary" onClick={abort}>停止播放</button><button className="secondary" onClick={()=>disconnect()}>断开</button></>}</div>{transcript&&<p>识别：{transcript}</p>}<p className="muted">可说“下一阶段”“搜查＋线索名”“投票＋角色名”，关键操作会先复述，再说“确认执行”才生效；也可说“取消操作”。切到后台会暂停语音，返回后自动尝试恢复。</p></div>;
}
