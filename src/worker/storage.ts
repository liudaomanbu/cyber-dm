import type {StorageBackend} from '../server/store.js';

/** Structural subset shared by Durable Object SQLite and the test adapter. */
export interface SqliteStorage {
 sql:{exec(query:string,...bindings:(string|number|null|ArrayBuffer)[]):Iterable<Record<string,unknown>>};
 transactionSync<T>(callback:()=>T):T;
}
const CHUNK_BYTES=64*1024;

/** Chunked SQLite BLOBs avoid the Durable Object KV per-value size limit. */
export class WorkersSqliteStorage implements StorageBackend {
 constructor(private readonly storage:SqliteStorage){
  storage.sql.exec('CREATE TABLE IF NOT EXISTS app_storage_chunks (kind TEXT NOT NULL, key TEXT NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (kind, key, chunk))');
 }
 private read(kind:string,key:string):Uint8Array|undefined {
  const chunks=Array.from(this.storage.sql.exec('SELECT data FROM app_storage_chunks WHERE kind = ? AND key = ? ORDER BY chunk',kind,key),row=>{
   const value=row.data;
   if(value instanceof ArrayBuffer)return new Uint8Array(value);
   if(value instanceof Uint8Array)return value;
   throw new Error('Invalid persisted storage chunk');
  });
  if(!chunks.length)return undefined;
  const bytes=new Uint8Array(chunks.reduce((total,chunk)=>total+chunk.byteLength,0));
  let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
 }
 private writeChunks(kind:string,key:string,bytes:Uint8Array):void {
  this.storage.sql.exec('DELETE FROM app_storage_chunks WHERE kind = ? AND key = ?',kind,key);
  // An empty BLOB distinguishes an existing empty file from a missing file.
  for(let offset=0;offset<Math.max(1,bytes.byteLength);offset+=CHUNK_BYTES){
   // Buffer.slice() is a view: its .buffer may contain the entire upload
   // (or unrelated pooled bytes). Copy precisely this range into an owned array.
   const chunk=new Uint8Array(bytes.subarray(offset,offset+CHUNK_BYTES));
   if(chunk.byteLength===0)this.storage.sql.exec('INSERT INTO app_storage_chunks (kind, key, chunk, data) VALUES (?, ?, ?, zeroblob(0))',kind,key,0);
   else this.storage.sql.exec('INSERT INTO app_storage_chunks (kind, key, chunk, data) VALUES (?, ?, ?, ?)',kind,key,offset/CHUNK_BYTES,chunk.buffer as ArrayBuffer);
  }
 }
 private write(kind:string,key:string,bytes:Uint8Array):void {
  this.storage.transactionSync(()=>this.writeChunks(kind,key,bytes));
 }
 private encodeJson(data:unknown):Uint8Array {
  const json=JSON.stringify(data);
  if(json===undefined)throw new TypeError('Cannot persist an undefined JSON value');
  return new TextEncoder().encode(json);
 }
 /** Import records (including the caller's migration marker) and files atomically. */
 importSnapshot(records:Record<string,unknown>,binaries:Record<string,Uint8Array>):void {
  this.storage.transactionSync(()=>{
   for(const [key,value]of Object.entries(records))this.writeChunks('json',key,this.encodeJson(value));
   for(const [key,bytes]of Object.entries(binaries))this.writeChunks('binary',key,bytes);
  });
 }
 async load<T>(key:string,fallback:T):Promise<T>{
  const data=this.read('json',key);return data===undefined?fallback:JSON.parse(new TextDecoder().decode(data)) as T;
 }
 async save(key:string,data:unknown):Promise<void>{
  this.write('json',key,this.encodeJson(data));
 }
 async readBinary(key:string):Promise<Uint8Array>{
  const bytes=this.read('binary',key);if(bytes===undefined)throw Object.assign(new Error(`ENOENT: no such binary file, ${key}`),{code:'ENOENT'});return bytes;
 }
 async writeBinary(key:string,data:Uint8Array):Promise<void>{this.write('binary',key,data);}
 async deleteBinary(key:string):Promise<void>{
  this.storage.transactionSync(()=>{
   if(!this.storage.sql.exec('SELECT data FROM app_storage_chunks WHERE kind = ? AND key = ? LIMIT 1','binary',key)[Symbol.iterator]().next().done){
    this.storage.sql.exec('DELETE FROM app_storage_chunks WHERE kind = ? AND key = ?','binary',key);
   }else throw Object.assign(new Error(`ENOENT: no such binary file, ${key}`),{code:'ENOENT'});
  });
 }
}
