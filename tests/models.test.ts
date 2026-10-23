import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, parseJson } from '../src/server/models.js';
import type { Provider } from '../src/server/store.js';

const provider = (protocol: Provider['protocol']): Provider => ({
  id: 'p', name: 'test', protocol, baseUrl: 'https://provider.example/v1', modelId: 'm', apiKey: 'secret', timeoutMs: 2000,
});

test('model adapters parse chat, Anthropic, and Responses text plus usage', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const responses = [
    { choices: [{ message: { content: [{ type: 'text', text: 'chat' }] } }], usage: { prompt_tokens: 11, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } },
    { content: [{ type: 'text', text: 'anthropic' }], usage: { input_tokens: 13, output_tokens: 5, cache_read_input_tokens: 4 } },
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses' }] }], usage: { input_tokens: 17, output_tokens: 7, input_tokens_details: { cached_tokens: 6 } } },
  ];
  let index = 0;
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(responses[index++]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const chat = await generate(provider('chat-completions'), 'system', { ok: true });
    const anthropic = await generate(provider('anthropic'), 'system', { ok: true });
    const response = await generate(provider('responses'), 'system', { ok: true });
    assert.equal(chat.text, 'chat');
    assert.deepEqual(chat.usage, { input: 11, output: 3, cacheRead: 2, cacheWrite: undefined, raw: responses[0].usage });
    assert.equal(anthropic.text, 'anthropic');
    assert.equal(anthropic.usage.cacheRead, 4);
    assert.equal(response.text, 'responses');
    assert.equal(response.usage.cacheRead, 6);
    assert.equal(calls[0].url, 'https://provider.example/v1/chat/completions');
    assert.equal(calls[1].url, 'https://provider.example/v1/messages');
    assert.equal(calls[2].url, 'https://provider.example/v1/responses');
    assert.equal(calls[1].headers.get('x-api-key'), 'secret');
    assert.equal(calls[2].headers.get('authorization'), 'Bearer secret');
  } finally {
    globalThis.fetch = original;
  }
});

test('model adapter reports provider errors and accepts fenced JSON only', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad model' } }), { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(() => generate(provider('chat-completions'), 'system', 'input'), /HTTP 400.*bad model/);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(parseJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseJson('{"ok":true}\ntrailing'), SyntaxError);
});
