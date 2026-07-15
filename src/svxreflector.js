import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import { EventEmitter } from 'node:events';

export const MsgType = {
  HEARTBEAT: 1,
  PROTO_VER: 5,
  PROTO_VER_DOWNGRADE: 6,
  AUTH_CHALLENGE: 10,
  AUTH_RESPONSE: 11,
  AUTH_OK: 12,
  ERROR: 13,
  SERVER_INFO: 100,
  NODE_LIST: 101,
  NODE_JOINED: 102,
  NODE_LEFT: 103,
  TALKER_START: 104,
  TALKER_STOP: 105,
  SELECT_TG: 106,
  TG_MONITOR: 107,
  REQUEST_QSY: 109,
  STATE_EVENT: 110,
  NODE_INFO: 111,
  SIGNAL_STRENGTH: 112,
  TX_STATUS: 113
};

export const UdpMsgType = {
  HEARTBEAT: 1,
  AUDIO: 101,
  FLUSH_SAMPLES: 102,
  ALL_SAMPLES_FLUSHED: 103,
  SIGNAL_STRENGTH: 104
};

const PROTOCOL_MAJOR = 2;
const PROTOCOL_MINOR = 0;
const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_RECONNECT_INITIAL_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30000;

export class SvxReflectorClient extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.tcp = null;
    this.udp = null;
    this.tcpBuffer = Buffer.alloc(0);
    this.clientId = 0;
    this.udpSequence = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = this.config.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.stopping = false;
    this.connecting = false;
    this.udpReady = false;
    this.connected = false;
  }

  async connect() {
    this.stopping = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.ensureUdpSocket();
    await this.connectTcp();
  }

  async ensureUdpSocket() {
    if (this.udpReady && this.udp) return;
    this.closeUdpSocket();
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', (packet) => this.handleUdp(packet));
    this.udp.on('error', (error) => this.handleUdpError(error));
    await new Promise((resolve) => this.udp.bind(0, resolve));
    this.udpReady = true;
  }

  async connectTcp() {
    if (this.connecting) return;
    this.connecting = true;
    this.connected = false;
    this.tcpBuffer = Buffer.alloc(0);
    this.clientId = 0;
    this.stopHeartbeat();
    this.tcp?.destroy();
    this.tcp = net.createConnection({
      host: this.config.host,
      port: this.config.tcpPort
    });
    this.tcp.setKeepAlive(true);
    this.tcp.setNoDelay(true);

    this.tcp.on('data', (chunk) => this.handleTcp(chunk));
    this.tcp.on('close', () => {
      this.connected = false;
      this.stopHeartbeat();
      this.emit('close');
      this.scheduleReconnect('tcp-close');
    });
    this.tcp.on('error', (error) => this.emit('error', error));

    try {
      await new Promise((resolve, reject) => {
        const onConnect = () => {
          this.tcp.off('error', onError);
          resolve();
        };
        const onError = (error) => {
          this.tcp.off('connect', onConnect);
          reject(error);
        };
        this.tcp.once('connect', onConnect);
        this.tcp.once('error', onError);
      });
    } catch (error) {
      this.connecting = false;
      if (this.shouldReconnect()) {
        const delayMs = this.nextReconnectDelay();
        this.logger.warn('SvxReflector TCP connect failed; reconnect scheduled', {
          message: error.message,
          delayMs
        });
        this.scheduleReconnect('tcp-error', delayMs);
        return;
      }
      throw error;
    }

    this.connecting = false;
    this.reconnectDelayMs = this.config.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;

    this.logger.info('Connected to SvxReflector TCP', {
      host: this.config.host,
      port: this.config.tcpPort,
      udpLocalPort: this.udp.address().port
    });
    this.sendProtoVer();
  }

  close() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.tcp?.destroy();
    this.closeUdpSocket();
  }

  sendOpus(opusFrame) {
    if (!opusFrame?.length || !this.connected) return;
    const header = Buffer.allocUnsafe(8);
    header.writeUInt16BE(UdpMsgType.AUDIO, 0);
    header.writeUInt16BE(this.clientId, 2);
    header.writeUInt16BE(this.udpSequence, 4);
    header.writeUInt16BE(opusFrame.length, 6);
    this.udpSequence = (this.udpSequence + 1) & 0xffff;
    this.sendUdp(Buffer.concat([header, opusFrame]));
  }

  sendPtt(active) {
    if (!this.connected) return;
    const payload = Buffer.allocUnsafe(2 + 1 + 20);
    payload.writeUInt16BE(MsgType.TX_STATUS, 0);
    payload.writeUInt8(active ? 1 : 0, 2);
    writeFixedAscii(payload, this.config.callsign, 3, 20);
    this.sendFrame(payload);
  }

  sendFlushSamples() {
    if (!this.connected) return;
    const packet = Buffer.allocUnsafe(6);
    packet.writeUInt16BE(UdpMsgType.FLUSH_SAMPLES, 0);
    packet.writeUInt16BE(this.clientId, 2);
    packet.writeUInt16BE(this.udpSequence, 4);
    this.udpSequence = (this.udpSequence + 1) & 0xffff;
    this.sendUdp(packet);
  }

  sendProtoVer() {
    const payload = Buffer.allocUnsafe(6);
    payload.writeUInt16BE(MsgType.PROTO_VER, 0);
    payload.writeUInt16BE(PROTOCOL_MAJOR, 2);
    payload.writeUInt16BE(PROTOCOL_MINOR, 4);
    this.sendFrame(payload);
    this.logger.info('SvxReflector protocol version sent', {
      major: PROTOCOL_MAJOR,
      minor: PROTOCOL_MINOR
    });
  }

  sendAuthResponse(challenge) {
    const digest = crypto.createHmac('sha1', this.config.authKey).update(challenge).digest();
    const callsign = Buffer.from(this.config.callsign.trim(), 'utf8');
    const payload = Buffer.allocUnsafe(2 + 2 + callsign.length + 2 + digest.length);
    let offset = 0;
    payload.writeUInt16BE(MsgType.AUTH_RESPONSE, offset);
    offset += 2;
    payload.writeUInt16BE(callsign.length, offset);
    offset += 2;
    callsign.copy(payload, offset);
    offset += callsign.length;
    payload.writeUInt16BE(digest.length, offset);
    offset += 2;
    digest.copy(payload, offset);
    this.sendFrame(payload);
    this.logger.info('SvxReflector authentication response sent', {
      callsign: this.config.callsign,
      digestBytes: digest.length
    });
  }

  sendNodeInfo() {
    const info = {
      sw: this.config.clientName,
      swVer: this.config.clientVersion,
      callsign: this.config.callsign,
      tip: 'ASL3 to SVXLink bridge',
      Website: 'https://github.com/AllStarLink/ASL3'
    };
    const json = Buffer.from(JSON.stringify(info), 'utf8');
    const payload = Buffer.allocUnsafe(2 + 2 + json.length);
    payload.writeUInt16BE(MsgType.NODE_INFO, 0);
    payload.writeUInt16BE(json.length, 2);
    json.copy(payload, 4);
    this.sendFrame(payload);
  }

  sendSelectTalkgroup(talkgroup = this.config.talkgroup) {
    const payload = Buffer.allocUnsafe(6);
    payload.writeUInt16BE(MsgType.SELECT_TG, 0);
    payload.writeUInt32BE(talkgroup >>> 0, 2);
    this.sendFrame(payload);
    this.logger.info('SvxReflector talkgroup selected', { talkgroup });
  }

  sendMonitorTalkgroups(talkgroups = this.config.monitorTalkgroups) {
    const normalized = normalizeTalkgroups(talkgroups);
    const payload = Buffer.allocUnsafe(4 + normalized.length * 4);
    payload.writeUInt16BE(MsgType.TG_MONITOR, 0);
    payload.writeUInt16BE(normalized.length, 2);
    normalized.forEach((talkgroup, index) => {
      payload.writeUInt32BE(talkgroup >>> 0, 4 + index * 4);
    });
    this.sendFrame(payload);
    this.logger.info('SvxReflector monitor talkgroups configured', {
      talkgroups: normalized
    });
  }

  sendTcpHeartbeat() {
    const payload = Buffer.allocUnsafe(2);
    payload.writeUInt16BE(MsgType.HEARTBEAT, 0);
    this.sendFrame(payload);
  }

  sendUdpHeartbeat() {
    if (!this.connected) return;
    const packet = Buffer.allocUnsafe(6);
    packet.writeUInt16BE(UdpMsgType.HEARTBEAT, 0);
    packet.writeUInt16BE(this.clientId, 2);
    packet.writeUInt16BE(this.udpSequence, 4);
    this.udpSequence = (this.udpSequence + 1) & 0xffff;
    this.sendUdp(packet);
  }

  sendFrame(payload) {
    if (!this.tcp || this.tcp.destroyed) return;
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    this.tcp.write(frame);
  }

  handleUdpError(error) {
    this.emit('error', error);
    if (!this.shouldReconnect()) return;
    this.connected = false;
    this.stopHeartbeat();
    this.tcp?.destroy();
    this.closeUdpSocket();
    this.scheduleReconnect('udp-error');
  }

  scheduleReconnect(reason, delayOverrideMs) {
    if (!this.shouldReconnect() || this.reconnectTimer) return;
    const delayMs = delayOverrideMs ?? this.nextReconnectDelay();
    this.logger.warn('SvxReflector reconnect scheduled', {
      reason,
      delayMs,
      host: this.config.host,
      port: this.config.tcpPort
    });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.ensureUdpSocket();
        await this.connectTcp();
      } catch (error) {
        this.emit('error', error);
        this.scheduleReconnect('reconnect-error');
      }
    }, delayMs);
  }

  nextReconnectDelay() {
    const delayMs = this.reconnectDelayMs;
    const maxDelayMs = this.config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.reconnectDelayMs = Math.min(delayMs * 2, maxDelayMs);
    return delayMs;
  }

  shouldReconnect() {
    return !this.stopping && this.config.autoReconnect !== false;
  }

  closeUdpSocket() {
    if (!this.udp) return;
    try {
      this.udp.close();
    } catch {
      // Socket may already be closed while recovering from a UDP error.
    }
    this.udp = null;
    this.udpReady = false;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendTcpHeartbeat();
      this.sendUdpHeartbeat();
    }, this.config.heartbeatIntervalMs);
    this.sendTcpHeartbeat();
    this.sendUdpHeartbeat();
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  handleTcp(chunk) {
    this.tcpBuffer = Buffer.concat([this.tcpBuffer, chunk]);
    while (this.tcpBuffer.length >= 4) {
      const payloadSize = this.tcpBuffer.readUInt32BE(0);
      if (payloadSize > MAX_FRAME_BYTES) {
        this.emit('error', new Error(`SvxReflector frame too large: ${payloadSize}`));
        this.close();
        return;
      }
      if (this.tcpBuffer.length < 4 + payloadSize) return;

      const payload = this.tcpBuffer.subarray(4, 4 + payloadSize);
      this.tcpBuffer = this.tcpBuffer.subarray(4 + payloadSize);
      this.handleTcpPayload(payload);
    }
  }

  handleTcpPayload(payload) {
    if (payload.length < 2) return;
    const type = payload.readUInt16BE(0);
    this.emit('control', { type, bytes: payload.length });

    switch (type) {
      case MsgType.PROTO_VER:
        this.logger.debug('SvxReflector protocol version acknowledged');
        break;
      case MsgType.AUTH_CHALLENGE:
        this.handleAuthChallenge(payload);
        break;
      case MsgType.AUTH_OK:
        this.logger.info('SvxReflector authentication accepted');
        break;
      case MsgType.SERVER_INFO:
        this.handleServerInfo(payload);
        break;
      case MsgType.ERROR:
        this.handleError(payload);
        break;
      case MsgType.HEARTBEAT:
        this.logger.debug('SvxReflector TCP heartbeat received');
        break;
      default:
        this.logger.debug('Unhandled SvxReflector TCP message', { type, bytes: payload.length });
    }
  }

  handleAuthChallenge(payload) {
    if (payload.length < 4) {
      this.emit('error', new Error('Malformed SvxReflector auth challenge'));
      return;
    }
    const length = payload.readUInt16BE(2);
    const challenge = payload.subarray(4, 4 + length);
    if (challenge.length !== length) {
      this.emit('error', new Error('Truncated SvxReflector auth challenge'));
      return;
    }
    this.logger.info('SvxReflector authentication challenge received', { challengeBytes: length });
    this.sendAuthResponse(challenge);
  }

  handleServerInfo(payload) {
    if (payload.length < 6) {
      this.emit('error', new Error('Malformed SvxReflector server info'));
      return;
    }
    const reserved = payload.readUInt16BE(2);
    this.clientId = payload.readUInt16BE(4);
    this.connected = true;
    this.logger.info('SvxReflector login complete', {
      clientId: this.clientId,
      reserved,
      callsign: this.config.callsign,
      talkgroup: this.config.talkgroup
    });
    this.sendNodeInfo();
    this.sendSelectTalkgroup();
    this.sendMonitorTalkgroups();
    this.startHeartbeat();
    this.emit('login', { clientId: this.clientId });
  }

  handleError(payload) {
    let message = 'unknown error';
    if (payload.length >= 4) {
      const length = payload.readUInt16BE(2);
      message = payload.subarray(4, 4 + length).toString('utf8');
    }
    this.logger.error('SvxReflector returned error', { message });
    this.emit('auth-error', message);
  }

  handleUdp(packet) {
    if (packet.length < 6) return;
    const type = packet.readUInt16BE(0);
    const clientId = packet.readUInt16BE(2);
    const sequence = packet.readUInt16BE(4);

    if (type === UdpMsgType.AUDIO) {
      if (packet.length < 8) return;
      const audioLen = packet.readUInt16BE(6);
      const audio = packet.subarray(8, 8 + audioLen);
      this.emit('opus', audio, { clientId, sequence });
    } else if (type === UdpMsgType.HEARTBEAT) {
      this.emit('heartbeat', { clientId, sequence });
    }
  }

  sendUdp(packet) {
    if (!this.udp) return;
    const host = this.tcp?.remoteAddress ?? this.config.host;
    this.udp.send(packet, this.config.udpPort, host);
  }
}

function writeFixedAscii(buffer, value, offset, length) {
  buffer.fill(0, offset, offset + length);
  Buffer.from(String(value ?? ''), 'ascii').copy(buffer, offset, 0, length);
}

function normalizeTalkgroups(talkgroups) {
  if (!Array.isArray(talkgroups)) return [];
  return [...new Set(talkgroups
    .map((talkgroup) => Number(talkgroup))
    .filter((talkgroup) => Number.isInteger(talkgroup) && talkgroup > 0)
    .map((talkgroup) => talkgroup >>> 0))]
    .sort((a, b) => a - b);
}

export const reflectorInternals = {
  MsgType,
  UdpMsgType,
  normalizeTalkgroups
};
