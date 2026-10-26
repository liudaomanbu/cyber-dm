import { mkdir,readFile,writeFile,rename,unlink } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const dataDir=resolve(process.env.CYBER_DM_DATA_DIR??'.data');
const profile=z.object({id:z.string().min(1).max(100),name:z.string().min(1),protocol:z.enum(['chat-completions','anthropic','responses']),baseUrl:z.url(),modelId:z.string().min(1),apiKey:z.string(),timeoutMs:z.number().int().min(1000).max(120000).default(30000)});
export const configSchema=z.object({providers:z.array(profile).max(30),compilerProviderId:z.string().default(''),roleModels:z.record(z.string(),z.string()),roleVoices:z.record(z.string(),z.object({provider:z.string().optional().default(''),voiceType:z.string().optional().default(''),voiceId:z.string().optional()})),linx:z.object({inputMode:z.enum(['callback','stt']).default('callback'),speechDeviceId:z.string().default(''),speechWsToken:z.string().default(''),speechClientId:z.string().default(''),speechWsUrl:z.string().default(''),publicBaseUrl:z.string().default(''),apiKey:z.string(),wsUrl:z.url(),wsToken:z.string(),deviceId:z.string(),clientId:z.string(),agentId:z.string(),callbackToken:z.string()})});
export type Config=z.infer<typeof configSchema>;
export type Provider=z.infer<typeof profile>;
export const defaultConfig:Config={providers:[],compilerProviderId:'',roleModels:{},roleVoices:{},linx:{inputMode:'callback',speechDeviceId:'',speechWsToken:'',speechClientId:'',speechWsUrl:'',publicBaseUrl:'',apiKey:'',wsUrl:'wss://xrobo-io.qiniuapi.com/v1/ws/',wsToken:'',deviceId:'',clientId:'cyber-dm-client',agentId:'',callbackToken:''}};
/** Each request/background callback must run in its owning application's context. */
export interface StorageBackend {
 load<T>(key:string,fallback:T):Promise<T>;
 save(key:string,data:unknown):Promise<void>;
 readBinary(key:string):Promise<Uint8Array>;
 writeBinary(key:string,data:Uint8Array):Promise<void>;
 deleteBinary(key:string):Promise<void>;
}
const storageContext=new AsyncLocalStorage<StorageBackend>();
// Await thenables inside the context: Fastify inject() starts lazily in .then().
export function runWithStorage<T>(backend:StorageBackend,callback:()=>T|PromiseLike<T>):Promise<T>{
 return storageContext.run(backend,async()=>await callback());
}
export async function load<T>(key:string,fallback:T):Promise<T>{
 const backend=storageContext.getStore();if(backend)return backend.load(key,fallback);
 try{return JSON.parse(await readFile(resolve(dataDir,key+'.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw e;}
}
export async function save(key:string,data:unknown){
 const backend=storageContext.getStore();if(backend)return backend.save(key,data);
 await mkdir(dataDir,{recursive:true,mode:0o700});const file=resolve(dataDir,key+'.json'),tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600});await rename(tmp,file);
}
export async function readBinary(key:string):Promise<Buffer>{
 const backend=storageContext.getStore();return backend?Buffer.from(await backend.readBinary(key)):readFile(resolve(dataDir,key));
}
export async function writeBinary(key:string,data:Uint8Array):Promise<void>{
 const backend=storageContext.getStore();if(backend)return backend.writeBinary(key,data);
 const file=resolve(dataDir,key);await mkdir(dirname(file),{recursive:true,mode:0o700});await writeFile(file,data,{mode:0o600});
}
export async function deleteBinary(key:string):Promise<void>{
 const backend=storageContext.getStore();if(backend)return backend.deleteBinary(key);
 await unlink(resolve(dataDir,key));
}
export const MASK='••••••••';
export function publicConfig(c:Config){return {...c,providers:c.providers.map(p=>({...p,apiKey:p.apiKey?MASK:''})),linx:{...c.linx,apiKey:c.linx.apiKey?MASK:'',wsToken:c.linx.wsToken?MASK:'',speechWsToken:c.linx.speechWsToken?MASK:'',callbackToken:c.linx.callbackToken?MASK:''}};}
export function mergeSecrets(next:Config,old:Config):Config {
 return {...next,providers:next.providers.map(p=>({...p,apiKey:p.apiKey===MASK?old.providers.find(o=>o.id===p.id)?.apiKey??'':p.apiKey})),linx:{...next.linx,...Object.fromEntries(['inputMode','speechDeviceId','speechWsToken','speechClientId','speechWsUrl'].map(k=>[k,old.linx[k as keyof Config['linx']]])),...Object.fromEntries(['apiKey','wsToken','callbackToken'].map(k=>[k,next.linx[k as keyof Config['linx']]===MASK?old.linx[k as keyof Config['linx']]:next.linx[k as keyof Config['linx']]]))}};
}
