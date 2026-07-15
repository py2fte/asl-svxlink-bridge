import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OpusCodec,
  Pcm16Downsampler2x,
  createOpusBackend,
  downsamplePcm16Mono2x,
  upsamplePcm16Mono2x
} from '../src/codec/opus-codec.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

test('2x downsampler preserves steady signal level', () => {
  const pcm16k = Buffer.alloc(320 * 2);
  for (let offset = 0; offset < pcm16k.length; offset += 2) {
    pcm16k.writeInt16LE(2000, offset);
  }

  const pcm8k = downsamplePcm16Mono2x(pcm16k);
  assert.equal(pcm8k.length, 320);
  assert.ok(Math.abs(pcm8k.readInt16LE(160) - 2000) < 10);
});

test('stateful 2x downsampler attenuates near-Nyquist energy', () => {
  const downsampler = new Pcm16Downsampler2x();
  const pcm16k = Buffer.alloc(320 * 2);
  for (let sample = 0; sample < 320; sample += 1) {
    pcm16k.writeInt16LE(sample % 2 === 0 ? 10000 : -10000, sample * 2);
  }

  const pcm8k = downsampler.process(pcm16k);
  assert.equal(pcm8k.length, 320);
  assert.ok(rms(pcm8k.subarray(80)) < 800);
});

test('2x upsampler interpolates 8 kHz samples', () => {
  const pcm8k = Buffer.alloc(4);
  pcm8k.writeInt16LE(1000, 0);
  pcm8k.writeInt16LE(-1000, 2);

  const pcm16k = upsamplePcm16Mono2x(pcm8k);
  assert.deepEqual(
    [0, 2, 4, 6].map((offset) => pcm16k.readInt16LE(offset)),
    [1000, 1000, 0, -1000]
  );
});

test('Opus codec decodes an encoded 20 ms silence frame to 8 kHz PCM', () => {
  const codec = new OpusCodec({ logger, config: { opusBackend: 'opusscript' } });
  const pcm8k = Buffer.alloc(320);
  const opus = codec.encodePcmToOpus(pcm8k);
  const decoded = codec.decodeOpusToPcm(opus);
  codec.close();

  assert.ok(opus.length > 0);
  assert.equal(decoded.length, 320);
});

test('Opus backend auto selects an available implementation', () => {
  const backend = createOpusBackend({ requestedBackend: 'auto' });
  try {
    assert.match(backend.name, /^(libopus|opusscript)$/);
  } finally {
    backend.close();
  }
});

test('Opus backend libopus falls back when native module is unavailable', () => {
  const backend = createOpusBackend({ requestedBackend: 'libopus' });
  try {
    assert.match(backend.name, /^(libopus|opusscript)$/);
  } finally {
    backend.close();
  }
});

test('Opus backend rejects unsupported codec names', () => {
  assert.throws(
    () => createOpusBackend({ requestedBackend: 'bad-codec' }),
    /Unsupported Opus backend/
  );
});

function rms(pcm) {
  let sum = 0;
  const samples = pcm.length / 2;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}
