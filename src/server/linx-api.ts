import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Config } from './store.js';
import { load, save, readBinary, writeBinary, deleteBinary } from './store.js';
import type { Script } from '../core/script.js';
import { bindingKey } from '../core/bindings.js';
import { chooseVoices, voiceSchema, type Voice } from '../core/voices.js';
import { randomBytes, randomUUID } from 'node:crypto';

const LINX_ORIGIN = 'https://xrobo.qiniu.com';
const cloneId = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const cloneSchema = z.object({
  id: cloneId,
  name: z.string(),
  language: z.string(),
  demo_url: z.string().optional().default(''),
  state: z.string(),
  tier: z.enum(['free', 'lite', 'pro']),
  expired_time: z.string().optional().default(''),
}).passthrough();
type VoiceClone = z.infer<typeof cloneSchema>;

function errorDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const value = body as Record<string, unknown>;
  return String((value.error && typeof value.error === 'object' ? (value.error as Record<string, unknown>).message : undefined)
    ?? value.message ?? value.msg ?? '').trim().slice(0, 240);
}

/** Call the documented Linx envelope and return its `data` member. */
export async function linxRequest(config: Config, path: string, method = 'GET', body?: unknown, timeoutMs = 30000): Promise<any> {
  if (!config.linx.apiKey) throw new Error('请先填写灵矽平台 API Key');
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('灵矽 API 路径无效');
  let result: Response;
  try {
    result = await fetch(`${LINX_ORIGIN}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.linx.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`灵矽 API 请求失败：${error instanceof Error ? error.message : '网络错误'}`);
  }
  let payload: any;
  try {
    payload = await result.json();
  } catch {
    throw new Error(`灵矽 API 返回了无效 JSON（HTTP ${result.status}）`);
  }
  if (!result.ok) throw new Error(`灵矽 API HTTP ${result.status}${errorDetail(payload) ? `：${errorDetail(payload)}` : ''}`);
  if (!payload || typeof payload !== 'object' || !('code' in payload)) throw new Error('灵矽 API 返回格式无效：缺少 code');
  if (payload.code !== 0 && payload.code !== '0') {
    throw new Error(`灵矽 API 错误 ${String(payload.code)}: ${errorDetail(payload) || '请求失败'}`);
  }
  return payload.data;
}

type Sample = { id: string; token: string; expires: number; mime: string; cloneId?: string; lastReadAt?:number; lastReadMethod?:string; readCount?:number };

function publicBase(base: string): string {
  if (!base) throw new Error('请先配置公网 HTTPS 地址，灵矽需要通过临时链接读取参考音频');
  let parsed: URL;
  try { parsed = new URL(base); } catch { throw new Error('参考音频地址必须是有效的 HTTPS URL'); }
  if (parsed.protocol !== 'https:' || parsed.search || parsed.hash) throw new Error('参考音频地址必须使用无查询参数的 HTTPS URL');
  return parsed.toString().replace(/\/$/, '');
}

function sampleUrl(base: string, sample: Sample): string {
  return `${publicBase(base)}/voice-samples/${encodeURIComponent(sample.id)}/${encodeURIComponent(sample.token)}/reference.${sample.mime==='audio/wav'?'wav':sample.mime==='audio/mpeg'?'mp3':'m4a'}`;
}

export function catalogVoices(data: unknown): Voice[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as any).voices)
      ? (data as any).voices
      : data && typeof data === 'object' && Array.isArray((data as any).items)
        ? (data as any).items
        : undefined;
  if (!list) throw new Error('灵矽音色目录返回格式无效：缺少 voices');
  return z.array(voiceSchema).parse(list);
}

function clones(data: unknown): VoiceClone[] {
  const list = data && typeof data === 'object' && Array.isArray((data as any).voices) ? (data as any).voices : undefined;
  if (!list) throw new Error('灵矽复刻音色列表返回格式无效：缺少 voices');
  return z.array(cloneSchema).parse(list);
}

export async function registerLinxApi(app: FastifyInstance, options: {
  getConfig: () => Config;
  setConfig: (c: Config) => Promise<void>;
  scripts: () => Record<string, Script>;
}) {
  const samples = await load<Record<string, Sample>>('voice-samples', {});
  type Attempt={note:string;phase?:'submitting'|'accepted'|'uncertain';sampleId?:string;startedAt?:number};
  const attempts = await load<Record<string, Attempt>>('voice-clone-attempts', {});
  // Never replay a potentially charged PUT after a restart. GET reconciles it.
  for(const attempt of Object.values(attempts))if(attempt.phase==='submitting'){
    attempt.phase='uncertain';attempt.note='服务在提交期间重启，结果尚未确认。正在查询平台状态；不会自动重复扣减训练额度。';
  }
  let writes=Promise.resolve();
  const persist=()=>{writes=writes.catch(()=>{}).then(()=>save('voice-clone-attempts',attempts));return writes;};
  await persist();
  const pending = new Set<string>();
  const jobs=new Map<string,Promise<void>>();
  const annotate = (voice: VoiceClone) => ({...voice,
    sampleRead: attempts[voice.id]?.sampleId ? (()=>{const s=samples[attempts[voice.id].sampleId!];return s?{lastReadAt:s.lastReadAt,lastReadMethod:s.lastReadMethod,readCount:s.readCount??0}:undefined;})() : undefined,
    submissionPhase: ['Training','Success'].includes(voice.state)?'accepted':attempts[voice.id]?.phase,
    submissionNote: ['Init','Failed'].includes(voice.state) ? attempts[voice.id]?.note : undefined});
  const cleanup = async () => {
    for (const [id, sample] of Object.entries(samples)) {
      if (sample.expires < Date.now()&&!jobs.has(sample.cloneId??'')) {
        delete samples[id];
        await deleteBinary(`voice-samples/${id}`).catch(() => undefined);
      }
    }
    await save('voice-samples', samples);
  };
  await cleanup();

  app.get('/api/linx/samples/latest',async()=>{
    const sample=Object.values(samples).filter(s=>s.expires>Date.now()).sort((a,b)=>b.expires-a.expires)[0];
    return sample?{sampleId:sample.id,cloneId:sample.cloneId,url:sampleUrl(options.getConfig().linx.publicBaseUrl,sample),expiresAt:new Date(sample.expires).toISOString()}:null;
  });

  app.get('/api/linx/voices', async () => catalogVoices(await linxRequest(options.getConfig(), '/v1/voices')));

  app.post('/api/linx/voices/assign', async (req) => {
    const { scriptId } = z.object({ scriptId: z.string() }).parse(req.body);
    const script = options.scripts()[scriptId];
    if (!script) throw new Error('剧本不存在');
    const voices = catalogVoices(await linxRequest(options.getConfig(), '/v1/voices'));
    const selected = chooseVoices([{ id: 'dm', name: '主持人', voiceHint: '沉稳、清晰、有声书' }, ...script.roles], voices);
    const config = options.getConfig();
    const bindings = { ...config.roleVoices };
    for (const [roleId, voice] of Object.entries(selected)) {
      // The documented native WebSocket path uses this catalog id directly.
      // Keep legacy callback fields when a catalog version supplies them, but
      // do not require undocumented provider/voice_type mappings.
      bindings[bindingKey(script.id, roleId)] = {
        voiceId: voice.id,
        provider: voice.provider ?? '',
        voiceType: voice.voice_type ?? '',
      };
    }
    await options.setConfig({ ...config, roleVoices: bindings });
    const assignedKeys = Object.keys(selected).map((roleId) => bindingKey(script.id, roleId));
    return {
      selected,
      needsMapping: assignedKeys.filter((key) => !bindings[key].voiceId),
    };
  });

  app.get('/api/linx/clones', async () => {
    const data = await linxRequest(options.getConfig(), '/v1/voice-clones');
    return { ...(data as Record<string, unknown>), voices: clones(data).map(annotate) };
  });
  app.get('/api/linx/clones/:id', async (req) => {
    const { id } = z.object({ id: cloneId }).parse(req.params);
    return annotate(cloneSchema.parse(await linxRequest(options.getConfig(), `/v1/voice-clones/${encodeURIComponent(id)}`)));
  });

  app.post('/api/linx/samples', async (req) => {
    await cleanup();
    const file = await req.file();
    if (!file) throw new Error('请选择参考音频');
    const ext = file.filename.toLowerCase().split('.').at(-1);
    if (!['wav', 'mp3', 'm4a'].includes(ext ?? '')) throw new Error('参考音频支持 WAV、MP3 或 M4A');
    const base = publicBase(options.getConfig().linx.publicBaseUrl);
    const bytes = await file.toBuffer();
    if (bytes.length < 1024) throw new Error('参考音频过短或无效');
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const sample: Sample = {
      id,
      token,
      expires: Date.now() + 60 * 60 * 1000,
      mime: ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4',
    };
    await writeBinary(`voice-samples/${id}`, bytes);
    samples[id] = sample;
    await save('voice-samples', samples);
    return { sampleId: id, url: sampleUrl(base,sample), expiresAt: new Date(sample.expires).toISOString() };
  });

  const serveSample: import('fastify').RouteHandlerMethod = async (req, reply) => {
    const { id, token } = z.object({ id: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params);
    const sample = samples[id];
    if (!sample || sample.token !== token || sample.expires < Date.now()) return reply.code(404).send({ error: 'Not found' });
    const bytes=await readBinary(`voice-samples/${sample.id}`);
    reply.header('Cache-Control','no-store').header('Accept-Ranges','bytes').type(sample.mime);
    // Some media downloaders probe metadata before downloading the audio.
    if(req.method==='HEAD')return reply.header('Content-Length',String(bytes.length)).send(bytes);
    const range=req.headers.range;
    let start=0,end=bytes.length-1;
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match||(!match[1]&&!match[2]))return reply.code(416).header('Content-Range',`bytes */${bytes.length}`).send();
      if(!match[1])start=Math.max(0,bytes.length-Number(match[2]));
      else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=bytes.length)return reply.code(416).header('Content-Range',`bytes */${bytes.length}`).send();
      reply.code(206).header('Content-Range',`bytes ${start}-${end}/${bytes.length}`);
    }
    sample.lastReadAt=Date.now();sample.lastReadMethod=range?'GET range':'GET';sample.readCount=(sample.readCount??0)+1;
    await save('voice-samples',samples);
    return reply.header('Content-Length',String(end-start+1)).send(bytes.subarray(start,end+1));
  };
  app.get('/voice-samples/:id/:token',serveSample);
  app.get('/voice-samples/:id/:token/:filename',serveSample);

  const train = async (config:Config, slot:VoiceClone, sample:Sample, name:string) => {
    if(jobs.has(slot.id))return annotate(slot);
    // Extend only this authorized submission's read window, never the audio's identity.
    sample.expires=Math.max(sample.expires,Date.now()+10*60*1000);
    await save('voice-samples',samples);
    attempts[slot.id] = {phase:'submitting',sampleId:sample.id,startedAt:Date.now(),note:'正在向灵矽提交训练（最多等待 2 分钟）。可以离开或刷新页面，请勿重复提交。'};
    await persist();
    const job=(async()=>{
      try {
        const result = cloneSchema.parse(await linxRequest(config, `/v1/voice-clones/${encodeURIComponent(slot.id)}`, 'PUT', {name,key:sampleUrl(config.linx.publicBaseUrl,sample)},120000));
        attempts[slot.id] = {...attempts[slot.id],phase:['Training','Success'].includes(result.state)?'accepted':'uncertain',note:result.state==='Init'?'平台仍返回待训练状态，尚不能使用该声音。请刷新确认后再重试。':''};
      } catch (error) {
        const detail=(error instanceof Error?error.message:'请求失败').replace(/https?:\/\/\S+/g,'[音频地址]').slice(0,240);
        attempts[slot.id] = {...attempts[slot.id],phase:'uncertain',note:`训练提交未得到确认，已有音频和音色栏位已保留。请先刷新状态，勿重复创建。原因：${detail}`};
      }
      await persist();
    })();
    jobs.set(slot.id,job);
    void job.catch(()=>{app.log.error('Failed to persist voice training result');}).finally(()=>jobs.delete(slot.id));
    return annotate(slot);
  };
  app.post('/api/linx/clones/:id/train', async (req) => {
    const {id}=z.object({id:cloneId}).parse(req.params);
    const body=z.object({sampleId:z.string().uuid(),name:z.string().trim().min(1).max(20)}).parse(req.body);
    const sample=samples[body.sampleId];
    if(!sample||sample.expires<Date.now())throw new Error('音频链接已过期，请重新上传');
    if(pending.has(id)||jobs.has(id))throw new Error('该音色正在提交训练，请勿重复点击');
    pending.add(id);
    try{
      const config=options.getConfig();
      const slot=cloneSchema.parse(await linxRequest(config,`/v1/voice-clones/${encodeURIComponent(id)}`));
      if(!['Init','Failed'].includes(slot.state))return annotate(slot);
      sample.cloneId=id;await save('voice-samples',samples);
      return await train(config,slot,sample,body.name);
    }finally{pending.delete(id);}
  });
  app.post('/api/linx/clones', async (req) => {
    const body = z.object({
      sampleId: z.string().uuid(),
      name: z.string().trim().min(1).max(20),
      language: z.string().trim().min(2).max(16).default('zh'),
      tier: z.enum(['free', 'lite', 'pro']).default('free'),
    }).parse(req.body);
    await cleanup();
    const sample = samples[body.sampleId];
    if (!sample || sample.expires < Date.now()) throw new Error('音频链接已过期，请重新上传');
    if(pending.has(sample.id))throw new Error('正在创建音色，请勿重复提交');
    pending.add(sample.id);
    try {
      const config = options.getConfig();
      if(sample.cloneId)return annotate(cloneSchema.parse(await linxRequest(config,`/v1/voice-clones/${encodeURIComponent(sample.cloneId)}`)));
      const slot = cloneSchema.parse(await linxRequest(config, '/v1/voice-clones', 'POST', { language: body.language, tier: body.tier }));
      sample.cloneId=slot.id;await save('voice-samples',samples);
      pending.add(slot.id);
      try{return await train(config,slot,sample,body.name);}finally{pending.delete(slot.id);}
    }finally{pending.delete(sample.id);}
  });
}
