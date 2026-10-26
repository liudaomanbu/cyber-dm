import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from './store.js';

const model = 'cyber-dm-speech-only';

/** Terminates Linx's LLM leg; speech input is handled only by the bound WSS. */
export async function registerLinxNoop(app: FastifyInstance, options: { config: () => Config }) {
  app.post('/integrations/linx/openai/v1/chat/completions', { logLevel: 'silent' }, async (request, reply) => {
    const expected = options.config().linx.callbackToken;
    const authorization = request.headers.authorization ?? '';
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!expected || !supplied || Buffer.byteLength(expected) !== Buffer.byteLength(supplied)
      || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
      return reply.code(401).send({ error: { message: 'Unauthorized', type: 'authentication_error' } });
    }
    const body = request.body as { model?: unknown; stream?: unknown } | null;
    if (body?.model !== model) return reply.code(400).send({ error: { message: 'Unsupported model', type: 'invalid_request_error' } });
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
      return reply.code(400).send({ error: { message: 'Invalid stream option', type: 'invalid_request_error' } });
    }
    const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model };
    reply.header('Cache-Control', 'no-store');
    // Deliberately never read, copy, log, or forward messages or platform history.
    if (body.stream === true) {
      const chunk = { ...base, object: 'chat.completion.chunk' };
      return reply.type('text/event-stream').send([
        { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
    }
    return { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  });
}
