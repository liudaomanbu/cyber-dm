import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export const dataDir=resolve(process.env.CYBER_DM_DATA_DIR??'.data');
const profile=z.object({id:z.string().min(1).max(100),name:z.string().min(1),protocol:z.enum(['chat-completions','anthropic','responses']),baseUrl:z.url(),modelId:z.string().min(1),apiKey:z.string(),timeoutMs:z.number().int().min(1000).max(120000).default(30000)});
export const configSchema=z.object({providers:z.array(profile).max(30),compilerProviderId:z.string().default(''),roleModels:z.record(z.string(),z.string()),roleVoices:z.record(z.string(),z.object({provider:z.string().optional().default(''),voiceType:z.string().optional().default(''),voiceId:z.string().optional()})),linx:z.object({publicBaseUrl:z.string().default(''),apiKey:z.string(),wsUrl:z.url(),wsToken:z.string(),deviceId:z.string(),clientId:z.string(),agentId:z.string(),callbackToken:z.string()})});
export type Config=z.infer<typeof configSchema>;
export type Provider=z.infer<typeof profile>;
export const defaultConfig:Config={providers:[],compilerProviderId:'',roleModels:{},roleVoices:{},linx:{publicBaseUrl:'',apiKey:'',wsUrl:'wss://xrobo-io.qiniuapi.com/v1/ws/',wsToken:'',deviceId:'',clientId:randomUUID(),agentId:'',callbackToken:''}};
export async function load<T>(key:string,fallback:T):Promise<T>{try{return JSON.parse(await readFile(resolve(dataDir,key+'.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return fallback;throw e;}}
export async function save(key:string,data:unknown){await mkdir(dataDir,{recursive:true,mode:0o700});const file=resolve(dataDir,key+'.json'),tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(data,null,2),{mode:0o600});await rename(tmp,file);}
export const MASK='••••••••';
export function publicConfig(c:Config){return {...c,providers:c.providers.map(p=>({...p,apiKey:p.apiKey?MASK:''})),linx:{...c.linx,apiKey:c.linx.apiKey?MASK:'',wsToken:c.linx.wsToken?MASK:'',callbackToken:c.linx.callbackToken?MASK:''}};}
export function mergeSecrets(next:Config,old:Config):Config {
 return {...next,providers:next.providers.map(p=>({...p,apiKey:p.apiKey===MASK?old.providers.find(o=>o.id===p.id)?.apiKey??'':p.apiKey})),linx:{...next.linx,...Object.fromEntries(['apiKey','wsToken','callbackToken'].map(k=>[k,next.linx[k as keyof Config['linx']]===MASK?old.linx[k as keyof Config['linx']]:next.linx[k as keyof Config['linx']]]))}};
}
