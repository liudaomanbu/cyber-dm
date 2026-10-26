import type {FastifyInstance} from 'fastify';
import {randomBytes,timingSafeEqual,scryptSync} from 'node:crypto';
import {load,save} from './store.js';
const same=(a:string,b:string)=>{const aa=scryptSync(a,'cyber-dm-access',32),bb=scryptSync(b,'cyber-dm-access',32);return timingSafeEqual(aa,bb);};
export async function registerAccess(app:FastifyInstance,options:{accessCode?:string;publicOrigin?:string}){
 const attempts=new Map<string,{count:number;until:number}>();
 const sessions=()=>load<Record<string,number>>('access-sessions',{});
 const origin=options.publicOrigin?new URL(options.publicOrigin).origin:undefined;
 if(options.accessCode&&options.accessCode.length<16)throw new Error('CYBER_DM_ACCESS_CODE 至少需要 16 个字符');
 if(origin&&!options.accessCode)throw new Error('配置公网入口必须同时设置 CYBER_DM_ACCESS_CODE');
 const isAllowedHost=(host:string|undefined)=>{
  if(!host)return false;
  if(origin&&new URL(origin).host===host)return true;
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
 };
 app.addHook('onRequest',async(req,reply)=>{
  const path=req.url.split('?')[0];
  if(path.startsWith('/integrations/linx/')||path.startsWith('/voice-samples/'))return;
  if(!isAllowedHost(req.headers.host))return reply.code(403).send({error:'该访问地址未被允许，请配置 CYBER_DM_PUBLIC_ORIGIN'});
  const requestOrigin=req.headers.origin;
  if(requestOrigin&&new URL(requestOrigin).host!==req.headers.host)return reply.code(403).send({error:'不允许跨站请求'});
  if(path==='/api/access/status'||path==='/api/access/login')return;
  if(!path.startsWith('/api/')&&!path.startsWith('/voice/'))return;
  if(!options.accessCode)return;
  const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('cyber_session='))?.slice('cyber_session='.length);
  const active=await sessions();
  if(!cookie||(active[cookie]??0)<Date.now())return reply.code(401).send({error:'请先输入访问口令',loginRequired:true});
 });
 app.get('/api/access/status',async()=>({required:!!options.accessCode}));
 app.post('/api/access/login',async(req,reply)=>{
  if(!options.accessCode)return {ok:true};
  const now=Date.now();for(const [k,v]of attempts)if(v.until<now)attempts.delete(k);
  const prior=attempts.get(req.ip);if(prior&&prior.count>=5)return reply.code(429).send({error:'尝试次数过多，请 5 分钟后重试'});
  const input=(req.body as any)?.code;
  if(typeof input!=='string'||input.length>256||!same(input,options.accessCode)){
   attempts.set(req.ip,{count:(prior?.count??0)+1,until:prior?.until??now+300000});return reply.code(401).send({error:'访问口令不正确'});
  }
  attempts.delete(req.ip);const active=await sessions();for(const [id,expiry]of Object.entries(active))if(expiry<now)delete active[id];
  const token=randomBytes(32).toString('hex');active[token]=now+12*60*60*1000;await save('access-sessions',active);
  reply.header('Set-Cookie',`cyber_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${origin?.startsWith('https:')?'; Secure':''}`);
  return {ok:true};
 });
 app.post('/api/access/logout',async(req,reply)=>{
  const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('cyber_session='))?.slice('cyber_session='.length);if(cookie){const active=await sessions();delete active[cookie];await save('access-sessions',active);}
  reply.header('Set-Cookie','cyber_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return {ok:true};
 });
}
