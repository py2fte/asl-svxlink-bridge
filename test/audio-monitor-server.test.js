import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWavHeader } from '../src/audio-monitor-server.js';

test('audio monitor WAV header advertises PCM stream format', () => {
  const header = createWavHeader({
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16
  });

  assert.equal(header.length, 44);
  assert.equal(header.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(header.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(header.readUInt16LE(20), 1);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 16000);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.subarray(36, 40).toString('ascii'), 'data');
});
