import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

const REFLECTOR_SAMPLE_RATE = 16000;
const ASTERISK_SAMPLE_RATE = 8000;
const CHANNELS = 1;
const FRAME_MS = 20;
const REFLECTOR_FRAME_SAMPLES = REFLECTOR_SAMPLE_RATE * FRAME_MS / 1000;
const DEFAULT_BITRATE = 20000;
const DOWNSAMPLE_TAPS = createLowpassTaps({ taps: 31, cutoff: 0.23 });

export class OpusCodec extends EventEmitter {
  constructor({ logger, config = {} }) {
    super();
    this.logger = logger;
    this.bitrate = config.opusBitrate ?? DEFAULT_BITRATE;
    this.backend = createOpusBackend({
      requestedBackend: config.opusBackend ?? 'auto',
      bitrate: this.bitrate
    });
    if (this.backend.fallbackReason) {
      this.logger.warn('Requested Opus backend unavailable; using fallback', {
        requestedBackend: config.opusBackend ?? 'auto',
        backend: this.backend.name,
        reason: this.backend.fallbackReason
      });
    }
    this.logger.info('Opus codec initialized', {
      reflectorSampleRate: REFLECTOR_SAMPLE_RATE,
      asteriskSampleRate: ASTERISK_SAMPLE_RATE,
      channels: CHANNELS,
      backend: this.backend.name,
      requestedBackend: config.opusBackend ?? 'auto',
      bitrate: this.bitrate,
      resampler: 'linear-upsample/fir-downsample'
    });
  }

  close() {
    this.backend.close();
  }

  encodePcmToOpus(pcm8kFrame) {
    if (!pcm8kFrame?.length) return null;
    const pcm16kFrame = upsamplePcm16Mono2x(pcm8kFrame);
    return this.backend.encode(pcm16kFrame);
  }

  decodeOpusToPcm(opusFrame) {
    if (!opusFrame?.length) return null;
    const decoded16k = this.decodeOpusToPcm16k(opusFrame);
    return decoded16k ? downsamplePcm16Mono2x(decoded16k) : null;
  }

  decodeOpusToPcm16k(opusFrame) {
    if (!opusFrame?.length) return null;
    return this.backend.decode(opusFrame);
  }
}

export class Pcm16Downsampler2x {
  constructor() {
    this.history = new Int16Array(DOWNSAMPLE_TAPS.length - 1);
  }

  process(pcm16k) {
    if (pcm16k.length % 4 !== 0) {
      throw new Error('16 kHz mono PCM buffer must contain an even number of samples');
    }

    const inputSamples = pcm16k.length / 2;
    const samples = new Int16Array(this.history.length + inputSamples + this.history.length);
    samples.set(this.history, 0);
    for (let i = 0; i < inputSamples; i += 1) {
      samples[this.history.length + i] = pcm16k.readInt16LE(i * 2);
    }
    const lastSample = inputSamples > 0 ? pcm16k.readInt16LE(pcm16k.length - 2) : 0;
    samples.fill(lastSample, this.history.length + inputSamples);

    const out = Buffer.allocUnsafe(pcm16k.length / 2);
    const center = Math.floor(DOWNSAMPLE_TAPS.length / 2);
    for (let outSample = 0; outSample < inputSamples / 2; outSample += 1) {
      const centerIndex = this.history.length + outSample * 2;
      let acc = 0;
      for (let tap = 0; tap < DOWNSAMPLE_TAPS.length; tap += 1) {
        acc += samples[centerIndex + tap - center] * DOWNSAMPLE_TAPS[tap];
      }
      out.writeInt16LE(clamp16(Math.round(acc)), outSample * 2);
    }

    for (let i = 0; i < this.history.length; i += 1) {
      this.history[i] = samples[inputSamples + i];
    }
    return out;
  }
}

