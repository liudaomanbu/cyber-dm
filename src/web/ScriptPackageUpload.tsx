import React,{useRef,useState} from 'react';
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
async function readPdf(file:File,onPages:(pages:number)=>Promise<void>,onPage:(page:number,text:string,method:'text'|'ocr')=>Promise<void>){
 const pdfjs:any=await import('pdfjs-dist/legacy/build/pdf.mjs');
 pdfjs.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.296/pdf.worker.min.mjs';
 const pdf=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
 await onPages(pdf.numPages);
 let worker:any;
 try{
  for(let n=1;n<=pdf.numPages;n++){
   const page=await pdf.getPage(n);const content=await page.getTextContent();const text=content.items.map((item:any)=>item.str??'').join('\n');
   if(textLength(text)>=12){await onPage(n,text,'text');page.cleanup();continue;}
   worker??=await createWorker('chi_sim+eng',1,{workerPath:'/ocr/worker.min.js',langPath:'https://tessdata.projectnaptha.com/4.0.0',corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm.js'});
   const result=await worker.recognize(await renderPage(page));await onPage(n,result.data.text??'','ocr');
   page.cleanup();
  }
 }finally{if(worker)await worker.terminate();pdf.destroy();}
 return pdf.numPages;
}
export function ScriptPackageUpload({api,onDone,onError}:{api:Api;onDone:()=>Promise<void>|void;onError:(message:string)=>void}){
 const input=useRef<HTMLInputElement>(null);const folderInput=useRef<HTMLInputElement>(null);const [entries,setEntries]=useState<Entry[]>([]);const [running,setRunning]=useState(false);const [compiling,setCompiling]=useState(false);const [status,setStatus]=useState('');const [packageId,setPackageId]=useState('');
 const choose=(files:File[])=>{const usable=files.filter(f=>accepted.test(f.name));const mapped=usable.map(file=>({file,path:(file as File&{webkitRelativePath?:string}).webkitRelativePath||file.name,kind:'document' as const,id:'',done:0,ocr:0}));setEntries(mapped);setPackageId('');setStatus(usable.length?`已选 ${usable.length} 个正文文件；海报、音频会跳过。`:'没有找到 PDF、TXT 或 Markdown 正文文件。');void (async()=>{await Promise.all(mapped.map(async(entry,i)=>{const id=await digest(entry.file);setEntries(old=>old.map((x,j)=>j===i?{...x,id}:x));}));})();};
 const start=async()=>{if(running||!entries.length||entries.some(e=>!e.id))return;setRunning(true);setStatus('正在建立资料包…');try{
  const title=entries.map(e=>e.path.split('/')[0]).find(Boolean)||'未命名剧本资料包';
  const manifest=await api('/script-packages',{method:'POST',body:JSON.stringify({title,files:entries.map(e=>({id:e.id,path:e.path,size:e.file.size,kind:e.kind}))})});setPackageId(manifest.id);
  await eachWithConcurrency(entries,FILE_CONCURRENCY,async entry=>{
   setStatus(`正在并行识别资料（最多 ${FILE_CONCURRENCY} 个文件）：${entry.path}`);let pages=1;let done=0;let ocr=0;
   const send=async(page:number,text:string,method:'text'|'ocr')=>{await api(`/script-packages/${manifest.id}/files/${entry.id}/pages/${page}`,{method:'PUT',body:JSON.stringify({text,method,reviewed:false})});done=page;if(method==='ocr')ocr++;setEntries(old=>old.map(e=>e.id===entry.id?{...e,done,ocr,pages}:e));};
   if(isPdf(entry.file.name))await readPdf(entry.file,async total=>{pages=total;await api(`/script-packages/${manifest.id}/files/${entry.id}`,{method:'PUT',body:JSON.stringify({pages:total})});setEntries(old=>old.map(e=>e.id===entry.id?{...e,pages:total}:e));},send);else{pages=1;await api(`/script-packages/${manifest.id}/files/${entry.id}`,{method:'PUT',body:JSON.stringify({pages:1})});await send(1,await entry.file.text(),'text');}
   setEntries(old=>old.map(e=>e.id===entry.id?{...e,pages,done,ocr}:e));
  });
  setStatus('资料包已保存。请先逐页核对 OCR，再生成待审核草稿。');await onDone();
 }catch(error){const message=(error as Error).message;setStatus('资料包处理未完成');onError(message);}finally{setRunning(false);}};
 const compilePackage=async()=>{if(!packageId||compiling)return;setCompiling(true);try{await api(`/script-packages/${packageId}/compile`,{method:'POST',body:JSON.stringify({})});setStatus('待审核草稿已生成，请在下方核对后发布。');await onDone();}catch(error){onError((error as Error).message);}finally{setCompiling(false);}};
 return <section className="panel package-upload"><div className="section-title"><div><h2>上传整套剧本资料</h2><p className="muted">适合《乱春》这种“手册＋角色本＋线索本”的多文件资料包。PDF 页面会先渲染为图片：有文字层的直接提取，扫描页才 OCR；文件之间最多同时处理 {FILE_CONCURRENCY} 个，原文件不会被改写。</p></div><div className="package-upload-buttons"><button className="secondary" disabled={running} onClick={()=>input.current?.click()}>选择多个文件</button><button className="secondary" disabled={running} onClick={()=>folderInput.current?.click()}>选择文件夹</button></div></div><input ref={input} type="file" hidden multiple accept=".pdf,.txt,.md" onChange={e=>{choose([...e.target.files??[]]);e.target.value='';}}/><input ref={folderInput} type="file" hidden multiple accept=".pdf,.txt,.md" {...({webkitdirectory:'',directory:''} as any)} onChange={e=>{choose([...e.target.files??[]]);e.target.value='';}}/>{entries.length>0&&<><div className="package-files">{entries.map(e=><div className="package-file" key={e.id||e.path}><span>{e.path}</span><small>{e.pages?`${e.done}/${e.pages} 页${e.ocr?` · OCR ${e.ocr} 页`:''}`:'等待识别'}</small></div>)}</div><div className="package-controls"><button disabled={running||entries.some(e=>!e.id)} onClick={()=>void start()}>{running?'正在识别…':'开始识别并保存资料包'}</button>{status&&<span className="muted">{status}</span>}{packageId&&<button className="secondary" disabled={running||compiling} onClick={()=>void compilePackage()}>{compiling?'生成中…':'生成待审核草稿'}</button>}</div></>}</section>;
}
