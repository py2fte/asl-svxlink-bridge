import crypto from 'node:crypto';
import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const CRLF = '\r\n';

export class SipClient extends EventEmitter {
  constructor({ config, rtpConfig, logger }) {
    super();
    this.config = config;
    this.rtpConfig = rtpConfig;
    this.logger = logger;
    this.localPort = config.localPort ?? 5062;
    this.localIP = config.advertiseHost || config.localIP || getLocalIP(config.serverHost);
    this.registerExpires = Math.max(60, Number(config.registerExpires ?? 300));
    this.registerRefreshMs = Math.max(30000, Math.floor(this.registerExpires * 850));

    this.regCallId = `reg-${crypto.randomBytes(6).toString('hex')}@${this.localIP}`;
    this.regFromTag = crypto.randomBytes(6).toString('hex');
    this.regCSeq = 1;
    this.registered = false;

    this.callId = null;
    this.localTag = null;
    this.remoteTag = null;
    this.remoteToUri = null;
    this.remoteContactUri = null;
    this.callCSeq = 1;
    this.inCall = false;
    this.pendingInvite = null;

    this.socket = dgram.createSocket('udp4');
    this.registerTimer = null;
    this.registerWatchdog = null;
    this.registerAttempts = 0;
  }

  async start() {
    this.socket.on('message', (packet, remote) => this.handleMessage(packet.toString('utf8'), remote));
    this.socket.on('error', (error) => this.emit('error', error));
    await new Promise((resolve) => this.socket.bind(this.localPort, this.config.localHost ?? '0.0.0.0', resolve));
    this.logger.info('SIP client listening', {
      host: this.config.localHost ?? '0.0.0.0',
      advertiseHost: this.localIP,
      port: this.localPort,
      user: this.config.username,
      server: `${this.config.serverHost}:${this.config.serverPort ?? 5060}`
    });
    this.doRegister();
    this.registerTimer = setInterval(() => this.doRegister(), this.registerRefreshMs);
  }

  stop() {
    clearInterval(this.registerTimer);
    clearTimeout(this.registerWatchdog);
    if (this.inCall) this.hangup();
    this.sendRaw(this.buildRegister({ expire: 0 }));
    setTimeout(() => {
      try {
        this.socket.close();
      } catch {}
    }, 600);
  }

  connect(nodeNumber = this.config.autoConnectNode) {
    if (!nodeNumber) return;
    if (this.inCall) {
      this.logger.info('SIP call already active');
      return;
    }
    this.callId = `${crypto.randomBytes(8).toString('hex')}@${this.localIP}`;
    this.localTag = crypto.randomBytes(6).toString('hex');
    this.remoteTag = null;
    this.callCSeq = 1;
    this.pendingInvite = { nodeNumber };
    const uri = `sip:${nodeNumber}@${this.config.serverHost}`;
    this.remoteToUri = uri;
    this.remoteContactUri = null;
    this.sendRaw(this.buildInvite(uri));
    this.logger.info('SIP INVITE sent', { nodeNumber, uri });
  }

  hangup() {
    if (!this.inCall) return;
    this.sendRaw(this.buildBye());
    this.inCall = false;
    this.emit('call-ended');
    this.logger.info('SIP BYE sent');
  }

  doRegister(authHeader = null, expire = this.registerExpires) {
    this.registerAttempts += 1;
    this.sendRaw(this.buildRegister({ expire, authHeader }));
    this.logger.info('Sending SIP REGISTER', {
      user: this.config.username,
      server: `${this.config.serverHost}:${this.config.serverPort ?? 5060}`,
      cseq: this.regCSeq - 1,
      authenticated: Boolean(authHeader),
      attempt: this.registerAttempts
    });
    this.armRegisterWatchdog();
  }

  armRegisterWatchdog() {
    clearTimeout(this.registerWatchdog);
    this.registerWatchdog = setTimeout(() => {
      if (!this.registered) {
        this.logger.warn('No SIP response received for REGISTER', {
          server: `${this.config.serverHost}:${this.config.serverPort ?? 5060}`,
          local: `${this.localIP}:${this.localPort}`,
          hint: 'Check Asterisk PJSIP endpoint, IP/port, and Windows firewall for UDP SIP'
        });
        if (this.registerAttempts < 4) {
          this.doRegister();
        }
      }
    }, 5000);
  }

