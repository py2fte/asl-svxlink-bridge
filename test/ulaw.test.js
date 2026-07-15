import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pcm16BufferToUlaw,
  pcm16SampleToUlaw,
  ulawBufferToPcm16,
  ulawToPcm16Sample
} from '../src/codec/ulaw.js';

test('mu-law zero samples map close to silence', () => {
  const encoded = pcm16SampleToUlaw(0);
  const decoded = ulawToPcm16Sample(encoded);
  assert.ok(Math.abs(decoded) < 132);
});

test('mu-law buffer conversion preserves frame length', () => {
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < pcm.length / 2; i += 1) {
    pcm.writeInt16LE(i % 2 === 0 ? 1200 : -1200, i * 2);
  }

  const ulaw = pcm16BufferToUlaw(pcm);
  const roundTrip = ulawBufferToPcm16(ulaw);

  assert.equal(ulaw.length, 160);
  assert.equal(roundTrip.length, pcm.length);
});
