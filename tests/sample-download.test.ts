import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import createRouter from '../src/worker/router.js';
import {registerLinxApi} from '../src/server/linx-api.js';
import {defaultConfig,runWithStorage,type StorageBackend} from '../src/server/store.js';

for(const runtime of ['node','worker'])test(`${runtime}: sample links support downloader HEAD, byte ranges and reject expired or wrong tokens`,async()=>{
 const id='12345678-1234-4234-8234-123456789012',token='a'.repeat(64);
 const bytes=Buffer.from('RIFFabcdefghijklmnop');
 const records:Record<string,any>={'voice-samples':{[id]:{id,token,mime:'audio/wav',expires:Date.now()+60000}}};
 const backend:StorageBackend={async load(key,fallback){return records[key]??fallback;},async save(key,data){records[key]=data;},async readBinary(){return bytes;},async writeBinary(){},async deleteBinary(){}};
 const app=runtime==='node'?Fastify():createRouter();
 const config=structuredClone(defaultConfig);config.linx.publicBaseUrl='https://example.com';
 await runWithStorage(backend,()=>registerLinxApi(app,{getConfig:()=>config,setConfig:async()=>{},scripts:()=>({})}));
 const url=`/voice-samples/${id}/${token}/reference.wav`;
 const inject=(options:any)=>runWithStorage(backend,()=>app.inject(options));
 try{
  const head=await inject({method:'HEAD',url});assert.equal(head.statusCode,200);assert.equal(head.headers['content-length'],String(bytes.length));assert.equal(head.rawPayload.length,0);
  const get=await inject({url});assert.equal(get.statusCode,200);assert.deepEqual(get.rawPayload,bytes);assert.equal(get.headers['content-type'],'audio/wav');
  const partial=await inject({url,headers:{range:'bytes=2-6'}});assert.equal(partial.statusCode,206);assert.equal(partial.headers['content-range'],`bytes 2-6/${bytes.length}`);assert.deepEqual(partial.rawPayload,bytes.subarray(2,7));
  const suffix=await inject({url,headers:{range:'bytes=-3'}});assert.deepEqual(suffix.rawPayload,bytes.subarray(-3));
  const open=await inject({url,headers:{range:'bytes=8-'}});assert.deepEqual(open.rawPayload,bytes.subarray(8));
  assert.equal((await inject({url,headers:{range:'bytes=999-'}})).statusCode,416);
  assert.equal((await inject({url,headers:{range:'bytes=0-1,3-4'}})).statusCode,416);
  assert.equal((await inject({url:url.replace(token,'b'.repeat(64))})).statusCode,404);
  assert.equal((await inject({url:`/voice-samples/${id}/${token}`})).statusCode,200,'old links remain valid');
  assert.equal(records['voice-samples'][id].readCount,5);
  records['voice-samples'][id].expires=0;
  assert.equal((await inject({method:'HEAD',url})).statusCode,404);
 }finally{await app.close();}
});