  buildRegister({ expire = this.registerExpires, authHeader = null } = {}) {
    const realm = this.config.domain || this.config.serverHost;
    const reqUri = `sip:${realm}`;
    const from = `sip:${this.config.username}@${realm}`;
    const branch = `z9hG4bK${crypto.randomBytes(7).toString('hex')}`;
    const cseq = this.regCSeq++;
    const lines = [
      `REGISTER ${reqUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIP}:${this.localPort};branch=${branch};rport`,
      `From: <${from}>;tag=${this.regFromTag}`,
      `To: <${from}>`,
      `Call-ID: ${this.regCallId}`,
      `CSeq: ${cseq} REGISTER`,
      `Contact: <sip:${this.config.username}@${this.localIP}:${this.localPort}>;expires=${expire}`,
      `Expires: ${expire}`,
      'Max-Forwards: 70',
      'User-Agent: asl-svxlink-bridge',
      'Allow: INVITE, ACK, BYE, CANCEL, OPTIONS, REGISTER'
    ];
    if (authHeader) lines.push(`Authorization: ${authHeader}`);
    lines.push('Content-Length: 0');
    return `${lines.join(CRLF)}${CRLF}${CRLF}`;
  }

  buildInvite(uri, authHeader = null) {
    const sdp = buildSdp({
      address: this.rtpConfig.rtpAdvertiseHost ?? this.localIP,
      port: this.rtpConfig.localRtpPort,
      payloadType: this.rtpConfig.payloadType
    });
    const branch = `z9hG4bK${crypto.randomBytes(7).toString('hex')}`;
    const realm = this.config.domain || this.config.serverHost;
    const lines = [
      `INVITE ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIP}:${this.localPort};branch=${branch};rport`,
      `From: <sip:${this.config.username}@${realm}>;tag=${this.localTag}`,
      `To: <${uri}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.callCSeq++} INVITE`,
      `Contact: <sip:${this.config.username}@${this.localIP}:${this.localPort}>`,
      'Max-Forwards: 70',
      'User-Agent: asl-svxlink-bridge',
      'Allow: INVITE, ACK, BYE, CANCEL, OPTIONS',
      'Content-Type: application/sdp'
    ];
    if (authHeader) lines.push(`Authorization: ${authHeader}`);
    lines.push(`Content-Length: ${Buffer.byteLength(sdp)}`);
    return `${lines.join(CRLF)}${CRLF}${CRLF}${sdp}`;
  }

  buildAck() {
    const branch = `z9hG4bK${crypto.randomBytes(7).toString('hex')}`;
    const realm = this.config.domain || this.config.serverHost;
    const requestUri = this.remoteContactUri || this.remoteToUri || `sip:${this.config.serverHost}`;
    const toUri = this.remoteToUri || requestUri;
    const toTag = this.remoteTag ? `;tag=${this.remoteTag}` : '';
    return [
      `ACK ${requestUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIP}:${this.localPort};branch=${branch}`,
      `From: <sip:${this.config.username}@${realm}>;tag=${this.localTag}`,
      `To: <${toUri}>${toTag}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.callCSeq - 1} ACK`,
      'Max-Forwards: 70',
      'Content-Length: 0',
      '',
      ''
    ].join(CRLF);
  }

  buildBye() {
    const branch = `z9hG4bK${crypto.randomBytes(7).toString('hex')}`;
    const realm = this.config.domain || this.config.serverHost;
    const toTag = this.remoteTag ? `;tag=${this.remoteTag}` : '';
    const requestUri = this.remoteContactUri || this.remoteToUri || `sip:${this.config.serverHost}`;
    const toUri = this.remoteToUri || requestUri;
    return [
      `BYE ${requestUri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIP}:${this.localPort};branch=${branch}`,
      `From: <sip:${this.config.username}@${realm}>;tag=${this.localTag}`,
      `To: <${toUri}>${toTag}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.callCSeq++} BYE`,
      'Max-Forwards: 70',
      'Content-Length: 0',
      '',
      ''
    ].join(CRLF);
  }

  handleMessage(raw, remote) {
    raw = raw.trimStart();
    if (!raw) return;
    const message = parseSipMessage(raw);
    if (!message) return;
    if (message.startLine.startsWith('SIP/2.0')) {
      this.handleResponse(message, raw);
    } else {
      this.handleRequest(message, remote, raw);
    }
  }

