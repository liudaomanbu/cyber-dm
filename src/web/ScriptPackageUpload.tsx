import React,{useEffect,useRef,useState} from 'react';
import {createWorker} from 'tesseract.js';

type Api=(path:string,options?:RequestInit)=>Promise<any>;
type Entry={id:string;file:File;path:string;kind:'document'|'attachment';pages?:number;done:number;ocr:number;error?:string};
const accepted=/\.(pdf|txt|md)$/i;
const isPdf=(name:string)=>/\.pdf$/i.test(name);
const textLength=(text:string)=>text.replace(/\s+/g,'').length;
const FILE_CONCURRENCY=2;
async function digest(file:File){const data=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return [...new Uint8Array(data)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function eachWithConcurrency<T>(items:T[],limit:number,work:(item:T,index:number)=>Promise<void>){
 const next={value:0};
 const worker=async()=>{while(true){const index=next.value++;if(index>=items.length)return;await work(items[index],index);}};
 await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));
}
async function renderPage(page:any){const viewport=page.getViewport({scale:1.7});const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d')!,viewport}).promise;return canvas;}
async function readPdf(file:File,completed:Set<number>,onPages:(pages:number)=>Promise<void>,onPage:(page:number,text:string,method:'text'|'ocr')=>Promise<void>){
 const pdfjs:any=await import('pdfjs-dist/legacy/build/pdf.mjs');
 pdfjs.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.296/pdf.worker.min.mjs';
 const pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
 let worker:any;
 try{
  await onPages(pdf.numPages);
  for(let n=1;n<=pdf.numPages;n++){
   if(completed.has(n))continue;
   const page=await pdf.getPage(n);const content=await page.getTextContent();const text=content.items.map((item:any)=>item.str??'').join('\n');
   if(textLength(text)>=12){await onPage(n,text,'text');page.cleanup();continue;}
   worker??=await createWorker('chi_sim+eng',1,{workerPath:'/ocr/worker.min.js',langPath:'https://tessdata.projectnaptha.com/4.0.0',corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm.js'});
   const result=await worker.recognize(await renderPage(page));await onPage(n,result.data.text??'','ocr');
   page.cleanup();
  }
 }finally{if(worker)await worker.terminate();pdf.destroy();}
 return pdf.numPages;
}
type SavedFile={id:string;path:string;pages?:number;completed:number[];ocrPages:number[];emptyPages:number[];characters:number;error?:string};
type Package={id:string;title:string;files:SavedFile[];complete:boolean;characters:number;ocrPages:number};
type Page={page:number;text:string;method:'text'|'ocr';reviewed:boolean};
export function ScriptPackageUpload({api,onDone,onError}:{api:Api;onDone:()=>Promise<void>|void;onError:(message:string)=>void}){
 const input=useRef<HTMLInputElement>(null),folderInput=useRef<HTMLInputElement>(null),selection=useRef(0),pageRequest=useRef(0),apiRef=useRef(api);
 apiRef.current=api;
 const [entries,setEntries]=useState<Entry[]>([]),[running,setRunning]=useState(false),[compiling,setCompiling]=useState(false),[status,setStatus]=useState('');
 const [packages,setPackages]=useState<Package[]>([]),[selected,setSelected]=useState<Package|null>(null),[fileId,setFileId]=useState(''),[pageNumber,setPageNumber]=useState(1),[page,setPage]=useState<Page|null>(null),[pageLoading,setPageLoading]=useState(false),[saving,setSaving]=useState(false),[dirty,setDirty]=useState(false);
 const refresh=async(id?:string)=>{const list:Package[]=await apiRef.current('/script-packages');setPackages(list);if(id)setSelected(list.find(p=>p.id===id)??null);};
 useEffect(()=>{let active=true;void apiRef.current('/script-packages').then((list:Package[])=>{if(active)setPackages(list);}).catch((e:Error)=>{if(active)setStatus(`读取已保存资料包失败：${e.message}`);});return()=>{active=false;selection.current++;};},[]);
 useEffect(()=>{const request=++pageRequest.current;setPage(null);setDirty(false);if(!selected||!fileId)return;const file=selected.files.find(f=>f.id===fileId);if(!file?.completed.includes(pageNumber)){setPageLoading(false);return;}setPageLoading(true);void apiRef.current(`/script-packages/${selected.id}/files/${fileId}/pages/${pageNumber}`).then((data:Page)=>{if(request===pageRequest.current)setPage(data);}).catch((e:Error)=>{if(request===pageRequest.current)setStatus(`读取页面失败：${e.message}`);}).finally(()=>{if(request===pageRequest.current)setPageLoading(false);});},[selected?.id,fileId,pageNumber,selected?.files.find(f=>f.id===fileId)?.completed.includes(pageNumber)]);
 const openPackage=(p:Package)=>{setSelected(p);setFileId(p.files[0]?.id??'');setPageNumber(1);setStatus('');};
 const choose=(files:File[])=>{const generation=++selection.current;const usable=files.filter(f=>accepted.test(f.name));const mapped:Entry[]=usable.map(file=>({file,path:(file as File&{webkitRelativePath?:string}).webkitRelativePath||file.name,kind:'document',id:'',done:0,ocr:0}));setEntries(mapped);setStatus(usable.length?`已选 ${usable.length} 个正文文件，正在校验文件；海报、音频会跳过。`:'没有找到 PDF、TXT 或 Markdown 正文文件。');void eachWithConcurrency(mapped,FILE_CONCURRENCY,async(entry,index)=>{try{const id=await digest(entry.file);if(generation===selection.current)setEntries(old=>old.map((x,i)=>i===index?{...x,id}:x));}catch(e){if(generation===selection.current)setEntries(old=>old.map((x,i)=>i===index?{...x,error:`校验失败：${(e as Error).message}`} :x));}});};
 const start=async()=>{if(running||!entries.length||entries.some(e=>!e.id))return;setRunning(true);setStatus('正在建立或恢复资料包…');let id='';let failures=0;try{
  const title=entries[0].path.split('/')[0]||'未命名剧本资料包';
  const manifest:Package=await api('/script-packages',{method:'POST',body:JSON.stringify({title,files:entries.map(e=>({id:e.id,path:e.path,size:e.file.size,kind:e.kind}))})});id=manifest.id;openPackage(manifest);
  await eachWithConcurrency(entries,FILE_CONCURRENCY,async entry=>{
   const saved=manifest.files.find(f=>f.id===entry.id)!;const completed=new Set(saved.completed);let pages=saved.pages??1,ocr=saved.ocrPages.length;
   const update=(error?:string)=>setEntries(old=>old.map(e=>e.id===entry.id?{...e,pages,done:completed.size,ocr,error}:e));
   try{
    update();setStatus(`正在处理（最多 ${FILE_CONCURRENCY} 个文件并行）：${entry.path}`);
    const register=async(total:number)=>{pages=total;await api(`/script-packages/${id}/files/${entry.id}`,{method:'PUT',body:JSON.stringify({pages:total})});update();};
    const send=async(n:number,text:string,method:'text'|'ocr')=>{if(completed.has(n))return;await api(`/script-packages/${id}/files/${entry.id}/pages/${n}`,{method:'PUT',body:JSON.stringify({text,method,reviewed:false})});completed.add(n);if(method==='ocr')ocr++;update();};
    if(saved.pages&&completed.size===saved.pages){if(saved.error)await register(saved.pages);return;}
    if(isPdf(entry.file.name))await readPdf(entry.file,completed,register,send);else{await register(1);await send(1,await entry.file.text(),'text');}
   }catch(error){failures++;const message=(error as Error).message;update(message);try{await api(`/script-packages/${id}/files/${entry.id}`,{method:'PUT',body:JSON.stringify({error:message.slice(0,1000)})});}catch{/* Local error remains visible if the connection is unavailable. */}}
  });
  await refresh(id);setStatus(failures?`${failures} 个文件未完成。其他文件已处理完毕；点击继续可重试，已保存和手工修改的页面会保留。`:'整套资料已保存。请逐页核对识别结果；保存资料不等于已生成可玩剧本。');await onDone();
 }catch(error){setStatus(`资料处理未完成：${(error as Error).message}`);onError((error as Error).message);}finally{setRunning(false);}};
 const savePage=async()=>{if(!selected||!page)return;setSaving(true);try{await api(`/script-packages/${selected.id}/files/${fileId}/pages/${pageNumber}`,{method:'PUT',body:JSON.stringify(page)});setDirty(false);await refresh(selected.id);setStatus(`第 ${pageNumber} 页已保存${page.reviewed?'并标记已核对':''}。`);}catch(e){onError((e as Error).message);}finally{setSaving(false);}};
 const download=async()=>{if(!selected)return;try{const result=await api(`/script-packages/${selected.id}/source`);const url=URL.createObjectURL(new Blob([result.source],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=result.filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){onError((e as Error).message);}};
 const compilePackage=async()=>{if(!selected?.complete||selected.characters>90000||compiling)return;setCompiling(true);try{await api(`/script-packages/${selected.id}/compile`,{method:'POST',body:JSON.stringify({})});setStatus('待审核草稿已生成，请在下方核对后发布。');await onDone();}catch(error){onError((error as Error).message);}finally{setCompiling(false);}};
 const locked=running||compiling||saving;const currentFile=selected?.files.find(f=>f.id===fileId);
 return <section className="panel package-upload">
  <div className="section-title"><div><h2>上传整套剧本资料</h2><p className="muted">手册、角色本与线索本保存在同一个资料包。文字层直接提取，扫描页使用 OCR；最多同时处理 {FILE_CONCURRENCY} 个文件。刷新后重新选择相同文件夹可续传，已保存页（含手工改正）会跳过。</p></div><div className="package-upload-buttons"><button className="secondary" disabled={locked||dirty} onClick={()=>input.current?.click()}>选择多个文件</button><button className="secondary" disabled={locked||dirty} onClick={()=>folderInput.current?.click()}>选择文件夹</button></div></div>
  <input ref={input} type="file" hidden multiple accept=".pdf,.txt,.md" onChange={e=>{choose([...e.target.files??[]]);e.target.value='';}}/><input ref={folderInput} type="file" hidden multiple accept=".pdf,.txt,.md" {...({webkitdirectory:'',directory:''} as any)} onChange={e=>{choose([...e.target.files??[]]);e.target.value='';}}/>
  {entries.length>0&&<><div className="package-files">{entries.map(e=><div className="package-file" key={e.path}><span>{e.path}</span><small>{e.error?`失败：${e.error}`:!e.id?'正在校验…':e.pages?`${e.done}/${e.pages} 页 · OCR ${e.ocr} 页`:'等待识别'}</small></div>)}</div><button disabled={locked||dirty||entries.some(e=>!e.id)} onClick={()=>void start()}>{running?'正在识别…':'开始 / 继续识别并保存资料包'}</button></>}
  {status&&<p role="status">{status}</p>}
  <h3>已保存资料包</h3><div className="package-controls"><select aria-label="已保存资料包" disabled={locked||dirty} value={selected?.id??''} onChange={e=>{const p=packages.find(p=>p.id===e.target.value);if(p)openPackage(p);}}><option value="">选择资料包（共 {packages.length} 个）</option>{packages.map(p=><option key={p.id} value={p.id}>{p.title} · {p.complete?'识别完整':'待续传'} · {p.characters.toLocaleString()} 字</option>)}</select><button className="secondary" disabled={locked||dirty} onClick={()=>void refresh(selected?.id).catch(e=>onError(e.message))}>刷新列表</button></div>
  {selected&&<><p>{selected.title}：{selected.files.reduce((n,f)=>n+f.completed.length,0)} / {selected.files.reduce((n,f)=>n+(f.pages??0),0)} 已知页面 · {selected.characters.toLocaleString()} 字 · OCR {selected.ocrPages} 页</p>
   {!selected.complete&&<p role="status">资料尚未完整识别，不能生成草稿或下载全文。请重新选择原文件夹并继续识别。</p>}
   {selected.characters>90000&&<p role="status">资料包超过当前可玩短本解析的 9 万字上限，尚不能转换为可玩剧本。原文完整保留，可逐页核对；全部识别完成后可下载全文，不会截断或拆成多个剧本。</p>}
   <div className="package-controls"><button className="secondary" disabled={locked||dirty||!selected.complete} onClick={()=>void download()}>下载资料包全文</button><button disabled={locked||dirty||!selected.complete||selected.characters>90000} onClick={()=>void compilePackage()}>{compiling?'生成中…':'生成待审核草稿'}</button></div>
   <h3>逐页核对与编辑</h3><p className="muted">请对照本地原始 PDF 核对；修改后先保存，再切换页面。</p>
   <div className="package-controls"><select aria-label="核对文件" value={fileId} disabled={locked||dirty} onChange={e=>{setFileId(e.target.value);setPageNumber(1);}}>{selected.files.map(f=><option key={f.id} value={f.id}>{f.path} · {f.completed.length}/{f.pages??'?'} 页{f.error?' · 失败':''}</option>)}</select><label>页码 <input aria-label="核对页码" type="number" min={1} max={currentFile?.pages??1} value={pageNumber} disabled={locked||dirty} onChange={e=>setPageNumber(Math.min(currentFile?.pages??1,Math.max(1,Number(e.target.value)||1)))}/></label><button className="secondary" disabled={locked||dirty||pageNumber<=1} onClick={()=>setPageNumber(n=>n-1)}>上一页</button><button className="secondary" disabled={locked||dirty||pageNumber>=(currentFile?.pages??1)} onClick={()=>setPageNumber(n=>n+1)}>下一页</button></div>
   {currentFile?.error&&<p role="alert">文件处理失败：{currentFile.error}</p>}
   {pageLoading?<p>正在读取页面…</p>:page?<><p>{page.method==='ocr'?'OCR 识别':'文字层提取'} · {page.reviewed?'已核对':'待核对'}{!page.text.trim()?' · 空白页，请对照原文确认':''}</p><textarea aria-label="页面原文" rows={16} style={{width:'100%'}} value={page.text} disabled={locked} onChange={e=>{setPage({...page,text:e.target.value,reviewed:false});setDirty(true);}}/><label><input type="checkbox" checked={page.reviewed} disabled={locked} onChange={e=>{setPage({...page,reviewed:e.target.checked});setDirty(true);}}/>已对照原文核对本页</label><div><button disabled={locked||!dirty} onClick={()=>void savePage()}>{saving?'保存中…':'保存本页'}</button>{dirty&&<span className="muted"> 尚有未保存修改</span>}</div></>:<p>该页尚未识别，请续传原始文件。</p>}
  </>}
 </section>;
}
