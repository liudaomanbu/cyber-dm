import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {load,save,type Config} from './store.js';
import {compileSource,type Draft} from './compiler.js';
import {RuleError} from '../core/engine.js';

const fileSchema=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),path:z.string().min(1).max(600),size:z.number().int().nonnegative(),kind:z.enum(['document','attachment'])});
const manifestSchema=z.object({title:z.string().min(1).max(160),files:z.array(fileSchema).min(1).max(300)});
export type PackageFile=z.infer<typeof fileSchema>&{pages?:number;completed:number[];ocrPages:number[];emptyPages:number[];characters:number;error?:string};
export type ScriptPackage={id:string;title:string;files:PackageFile[];createdAt:string;updatedAt:string;revision:number;draftId?:string};
export type SourcePage={page:number;text:string;method:'text'|'ocr';reviewed:boolean};
export function packageStatus(p:ScriptPackage){
 const documents=p.files.filter(f=>f.kind==='document');
 return {complete:documents.length>0&&documents.every(f=>f.pages!==undefined&&f.completed.length===f.pages&&!f.error),
  characters:documents.reduce((n,f)=>n+f.characters,0),ocrPages:documents.reduce((n,f)=>n+f.ocrPages.length,0),
  emptyPages:documents.reduce((n,f)=>n+f.emptyPages.length,0)};
}
const pageKey=(packageId:string,fileId:string,page:number)=>`script-package-${packageId}-${fileId}-${page}`;

