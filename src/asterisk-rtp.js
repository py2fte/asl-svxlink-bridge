import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { pcm16BufferToUlaw, ulawBufferToPcm16 } from './codec/ulaw.js';

const RTP_HEADER_BYTES = 12;
const DTMF_PAYLOAD_TYPE = 101;
const DTMF_EVENT = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4,
  '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '*': 10, '#': 11, A: 12, B: 13, C: 14, D: 15
};

export class AsteriskRtpBridge extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.socket = dgram.createSocket('udp4');
    this.sequence = Math.floor(Math.random() * 0xffff);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = Math.floor(Math.random() * 0xffffffff);
    this.warnedNoRemote = false;
    this.loggedFirstSend = false;
    this.loggedFirstReceive = false;
    this.receivedPackets = 0;
    this.txQueue = [];
    this.txTimer = null;
    this.droppedTxPackets = 0;
    this.loggedQueueWarning = false;
  }

  async start() {
    this.socket.on('message', (packet, remote) => this.handlePacket(packet, remote));
    this.socket.on('error', (error) => this.emit('error', error));

    await new Promise((resolve) => {
      this.socket.bind(this.config.localRtpPort, this.config.localRtpHost, resolve);
    });
    this.logger.info('Asterisk RTP socket listening', {
      host: this.config.localRtpHost,
      port: this.config.localRtpPort
    });
  }

  stop() {
    if (this.txTimer) clearTimeout(this.txTimer);
    this.txTimer = null;
    this.socket.close();
  }

  sendPcm(pcmFrame) {
    if (!this.config.remoteRtpHost || !this.config.remoteRtpPort) {
      if (!this.warnedNoRemote) {
        this.logger.warn('Skipping decoded reflector audio until Asterisk RTP remote endpoint is known');
        this.warnedNoRemote = true;
      }
      return;
    }
    const samplesPerPacket = Math.round(8000 * (this.config.packetMs ?? 20) / 1000);
    const bytesPerPacket = samplesPerPacket * 2;
    for (let offset = 0; offset + bytesPerPacket <= pcmFrame.length; offset += bytesPerPacket) {
      const payload = pcm16BufferToUlaw(pcmFrame.subarray(offset, offset + bytesPerPacket));
      this.txQueue.push(payload);
      this.emit('outbound-pcmu', ulawBufferToPcm16(payload));
      if (!this.loggedFirstSend) {
        this.logger.info('Sending audio to Asterisk RTP', {
          host: this.config.remoteRtpHost,
          port: this.config.remoteRtpPort,
          packetMs: this.config.packetMs ?? 20
        });
        this.loggedFirstSend = true;
      }
    }
    this.startTxPump();
  }

  getQueuedAudioPackets() {
    return this.txQueue.length;
  }

  getReceivedPackets() {
    return this.receivedPackets;
  }

  startTxPump() {
    if (this.txTimer) return;
    this.scheduleNextTxPacket(0);
  }

  scheduleNextTxPacket(delayMs = this.config.packetMs ?? 20) {
    this.txTimer = setTimeout(() => {
      this.txTimer = null;
      if (!this.txQueue.length) return;

      this.dropExcessQueuedAudio();
      const payload = this.txQueue.shift();
      const packet = this.buildRtpPacket(payload);
      this.socket.send(packet, this.config.remoteRtpPort, this.config.remoteRtpHost, (error) => {
        if (error) this.logger.error('Failed sending RTP to Asterisk', { message: error.message });
      });
      this.scheduleNextTxPacket(Math.max(5, Number(this.config.packetMs ?? 20)));
    }, Math.max(0, Number(delayMs)));
  }

  dropExcessQueuedAudio() {
    const maxQueuePackets = this.config.rtpMaxQueuePackets ?? 200;
    if (this.txQueue.length <= maxQueuePackets) return;
    const dropCount = this.txQueue.length - maxQueuePackets;
    this.txQueue.splice(0, dropCount);
    this.droppedTxPackets += dropCount;
    if (!this.loggedQueueWarning || this.droppedTxPackets % 250 === 0) {
      this.loggedQueueWarning = true;
      this.logger.warn('Dropping queued RTP audio packets for Asterisk', {
        dropCount,
        droppedTxPackets: this.droppedTxPackets,
        queuedAudioPackets: this.txQueue.length,
        maxQueuePackets
      });
    }
  }

  setRemote({ host, port }) {
    this.config.remoteRtpHost = host;
    this.config.remoteRtpPort = port;
    this.warnedNoRemote = false;
    this.logger.info('Asterisk RTP remote endpoint set', { host, port });
  }

  async sendDtmfSequence(sequence, { digitMs = 120, gapMs = 120 } = {}) {
    if (!this.config.remoteRtpHost || !this.config.remoteRtpPort) return 0;
    let sent = 0;
    for (const digit of String(sequence).toUpperCase()) {
      if (await this.sendDtmfDigit(digit, { digitMs, gapMs })) sent += 1;
    }
    return sent;
  }

  async sendDtmfDigit(digit, { digitMs, gapMs }) {
    const event = DTMF_EVENT[digit];
    if (event === undefined) return false;
    const ts = this.timestamp >>> 0;
    const packets = Math.max(4, Math.ceil(digitMs / 20));
    let duration = 0;
    for (let i = 0; i < packets; i += 1) {
      duration += 160;
      this.sendDtmfPacket(event, false, duration, i === 0, ts);
      await delay(20);
    }
    for (let i = 0; i < 3; i += 1) {
      this.sendDtmfPacket(event, true, duration, false, ts);
      await delay(20);
    }
    this.timestamp = (this.timestamp + Math.round((digitMs + 60 + gapMs) * 8)) >>> 0;
    await delay(gapMs);
    return true;
  }

  sendDtmfPacket(event, end, duration, marker, timestamp) {
    const payload = Buffer.allocUnsafe(4);
    payload[0] = event;
    payload[1] = (end ? 0x80 : 0) | 10;
    payload.writeUInt16BE(duration, 2);
    const packet = this.buildRtpPacket(payload, DTMF_PAYLOAD_TYPE, marker, timestamp);
    this.socket.send(packet, this.config.remoteRtpPort, this.config.remoteRtpHost);
  }

  async sendTestTone({ durationMs = 4000, frequency = 1000, amplitude = 5000 } = {}) {
    const samplesPerPacket = Math.round(8000 * (this.config.packetMs ?? 20) / 1000);
    const packets = Math.ceil(durationMs / (this.config.packetMs ?? 20));
    let sampleIndex = 0;
    for (let i = 0; i < packets; i += 1) {
      const pcm = Buffer.allocUnsafe(samplesPerPacket * 2);
      for (let s = 0; s < samplesPerPacket; s += 1) {
        const value = Math.round(Math.sin(2 * Math.PI * frequency * sampleIndex / 8000) * amplitude);
        pcm.writeInt16LE(value, s * 2);
        sampleIndex += 1;
      }
      this.sendPcm(pcm);
      await delay(this.config.packetMs ?? 20);
    }
  }

  handlePacket(packet, remote) {
    if (packet.length < RTP_HEADER_BYTES) return;
    const version = packet[0] >> 6;
    if (version !== 2) return;
    if (this.config.learnRemoteFromIncoming !== false && !this.config.remoteRtpHost) {
      this.setRemote({ host: remote.address, port: remote.port });
    }
    if (!this.loggedFirstReceive) {
      this.logger.info('Received RTP from Asterisk', {
        host: remote.address,
        port: remote.port,
        bytes: packet.length
      });
      this.loggedFirstReceive = true;
    }
    this.receivedPackets += 1;

    const csrcCount = packet[0] & 0x0f;
    const extension = (packet[0] & 0x10) !== 0;
    const payloadType = packet[1] & 0x7f;
    let offset = RTP_HEADER_BYTES + csrcCount * 4;
    if (payloadType !== this.config.payloadType) return;
    if (extension) {
      if (packet.length < offset + 4) return;
      const extLengthWords = packet.readUInt16BE(offset + 2);
      offset += 4 + extLengthWords * 4;
    }
    if (packet.length <= offset) return;

    const payload = packet.subarray(offset);
    const pcm = ulawBufferToPcm16(payload);
    this.emit('pcm', pcm, { remote, payloadType });
  }

  buildRtpPacket(payload, payloadType = this.config.payloadType, marker = false, fixedTimestamp = null) {
    const packet = Buffer.allocUnsafe(RTP_HEADER_BYTES + payload.length);
    packet[0] = 0x80;
    packet[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
    packet.writeUInt16BE(this.sequence, 2);
    packet.writeUInt32BE((fixedTimestamp ?? this.timestamp) >>> 0, 4);
    packet.writeUInt32BE(this.ssrc >>> 0, 8);
    payload.copy(packet, RTP_HEADER_BYTES);

    this.sequence = (this.sequence + 1) & 0xffff;
    if (fixedTimestamp === null) this.timestamp = (this.timestamp + payload.length) >>> 0;
    return packet;
  }

}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