export function createOpusBackend({ requestedBackend = 'auto', bitrate = DEFAULT_BITRATE } = {}) {
  const backend = String(requestedBackend ?? 'auto').toLowerCase();
  if (backend === 'auto' || backend === 'libopus' || backend === '@discordjs/opus' || backend === 'libopus-strict') {
    try {
      return createDiscordOpusBackend({ bitrate });
    } catch (error) {
      if (backend === 'libopus-strict') {
        throw new Error(`Requested libopus backend is not available: ${error.message}`);
      }
      const fallback = createOpusScriptBackend({ bitrate });
      fallback.fallbackReason = error.message;
      return fallback;
    }
  }
  if (backend === 'auto' || backend === 'opusscript') {
    return createOpusScriptBackend({ bitrate });
  }
  throw new Error(`Unsupported Opus backend "${requestedBackend}". Use "auto", "libopus", "libopus-strict", or "opusscript".`);
}

function createDiscordOpusBackend({ bitrate }) {
  const { OpusEncoder } = require('@discordjs/opus');
  const opus = new OpusEncoder(REFLECTOR_SAMPLE_RATE, CHANNELS);
  opus.setBitrate?.(bitrate);
  return {
    name: 'libopus',
    encode(pcm16kFrame) {
      return opus.encode(pcm16kFrame, REFLECTOR_FRAME_SAMPLES);
    },
    decode(opusFrame) {
      return normalizeDecodedPcm(opus.decode(opusFrame));
    },
    close() {}
  };
}

function createOpusScriptBackend({ bitrate }) {
  const OpusScript = require('opusscript');
  const opus = new OpusScript(
    REFLECTOR_SAMPLE_RATE,
    CHANNELS,
    OpusScript.Application.AUDIO
  );
  opus.setBitrate?.(bitrate);
  return {
    name: 'opusscript',
    encode(pcm16kFrame) {
      return opus.encode(pcm16kFrame, REFLECTOR_FRAME_SAMPLES);
    },
    decode(opusFrame) {
      const maxSamples = REFLECTOR_SAMPLE_RATE * 60 / 1000;
      return normalizeDecodedPcm(opus.decode(opusFrame, maxSamples));
    },
    close() {
      opus.delete?.();
    }
  };
}

function normalizeDecodedPcm(decoded16k) {
  if (!Buffer.isBuffer(decoded16k)) decoded16k = Buffer.from(decoded16k);
  const alignedLength = decoded16k.length - (decoded16k.length % 4);
  if (alignedLength !== decoded16k.length) return decoded16k.subarray(0, alignedLength);
  return decoded16k;
}

export function downsamplePcm16Mono2x(pcm16k) {
  return new Pcm16Downsampler2x().process(pcm16k);
}

export function upsamplePcm16Mono2x(pcm8k) {
  if (pcm8k.length % 2 !== 0) {
    throw new Error('8 kHz mono PCM buffer length must be even');
  }

  const out = Buffer.allocUnsafe(pcm8k.length * 2);
  let previous = pcm8k.readInt16LE(0);
  for (let inOffset = 0, outOffset = 0; inOffset < pcm8k.length; inOffset += 2, outOffset += 4) {
    const sample = pcm8k.readInt16LE(inOffset);
    out.writeInt16LE(clamp16(Math.round((previous + sample) / 2)), outOffset);
    out.writeInt16LE(sample, outOffset + 2);
    previous = sample;
  }
  return out;
}

function clamp16(value) {
  return Math.max(-32768, Math.min(32767, value));
}

function readPcm16Clamped(buffer, offset) {
  if (offset < 0) return buffer.readInt16LE(0);
  if (offset >= buffer.length) return buffer.readInt16LE(buffer.length - 2);
  return buffer.readInt16LE(offset);
}

function createLowpassTaps({ taps, cutoff }) {
  const center = (taps - 1) / 2;
  const values = [];
  for (let i = 0; i < taps; i += 1) {
    const x = i - center;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
    values.push(sinc * window);
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return values.map((value) => value / sum);
}
