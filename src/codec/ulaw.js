const BIAS = 0x84;
const CLIP = 32635;

export function ulawToPcm16Sample(value) {
  const u = ~value & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

export function pcm16SampleToUlaw(sample) {
  let pcm = Math.max(-CLIP, Math.min(CLIP, sample));
  const sign = pcm < 0 ? 0x80 : 0x00;
  if (pcm < 0) pcm = -pcm;
  pcm += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function ulawBufferToPcm16(ulaw) {
  const pcm = Buffer.allocUnsafe(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i += 1) {
    pcm.writeInt16LE(ulawToPcm16Sample(ulaw[i]), i * 2);
  }
  return pcm;
}

export function pcm16BufferToUlaw(pcm) {
  if (pcm.length % 2 !== 0) {
    throw new Error('PCM buffer length must be even');
  }
  const ulaw = Buffer.allocUnsafe(pcm.length / 2);
  for (let i = 0; i < ulaw.length; i += 1) {
    ulaw[i] = pcm16SampleToUlaw(pcm.readInt16LE(i * 2));
  }
  return ulaw;
}