export async function registerScriptPackages(app:FastifyInstance,options:{config:()=>Config;addDraft:(draft:Draft)=>Promise<void>}){
 const packages=await load<Record<string,ScriptPackage>>('script-packages',{});
 // Serialize writes so retries and concurrent tabs never lose page metadata.
 let queue=Promise.resolve();
 const mutate=<T>(work:()=>Promise<T>)=>{const next=queue.then(work);queue=next.then(()=>{},()=>{});return next;};
 const get=(id:string)=>{const p=packages[id];if(!p)throw new RuleError('资料包不存在');return p;};
 const summary=(p:ScriptPackage)=>({...p,...packageStatus(p)});
 const persist=async(p:ScriptPackage)=>{p.revision++;p.updatedAt=new Date().toISOString();await save('script-packages',packages);};
 app.get('/api/script-packages',async()=>Object.values(packages).map(summary));
 app.post('/api/script-packages',async req=>mutate(async()=>{
  const input=manifestSchema.parse(req.body);
  if(!input.files.some(f=>f.kind==='document'))throw new RuleError('请选择 PDF、TXT 或 Markdown 正文材料');
  if(new Set(input.files.map(f=>f.path)).size!==input.files.length)throw new RuleError('文件路径重复，请从同一个根目录选择文件');
  if(new Set(input.files.map(f=>f.id)).size!==input.files.length)throw new RuleError('文件标识重复');
  // Identical selections resume the same package; new material never overwrites it.
  const id=createHash('sha256').update(JSON.stringify(input.files.map(f=>[f.id,f.path]).sort())).digest('hex').slice(0,24);
  if(packages[id])return summary(packages[id]);
  const now=new Date().toISOString();
  const p:ScriptPackage={id,title:input.title,files:input.files.map(f=>({...f,completed:[],ocrPages:[],emptyPages:[],characters:0})),createdAt:now,updatedAt:now,revision:0};
  packages[id]=p;await persist(p);return summary(p);
 }));
 app.get('/api/script-packages/:id',async req=>summary(get((req.params as any).id)));
 app.put('/api/script-packages/:id/files/:fileId',async req=>mutate(async()=>{
  const {id,fileId}=req.params as any;const p=get(id);const f=p.files.find(f=>f.id===fileId&&f.kind==='document');
  if(!f)throw new RuleError('正文文件不存在');
  const body=z.object({pages:z.number().int().min(1).max(5000).optional(),error:z.string().max(1000).optional()}).parse(req.body);
  if(body.pages!==undefined){if(f.pages!==undefined&&body.pages!==f.pages)throw new RuleError('页数发生变化，请重新选择资料');f.pages=body.pages;}
  f.error=body.error;await persist(p);return summary(p);
 }));
 app.put('/api/script-packages/:id/files/:fileId/pages/:page',async req=>mutate(async()=>{
  const {id,fileId,page}=req.params as any;const p=get(id);const f=p.files.find(f=>f.id===fileId&&f.kind==='document');
  const num=Number(page);
  if(!f||!f.pages||!Number.isInteger(num)||num<1||num>f.pages)throw new RuleError('文件或页码无效');
  const data=z.object({text:z.string().max(100000),method:z.enum(['text','ocr']),reviewed:z.boolean().default(false)}).parse(req.body);
  const key=pageKey(id,fileId,num);const previous=await load<SourcePage|null>(key,null);
  await save(key,{page:num,...data});
  if(!f.completed.includes(num))f.completed.push(num);
  f.ocrPages=f.ocrPages.filter(n=>n!==num);if(data.method==='ocr')f.ocrPages.push(num);
  f.emptyPages=f.emptyPages.filter(n=>n!==num);if(!data.text.trim())f.emptyPages.push(num);
  f.characters+=data.text.length-(previous?.text.length??0);f.error=undefined;delete p.draftId;
  await persist(p);return {ok:true,page:num};
 }));
 app.get('/api/script-packages/:id/files/:fileId/pages/:page',async req=>{
  const {id,fileId,page}=req.params as any;const p=get(id);
  if(!p.files.some(f=>f.id===fileId))throw new RuleError('文件不存在');
  const data=await load<SourcePage|null>(pageKey(id,fileId,Number(page)),null);if(!data)throw new RuleError('该页尚未识别');return data;
 });
 async function sourceOf(p:ScriptPackage){
  const blocks=[`# 剧本资料包：${p.title}`];
  for(const f of p.files.filter(f=>f.kind==='document')){
   blocks.push(`\n## 文件：${f.path}`);
   for(let n=1;n<=(f.pages??0);n++){
    const page=await load<SourcePage|null>(pageKey(p.id,f.id,n),null);
    if(!page)throw new RuleError(`${f.path} 第 ${n} 页尚未识别`);
    blocks.push(`\n[文件：${f.path}；第 ${n} 页；${page.method==='ocr'?'OCR 识别':'文字层'}]\n${page.text}`);
   }
  }
  return blocks.join('\n');
 }
 app.get('/api/script-packages/:id/source',async(req,reply)=>{
  const p=get((req.params as any).id);if(!packageStatus(p).complete)throw new RuleError('请先完成所有正文文件的识别');
  return {filename:`${p.title}.md`,source:await sourceOf(p)};
 });
 app.post('/api/script-packages/:id/compile',async req=>{
  const p=structuredClone(get((req.params as any).id));const status=packageStatus(p);
  if(!status.complete)throw new RuleError('请先完成整个资料包的文字识别，不能把单份角色本当作完整剧本');
  if(status.characters>90000)throw new RuleError('资料已完整保存。此资料包超过当前可玩短本解析的 9 万字上限；可以逐页核对和下载全文，尚不能直接转换为可玩剧本。不会截断或拆成多个剧本。');
  const source=await sourceOf(p);
  const provider=options.config().providers.find(v=>v.id===options.config().compilerProviderId);
  if(!provider)throw new RuleError('请先在连接与声音中选择剧本解析模型');
  const draft=await compileSource(p.title,source,provider);
  if(status.ocrPages)draft.warnings.push('资料包含扫描页 OCR 结果，请对照原文件核对错字、人名和角色权限后再发布。');
  return mutate(async()=>{const current=get(p.id);if(current.revision!==p.revision)throw new RuleError('资料在解析期间发生变化，请重新解析');await options.addDraft(draft);current.draftId=draft.id;await persist(current);return {draftId:draft.id};});
 });
}
