import React,{useEffect,useRef,useState} from 'react';
type Props={voiceId:string;name:string;api:(path:string,options?:RequestInit)=>Promise<any>};
export function VoicePreview({voiceId,name,api}:Props){
 const [text,setText]=useState('你好，这是我的声音。今晚，让我们一起走进故事。');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[audio,setAudio]=useState('');
 const [status,setStatus]=useState(''),[firstAudio,setFirstAudio]=useState<number>();
 const request=useRef<AbortController|null>(null);const audioUrl=useRef('');
 const cancel=()=>{request.current?.abort();request.current=null;};
 const clearAudio=()=>{if(audioUrl.current)URL.revokeObjectURL(audioUrl.current);audioUrl.current='';setAudio('');};
 useEffect(()=>{setError('');setStatus('');setBusy(false);setFirstAudio(undefined);clearAudio();return ()=>{cancel();if(audioUrl.current)URL.revokeObjectURL(audioUrl.current);};},[voiceId]);
 const start=async()=>{
  cancel();clearAudio();const controller=new AbortController();request.current=controller;
  setBusy(true);setError('');setStatus('正在连接并合成…');setFirstAudio(undefined);
  const started=performance.now();let ctx:AudioContext|undefined,ws:WebSocket|undefined;
  let rate=16000,nextTime=0,completed=false,bytes=0,heard=false;const frames:ArrayBuffer[]=[];const sources=new Set<AudioBufferSourceNode>();
  const current=()=>request.current===controller&&!controller.signal.aborted;
  const timer=setTimeout(()=>fail('试听超时，请稍后重试'),85000);
  const dispose=()=>{clearTimeout(timer);ws?.close();for(const source of sources){try{source.stop();}catch{}}sources.clear();void ctx?.close().catch(()=>{});};
  controller.signal.addEventListener('abort',dispose,{once:true});
  const fail=(message:string)=>{if(!current())return;setError(message);setStatus('');setBusy(false);cancel();};
  const finishPlayback=()=>{if(current()&&completed&&!sources.size){setBusy(false);setStatus('试听完成');clearTimeout(timer);void ctx?.close().catch(()=>{});}};
  try{
   const Ctx=window.AudioContext??window.webkitAudioContext;if(!Ctx)throw new Error('当前浏览器不支持音频播放，请更新 Safari 或 Chrome');
   // Unlock playback inside this click, before any network request (including Safari).
   ctx=new Ctx();await ctx.resume();if(!current())return;
   const {ticket}=await api('/linx/voices/preview-ticket',{method:'POST',body:JSON.stringify({voiceId,text:text.trim()}),signal:controller.signal});
   if(!current())return;
   ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/voice/preview?ticket=${encodeURIComponent(ticket)}`);ws.binaryType='arraybuffer';
   ws.onmessage=e=>{
    if(!current())return;
    try{
     if(e.data instanceof ArrayBuffer){
      if(e.data.byteLength%2)throw new Error('试听音频格式无效');
      if(!e.data.byteLength)return;
      bytes+=e.data.byteLength;if(bytes>8*1024*1024)throw new Error('试听音频过长');frames.push(e.data);
      const ints=new Int16Array(e.data),buffer=ctx!.createBuffer(1,ints.length,rate),values=buffer.getChannelData(0);
      for(let i=0;i<ints.length;i++)values[i]=ints[i]/32768;
      const source=ctx!.createBufferSource();source.buffer=buffer;source.connect(ctx!.destination);sources.add(source);
      source.onended=()=>{sources.delete(source);finishPlayback();};
      nextTime=Math.max(ctx!.currentTime+.06,nextTime);source.start(nextTime);nextTime+=buffer.duration;
      if(!heard){heard=true;setFirstAudio((performance.now()-started)/1000);setStatus('正在试听，后续语音持续生成…');}
      return;
     }
     const msg=JSON.parse(e.data);
     if(msg.type==='format'){if(![8000,12000,16000,24000,48000].includes(msg.sampleRate))throw new Error('不支持的试听采样率');rate=msg.sampleRate;}
     if(msg.type==='error')throw new Error(msg.message);
     if(msg.type==='complete'){
      if(!bytes)throw new Error('没有收到试听音频');completed=true;clearTimeout(timer);
      const wav=new ArrayBuffer(44+bytes),view=new DataView(wav),out=new Uint8Array(wav);
      const label=(at:number,s:string)=>{for(let i=0;i<s.length;i++)out[at+i]=s.charCodeAt(i);};
      label(0,'RIFF');view.setUint32(4,bytes+36,true);label(8,'WAVEfmt ');view.setUint32(16,16,true);
      view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);
      view.setUint16(32,2,true);view.setUint16(34,16,true);label(36,'data');view.setUint32(40,bytes,true);
      let offset=44;for(const frame of frames){out.set(new Uint8Array(frame),offset);offset+=frame.byteLength;}
      audioUrl.current=URL.createObjectURL(new Blob([wav],{type:'audio/wav'}));setAudio(audioUrl.current);finishPlayback();
     }
    }catch(error){fail((error as Error).message);}
   };
   ws.onerror=()=>fail('试听连接失败，请检查网络后重试');
   ws.onclose=()=>{if(current()&&!completed)fail('试听连接提前断开，请重试');};
  }catch(error){if(current())fail((error as Error).message);}
 };
 return <div><label>试听文字 · {name}<textarea maxLength={200} value={text} disabled={busy} onChange={e=>setText(e.target.value)}/></label>
 <button className="secondary" disabled={busy||!text.trim()} onClick={()=>void start()}>{busy?'正在试听…':'开始试听'}</button>
 {busy&&<button className="secondary" onClick={()=>{cancel();setBusy(false);setStatus('试听已停止');}}>停止试听</button>}
 {status&&<p role="status">{status}{firstAudio!==undefined&&`（首段音频等待 ${firstAudio.toFixed(1)} 秒）`}</p>}
 {error&&<p role="alert" className="warning">{error}</p>}
 {audio&&!busy&&<div><p>重播已生成的声音，无需再次等待合成。</p><audio aria-label={`${name}文字试听`} controls src={audio} style={{width:'100%'}}/></div>}
 </div>;
}
