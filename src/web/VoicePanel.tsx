import React,{useEffect,useRef,useState} from 'react';
type Props={sessionId:string;api:(path:string,options?:RequestInit)=>Promise<any>;onUpdate:()=>void;onError:(s:string)=>void};
export function VoicePanel({sessionId,api,onUpdate,onError}:Props){
 const [status,setStatus]=useState('未连接语音');const [ready,setReady]=useState(false);const [recording,setRecording]=useState(false);const [transcript,setTranscript]=useState('');
 const socket=useRef<WebSocket|null>(null);const audio=useRef<AudioContext|null>(null);const stream=useRef<MediaStream|null>(null);const node=useRef<AudioWorkletNode|null>(null);const sources=useRef<AudioBufferSourceNode[]>([]);const playAt=useRef(0);const rate=useRef(24000);const rec=useRef(false);const connecting=useRef(false);
 const stopPlayback=()=>{for(const s of sources.current){try{s.stop();}catch{}}sources.current=[];playAt.current=0;};
 const disconnect=()=>{rec.current=false;connecting.current=false;socket.current?.close();socket.current=null;stream.current?.getTracks().forEach(t=>t.stop());node.current?.disconnect();stopPlayback();void audio.current?.close();audio.current=null;setReady(false);setRecording(false);setStatus('语音已断开');};
 useEffect(()=>{const visibility=()=>{if(document.hidden){disconnect();}};document.addEventListener('visibilitychange',visibility);return()=>{document.removeEventListener('visibilitychange',visibility);disconnect();};},[sessionId]);
 const connect=async()=>{
  if(connecting.current||socket.current)return;connecting.current=true;
  try{
   if(!navigator.mediaDevices?.getUserMedia||!window.isSecureContext)throw new Error('麦克风需要 HTTPS 安全连接；请使用 HTTPS 地址在手机上打开');
   setStatus('正在请求麦克风权限');
   const ctx=new AudioContext();audio.current=ctx;await ctx.resume();
   stream.current=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
   await ctx.audioWorklet.addModule('/mic-worklet.js');
   const mic=new AudioWorkletNode(ctx,'microphone');node.current=mic;const gain=ctx.createGain();gain.gain.value=0;
   ctx.createMediaStreamSource(stream.current).connect(mic);mic.connect(gain).connect(ctx.destination);
   mic.port.onmessage=e=>{if(rec.current&&socket.current?.readyState===WebSocket.OPEN&&socket.current.bufferedAmount<128000)socket.current.send(e.data);};
   const ticket=await api('/voice/ticket',{method:'POST',body:JSON.stringify({sessionId})});
   const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/voice/socket?ticket=${encodeURIComponent(ticket.ticket)}`);ws.binaryType='arraybuffer';socket.current=ws;setStatus('正在连接灵矽');
   ws.onmessage=e=>{
    if(e.data instanceof ArrayBuffer){
     if(rec.current)return;const ints=new Int16Array(e.data);const buffer=ctx.createBuffer(1,ints.length,rate.current);const values=buffer.getChannelData(0);for(let i=0;i<ints.length;i++)values[i]=ints[i]/32768;
     const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);sources.current.push(source);source.onended=()=>{sources.current=sources.current.filter(s=>s!==source);};
     playAt.current=Math.max(ctx.currentTime+.03,playAt.current);source.start(playAt.current);playAt.current+=buffer.duration;return;
    }
    const msg=JSON.parse(e.data);
    if(msg.type==='ready'){rate.current=msg.sampleRate;setReady(true);setStatus('语音已就绪');connecting.current=false;}
    if(msg.type==='transcript'){setTranscript(msg.text);setStatus('角色正在思考');}
    if(msg.type==='session_updated')onUpdate();
    if(msg.type==='tts'){if(msg.state==='start')setStatus('角色正在发言');if(msg.state==='stop'){if(msg.isAborted)stopPlayback();setStatus('语音已就绪');}}
    if(msg.type==='error'){onError(msg.message);setStatus('语音发生错误');}
   };
   ws.onerror=()=>onError('语音连接失败，请检查网络与灵矽配置');
   ws.onclose=()=>{socket.current=null;rec.current=false;connecting.current=false;stream.current?.getTracks().forEach(t=>t.stop());setReady(false);setRecording(false);setStatus('连接已断开，点击重新连接');};
  }catch(e){disconnect();onError((e as Error).message);}
 };
 const toggle=async()=>{
  if(!ready)return;await audio.current?.resume();stopPlayback();
  if(rec.current){rec.current=false;socket.current?.send(JSON.stringify({type:'stop'}));setRecording(false);setStatus('正在识别');}
  else{socket.current?.send(JSON.stringify({type:'start'}));rec.current=true;setRecording(true);setStatus('正在听，点击结束');}
 };
 return <div className="voice-panel"><div><strong>◉ 语音房间</strong><small role="status">{status}</small></div><div className="voice-buttons">{!ready?<button onClick={()=>void connect()}>连接麦克风</button>:<><button className={recording?'recording':''} onClick={()=>void toggle()}>{recording?'■ 结束录音':'● 开始说话'}</button><button className="secondary" onClick={()=>{rec.current=false;setRecording(false);stopPlayback();socket.current?.send(JSON.stringify({type:'abort'}));}}>停止播放</button><button className="secondary" onClick={disconnect}>断开</button></>}</div>{transcript&&<p>识别：{transcript}</p>}<p className="muted">可说“下一阶段”“搜查＋线索名”“确认投票＋角色名”，或直接和角色讨论。切到后台会暂停语音，返回后请重新连接。</p></div>;
}
