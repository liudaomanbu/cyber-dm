import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/server/app.js';
import {runWithStorage,type StorageBackend} from '../src/server/store.js';
function storage():StorageBackend{const data=new Map<string,unknown>();return {async load(k,f){return structuredClone(data.has(k)?data.get(k):f) as any},async save(k,v){data.set(k,structuredClone(v))},async readBinary(){throw new Error('unused')},async writeBinary(){},async deleteBinary(){}}}
test('script packages keep multiple source files and page OCR metadata together',async()=>{
 const backend=storage();const app=await runWithStorage(backend,()=>createApp({fastifyOptions:{logger:false}}));
 try{const boot=await runWithStorage(backend,()=>app.app.inject({url:'/api/bootstrap'}));const key=boot.json().key;const headers={'x-cyber-key':key};
  const files=[{id:'a'.repeat(64),path:'乱春/乱春手册.pdf',size:100,kind:'document'},{id:'b'.repeat(64),path:'乱春/角色本.pdf',size:200,kind:'document'}];
  const created=await runWithStorage(backend,()=>app.app.inject({method:'POST',url:'/api/script-packages',headers,payload:{title:'乱春',files}}));assert.equal(created.statusCode,200);const id=created.json().id;
  const page=await runWithStorage(backend,()=>app.app.inject({method:'PUT',url:`/api/script-packages/${id}/files/${files[0].id}`,headers,payload:{pages:2}}));assert.equal(page.statusCode,200);
  for(const n of [1,2]){const saved=await runWithStorage(backend,()=>app.app.inject({method:'PUT',url:`/api/script-packages/${id}/files/${files[0].id}/pages/${n}`,headers,payload:{text:`手册第${n}页`,method:n===1?'text':'ocr',reviewed:false}}));assert.equal(saved.statusCode,200);}
  const summary=await runWithStorage(backend,()=>app.app.inject({url:`/api/script-packages/${id}`,headers}));const body=summary.json();assert.equal(body.files.length,2);assert.equal(body.files[0].completed.length,2);assert.equal(body.files[0].ocrPages.length,1);assert.equal(body.files[1].completed.length,0);
 }finally{await app.app.close();}
});
test('a large real-world-shaped package survives reload, preserves reviewed corrections, and blocks playable compilation without truncation',async()=>{
 const backend=storage();let instance=await runWithStorage(backend,()=>createApp({fastifyOptions:{logger:false}}));
 const boot=await runWithStorage(backend,()=>instance.app.inject('/api/bootstrap'));const headers={'x-cyber-key':boot.json().key};
 const request=(method:'GET'|'POST'|'PUT',url:string,payload?:unknown)=>runWithStorage(backend,()=>instance.app.inject({method,url,headers,payload:payload as any}));
 const files=[{id:'c'.repeat(64),path:'乱春/手册.pdf',size:60000000,kind:'document'},{id:'d'.repeat(64),path:'乱春/角色本.pdf',size:60000000,kind:'document'}];
 try{
  const created=await request('POST','/api/script-packages',{title:'乱春',files});assert.equal(created.statusCode,200);const id=created.json().id;
  const incomplete=await request('POST',`/api/script-packages/${id}/compile`,{});assert.equal(incomplete.statusCode,400);assert.match(incomplete.json().error,/整个资料包/);
  for(const f of files)assert.equal((await request('PUT',`/api/script-packages/${id}/files/${f.id}`,{pages:1})).statusCode,200);
  const manual='手册完整内容'.repeat(10000),ocr='角色秘密识别稿'.repeat(8000);
  await request('PUT',`/api/script-packages/${id}/files/${files[0].id}/pages/1`,{text:manual,method:'text'});
  await request('PUT',`/api/script-packages/${id}/files/${files[1].id}/pages/1`,{text:ocr,method:'ocr'});
  const corrected=ocr+'人工纠正角色名';
  await request('PUT',`/api/script-packages/${id}/files/${files[1].id}/pages/1`,{text:corrected,method:'ocr',reviewed:true});
  await instance.app.close();instance=await runWithStorage(backend,()=>createApp({fastifyOptions:{logger:false}}));
  const resumed=(await request('POST','/api/script-packages',{title:'乱春',files:[...files].reverse()})).json();
  assert.equal(resumed.id,id);assert.equal(resumed.complete,true);assert.equal(resumed.characters,manual.length+corrected.length);assert.equal(resumed.ocrPages,1);
  const page=(await request('GET',`/api/script-packages/${id}/files/${files[1].id}/pages/1`)).json();assert.equal(page.text,corrected);assert.equal(page.reviewed,true);
  const source=(await request('GET',`/api/script-packages/${id}/source`)).json().source;
  assert.ok(source.includes(manual));assert.ok(source.includes(corrected));assert.match(source,/文件：乱春\/角色本.pdf；第 1 页；OCR 识别/);
  const compiled=await request('POST',`/api/script-packages/${id}/compile`,{});assert.equal(compiled.statusCode,400);assert.match(compiled.json().error,/9 万字/);
  assert.equal((await request('GET','/api/script-packages')).json().length,1);assert.equal((await request('GET','/api/drafts')).json().length,0);
  assert.equal((await request('GET','/api/scripts')).json().length,1,'source files never become separate playable scripts');
 }finally{await instance.app.close();}
});