  handleResponse(message, raw) {
    const status = Number(message.startLine.split(/\s+/)[1]);
    const cseq = getHeader(message, 'CSeq');
    const isRegister = /REGISTER/i.test(cseq);
    const isInvite = /INVITE/i.test(cseq);
    this.logger.info('SIP response received', { status, cseq });
    if (isRegister) clearTimeout(this.registerWatchdog);
    if (status >= 100 && status < 200) return;

    if (status === 401 || status === 407) {
      if (!isRegister && !isInvite) return;
      const challengeHeader = getHeader(message, status === 401 ? 'WWW-Authenticate' : 'Proxy-Authenticate');
      if (!challengeHeader) return;
      const challenge = parseDigestChallenge(challengeHeader);
      this.logger.info('SIP auth challenge received', {
        status,
        realm: challenge.realm,
        qop: challenge.qop ?? 'none'
      });

      if (isRegister) {
        this.doRegister(buildAuthHeader({
          username: this.config.username,
          password: this.config.password,
          realm: challenge.realm,
          nonce: challenge.nonce,
          opaque: challenge.opaque,
          qop: challenge.qop,
          method: 'REGISTER',
          uri: `sip:${challenge.realm}`
        }));
      } else if (isInvite && this.pendingInvite) {
        const uri = `sip:${this.pendingInvite.nodeNumber}@${this.config.serverHost}`;
        this.sendRaw(this.buildInvite(uri, buildAuthHeader({
          username: this.config.username,
          password: this.config.password,
          realm: challenge.realm,
          nonce: challenge.nonce,
          opaque: challenge.opaque,
          qop: challenge.qop,
          method: 'INVITE',
          uri
        })));
        this.logger.info('SIP authenticated INVITE sent', { uri });
      }
      return;
    }

    if (status === 200 && isRegister) {
      if (!this.registered) {
        this.registered = true;
        this.registerAttempts = 0;
        this.emit('registered');
        this.logger.info('SIP registration accepted');
        if (this.config.autoConnectNode) {
          setTimeout(() => this.connect(this.config.autoConnectNode), 500);
        }
      }
      return;
    }

    if (status === 200 && isInvite) {
      const tagMatch = getHeader(message, 'To').match(/tag=([^\s;>]+)/);
      if (tagMatch) this.remoteTag = tagMatch[1];
      const remoteRtp = parseSdp(raw);
      this.remoteContactUri = getHeader(message, 'Contact').match(/<([^>]+)>/)?.[1] || this.remoteToUri;
      this.sendRaw(this.buildAck());
      this.inCall = true;
      this.pendingInvite = null;
      this.logger.info('SIP outbound call established', remoteRtp);
      this.emitRemoteRtp(remoteRtp);
      this.emit('call-established');
      return;
    }

    if (status >= 400) {
      if (isInvite) {
        this.inCall = false;
        this.pendingInvite = null;
        this.emit('call-failed', { status, reason: message.startLine });
      }
      this.logger.warn('SIP request failed', { status, cseq, reason: message.startLine });
    }
  }

  handleRequest(message, remote, raw) {
    const [method] = message.startLine.split(/\s+/);
    this.logger.info('SIP request received', { method, from: `${remote.address}:${remote.port}` });

    if (method === 'OPTIONS') {
      this.respondTo(message, '200 OK');
      return;
    }
    if (method === 'BYE') {
      this.respondTo(message, '200 OK');
      this.inCall = false;
      this.emit('call-ended');
      return;
    }
    if (method === 'INVITE') {
      const remoteRtp = parseSdp(raw);
      const sdp = buildSdp({
        address: this.rtpConfig.rtpAdvertiseHost ?? this.localIP,
        port: this.rtpConfig.localRtpPort,
        payloadType: this.rtpConfig.payloadType
      });
      this.respondTo(message, '200 OK', sdp);
      this.inCall = true;
      this.emitRemoteRtp(remoteRtp);
      this.logger.info('SIP incoming call auto-answered', remoteRtp);
      return;
    }
    if (method === 'CANCEL') {
      this.respondTo(message, '200 OK');
      this.respondTo(message, '487 Request Terminated');
      this.inCall = false;
      this.emit('call-ended');
      return;
    }
    if (['MESSAGE', 'NOTIFY', 'SUBSCRIBE', 'REFER', 'UPDATE', 'INFO'].includes(method)) {
      this.respondTo(message, '200 OK');
    }
  }

