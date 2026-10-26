import { readFile,access } from 'node:fs/promises';
import { resolve } from 'node:path';
import staticPlugin from '@fastify/static';
import { createApp } from './app.js';
import { registerVoice } from './voice.js';

const certPath=process.env.CYBER_DM_TLS_CERT;
const keyPath=process.env.CYBER_DM_TLS_KEY;
if(Boolean(certPath)!==Boolean(keyPath))throw new Error('CYBER_DM_TLS_CERT 与 CYBER_DM_TLS_KEY 必须同时配置');
const httpsOptions=certPath&&keyPath?{cert:await readFile(resolve(certPath)),key:await readFile(resolve(keyPath))}:undefined;
const {app}=await createApp({accessCode:process.env.CYBER_DM_ACCESS_CODE,publicOrigin:process.env.CYBER_DM_PUBLIC_ORIGIN,fastifyOptions:httpsOptions?{https:httpsOptions}:undefined,registerVoice});
try{await access(resolve('dist/index.html'));await app.register(staticPlugin,{root:resolve('dist')});}catch{}
await app.listen({port:Number(process.env.PORT??3001),host:process.env.HOST??'127.0.0.1'});
