import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import Fastify from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { registerVoice, type VoiceReply } from '../src/server/voice.js';
import { defaultConfig } from '../src/server/store.js';

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
type Connection = { socket: WebSocket; device: string; authorization?: string; client?: string; messages: any[]; audio: Buffer[] };
async function setup(respond: (id: string, text: string, current: () => boolean, target?: string) => Promise<VoiceReply[]>, eventsFor?: (id: string) => VoiceReply[], outputBehavior?: (text: string) => 'hold' | 'fail' | undefined) {
  const upstream = new WebSocketServer({ port: 0 }); await once(upstream, 'listening');
  const connections: Connection[] = [];
  const approvedPcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  upstream.on('connection', (socket, request) => {
    const connection: Connection = { socket, device: String(request.headers['device-id']), authorization: request.headers.authorization, client: String(request.headers['client-id']), messages: [], audio: [] };
    connections.push(connection);
    socket.on('message', (raw, binary) => {
      if (binary) { connection.audio.push(Buffer.from(raw as Buffer)); return; }
      const message = JSON.parse(raw.toString()); connection.messages.push(message);
      if (message.type === 'hello') socket.send(JSON.stringify({ type: 'hello', session_id: `session-${connections.indexOf(connection)}`, audio_params: { format: 'pcm', sample_rate: 16000, channels: 1 } }));
      if (connection.device === 'output-device' && message.text_response) {
        const behavior = outputBehavior?.(message.text_response);
        if (behavior === 'hold') return;
        if (behavior === 'fail') { socket.close(); return; }
        socket.send(JSON.stringify({ type: 'tts', state: 'start' }));
        socket.send(approvedPcm);
        socket.send(JSON.stringify({ type: 'tts', state: 'stop' }));
      }
    });
  });
  const config = structuredClone(defaultConfig);
  Object.assign(config.linx, { inputMode: 'stt', wsUrl: `ws://127.0.0.1:${(upstream.address() as { port: number }).port}`, deviceId: 'input-device', wsToken: 'input-token', clientId: 'input-client', callbackToken: 'callback-token', speechDeviceId: 'output-device', speechWsToken: 'output-token', speechClientId: 'output-client' });
  const app = Fastify();
  await registerVoice(app, { config: () => config, hasSession: id => id === 'game-room', respond, eventsFor, voiceFor: (_id, speaker) => ({ voiceId: `voice-${speaker}` }) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const ticketResponse = await app.inject({ method: 'POST', url: '/api/voice/ticket', payload: { sessionId: 'game-room' } });
  assert.equal(ticketResponse.statusCode, 200);
  const browser = new WebSocket(`ws://127.0.0.1:${port}/voice/socket?ticket=${ticketResponse.json().ticket}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  const received: any[] = []; const audio: Buffer[] = [];
  browser.on('message', (raw, binary) => binary ? audio.push(Buffer.from(raw as Buffer)) : received.push(JSON.parse(raw.toString())));
  await until(() => received.some(m => m.type === 'ready'), 'browser ready');
  const inputs = () => connections.filter(c => c.device === 'input-device');
  const outputs = () => connections.filter(c => c.device === 'output-device');
  const send = (message: unknown) => browser.send(JSON.stringify(message));
  const start = async (target?: string) => {
    const count = inputs().length; send({ type: 'start', target });
    await until(() => inputs().length === count + 1 && inputs()[count].messages.some(m => m.type === 'listen' && m.state === 'start'), 'new recording connection');
    return inputs()[count];
  };
  return { browser, received, audio, approvedPcm, inputs, outputs, send, start, close: async () => { browser.terminate(); for (const socket of upstream.clients) socket.terminate(); await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); } };
}

test('STT mode preserves private target after stop, deduplicates STT and only plays approved independent-device audio', { timeout: 10000 }, async () => {
  const calls: { id: string; text: string; target?: string }[] = [];
  const bridge = await setup(async (id, text, current, target) => { assert(current()); calls.push({ id, text, target }); return [{ speaker: 'chen', text: '已审核的私聊回答' }]; });
  try {
    assert.equal(bridge.inputs().length, 0, 'ticket connection must not start an unscoped recognition session');
    const first = await bridge.start('chen');
    assert.equal(first.authorization, 'Bearer input-token');
    bridge.browser.send(Buffer.from([5, 0, 6, 0]));
    bridge.send({ type: 'stop' });
    await until(() => first.messages.some(m => m.state === 'stop'), 'capture stop reaches input device');
    assert.equal(first.messages.filter(m => m.type === 'abort').length, 0);
    assert.deepEqual(first.audio, [Buffer.from([5, 0, 6, 0])]);
    first.socket.send(JSON.stringify({ type: 'tts', state: 'start' }));
    first.socket.send(Buffer.from([99, 0, 99, 0]));
    first.socket.send(JSON.stringify({ type: 'tts', state: 'stop' }));
    first.socket.send(JSON.stringify({ type: 'stt', text: '私聊问题' }));
    first.socket.send(JSON.stringify({ type: 'stt', text: '私聊问题' }));
    await until(() => bridge.received.some(m => m.type === 'tts' && m.state === 'stop'), 'approved playback complete');
    assert.deepEqual(calls, [{ id: 'game-room', text: '私聊问题', target: 'chen' }]);
    assert.equal(bridge.outputs().length, 1);
    const output = bridge.outputs()[0];
    assert.equal(output.authorization, 'Bearer output-token'); assert.equal(output.client, 'output-client');
    assert.deepEqual(output.messages.filter(m => m.type === 'listen').map(m => [m.text_response, m.agent_params.voice.id]), [['已审核的私聊回答', 'voice-chen']]);
    assert.deepEqual(Buffer.concat(bridge.audio), bridge.approvedPcm, 'input-device audio must never escape to browser');
    const second = await bridge.start();
    assert.notEqual(second.socket, first.socket);
    second.socket.send(JSON.stringify({ type: 'stt', text: '公开问题' }));
    await until(() => bridge.audio.length === 2, 'second approved playback');
    assert.deepEqual(calls[1], { id: 'game-room', text: '公开问题', target: undefined });
    assert.equal(bridge.inputs().length, 2);
  } finally { await bridge.close(); }
});

test('STT abort invalidates in-flight replies and replaced input sockets cannot deliver a later turn', { timeout: 10000 }, async () => {
  let release!: () => void; let oldCurrent!: () => boolean;
  const calls: string[] = [];
  const bridge = await setup(async (_id, text, current) => {
    calls.push(text);
    if (text === '旧问题') { oldCurrent = current; await new Promise<void>(resolve => { release = resolve; }); }
    return [{ speaker: 'chen', text: text === '旧问题' ? '不得播放的旧回复' : '新回复' }];
  });
  try {
    const old = await bridge.start('chen'); old.socket.send(JSON.stringify({ type: 'stt', text: '旧问题' }));
    await until(() => Boolean(release), 'game response blocked'); assert(oldCurrent());
    bridge.send({ type: 'abort' });
    await until(() => bridge.received.some(m => m.isAborted), 'abort acknowledged'); assert(!oldCurrent());
    const replacement = await bridge.start('dm');
    release();
    // The abandoned connection has closed, so it cannot carry delayed STT into this turn.
    await until(() => old.socket.readyState === WebSocket.CLOSED, 'old input transport closed');
    assert.equal(bridge.outputs().length, 0, 'aborted in-flight game reply must not synthesize');
    // Replace a still-listening turn, then send its queued event during teardown.
    bridge.send({ type: 'start', target: 'chen' });
    await until(() => bridge.inputs().length === 3, 'third recording connection');
    if (replacement.socket.readyState === WebSocket.OPEN) replacement.socket.send(JSON.stringify({ type: 'stt', text: '过期录音' }));
    await until(() => replacement.socket.readyState === WebSocket.CLOSED, 'superseded recording closed');
    const latest = bridge.inputs()[2];
    await until(() => latest.messages.some(m => m.state === 'start'), 'latest input ready');
    latest.socket.send(JSON.stringify({ type: 'stt', text: '新问题' }));
    await until(() => bridge.audio.length === 1, 'current reply played');
    assert.deepEqual(calls, ['旧问题', '新问题']);
    assert.equal(bridge.outputs().length, 1);
    assert.equal(bridge.outputs()[0].messages.find(m => m.text_response)?.text_response, '新回复');
    assert.deepEqual(Buffer.concat(bridge.audio), bridge.approvedPcm);
  } finally { release?.(); await bridge.close(); }
});

test('event queue plays opening and HTTP replies in order with each role voice', { timeout: 10000 }, async () => {
  const events: VoiceReply[] = [
    {eventId:'opening',speaker:'dm',text:'主持人开场'},
    {eventId:'http-zhou',speaker:'zhou',text:'周的按钮发言'},
    {eventId:'http-chen',speaker:'chen',text:'陈的按钮发言'},
  ];
  const bridge = await setup(async () => [], id => { assert.equal(id,'game-room'); return events; });
  try {
    bridge.send({type:'play_events',eventIds:events.map(e=>e.eventId)});
    await until(()=>bridge.received.some(m=>m.type==='tts'&&m.state==='stop'),'queue complete');
    assert.deepEqual(bridge.outputs().flatMap(c=>c.messages.filter(m=>m.text_response).map(m=>[m.text_response,m.agent_params.voice.id])),[
      ['主持人开场','voice-dm'],['周的按钮发言','voice-zhou'],['陈的按钮发言','voice-chen'],
    ]);
    assert.deepEqual(Buffer.concat(bridge.audio),Buffer.concat(events.map(()=>bridge.approvedPcm)));
    assert.equal(bridge.inputs().length,0);
  } finally { await bridge.close(); }
});

test('direct voice replies and subsequent UI event synchronization deduplicate by event ID', { timeout: 10000 }, async () => {
  const line: VoiceReply={eventId:'voice-event',speaker:'chen',text:'只应播放一次'};
  const bridge=await setup(async()=>[line],()=>[line]);
  try {
    const input=await bridge.start();input.socket.send(JSON.stringify({type:'stt',text:'问题'}));
    await until(()=>bridge.received.some(m=>m.type==='session_updated'),'reply committed');
    bridge.send({type:'play_events',eventIds:['voice-event','voice-event']});
    await until(()=>bridge.received.some(m=>m.type==='events_synced')&&bridge.received.some(m=>m.type==='tts'&&m.state==='stop'),'reply and sync complete');
    assert.equal(bridge.outputs().length,1);
    assert.deepEqual(Buffer.concat(bridge.audio),bridge.approvedPcm);
  } finally { await bridge.close(); }
});

test('event IDs outside the authorized playable view are rejected without synthesis', { timeout: 10000 }, async () => {
  const bridge=await setup(async()=>[],()=>[{eventId:'visible',speaker:'dm',text:'授权文本'}]);
  try {
    for(const id of ['nonexistent','player-event','other-room-private-event']){
      const errors=bridge.received.filter(m=>m.type==='error').length;
      bridge.send({type:'play_events',eventIds:['visible',id],text:'伪造文本',speaker:'chen'});
      await until(()=>bridge.received.filter(m=>m.type==='error').length===errors+1,'unauthorized request rejected');
    }
    assert.equal(bridge.outputs().length,0);
    assert.equal(bridge.audio.length,0);
  } finally { await bridge.close(); }
});

test('aborted event synthesis can be explicitly replayed', { timeout: 10000 }, async () => {
  let hold=true;
  const bridge=await setup(async()=>[],()=>[{eventId:'replay',speaker:'dm',text:'重播台词'}],()=>hold?'hold':undefined);
  try {
    bridge.send({type:'play_events',eventIds:['replay']});
    await until(()=>bridge.outputs().some(c=>c.messages.some(m=>m.text_response)),'synthesis in flight');
    bridge.send({type:'abort'});
    await until(()=>bridge.received.some(m=>m.isAborted),'abort acknowledged');
    assert.equal(bridge.audio.length,0);
    hold=false;bridge.send({type:'play_events',eventIds:['replay'],replay:true});
    await until(()=>bridge.audio.length===1,'explicit replay delivered');
    assert.equal(bridge.outputs().length,2);
    assert.deepEqual(Buffer.concat(bridge.audio),bridge.approvedPcm);
  } finally { await bridge.close(); }
});

test('one failed TTS item reports an error and the next queued role still plays', { timeout: 10000 }, async () => {
  const bridge=await setup(async()=>[],()=>[
    {eventId:'bad',speaker:'dm',text:'合成失败'},
    {eventId:'good',speaker:'zhou',text:'后续正常台词'},
  ],text=>text==='合成失败'?'fail':undefined);
  try {
    bridge.send({type:'play_events',eventIds:['bad','good']});
    await until(()=>bridge.received.some(m=>m.type==='tts'&&m.state==='stop'),'queue recovered');
    assert(bridge.received.some(m=>m.type==='error'&&m.message.includes('语音播放失败')));
    assert.equal(bridge.outputs().length,2);
    assert.deepEqual(Buffer.concat(bridge.audio),bridge.approvedPcm);
    assert.equal(bridge.outputs()[1].messages.find(m=>m.text_response).agent_params.voice.id,'voice-zhou');
  } finally { await bridge.close(); }
});
