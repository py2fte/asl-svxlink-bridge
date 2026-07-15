import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

const USRP_HEADER_BYTES = 32;
const USRP_VOICE_FRAME_BYTES = 160 * 2;
const USRP_TYPE_VOICE = 0;
const DEFAULT_RECONNECT_DELAY_MS = 1000;

export class AsteriskUsrpBridge extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.socket = null;
    this.sequence = Math.floor(Math.random() * 0xffff);
    this.receivedPackets = 0;
    this.txQueue = [];
    this.txTimer = null;
    this.nextTxAt = 0;
    this.txActive = false;
    this.droppedTxPackets = 0;
    this.loggedQueueWarning = false;
    this.loggedFirstSend = false;
    this.loggedFirstReceive = false;
    this.sentPackets = 0;
    this.lastSentAt = 0;
    this.sendTiming = { count: 0, min: Infinity, max: 0, sum: 0 };
    this.warnedNoRemote = false;
    this.running = false;
    this.restartingSocket = false;
    this.createSocket();
  }

  async start() {
    this.running = true;
    await this.bindSocket();
    this.logger.info('Asterisk USRP socket listening', {
      host: this.config.localHost,
      port: this.config.localPort,
      remoteHost: this.config.remoteHost,
      remotePort: this.config.remotePort
    });
  }

  stop() {
    if (this.txTimer) {
      clearTimeout(this.txTimer);
      clearImmediate(this.txTimer);
    }
    this.txTimer = null;
    this.running = false;
    this.closeSocket();
  }

  createSocket() {
    this.closeSocket();
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (packet, remote) => this.handlePacket(packet, remote));
    this.socket.on('error', (error) => this.handleSocketError(error));
  }

  bindSocket() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.socket.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.socket.off('error', onError);
        resolve();
      };
      this.socket.once('error', onError);
      this.socket.once('listening', onListening);
      this.socket.bind(this.config.localPort, this.config.localHost);
    });
  }

  closeSocket() {
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch {
      // Socket may already be closed while recovering from an error.
    }
    this.socket = null;
  }

  handleSocketError(error) {
    this.emit('error', error);
    if (!this.running || this.config.autoReconnect === false) return;
    this.restartSocket(error);
  }

  async restartSocket(error) {
    if (this.restartingSocket) return;
    this.restartingSocket = true;
    const delayMs = this.config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.logger.warn('Asterisk USRP socket reconnect scheduled', {
      message: error.message,
      delayMs,
      host: this.config.localHost,
      port: this.config.localPort
    });
    this.closeSocket();
    await delay(delayMs);
    if (!this.running) {
      this.restartingSocket = false;
      return;
    }
    try {
      this.createSocket();
      await this.bindSocket();
      this.logger.info('Asterisk USRP socket reconnected', {
        host: this.config.localHost,
        port: this.config.localPort,
        remoteHost: this.config.remoteHost,
        remotePort: this.config.remotePort
      });
    } catch (restartError) {
      this.emit('error', restartError);
      this.restartingSocket = false;
      this.restartSocket(restartError);
      return;
    }
    this.restartingSocket = false;
  }

  sendPcm(pcmFrame) {
    if (!this.config.remoteHost || !this.config.remotePort) {
      if (!this.warnedNoRemote) {
        this.logger.warn('Skipping decoded reflector audio until Asterisk USRP remote endpoint is configured');
        this.warnedNoRemote = true;
      }
      return;
    }

    for (let offset = 0; offset + USRP_VOICE_FRAME_BYTES <= pcmFrame.length; offset += USRP_VOICE_FRAME_BYTES) {
      this.txQueue.push(Buffer.from(pcmFrame.subarray(offset, offset + USRP_VOICE_FRAME_BYTES)));
      if (!this.loggedFirstSend) {
        this.logger.info('Sending audio to Asterisk USRP', {
          host: this.config.remoteHost,
          port: this.config.remotePort,
          packetMs: this.config.packetMs ?? 20
        });
        this.loggedFirstSend = true;
      }
    }
    this.txActive = true;
    this.dropExcessQueuedAudio();
    this.startTxPump();
  }

  sendUnkey() {
    this.txActive = false;
    this.txQueue.length = 0;
    this.sendPacket(Buffer.alloc(0), false);
  }

  getQueuedAudioPackets() {
    return this.txQueue.length;
  }

  getReceivedPackets() {
    return this.receivedPackets;
  }

  getSentPackets() {
    return this.sentPackets;
  }

  startTxPump() {
    if (this.txTimer) return;
    this.nextTxAt = performance.now();
    this.scheduleNextTxPacket(0);
  }

  scheduleNextTxPacket(delayMs = 0) {
    this.txTimer = setImmediate(() => {
      this.txTimer = null;
      if (!this.txQueue.length && !this.txActive) return;

      const now = performance.now();
      if (now + 0.25 < this.nextTxAt) {
        this.scheduleNextTxPacket(this.nextTxAt - now);
        return;
      }

      this.dropExcessQueuedAudio();
      const payload = this.txQueue.shift() ?? Buffer.alloc(USRP_VOICE_FRAME_BYTES);
      this.sendPacket(payload, true);
      this.nextTxAt += Number(this.config.packetMs ?? 20);
      if (this.nextTxAt < now - Number(this.config.packetMs ?? 20)) {
        this.nextTxAt = now + Number(this.config.packetMs ?? 20);
      }
      if (this.txQueue.length || this.txActive) {
        this.scheduleNextTxPacket(this.nextTxAt - performance.now());
      }
    });
  }

  sendPacket(payload, keyup) {
    const packet = Buffer.alloc(USRP_HEADER_BYTES + payload.length);
    packet.write('USRP', 0, 4, 'ascii');
    packet.writeUInt32BE(this.sequence++ >>> 0, 4);
    packet.writeUInt32BE(0, 8);
    packet.writeUInt32BE(keyup ? 1 : 0, 12);
    packet.writeUInt32BE(this.config.talkgroup ?? 0, 16);
    packet.writeUInt32BE(USRP_TYPE_VOICE, 20);
    packet.writeUInt32BE(0, 24);
    packet.writeUInt32BE(0, 28);
    payload.copy(packet, USRP_HEADER_BYTES);
    try {
      this.socket?.send(packet, this.config.remotePort, this.config.remoteHost, (error) => {
        if (error) {
          this.logger.error('Failed sending USRP to Asterisk', { message: error.message });
          if (this.running && this.config.autoReconnect !== false) this.restartSocket(error);
        }
      });
    } catch (error) {
      this.logger.error('Failed sending USRP to Asterisk', { message: error.message });
      if (this.running && this.config.autoReconnect !== false) this.restartSocket(error);
    }
    this.recordSendTiming();
    this.sentPackets += 1;
    if (this.sentPackets === 1 || this.sentPackets % 250 === 0) {
      this.logger.info('USRP packets sent to Asterisk', {
        packets: this.sentPackets,
        host: this.config.remoteHost,
        port: this.config.remotePort,
        keyup,
        bytes: packet.length,
        timing: this.flushSendTiming()
      });
    }
  }

  async sendTestTone({ durationMs = 4000, frequency = 1000, amplitude = 5000 } = {}) {
    const packetMs = this.config.packetMs ?? 20;
    const packets = Math.ceil(durationMs / packetMs);
    let sampleIndex = 0;
    for (let i = 0; i < packets; i += 1) {
      const pcm = Buffer.allocUnsafe(USRP_VOICE_FRAME_BYTES);
      for (let s = 0; s < 160; s += 1) {
        const value = Math.round(Math.sin(2 * Math.PI * frequency * sampleIndex / 8000) * amplitude);
        pcm.writeInt16LE(value, s * 2);
        sampleIndex += 1;
      }
      this.sendPcm(pcm);
    }
    await delay(durationMs + 500);
    this.sendUnkey();
  }

  recordSendTiming() {
    const now = performance.now();
    if (this.lastSentAt > 0) {
      const delta = now - this.lastSentAt;
      this.sendTiming.count += 1;
      this.sendTiming.min = Math.min(this.sendTiming.min, delta);
      this.sendTiming.max = Math.max(this.sendTiming.max, delta);
      this.sendTiming.sum += delta;
    }
    this.lastSentAt = now;
  }

  flushSendTiming() {
    const timing = this.sendTiming;
    if (!timing.count) return null;
    const summary = {
      count: timing.count,
      minMs: Number(timing.min.toFixed(3)),
      avgMs: Number((timing.sum / timing.count).toFixed(3)),
      maxMs: Number(timing.max.toFixed(3))
    };
    this.sendTiming = { count: 0, min: Infinity, max: 0, sum: 0 };
    return summary;
  }

  dropExcessQueuedAudio() {
    const maxQueuePackets = this.config.maxQueuePackets ?? 200;
    if (this.txQueue.length <= maxQueuePackets) return;
    const dropCount = this.txQueue.length - maxQueuePackets;
    this.txQueue.splice(0, dropCount);
    this.droppedTxPackets += dropCount;
    if (!this.loggedQueueWarning || this.droppedTxPackets % 250 === 0) {
      this.loggedQueueWarning = true;
      this.logger.warn('Dropping queued USRP audio packets for Asterisk', {
        dropCount,
        droppedTxPackets: this.droppedTxPackets,
        queuedAudioPackets: this.txQueue.length,
        maxQueuePackets
      });
    }
  }

  handlePacket(packet, remote) {
    if (packet.length < USRP_HEADER_BYTES) return;
    if (packet.toString('ascii', 0, 4) !== 'USRP') return;
    this.receivedPackets += 1;

    if (!this.loggedFirstReceive) {
      this.logger.info('Received USRP from Asterisk', {
        host: remote.address,
        port: remote.port,
        bytes: packet.length
      });
      this.loggedFirstReceive = true;
    }

    const keyup = packet.readUInt32BE(12) !== 0;
    const type = packet.readUInt32BE(20);
    const payload = packet.subarray(USRP_HEADER_BYTES);
    if (!keyup || type !== USRP_TYPE_VOICE || payload.length !== USRP_VOICE_FRAME_BYTES) {
      if (!keyup) this.emit('unkey', { remote });
      return;
    }

    this.emit('pcm', Buffer.from(payload), { remote, type: 'usrp' });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
