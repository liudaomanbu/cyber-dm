import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Config } from './store.js';
import { dataDir, load, save } from './store.js';
import type { Script } from '../core/script.js';
import { bindingKey } from '../core/bindings.js';
import { chooseVoices, voiceSchema, type Voice } from '../core/voices.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

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
export async function linxRequest(config: Config, path: string, method = 'GET', body?: unknown): Promise<any> {
  if (!config.linx.apiKey) throw new Error('请先填写灵矽平台 API Key');
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('灵矽 API 路径无效');
  let result: Response;
  try {
    result = await fetch(`${LINX_ORIGIN}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.linx.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
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

type Sample = { id: string; token: string; expires: number; mime: string };

function publicBase(base: string): string {
  if (!base) throw new Error('请先配置公网 HTTPS 地址，灵矽需要通过临时链接读取参考音频');
  let parsed: URL;
  try { parsed = new URL(base); } catch { throw new Error('参考音频地址必须是有效的 HTTPS URL'); }
  if (parsed.protocol !== 'https:' || parsed.search || parsed.hash) throw new Error('参考音频地址必须使用无查询参数的 HTTPS URL');
  return parsed.toString().replace(/\/$/, '');
}

function sampleUrl(base: string, sample: Sample): string {
  return `${publicBase(base)}/voice-samples/${encodeURIComponent(sample.id)}/${encodeURIComponent(sample.token)}`;
}

function catalogVoices(data: unknown): Voice[] {
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
  const cleanup = async () => {
    for (const [id, sample] of Object.entries(samples)) {
      if (sample.expires < Date.now()) {
        delete samples[id];
        await unlink(resolve(dataDir, 'voice-samples', id)).catch(() => undefined);
      }
    }
    await save('voice-samples', samples);
  };
  await cleanup();

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
      // Keep the catalog id and callback voice_type as separate values. A
      // catalog can expose one without the other and still needs manual setup.
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
      needsMapping: assignedKeys.filter((key) => !bindings[key].provider || !bindings[key].voiceType),
    };
  });

  app.get('/api/linx/clones', async () => {
    const data = await linxRequest(options.getConfig(), '/v1/voice-clones');
    return { ...(data as Record<string, unknown>), voices: clones(data) };
  });
  app.get('/api/linx/clones/:id', async (req) => {
    const { id } = z.object({ id: cloneId }).parse(req.params);
    return cloneSchema.parse(await linxRequest(options.getConfig(), `/v1/voice-clones/${encodeURIComponent(id)}`));
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
    await mkdir(resolve(dataDir, 'voice-samples'), { recursive: true, mode: 0o700 });
    await writeFile(resolve(dataDir, 'voice-samples', id), bytes, { mode: 0o600 });
    samples[id] = sample;
    await save('voice-samples', samples);
    return { sampleId: id, url: `${base}/voice-samples/${id}/${token}`, expiresAt: new Date(sample.expires).toISOString() };
  });

  app.get('/voice-samples/:id/:token', async (req, reply) => {
    const { id, token } = z.object({ id: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params);
    const sample = samples[id];
    if (!sample || sample.token !== token || sample.expires < Date.now()) return reply.code(404).send({ error: 'Not found' });
    return reply.header('Cache-Control', 'no-store').type(sample.mime).send(await readFile(resolve(dataDir, 'voice-samples', sample.id)));
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
    const config = options.getConfig();
    const slot = cloneSchema.parse(await linxRequest(config, '/v1/voice-clones', 'POST', { language: body.language, tier: body.tier }));
    try {
      return cloneSchema.parse(await linxRequest(config, `/v1/voice-clones/${encodeURIComponent(slot.id)}`, 'PUT', {
        name: body.name,
        key: sampleUrl(config.linx.publicBaseUrl, sample),
      }));
    } catch (error) {
      throw new Error(`音色栏位 ${slot.id} 已创建，但训练未成功提交；请刷新音色列表后检查，避免重复创建。${error instanceof Error ? error.message : ''}`);
    }
  });
}
