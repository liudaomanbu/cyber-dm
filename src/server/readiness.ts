import type { Script } from '../core/script.js';
import { bindingKey } from '../core/bindings.js';
import type { Config } from './store.js';

export type ReadinessItem = { id: string; label: string; ok: boolean; detail: string };
export type ReadinessReport = { ready: boolean; items: ReadinessItem[]; scripts: number; roles: number };

/** Return a secret-free checklist for the minimum real voice-game setup. */
export function readiness(config: Config, scripts: Record<string, Script>): ReadinessReport {
  const entries = Object.values(scripts);
  const roles = entries.reduce((count, script) => count + script.roles.length + 1, 0);
  const items: ReadinessItem[] = [];
  items.push({ id: 'scripts', label: '至少有一个可玩剧本', ok: entries.length > 0,
    detail: entries.length > 0 ? `已加载 ${entries.length} 个剧本` : '请先上传并发布完整剧本' });

  const providerIds = new Set(config.providers.map((provider) => provider.id));
  items.push({ id: 'provider', label: '已配置模型服务', ok: config.providers.length > 0,
    detail: config.providers.length > 0 ? `已配置 ${config.providers.length} 个服务` : '请添加至少一个模型服务' });
  // A compiler is needed for PDF/TXT/Markdown imports, but a published JSON
  // script can start a voice game without one. Keep this item informative
  // instead of blocking the core voice-game readiness gate.
  const compilerOk = !config.compilerProviderId || providerIds.has(config.compilerProviderId);
  items.push({ id: 'compiler', label: '剧本解析服务可用（可选）', ok: compilerOk,
    detail: compilerOk
      ? (config.compilerProviderId ? '上传 PDF/TXT/Markdown 时可生成草稿' : '未选择；结构化 JSON 剧本仍可直接使用')
      : '解析服务配置已失效，请重新选择模型服务' });

  const missingModels: string[] = [];
  const missingVoices: string[] = [];
  for (const script of entries) {
    for (const role of [{ id: 'dm', name: '主持人' }, ...script.roles]) {
      const key = bindingKey(script.id, role.id);
      if (!providerIds.has(config.roleModels[key])) missingModels.push(`${script.title}/${role.name}`);
      const voice = config.roleVoices[key];
      if (!voice?.voiceId && (!voice?.provider || !voice.voiceType)) missingVoices.push(`${script.title}/${role.name}`);
    }
  }
  const summarize = (names: string[]) => names.length === 0 ? '' : `缺少：${names.slice(0, 4).join('、')}${names.length > 4 ? '等' : ''}`;
  items.push({ id: 'role-models', label: '每个角色已有独立模型绑定', ok: missingModels.length === 0,
    detail: missingModels.length ? summarize(missingModels) : `已绑定 ${roles} 个角色位` });
  items.push({ id: 'role-voices', label: '每个角色已有独立灵矽音色 ID', ok: missingVoices.length === 0,
    detail: missingVoices.length ? summarize(missingVoices) : `已绑定 ${roles} 个角色位` });

  const linx = config.linx;
  const fields: Array<[keyof Config['linx'], string]> = [
    ['apiKey', '平台 API Key'], ['wsToken', 'WebSocket Token'], ['deviceId', '设备 ID'],
    ['clientId', '客户端 ID'], ['callbackToken', '业务回调 Token'],
  ];
  if(linx.inputMode==='stt')fields.push(['speechDeviceId','播报设备 ID'],['speechWsToken','播报设备 Token']);
  const missingLinx = fields.filter(([key]) => !String(linx[key] ?? '').trim()).map(([, label]) => label);
  try {
    const url = new URL(linx.wsUrl);
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') missingLinx.push('WebSocket 地址');
  } catch { missingLinx.push('WebSocket 地址'); }
  items.push({ id: 'linx', label: '灵矽语音桥配置完整', ok: missingLinx.length === 0,
    detail: missingLinx.length ? `缺少：${missingLinx.join('、')}` : '接入字段已填写；实际录音、识别和播放仍需测试' });
  return { ready: items.every((item) => item.ok), items, scripts: entries.length, roles };
}
