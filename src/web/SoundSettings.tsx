import {bindingKey} from '../core/bindings';
import React,{useEffect,useState} from 'react';
import {ReferenceAudioInput} from './ReferenceAudioInput';
import {VoicePreview} from './VoicePreview';
import {FixedVoiceDemo} from './FixedVoiceDemo';
type Props={api:(path:string,options?:RequestInit)=>Promise<any>;scripts:any[];config:any;setConfig:(c:any)=>void;onError:(s:string)=>void};
const states:Record<string,string>={Init:'待提交训练',Training:'训练中',Success:'可使用',Failed:'训练失败'};
export function SoundSettings({api,scripts,config,setConfig,onError}:Props){
 const [voices,setVoices]=useState<any[]>([]),[clones,setClones]=useState<any[]>([]),[scriptId,setScriptId]=useState(scripts[0]?.id??''),[name,setName]=useState('我的角色声音'),[tier,setTier]=useState('free'),[sampleId,setSampleId]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState(''),[attemptId,setAttemptId]=useState('');
 const [restoredUrl,setRestoredUrl]=useState('');
 const work=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');onError('');try{await fn();}catch(e){setError((e as Error).message);onError((e as Error).message);}finally{setBusy(false);}};
 const saveConfig=async(signal?:AbortSignal)=>{const saved=await api('/config',{method:'PUT',body:JSON.stringify(config),signal});signal?.throwIfAborted();setConfig(saved);};
 const refresh=async()=>{const [catalog,mine]=await Promise.all([api('/linx/voices'),api('/linx/clones')]);setVoices(catalog);setClones(mine.voices??[]);};
 useEffect(()=>{if(!config.linx.apiKey)return;let cancelled=false;void Promise.all([api('/linx/voices'),api('/linx/clones'),api('/linx/samples/latest')]).then(([catalog,mine,sample])=>{if(!cancelled){setVoices(catalog);setClones(mine.voices??[]);if(sample?.sampleId){setSampleId(sample.sampleId);setAttemptId(sample.cloneId??'');setRestoredUrl(sample.url??'');setNotice('已恢复上次上传的参考音频，可继续用于已有音色的训练，无需重录。');}}}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};},[]);
 const hasActiveTraining=clones.some(v=>v.submissionPhase==='submitting'||v.state==='Training');
 useEffect(()=>{
  if(!hasActiveTraining)return;
  let cancelled=false;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const result=await api('/linx/clones');if(!cancelled){setClones(result.voices??[]);timer=setTimeout(()=>void poll(),5000);}}catch(e){if(!cancelled)setError(`自动刷新已暂停：${(e as Error).message}`);}};
  timer=setTimeout(()=>void poll(),5000);return()=>{cancelled=true;clearTimeout(timer);};
 },[hasActiveTraining]);
 useEffect(()=>{if(!scripts.some(s=>s.id===scriptId))setScriptId(scripts[0]?.id??'');},[scripts,scriptId]);
 const defaults=voices.filter(v=>!clones.some(c=>c.id===v.id)&&(!v.state||v.state==='Success'));
 const personal=clones.filter(v=>v.state==='Success');
 const available=[...defaults,...personal];
 const resultNotice=(result:any)=>{
  setAttemptId(result.id);
  setClones(current=>[result,...current.filter(v=>v.id!==result.id)]);
  setNotice(result.submissionPhase==='submitting'?'提交任务已保存，请在下方音色卡片查看最新进度。':result.submissionNote??(result.state==='Success'?'复刻成功，已加入声音库。可输入文字试听，再到角色处选择。':result.state==='Training'?'平台已确认正在训练，状态会自动刷新。':`平台当前状态：${states[result.state]??result.state}。尚不能使用，请刷新确认。`));
 };
 return <section className="panel"><div className="section-title"><h2>灵矽声音库与参考音频</h2><button className="secondary" disabled={busy} onClick={()=>void work(async()=>{await saveConfig();await refresh();setNotice('配置已保存，声音库已刷新。');})}>保存配置并加载音色</button></div>
 <p>语音识别、语音合成和音色复刻统一使用灵矽。默认声音和复刻成功的声音都可在角色处选择；复刻声音属于声音库，可以供多个角色使用。</p>
 <div className="assignment"><select aria-label="分配音色的剧本" value={scriptId} onChange={e=>setScriptId(e.target.value)}>{scripts.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select><button disabled={busy||!scriptId} onClick={()=>void work(async()=>{await saveConfig();const result=await api('/linx/voices/assign',{method:'POST',body:JSON.stringify({scriptId})});setConfig(await api('/config'));await refresh();setNotice(result.needsMapping.length?'部分音色没有返回有效音色 ID，请检查目录。':'已自动分配声音，可在下方调整。');})}>自动分配默认声音</button></div>
 <div className="role-voice-bindings">{scriptId&&[{id:'dm',name:'主持人'},...(scripts.find(s=>s.id===scriptId)?.roles??[])].map((r:any)=>{
 const key=bindingKey(scriptId,r.id),voice=config.roleVoices[key],selected=available.find(v=>v.id===voice?.voiceId);
 return <div className="role-voice-assignment" key={key}><strong>{r.name}</strong><div><label>{r.name}的声音<select aria-label={`${r.name}的声音`} disabled={busy} value={voice?.voiceId??''} onChange={e=>{const v=available.find(v=>v.id===e.target.value);setConfig({...config,roleVoices:{...config.roleVoices,[key]:{voiceId:e.target.value,provider:v?.provider??'',voiceType:v?.voice_type??''}}});setNotice('声音选择已修改，请点击“保存角色声音”后用于打本。');}}><option value="">请选择声音</option>{voice?.voiceId&&!selected&&<option value={voice.voiceId} disabled>当前声音（未加载或不可用）</option>}<optgroup label="默认声音">{defaults.map(v=><option value={v.id} key={v.id}>{v.name}</option>)}</optgroup><optgroup label="我的复刻声音">{personal.map(v=><option value={v.id} key={v.id}>{v.name}</option>)}</optgroup></select></label>{selected&&<details><summary>输入文字试听</summary><VoicePreview key={selected.id} voiceId={selected.id} name={selected.name} api={api}/></details>}</div></div>;
 })}</div>
 <button disabled={busy||!scriptId} onClick={()=>void work(async()=>{await saveConfig();setNotice('角色声音已保存。');})}>保存角色声音</button>
 {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="warning">{error}</p>}
 {defaults.length>0&&<details><summary>默认声音库（{defaults.length}）</summary><div className="voice-catalog">{defaults.map(v=><div className="voice-card" key={v.id}><strong>{v.name}</strong><p>{[v.tags?.gender,v.tags?.age,...(v.tags?.styles??[])].filter(Boolean).join(' · ')}</p>{/^https:\/\//.test(v.demo??'')&&<audio controls preload="none" src={v.demo}/>}</div>)}</div></details>}
 <hr/><h3>录制或上传参考声音</h3><p className="muted">建议使用清晰、无背景噪音的 20–30 秒音频。可直接录音，结束后自动上传，也可选择已有文件。提交训练会消耗所选档位的复刻额度，可能需要数分钟。声音复刻成功后加入声音库，再由角色选择使用。</p>
 <div className="form-grid"><label>声音名称<input value={name} maxLength={20} onChange={e=>setName(e.target.value)}/></label><label>资源档位<select value={tier} onChange={e=>setTier(e.target.value)}><option value="free">免费额度</option><option value="lite">付费额度</option><option value="pro">商务版额度</option></select></label></div>
 {restoredUrl&&<div><p>上次上传的参考音频（临时链接有效期内可用）</p><audio controls preload="none" src={restoredUrl}/><p><a href={restoredUrl} download="reference.wav">下载上次参考音频</a></p></div>}
 <ReferenceAudioInput disabled={busy} onBusy={setBusy} onReset={()=>{setSampleId('');setAttemptId('');setRestoredUrl('');setNotice('');}} onUpload={async(file,signal)=>{await saveConfig(signal);const form=new FormData();form.append('file',file);const result=await api('/linx/samples',{method:'POST',body:form,signal});signal.throwIfAborted();setSampleId(result.sampleId);setAttemptId('');setRestoredUrl('');setNotice('参考音频已上传，临时下载权限一小时后失效。可新建复刻声音，或在下方为已有声音重试训练。');}}/>
 <button disabled={busy||!sampleId||!name.trim()||!!attemptId} onClick={()=>void work(async()=>{resultNotice(await api('/linx/clones',{method:'POST',body:JSON.stringify({sampleId,name,tier,language:'zh'})}));})}>开始复刻新声音</button>
 {attemptId&&<p>本次音频已有复刻栏位，请在下方刷新状态或重试，避免重复创建。</p>}
 <h3>我的复刻声音</h3><button className="secondary" disabled={busy} onClick={()=>void work(async()=>{setClones((await api('/linx/clones')).voices??[]);})}>刷新训练状态</button>
 {clones.map(v=><div className="voice-card" key={v.id}><strong>{v.name}</strong><span className="badge">{v.submissionPhase==='submitting'?'正在提交训练':states[v.state]??v.state}</span><small>{v.id}</small>
 {v.submissionNote&&<p className="warning">{v.submissionNote}</p>}
 {v.state==='Init'&&v.submissionPhase!=='submitting'&&<p>音色栏位已创建，平台尚未进入训练状态；这不代表你没有点击提交。请求失败或超时也可能留下此状态。</p>}
 {v.state==='Training'&&<p>平台正在训练，完成后刷新状态即可选择和试听。</p>}
 {['Init','Failed'].includes(v.state)&&v.submissionPhase!=='submitting'&&<><p>可复用已上传的参考音频和此栏位重新提交。若之前请求超时，请先刷新状态确认；重试可能消耗复刻额度。</p><button disabled={busy||!sampleId||!name.trim()} onClick={()=>void work(async()=>{resultNotice(await api(`/linx/clones/${encodeURIComponent(v.id)}/train`,{method:'POST',body:JSON.stringify({sampleId,name})}));})}>用当前参考音频重试训练</button></>}
 {v.state==='Success'&&<><p>已加入声音库，可在上方角色设置中选择。</p><FixedVoiceDemo key={`${v.id}:${v.demo_url??''}`} name={v.name} demoUrl={v.demo_url}/><VoicePreview voiceId={v.id} name={v.name} api={api}/></>}
 </div>)}
 </section>;
}
