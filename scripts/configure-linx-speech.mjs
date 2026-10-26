#!/usr/bin/env node
// Documented APIs: /docs/xrobot/api/llm, api/agent, api/device, platform/OTA.
// Run only after deploying the speech-only endpoint. Never prints API responses or credentials.
import { readFile, writeFile, rename, open, unlink, chmod } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const configPath = resolve('.data/config.json');
const statePath = resolve('.data/linx-speech-setup.json');
const lockPath = resolve('.data/linx-speech-setup.lock');
const modelName = 'cyber-dm-speech-only';
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
async function main() {
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Setup lock exists; ensure no setup is running before removing it.'); });
  try {
    const original = await readFile(configPath, 'utf8');
    const config = JSON.parse(original);
    const c = config.linx;
    if (!c?.apiKey || !c.callbackToken || !c.agentId || !c.publicBaseUrl) throw new Error('Missing required Linx configuration.');
    const base = new URL(c.publicBaseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Public base URL must be HTTPS without credentials, query or fragment.');
    const endpoint = `${base.href.replace(/\/$/, '')}/integrations/linx/openai/v1`;
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid private setup state.'); }
    if (state && state.agentId !== c.agentId) throw new Error('Setup state belongs to another agent.');
    if (!state) {
      const mac = randomBytes(6); mac[0] = (mac[0] | 2) & 254;
      state = { agentId: c.agentId, modelLabel: `Cyber DM Speech Only ${randomUUID()}`, speechDeviceId: c.speechDeviceId || [...mac].map(v => v.toString(16).padStart(2, '0')).join(':').toUpperCase(), speechClientId: c.speechClientId || randomUUID() };
      await atomicJson(statePath, state);
    }
    if (state.speechDeviceId.toLowerCase() === c.deviceId?.toLowerCase()) throw new Error('Speech output must use a separate device.');
    const persist = () => atomicJson(statePath, state);
    async function api(path, method = 'GET', body) {
      const response = await fetch(`https://xrobo.qiniu.com${path}`, { method, headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || ![0, '0'].includes(data.code)) throw new Error(`Linx management request failed (${method}, HTTP ${response.status}); no response content logged.`);
      return data.data;
    }
    // Verify the deployed endpoint before changing the agent's model.
    const probe = await fetch(`${endpoint}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${c.callbackToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelName, messages: [], stream: false }), signal: AbortSignal.timeout(15000) });
    const probeBody = await probe.json().catch(() => null);
    if (!probe.ok || probeBody?.model !== modelName || probeBody?.choices?.[0]?.message?.content !== '' || probeBody?.choices?.[0]?.finish_reason !== 'stop') throw new Error('Deployed speech-only endpoint verification failed.');
    const models = await api('/v1/agents/models/llm');
    const matches = (models?.privates ?? []).filter(m => m.name === state.modelLabel);
    if (matches.length > 1) throw new Error('Ambiguous private model recovery.');
    if (!state.modelId && matches.length === 1) { state.modelId = matches[0].id; await persist(); }
    const model = { name: state.modelLabel, config: { type: 'openai', api_key: c.callbackToken, base_url: endpoint, model_name: modelName }, comment: 'Speech-only sink; game input arrives through the bound STT connection.' };
    if (!state.modelId) {
      const created = await api('/v1/models/llm', 'POST', model);
      if (!created?.id) throw new Error('Model creation returned no ID; rerun to recover by private name.');
      state.modelId = created.id; await persist();
    } else {
      if (!(models?.privates ?? []).some(m => m.id === state.modelId && m.name === state.modelLabel)) throw new Error('Stored model is not the expected private model.');
      await api(`/v1/models/${encodeURIComponent(state.modelId)}`, 'PUT', { ...model, model_type: 'llm' });
    }
    const savedModel = await api(`/v1/models/${encodeURIComponent(state.modelId)}`);
    if (savedModel?.config?.type !== 'openai' || savedModel.config.base_url !== endpoint || savedModel.config.model_name !== modelName) throw new Error('Private model verification failed.');
    if (!state.previousAgent) { state.previousAgent = await api(`/xiaozhi/agent/${encodeURIComponent(c.agentId)}`); await persist(); }
    await api(`/xiaozhi/agent/${encodeURIComponent(c.agentId)}`, 'PUT', { llmModelId: state.modelId, memModelId: 'Memory_nomem', intentModelId: 'Intent_nointent', chatHistoryConf: 0, extra: { disable_greeting: true } });
    const agent = await api(`/xiaozhi/agent/${encodeURIComponent(c.agentId)}`);
    if (agent?.llmModelId !== state.modelId) throw new Error('Agent model binding verification failed.');
    state.agentBound = true; await persist();
    async function ota() {
      const response = await fetch('https://xrobo.qiniuapi.com/v1/ota/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Activation-Version': '1', 'Device-Id': state.speechDeviceId, 'Client-Id': state.speechClientId, 'User-Agent': 'cyber-dm-web/0.1.0', 'Accept-Language': 'zh-CN' }, body: JSON.stringify({ version: 0, uuid: state.speechClientId, mac_address: state.speechDeviceId, application: { name: 'cyber-dm-web', version: '0.1.0', elf_sha256: '0'.repeat(64) }, board: { type: 'xiaoling-web-test', ssid: '', rssi: 0, mac: state.speechDeviceId } }), signal: AbortSignal.timeout(30000) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.error) throw new Error('Speech device OTA request failed.');
      return data;
    }
    let device = await ota();
    if (!device.websocket?.token) {
      const code = device.activation?.code;
      if (!/^\d{6}$/.test(String(code ?? ''))) throw new Error('OTA returned no usable activation code.');
      await api(`/xiaozhi/device/bind/${encodeURIComponent(c.agentId)}/${encodeURIComponent(code)}`, 'POST');
      device = await ota();
    }
    const bound = await api(`/xiaozhi/device/bind/${encodeURIComponent(c.agentId)}`);
    if (!Array.isArray(bound) || !bound.some(d => String(d.macAddress ?? d.id).toLowerCase() === state.speechDeviceId.toLowerCase())) throw new Error('Speech device is not bound to the expected agent.');
    if (!device.websocket?.token || !device.websocket?.url) throw new Error('OTA returned no speech connection credentials.');
    const speechUrl = new URL(device.websocket.url);
    if (speechUrl.protocol === 'ws:') speechUrl.protocol = 'wss:';
    if (speechUrl.protocol !== 'wss:') throw new Error('Invalid speech WebSocket URL.');
    // Refuse to overwrite edits made by the running application during setup.
    if (await readFile(configPath, 'utf8') !== original) throw new Error('Local configuration changed during setup; rerun to merge safely.');
    config.linx = { ...c, speechDeviceId: state.speechDeviceId, speechClientId: state.speechClientId, speechWsToken: device.websocket.token, speechWsUrl: speechUrl.href, inputMode: 'stt' };
    await atomicJson(configPath, config);
    state.completed = true; await persist();
    console.log('Speech-only model and separate output device configured. Restart the server and establish new voice connections.');
  } finally { await lock.close(); await unlink(lockPath); }
}
main().catch(error => { console.error(error instanceof Error && /^(Setup|Missing|Public|Invalid private|Speech|Deployed|Linx management|Ambiguous|Model creation|Stored model|Private model|Agent model|OTA|Invalid speech|Local configuration)/.test(error.message) ? error.message : 'Speech setup failed; credentials and remote response bodies were not logged.'); process.exitCode = 1; });
