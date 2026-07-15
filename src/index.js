#!/usr/bin/env node
import { AsteriskRtpBridge } from './asterisk-rtp.js';
import { AsteriskUsrpBridge } from './asterisk-usrp.js';
import { AudioMonitorServer } from './audio-monitor-server.js';
import { loadConfig } from './config.js';
import { OpusCodec, Pcm16Downsampler2x } from './codec/opus-codec.js';
import { SipClient } from './sip-client.js';
import { SvxReflectorClient } from './svxreflector.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.logging);
const usrpConfig = {
  ...config.asterisk.usrp,
  packetMs: config.asterisk.packetMs,
  maxQueuePackets: config.asterisk.rtpMaxQueuePackets
};
const asterisk = config.asterisk.mode === 'usrp'
  ? new AsteriskUsrpBridge({ config: usrpConfig, logger })
  : new AsteriskRtpBridge({ config: config.asterisk, logger });
const reflector = new SvxReflectorClient({ config: config.reflector, logger });
const codec = new OpusCodec({ logger, config: config.audio });
const reflectorDownsampler = new Pcm16Downsampler2x();
const audioMonitor = new AudioMonitorServer({ config: config.audioMonitor, logger });
const sip = config.asterisk.mode !== 'usrp' && (config.asterisk.mode === 'sip' || config.asterisk.sip.enabled)
  ? new SipClient({ config: config.asterisk.sip, rtpConfig: config.asterisk, logger })
  : null;
const testPttMode = process.argv.includes('--test-ptt');
let reflectorTx = false;
let reflectorTxTimer = null;
let reflectorTxRefreshTimer = null;
let asteriskToReflectorFrames = 0;
let reflectorToAsteriskFrames = 0;
let asteriskPtt = false;
let asteriskPttTimer = null;
let asteriskPttOpenPromise = null;
let allowAsteriskToReflectorAt = 0;
let loggedAsteriskGate = false;

asterisk.on('pcm', (pcmFrame) => {
  if (Date.now() < allowAsteriskToReflectorAt) {
    if (!loggedAsteriskGate) {
      loggedAsteriskGate = true;
      logger.info('Ignoring Asterisk announcement audio before SVXLink TX is enabled');
    }
    return;
  }

  const voice = isVoiceFrame(pcmFrame, config.asterisk.svxVoiceThreshold ?? 200);
  if (voice) {
    openReflectorTx();
    scheduleReflectorTxClose();
  }
  if (!reflectorTx) return;

  const opusFrame = codec.encodePcmToOpus(pcmFrame);
  if (opusFrame) {
    reflector.sendOpus(opusFrame);
    asteriskToReflectorFrames += 1;
    if (asteriskToReflectorFrames === 1 || asteriskToReflectorFrames % 250 === 0) {
      logger.info('Asterisk audio encoded for SVXLink', { frames: asteriskToReflectorFrames });
    }
  }
});

reflector.on('opus', async (opusFrame) => {
  try {
    const decoded16k = codec.decodeOpusToPcm16k(opusFrame);
    audioMonitor.write('svxlink', decoded16k);
    const pcmFrame = decoded16k ? reflectorDownsampler.process(decoded16k) : null;
    if (pcmFrame) {
      audioMonitor.write('asterisk', pcmFrame);
      await openAsteriskPtt();
      asterisk.sendPcm(pcmFrame);
      reflectorToAsteriskFrames += 1;
      if (reflectorToAsteriskFrames === 1 || reflectorToAsteriskFrames % 250 === 0) {
        logger.info('SVXLink audio decoded for Asterisk', {
          frames: reflectorToAsteriskFrames,
          queuedAudioPackets: asterisk.getQueuedAudioPackets()
        });
      }
    }
  } catch (error) {
    logger.warn('Failed to decode reflector Opus frame', { message: error.message });
  }
});

