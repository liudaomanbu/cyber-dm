import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import {apiRequest} from '../src/web/api.js';

test('browser requests support empty provider tests, JSON saves and multipart uploads',async()=>{
 const app=Fastify();await app.register(multipart);
 app.post('/api/providers/p/test',async req=>{
  assert.equal(req.headers['x-cyber-key'],'test-capability');
  assert.equal(req.headers['content-type'],undefined);
  return {ok:true};
 });
 app.put('/api/config',async req=>({body:req.body}));
 app.post('/api/upload',async req=>{const file=await req.file();return {text:(await file!.toBuffer()).toString()};});
 await app.listen({host:'127.0.0.1',port:0});
 const port=(app.server.address() as {port:number}).port;
 const realFetch=globalThis.fetch;
 globalThis.fetch=((path,options)=>realFetch(`http://127.0.0.1:${port}${path}`,options)) as typeof fetch;
 try{
  assert.deepEqual(await apiRequest('/providers/p/test','test-capability',{method:'POST'}),{ok:true});
  assert.deepEqual(await apiRequest('/config','test-capability',{method:'PUT',body:JSON.stringify({name:'deepseek'})}),{body:{name:'deepseek'}});
  const form=new FormData();form.append('file',new Blob(['script text']),'script.txt');
  assert.deepEqual(await apiRequest('/upload','test-capability',{method:'POST',body:form}),{text:'script text'});
 }finally{globalThis.fetch=realFetch;await app.close();}
});
