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

test('library and readiness count the same selectable scripts without retaining the retired built-in',async()=>{
 const backend=memoryStorage();
 const instance=await runWithStorage(backend,()=>createApp({fastifyOptions:{logger:false}}));
 try{
  const bootstrap=await runWithStorage(backend,()=>instance.app.inject('/api/bootstrap'));
  const headers={'x-cyber-key':bootstrap.json().key};
  const get=(url:string)=>runWithStorage(backend,()=>instance.app.inject({url,headers}));
  const library=(await get('/api/scripts')).json();
  assert.equal(library.length,1);assert.equal(library[0].title,'闭馆之后');
  assert.equal(instance.scripts['after-hours'],undefined);
  const report=(await get('/api/readiness')).json();
  assert.equal(report.scripts,library.length);assert.equal(report.roles,4);
  // An unconfigured hidden script must not add invisible missing bindings.
  assert.ok(!report.items.some((item:any)=>item.detail.includes('after-hours/')));
  instance.scripts['another-script']={...structuredClone(instance.scripts['after-hours-live']),id:'another-script',title:'另一个剧本'};
  const multiple=(await get('/api/scripts')).json();
  const multiReport=(await get('/api/readiness')).json();
  assert.equal(multiple.length,2);assert.equal(multiReport.scripts,2);assert.equal(multiReport.roles,8);
  assert.ok(multiple.some((script:any)=>script.id==='another-script'));
 }finally{await instance.app.close();}
});
test('retirement removes only old built-in rooms and bindings and is idempotent',async()=>{
 const backend=memoryStorage();
 const {defaultConfig}=await import('../src/server/store.js');
 const {bindingKey}=await import('../src/core/bindings.js');
 const {createSession}=await import('../src/core/engine.js');
 const {parseScript}=await import('../src/core/script.js');
 const {readFileSync}=await import('node:fs');
 const old=parseScript(JSON.parse(readFileSync('examples/after-hours.json','utf8')));
 const live=parseScript(JSON.parse(readFileSync('examples/after-hours-live.json','utf8')));
 const custom={...structuredClone(live),id:'user-script'};
 const rooms=[old,live,custom].map(script=>createSession(script,'lin',{deferStart:true}));
 const config=structuredClone(defaultConfig);
 config.roleModels[bindingKey(old.id,'dm')]='old-model';
 config.roleModels[bindingKey(live.id,'dm')]='current-model';
 config.roleModels.lin='unscoped-model';
 config.roleVoices[bindingKey(old.id,'dm')]={voiceId:'keep-voice',provider:'',voiceType:''};
 await runWithStorage(backend,async()=>{
  await save('scripts',Object.fromEntries([old,live,custom].map(s=>[s.id,s])));
  await save('sessions',Object.fromEntries(rooms.map(s=>[s.id,s])));await save('config',config);
 });
 for(let i=0;i<2;i++){
  const instance=await runWithStorage(backend,()=>createApp({fastifyOptions:{logger:false}}));
  try{
   assert.deepEqual(Object.keys(instance.sessions).sort(),rooms.slice(1).map(s=>s.id).sort());
   assert.equal(instance.scripts[old.id],undefined);assert.ok(instance.scripts[custom.id]);
   const actual=instance.getConfig();assert.equal(actual.roleModels[bindingKey(live.id,'dm')],'current-model');
   assert.equal(actual.roleModels[bindingKey(live.id,'lin')],'unscoped-model');
   assert.equal(actual.roleVoices[bindingKey(live.id,'dm')].voiceId,'keep-voice');
   assert.equal(actual.roleModels[bindingKey(old.id,'dm')],undefined);assert.equal(actual.roleModels.lin,undefined);
  }finally{await instance.app.close();}
 }
 const persisted=await backend.load<Record<string,unknown>>('sessions',{});assert.equal(persisted[rooms[0].id],undefined);
});