reflector.on('control', (message) => logger.debug('SvxReflector control message', message));
reflector.on('error', (error) => logger.error('SvxReflector error', { message: error.message }));
asterisk.on('error', (error) => logger.error('Asterisk audio bridge error', { message: error.message }));
asterisk.on('outbound-pcmu', (pcmFrame) => audioMonitor.write('ulaw', pcmFrame));
sip?.on('remote-rtp', (remote) => asterisk.setRemote(remote));
sip?.on('call-established', () => {
  const delayMs = config.asterisk.asteriskToReflectorDelayMs ?? config.asterisk.pttTestDelayMs ?? 15000;
  allowAsteriskToReflectorAt = Date.now() + delayMs;
  loggedAsteriskGate = false;
  logger.info('Asterisk to SVXLink audio gated until ASL node is ready', { delayMs });
});
sip?.on('error', (error) => logger.error('SIP client error', { message: error.message }));

async function main() {
  if (config.asterisk.mode === 'sip'
      && config.asterisk.rtpAdvertiseHost === config.asterisk.sip.serverHost
      && config.asterisk.sip.localHost === '0.0.0.0') {
    logger.warn('SIP/RTP advertise host equals Asterisk server host', {
      host: config.asterisk.rtpAdvertiseHost,
      hint: 'This is only correct if the bridge runs on the Asterisk server. Otherwise set rtpAdvertiseHost and sip.advertiseHost to the bridge machine IP.'
    });
  }
  logger.info('Starting ASL SVXLink bridge', {
    nodeName: config.nodeName,
    reflector: `${config.reflector.host}:${config.reflector.tcpPort}`,
    rtp: config.asterisk.mode === 'usrp'
      ? `${config.asterisk.usrp.localHost}:${config.asterisk.usrp.localPort}`
      : `${config.asterisk.localRtpHost}:${config.asterisk.localRtpPort}`,
    asteriskMode: config.asterisk.mode,
    sipEnabled: Boolean(sip)
  });

  await asterisk.start();
  await audioMonitor.start();
  if (sip) await sip.start();
  if (testPttMode) {
    await runPttTest();
    shutdown('test-complete');
    return;
  }
  await reflector.connect();
}

function shutdown(signal) {
  logger.info('Stopping ASL SVXLink bridge', { signal });
  codec.close();
  closeReflectorTx();
  audioMonitor.stop();
  sip?.stop();
  reflector.close();
  asterisk.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
  logger.error('Bridge failed to start', { message: error.message, stack: error.stack });
  process.exit(1);
});

function isVoiceFrame(pcmFrame, threshold) {
  let sum = 0;
  const samples = pcmFrame.length / 2;
  for (let offset = 0; offset < pcmFrame.length; offset += 2) {
    sum += Math.abs(pcmFrame.readInt16LE(offset));
  }
  return samples > 0 && sum / samples > threshold;
}

function openReflectorTx() {
  if (reflectorTx) return;
  reflectorTx = true;
  reflector.sendPtt(true);
  logger.info('Asterisk audio opened SVXLink TX');

  clearInterval(reflectorTxRefreshTimer);
  const refreshMs = config.asterisk.svxPttRefreshMs ?? 10000;
  if (refreshMs > 0) {
    reflectorTxRefreshTimer = setInterval(() => {
      if (reflectorTx) reflector.sendPtt(true);
    }, refreshMs);
  }
}

function scheduleReflectorTxClose() {
  clearTimeout(reflectorTxTimer);
  reflectorTxTimer = setTimeout(() => {
    closeReflectorTx();
  }, config.asterisk.svxPttHangMs ?? 2500);
}

function closeReflectorTx() {
  clearTimeout(reflectorTxTimer);
  reflectorTxTimer = null;
  clearInterval(reflectorTxRefreshTimer);
  reflectorTxRefreshTimer = null;
  if (!reflectorTx) return;
  reflectorTx = false;
  reflector.sendPtt(false);
  reflector.sendFlushSamples();
  logger.info('Asterisk audio closed SVXLink TX');
}

