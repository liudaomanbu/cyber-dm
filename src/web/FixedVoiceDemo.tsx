import React,{useEffect,useState} from 'react';

type Props={name:string;demoUrl?:string};

/** Only show the platform's own demo once the browser can read its duration.
 * A missing, protected or unplayable URL must not leave an empty player. */
export function FixedVoiceDemo({name,demoUrl}:Props){
 const [readyUrl,setReadyUrl]=useState('');
 useEffect(()=>{
  setReadyUrl('');
  if(!demoUrl||!/^https:\/\//.test(demoUrl))return;
  const probe=new Audio();let finished=false;
  const finish=(valid:boolean)=>{
   if(finished)return;finished=true;clearTimeout(timer);
   probe.onloadedmetadata=null;probe.onerror=null;
   if(valid)setReadyUrl(demoUrl);
   probe.removeAttribute('src');probe.load();
  };
  const timer=setTimeout(()=>finish(false),15000);
  probe.preload='metadata';
  probe.onloadedmetadata=()=>finish(Number.isFinite(probe.duration)&&probe.duration>0);
  probe.onerror=()=>finish(false);
  probe.src=demoUrl;probe.load();
  return()=>{finished=true;clearTimeout(timer);probe.onloadedmetadata=null;probe.onerror=null;probe.removeAttribute('src');probe.load();};
 },[demoUrl]);
 if(!readyUrl||readyUrl!==demoUrl)return null;
 return <div className="fixed-voice-demo"><p><strong>平台固定示例</strong></p><audio aria-label={`${name}平台固定示例`} controls preload="metadata" src={readyUrl} onError={()=>setReadyUrl('')}/></div>;
}
