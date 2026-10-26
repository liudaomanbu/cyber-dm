import {test} from 'node:test';
import type {InjectOptions} from 'fastify';
import assert from 'node:assert/strict';
import {createApp} from '../src/server/app.js';
import {runWithStorage,load,save,readBinary,writeBinary,deleteBinary,type StorageBackend} from '../src/server/store.js';

function memoryStorage():StorageBackend {
 const values=new Map<string,unknown>(),files=new Map<string,Uint8Array>();
 return {
  async load<T>(key:string,fallback:T){return structuredClone(values.has(key)?values.get(key):fallback) as T;},
  async save(key,data){values.set(key,structuredClone(data));},
  async readBinary(key){const data=files.get(key);if(!data)throw new Error('Missing binary');return data.slice();},
  async writeBinary(key,data){files.set(key,data.slice());},
  async deleteBinary(key){files.delete(key);},
 };
}
test('storage context isolates concurrent JSON and binary operations across asynchronous continuations',async()=>{
 const stores=[memoryStorage(),memoryStorage()];
 await Promise.all(stores.map((backend,i)=>runWithStorage(backend,async()=>{
  await save('same-key',{owner:i});
  await new Promise(resolve=>setImmediate(resolve));
  await writeBinary('voice-samples/same-key',Buffer.from([i]));
  assert.deepEqual(await load('same-key',null),{owner:i});
  assert.deepEqual(await readBinary('voice-samples/same-key'),Buffer.from([i]));
 })));
 await runWithStorage(stores[0],()=>deleteBinary('voice-samples/same-key'));
 await runWithStorage(stores[0],()=>assert.rejects(()=>readBinary('voice-samples/same-key')));
 assert.deepEqual(await runWithStorage(stores[1],()=>readBinary('voice-samples/same-key')),Buffer.from([1]));
});

test('factory preserves browser guards and persists sessions through application recreation',async()=>{
 const storage=memoryStorage();
 const create=()=>runWithStorage(storage,()=>createApp({fastifyOptions:{logger:false}}));
 let instance=await create();
 const inject=(options:InjectOptions)=>runWithStorage(storage,async()=>await instance.app.inject(options));
 try{
  assert.equal(instance.app.server.listening,false);
  assert.equal((await inject({url:'/api/bootstrap',headers:{host:'untrusted.example'}})).statusCode,403);
  assert.equal((await inject({url:'/api/scripts'})).statusCode,401);
  const bootstrap=await inject({url:'/api/bootstrap'});
  const key=bootstrap.json().key;
  const headers={'x-cyber-key':key};
  assert.equal((await inject({url:'/api/scripts',headers:{...headers,origin:'https://untrusted.example'}})).statusCode,403);
  const scripts=(await inject({url:'/api/scripts',headers})).json();
  assert.equal(scripts.length,1);
  assert.equal(scripts[0].title,'闭馆之后');
  const created=await inject({method:'POST',url:'/api/sessions',headers,payload:{scriptId:scripts[0].id,roleId:scripts[0].roles[0].id}});
  assert.equal(created.statusCode,200);
  await instance.app.close();
  instance=await create();
  assert.equal((await inject({url:'/api/bootstrap'})).json().key,key);
  const sessions=(await inject({url:'/api/sessions',headers})).json();
  assert.equal(sessions.length,1);
  assert.equal(sessions[0].roleId,scripts[0].roles[0].id);
 }finally{await instance.app.close();}
});
