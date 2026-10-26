import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readiness } from '../src/server/readiness.js';
import { defaultConfig } from '../src/server/store.js';
import { parseScript } from '../src/core/script.js';
import { readFileSync } from 'node:fs';
import { bindingKey } from '../src/core/bindings.js';

const script = parseScript(JSON.parse(readFileSync('examples/after-hours.json', 'utf8')));

test('readiness reports missing voice-game configuration without exposing secrets', () => {
  const report = readiness(structuredClone(defaultConfig), { [script.id]: script });
  assert.equal(report.ready, false);
  assert(report.items.find((item) => item.id === 'linx')?.detail.includes('平台 API Key'));
  assert(!JSON.stringify(report).includes('••••'));
});

test('readiness becomes ready when every model, voice and Linx field is bound', () => {
  const config = structuredClone(defaultConfig);
  config.providers = [{ id: 'p', name: 'test', protocol: 'chat-completions', baseUrl: 'https://example.com/v1', modelId: 'm', apiKey: 'secret', timeoutMs: 1000 }];
  config.compilerProviderId = 'p';
  for (const role of [{ id: 'dm' }, ...script.roles]) {
    const key = bindingKey(script.id, role.id);
    config.roleModels[key] = 'p';
    config.roleVoices[key] = { provider: 'test', voiceType: `voice-${role.id}` };
  }
  config.linx = { ...config.linx, apiKey: 'secret', wsToken: 'secret', deviceId: 'device', callbackToken: 'secret' };
  const report = readiness(config, { [script.id]: script });
  assert.equal(report.ready, true);
  assert(report.items.every((item) => item.ok));
});

test('readiness accepts native Linx voice ids without legacy TTS mapping', () => {
  const config = structuredClone(defaultConfig);
  config.providers = [{ id: 'p', name: 'test', protocol: 'chat-completions', baseUrl: 'https://example.com/v1', modelId: 'm', apiKey: 'secret', timeoutMs: 1000 }];
  for (const role of [{ id: 'dm' }, ...script.roles]) {
    const key = bindingKey(script.id, role.id);
    config.roleModels[key] = 'p';
    config.roleVoices[key] = { provider: '', voiceType: '', voiceId: `native-${role.id}` };
  }
  config.linx = { ...config.linx, apiKey: 'secret', wsToken: 'secret', deviceId: 'device', callbackToken: 'secret' };
  const report = readiness(config, { [script.id]: script });
  assert.equal(report.items.find((item) => item.id === 'role-voices')?.ok, true);
});
