import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeReferenceWav} from '../src/web/reference-wav.js';

test('reference recordings encode a mono PCM WAV with correct duration and clipped samples', () => {
  const wav = encodeReferenceWav([new Float32Array([-2, -0.5, 0, 0.5, 2, NaN])], 48000);
  const view = new DataView(wav);
  const bytes = Buffer.from(wav);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  assert.equal(view.getUint16(20, true), 1); // PCM, not a renamed WebM/MP4.
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true) / view.getUint32(28, true), 6 / 48000);
  assert.deepEqual(Array.from({length:6}, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -16384, 0, 16384, 32767, 0]);
});

test('stereo reference recordings mix channels and reject invalid input', () => {
  const view = new DataView(encodeReferenceWav([new Float32Array([1, 0]), new Float32Array([-1, 1])], 44100));
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 16384);
  assert.throws(() => encodeReferenceWav([], 48000));
  assert.throws(() => encodeReferenceWav([new Float32Array([1]), new Float32Array(2)], 48000));
  assert.throws(() => encodeReferenceWav([new Float32Array([1])], 0));
});