  respondTo(request, statusText, body = '') {
    const headers = [
      `SIP/2.0 ${statusText}`,
      `Via: ${getHeader(request, 'Via')}`,
      `From: ${getHeader(request, 'From')}`,
      `To: ${ensureTag(getHeader(request, 'To'))}`,
      `Call-ID: ${getHeader(request, 'Call-ID')}`,
      `CSeq: ${getHeader(request, 'CSeq')}`,
      `Content-Length: ${Buffer.byteLength(body)}`
    ];
    if (body) headers.push('Content-Type: application/sdp');
    this.sendRaw(`${headers.join(CRLF)}${CRLF}${CRLF}${body}`);
  }

  emitRemoteRtp(remoteRtp) {
    if (remoteRtp.connectionAddress && remoteRtp.audioPort) {
      this.emit('remote-rtp', {
        host: remoteRtp.connectionAddress,
        port: remoteRtp.audioPort
      });
    }
  }

  sendRaw(message) {
    const packet = Buffer.from(message, 'utf8');
    this.socket.send(packet, 0, packet.length, this.config.serverPort ?? 5060, this.config.serverHost, (error) => {
      if (error) this.emit('error', error);
    });
  }
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function buildAuthHeader({ username, password, realm, nonce, opaque, qop, method, uri }) {
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const response = digestResponse({ username, password, realm, method, uri, nonce, nc, cnonce, qop });
  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) header += `, opaque="${opaque}"`;
  return header;
}

function digestResponse({ username, password, realm, method, uri, nonce, nc, cnonce, qop }) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  if (qop === 'auth' || qop === 'auth-int') {
    return md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  }
  return md5(`${ha1}:${nonce}:${ha2}`);
}

function parseDigestChallenge(header) {
  const param = (key) => {
    let match = header.match(new RegExp(`${key}="([^"]*)"`, 'i'));
    if (match) return match[1];
    match = header.match(new RegExp(`${key}=([^,\\s]+)`, 'i'));
    return match ? match[1] : null;
  };
  let qop = param('qop');
  if (qop && qop.includes('auth')) qop = 'auth';
  else if (qop) qop = null;
  return {
    realm: param('realm'),
    nonce: param('nonce'),
    opaque: param('opaque'),
    algorithm: (param('algorithm') || 'MD5').toUpperCase(),
    qop
  };
}

function parseSipMessage(raw) {
  const [head, ...bodyParts] = raw.split(/\r?\n\r?\n/);
  if (!head) return null;
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift();
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { startLine, headers, body: bodyParts.join('\r\n\r\n') };
}

function getHeader(message, name) {
  const found = Object.entries(message.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? '';
}

function parseSdp(raw) {
  const connectionAddress = (raw.match(/c=IN IP4 ([\d.]+)/) || [])[1] ?? null;
  const audioPort = Number((raw.match(/m=audio\s+(\d+)/) || [])[1] ?? 0) || null;
  return { connectionAddress, audioPort };
}

function buildSdp({ address, port, payloadType }) {
  return [
    'v=0',
    `o=asl-svxlink-bridge ${Date.now()} ${Date.now()} IN IP4 ${address}`,
    's=ASL SVXLink Bridge',
    `c=IN IP4 ${address}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${payloadType} 101`,
    `a=rtpmap:${payloadType} PCMU/8000`,
    'a=ptime:20',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-15',
    'a=sendrecv',
    ''
  ].join(CRLF);
}

function ensureTag(toHeader) {
  if (/;tag=/i.test(toHeader)) return toHeader;
  return `${toHeader};tag=${crypto.randomBytes(5).toString('hex')}`;
}

function getLocalIP(preferSameSubnet) {
  const candidates = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) candidates.push(address.address);
    }
  }
  if (candidates.length === 0) return '127.0.0.1';
  if (preferSameSubnet) {
    const prefix = preferSameSubnet.split('.').slice(0, 3).join('.');
    const match = candidates.find((address) => address.startsWith(`${prefix}.`));
    if (match) return match;
  }
  return candidates[0];
}

export const sipInternals = {
  parseSdp,
  buildSdp,
  parseDigestChallenge,
  digestResponse
};
