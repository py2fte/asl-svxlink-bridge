import fs from 'node:fs';

const DEFAULTS = {
  nodeName: 'ASL3-BRIDGE',
  reflector: {
    host: '127.0.0.1',
    tcpPort: 5300,
    udpPort: 5300,
    callsign: 'N0CALL',
    authKey: '',
    clientName: 'asl-svxlink-bridge',
    clientVersion: '0.1.0',
    talkgroup: 9,
    monitorTalkgroups: [],
    txTimeoutMs: 180000,
    heartbeatIntervalMs: 5000,
    autoReconnect: true,
    reconnectInitialMs: 1000,
    reconnectMaxMs: 30000
  },
  asterisk: {
    mode: 'rtp',
    localRtpHost: '127.0.0.1',
    localRtpPort: 41000,
    rtpAdvertiseHost: '127.0.0.1',
    remoteRtpHost: '127.0.0.1',
    remoteRtpPort: 41002,
    learnRemoteFromIncoming: true,
    payloadType: 0,
    packetMs: 20,
    rtpMaxQueuePackets: 200,
    pttStartDtmf: '*99',
    pttStopDtmf: '#',
    pttHangMs: 700,
    pttOpenDelayMs: 250,
    pttTestDelayMs: 15000,
    asteriskToReflectorDelayMs: 15000,
    svxPttHangMs: 2500,
    svxVoiceThreshold: 200,
    svxPttRefreshMs: 10000,
    usrp: {
      localHost: '0.0.0.0',
      localPort: 4000,
      remoteHost: '127.0.0.1',
      remotePort: 4200,
      talkgroup: 0,
      autoReconnect: true,
      reconnectDelayMs: 1000
    },
    sip: {
      enabled: false,
      serverHost: '127.0.0.1',
      serverPort: 5060,
      localHost: '0.0.0.0',
      localPort: 5070,
      advertiseHost: '127.0.0.1',
      username: 'svxbridge',
      password: '',
      domain: '127.0.0.1',
      displayName: 'ASL SVX Bridge',
      registerExpires: 300,
      autoAnswer: true,
      autoConnectNode: null
    }
  },
  audio: {
    sampleRate: 8000,
    channels: 1,
    reflectorFrameMs: 20,
    opusBackend: 'auto',
    opusBitrate: 20000
  },
  audioMonitor: {
    enabled: false,
    host: '127.0.0.1',
    port: 8090
  },
  logging: {
    level: 'info'
  }
};

export function loadConfig(argv = process.argv) {
  const configPath = getArgValue(argv, '--config') ?? process.env.ASL_SVX_CONFIG;
  if (!configPath) return structuredClone(DEFAULTS);

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  return mergeConfig(structuredClone(DEFAULTS), parsed);
}

function getArgValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function mergeConfig(base, override) {
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      base[key] = mergeConfig(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
