import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linxRequest } from '../src/server/linx-api.js';
import { defaultConfig } from '../src/server/store.js';

test('Linx REST adapter sends bearer JSON and unwraps documented envelope', async () => {
  const original = globalThis.fetch;
  let seen: { url: string; method?: string; body?: string; authorization?: string } | undefined;
  globalThis.fetch = (async (input, init) => {
    seen = { url: String(input), method: init?.method, body: init?.body as string, authorization: new Headers(init?.headers).get('authorization') ?? undefined };
    return new Response(JSON.stringify({ code: 0, reqid: 'req-1', data: { voices: [] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const config = structuredClone(defaultConfig);
    config.linx.apiKey = 'linx-secret';
    assert.deepEqual(await linxRequest(config, '/v1/voices'), { voices: [] });
    assert.equal(seen?.url, 'https://xrobo.qiniu.com/v1/voices');
    assert.equal(seen?.method, 'GET');
    assert.equal(seen?.authorization, 'Bearer linx-secret');
    assert.equal(seen?.body, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('Linx REST adapter surfaces HTTP and platform errors without accepting malformed envelopes', async () => {
  const original = globalThis.fetch;
  const config = structuredClone(defaultConfig);
  config.linx.apiKey = 'linx-secret';
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: 403, msg: '额度不足' }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(() => linxRequest(config, '/v1/voice-clones', 'POST', { tier: 'free' }), /403.*额度不足/);
  } finally {
    globalThis.fetch = original;
  }
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(() => linxRequest(config, '/v1/voices'), /返回格式无效/);
  } finally {
    globalThis.fetch = original;
  }
});
