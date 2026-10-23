import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const source = z.object({document:z.string().min(1), locator:z.string().min(1), quote:z.string().min(1)});
export const scriptSchema = z.object({
  schemaVersion:z.literal(1), id, title:z.string().min(1), introduction:z.string().min(1),
  titleSource:source.optional(), introductionSource:source.optional(),
  roles:z.array(z.object({id,name:z.string().min(1),description:z.string(),voiceHint:z.string(),source:source.optional()})).min(2).max(12),
  stages:z.array(z.object({id,title:z.string(),introduction:z.string(),kind:z.enum(['discussion','investigation','vote','reveal']),source:source.optional()})).min(2),
  facts:z.array(z.object({id,text:z.string().min(1),knownBy:z.array(id),unlockStage:id,source})),
  clues:z.array(z.object({id,title:z.string(),factId:id,unlockStage:id,discoverableBy:z.array(id),source:source.optional()})),
  utterances:z.array(z.object({id,roleId:id,stageIds:z.array(id).min(1),text:z.string().min(1),
    factIds:z.array(id),audience:z.enum(['public','private']),kind:z.enum(['statement','scripted_lie','question','fallback']),source})),
  solution:z.object({culpritRoleId:id,explanation:z.string().min(1),factIds:z.array(id).min(1),source:source.optional()}),
});
export type Script = z.infer<typeof scriptSchema>;

export function parseScript(input:unknown):Script {
  const s=scriptSchema.parse(input);
  const unique=(values:string[],label:string)=>{if(new Set(values).size!==values.length)throw new Error(`${label} ID 重复`);};
  unique(s.roles.map(x=>x.id),'角色'); unique(s.stages.map(x=>x.id),'阶段');
  unique(s.facts.map(x=>x.id),'事实');unique(s.clues.map(x=>x.id),'线索');unique(s.utterances.map(x=>x.id),'台词');
  if(s.roles.some(r=>r.id==='dm'))throw new Error('dm 是主持人保留 ID');
  const roles=new Set([...s.roles.map(r=>r.id),'dm']);
  const stages=new Set(s.stages.map(x=>x.id)); const facts=new Map(s.facts.map(x=>[x.id,x]));
  const requireId=(value:string,set:Set<string>,label:string)=>{if(!set.has(value))throw new Error(`${label}不存在：${value}`);};
  if(s.stages.at(-1)?.kind!=='reveal'||s.stages.at(-2)?.kind!=='vote')throw new Error('首版剧本需要以投票、揭晓阶段结束');
  if(s.stages.slice(0,-2).some(x=>['vote','reveal'].includes(x.kind)))throw new Error('投票和揭晓只能在终局出现');
  if(!s.stages.some(x=>x.kind==='investigation'))throw new Error('首版剧本至少需要一个搜证阶段');
  if(!s.clues.length)throw new Error('首版剧本至少需要一条可搜证线索');
  for(const f of s.facts){requireId(f.unlockStage,stages,'事实阶段');for(const r of f.knownBy)requireId(r,roles,'事实角色');}
  for(const c of s.clues){if(!facts.has(c.factId))throw new Error('线索引用不存在的事实');requireId(c.unlockStage,stages,'线索阶段');for(const r of c.discoverableBy)requireId(r,roles,'搜证角色');}
  for(const u of s.utterances){
    requireId(u.roleId,roles,'台词角色');for(const stage of u.stageIds)requireId(stage,stages,'台词阶段');
    for(const f of u.factIds)if(!facts.has(f))throw new Error('台词引用不存在的事实');
  }
  for(const role of roles)if(!s.utterances.some(u=>u.roleId===role))throw new Error(`${role==='dm'?'主持人':role} 缺少经审核台词`);
  requireId(s.solution.culpritRoleId,new Set(s.roles.map(x=>x.id)),'真相角色');
  for(const f of s.solution.factIds)if(!facts.has(f))throw new Error('结局引用不存在的事实');
  return s;
}
