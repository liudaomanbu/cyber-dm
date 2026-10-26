import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerLinxNoop } from '../src/server/linx-noop.js';
import { defaultConfig } from '../src/server/store.js';

test('speech-only model authenticates, rejects other models, and never returns conversation data', async () => {
  const app = Fastify();
  const config = structuredClone(defaultConfig);
  config.linx.callbackToken = 'private-callback-token';
  await registerLinxNoop(app, { config: () => config });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No outbound requests permitted'); };
  try {
    const payload = { model: 'cyber-dm-speech-only', messages: [{ role: 'user', content: 'PRIVATE GAME CONTENT' }] };
    const call = (authorization?: string, overrides = {}) => app.inject({ method: 'POST', url: '/integrations/linx/openai/v1/chat/completions', headers: authorization ? { authorization } : {}, payload: { ...payload, ...overrides } });
    for (const token of [undefined, 'Bearer wrong', config.linx.callbackToken, 'Bearer ' + 'x'.repeat(config.linx.callbackToken.length)]) {
      assert.equal((await call(token)).statusCode, 401);
    }
    const auth = `Bearer ${config.linx.callbackToken}`;
    assert.equal((await call(auth, { model: 'other-model' })).statusCode, 400);
    assert.equal((await call(auth, { stream: 'true' })).statusCode, 400);
    const normal = await call(auth);
    assert.equal(normal.statusCode, 200);
    assert.equal(normal.json().choices[0].message.content, '');
    assert.equal(normal.json().choices[0].finish_reason, 'stop');
    assert.ok(!normal.body.includes('PRIVATE GAME CONTENT'));
    const streaming = await call(auth, { stream: true });
    assert.equal(streaming.statusCode, 200);
    assert.match(streaming.headers['content-type']!, /^text\/event-stream/);
    const events = streaming.body.trim().split('\n\n').map(line => line.slice(6));
    assert.equal(events.pop(), '[DONE]');
    const chunks = events.map(line => JSON.parse(line));
    assert.equal(chunks[0].id, chunks[1].id);
    assert.equal(chunks[0].choices[0].delta.content, '');
    assert.equal(chunks[1].choices[0].finish_reason, 'stop');
    assert.ok(!streaming.body.includes('PRIVATE GAME CONTENT'));
    config.linx.callbackToken = '';
    assert.equal((await call(auth)).statusCode, 401);
  } finally { globalThis.fetch = originalFetch; await app.close(); }
});
