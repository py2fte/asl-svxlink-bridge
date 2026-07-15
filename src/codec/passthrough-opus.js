import { EventEmitter } from 'node:events';

export class PassthroughOpusCodec extends EventEmitter {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.warnedEncode = false;
    this.warnedDecode = false;
  }

  encodePcmToOpus(pcmFrame) {
    if (!this.warnedEncode) {
      this.logger.warn('Opus encoder is not configured; ASL audio will not be transmitted to the reflector');
      this.warnedEncode = true;
    }
    return null;
  }

  decodeOpusToPcm(opusFrame) {
    if (!this.warnedDecode) {
      this.logger.warn('Opus decoder is not configured; reflector audio will not be transmitted to Asterisk');
      this.warnedDecode = true;
    }
    return null;
  }
}
