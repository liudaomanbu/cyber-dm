import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {WorkersSqliteStorage,type SqliteStorage} from '../src/worker/storage.js';

function database(){
 const db=new DatabaseSync(':memory:');let failAfter=Infinity;
 const storage:SqliteStorage={
  sql:{exec(query,...bindings){
   if(query.startsWith('INSERT')&&failAfter--<=0)throw new Error('Simulated write failure');
   const statement=db.prepare(query);
   const values=bindings.map(value=>value instanceof ArrayBuffer?new Uint8Array(value):value);
   return query.startsWith('SELECT')?statement.all(...values):(statement.run(...values),[]);
  }},
  transactionSync(callback){
   db.exec('BEGIN');try{const result=callback();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  },
 };
 return {db,storage,fail:(after=0)=>{failAfter=after;}};
}
test('SQLite storage chunks large JSON and binary, separates namespaces, and survives recreation',async()=>{
 const {db,storage}=database();try{
  let backend=new WorkersSqliteStorage(storage);
  const data={text:'中文'.repeat(80000)};
  const bytes=Uint8Array.from({length:200000},(_,i)=>i%251);
  await backend.save('shared',data);await backend.writeBinary('shared',bytes);
  backend=new WorkersSqliteStorage(storage);
  assert.deepEqual(await backend.load('shared',null),data);
  assert.deepEqual(await backend.readBinary('shared'),bytes);
  assert.equal(db.prepare('SELECT MAX(length(data)) AS size FROM app_storage_chunks').get()?.size,65536);
  await backend.writeBinary('shared',new Uint8Array());assert.equal((await backend.readBinary('shared')).length,0);
  await backend.deleteBinary('shared');assert.deepEqual(await backend.load('shared',null),data);
  await assert.rejects(()=>backend.readBinary('shared'),{code:'ENOENT'});
  await assert.rejects(()=>backend.deleteBinary('shared'),{code:'ENOENT'});
  assert.deepEqual(await backend.load('absent',{fallback:true}),{fallback:true});
 }finally{db.close();}
});
test('SQLite replacement rolls back deletion when inserting new chunks fails',async()=>{
 const {db,storage,fail}=database();try{
  const backend=new WorkersSqliteStorage(storage);await backend.save('state',{version:1});
  fail();await assert.rejects(()=>backend.save('state',{version:2}),/Simulated/);
  assert.deepEqual(await backend.load('state',null),{version:1});
 }finally{db.close();}
});
test('runWithStorage resolves lazy Fastify inject inside ALS without touching fallback files',async()=>{
 const directory=await mkdtemp(resolve(tmpdir(),'cyber-dm-als-'));
 try{
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',`
   import assert from 'node:assert/strict';
   import {readdir} from 'node:fs/promises';
   import Fastify from 'fastify';
   import {runWithStorage,save} from './src/server/store.ts';
   const writes=[];
   const backend={async save(key,data){writes.push([key,data]);}};
   const app=Fastify();app.post('/save',async()=>{await save('regression',{ok:true});return {ok:true};});
   await app.ready();
   const response=await runWithStorage(backend,()=>app.inject({method:'POST',url:'/save'}));
   assert.equal(response.statusCode,200);
   assert.deepEqual(writes,[['regression',{ok:true}]]);
   assert.deepEqual(await readdir(process.env.CYBER_DM_DATA_DIR),[]);
   await app.close();
  `],{cwd:resolve('.'),env:{...process.env,CYBER_DM_DATA_DIR:directory},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('snapshot imports JSON, migration marker and binary in one transaction and rolls back every key on failure',async()=>{
 const {db,storage,fail}=database();try{
  const backend=new WorkersSqliteStorage(storage);
  await backend.save('state',{version:1});await backend.writeBinary('sample',new Uint8Array([1]));
  // Fail only after two JSON records and one binary replacement have succeeded.
  fail(3);
  assert.throws(()=>backend.importSnapshot({state:{version:2},migration:{done:true}},{sample:new Uint8Array([2]),second:new Uint8Array([3])}),/Simulated/);
  assert.deepEqual(await backend.load('state',null),{version:1});
  assert.equal(await backend.load('migration',null),null);
  assert.deepEqual(await backend.readBinary('sample'),new Uint8Array([1]));
  await assert.rejects(()=>backend.readBinary('second'),{code:'ENOENT'});
  fail(Infinity);
  backend.importSnapshot({state:{version:2},migration:{done:true}},{sample:new Uint8Array([2]),second:new Uint8Array([3])});
  assert.deepEqual(await backend.load('state',null),{version:2});
  assert.deepEqual(await backend.load('migration',null),{done:true});
  assert.deepEqual(await backend.readBinary('sample'),new Uint8Array([2]));
  assert.deepEqual(await backend.readBinary('second'),new Uint8Array([3]));
 }finally{db.close();}
});


test('binary Buffer uploads preserve exact bytes and never persist backing pools or duplicate chunks',async()=>{
 const {db,storage}=database();try{
  const backend=new WorkersSqliteStorage(storage);
  for(const size of [1024,65536,65537,1075456]){
   const backing=Buffer.alloc(size+128,0xee);
   const upload=backing.subarray(64,64+size);
   for(let i=0;i<upload.length;i++)upload[i]=i%251;
   await backend.writeBinary('upload',upload);
   const restored=await backend.readBinary('upload');
   assert.equal(restored.byteLength,upload.byteLength);
   assert.deepEqual(Buffer.from(restored),upload);
   assert.ok(Number(db.prepare('SELECT MAX(length(data)) AS size FROM app_storage_chunks').get()?.size)<=65536);
  }
  const snapshotBuffer=Buffer.from([1,2,3,4]);
  backend.importSnapshot({}, {'snapshot':snapshotBuffer.subarray(1,3)});
  assert.deepEqual(await backend.readBinary('snapshot'),new Uint8Array([2,3]));
 }finally{db.close();}
});
