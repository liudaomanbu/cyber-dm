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