async function runPttTest() {
  if (config.asterisk.mode === 'usrp') {
    logger.info('USRP test sending 1 kHz tone', {
      host: config.asterisk.usrp.remoteHost,
      port: config.asterisk.usrp.remotePort
    });
    await asterisk.sendTestTone({ durationMs: 5000 });
    await delay(1000);
    if (typeof asterisk.getSentPackets === 'function') {
      logger.info('USRP test complete', {
        sentPackets: asterisk.getSentPackets(),
        receivedPackets: asterisk.getReceivedPackets()
      });
    }
    return;
  }

  if (!sip) throw new Error('--test-ptt requires SIP mode');
  if (!config.asterisk.sip.autoConnectNode) {
    throw new Error('--test-ptt requires asterisk.sip.autoConnectNode');
  }
  logger.info('PTT test waiting for SIP call establishment');
  await waitForEvent(sip, 'call-established', 30000);
  const delayMs = config.asterisk.pttTestDelayMs ?? 15000;
  logger.info('PTT test waiting for ASL node to enter Rpt', { delayMs });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (asterisk.getReceivedPackets() === 0) {
    logger.warn('No RTP received from Asterisk before PTT test', {
      rtpAdvertiseHost: config.asterisk.rtpAdvertiseHost,
      localRtpHost: config.asterisk.localRtpHost,
      localRtpPort: config.asterisk.localRtpPort,
      hint: 'rtpAdvertiseHost must be the IP of the machine running this bridge, not the Asterisk server IP'
    });
  }
  logger.info('PTT test sending start DTMF', { sequence: config.asterisk.pttStartDtmf });
  await asterisk.sendDtmfSequence(config.asterisk.pttStartDtmf ?? '*99');
  logger.info('PTT test sending RTP tone');
  await asterisk.sendTestTone({ durationMs: 4000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  logger.info('PTT test sending stop DTMF', { sequence: config.asterisk.pttStopDtmf });
  await asterisk.sendDtmfSequence(config.asterisk.pttStopDtmf ?? '#');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

function waitForEvent(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      emitter.off('error', onError);
    };
    emitter.on(event, onEvent);
    emitter.on('error', onError);
  });
}

async function openAsteriskPtt() {
  let openedNow = false;
  if (!asteriskPtt) {
    openedNow = true;
    asteriskPtt = true;
    if (config.asterisk.pttStartDtmf && typeof asterisk.sendDtmfSequence === 'function') {
      logger.info('Opening Asterisk PTT before sending SVXLink audio', { sequence: config.asterisk.pttStartDtmf });
      asteriskPttOpenPromise = asterisk.sendDtmfSequence(config.asterisk.pttStartDtmf)
        .then((sent) => logger.info('Sent Asterisk PTT start DTMF', { sequence: config.asterisk.pttStartDtmf, sent }))
        .finally(() => {
          asteriskPttOpenPromise = null;
        });
    }
  }
  if (asteriskPttOpenPromise) await asteriskPttOpenPromise;
  if (openedNow && (config.asterisk.pttOpenDelayMs ?? 0) > 0) {
    await delay(config.asterisk.pttOpenDelayMs);
  }
  clearTimeout(asteriskPttTimer);
  asteriskPttTimer = setTimeout(() => {
    asteriskPtt = false;
    if (config.asterisk.pttStopDtmf && typeof asterisk.sendDtmfSequence === 'function') {
      asterisk.sendDtmfSequence(config.asterisk.pttStopDtmf)
        .then((sent) => logger.info('Sent Asterisk PTT stop DTMF', { sequence: config.asterisk.pttStopDtmf, sent }));
    } else if (typeof asterisk.sendUnkey === 'function') {
      asterisk.sendUnkey();
    }
  }, config.asterisk.pttHangMs ?? 700);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
