import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SvxReflectorClient,
  MsgType,
  UdpMsgType,
  reflectorInternals
} from '../src/svxreflector.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

test('SvxReflector auth challenge produces framed auth response', () => {
  const client = new SvxReflectorClient({
    config: {
      host: '127.0.0.1',
      tcpPort: 5300,
      udpPort: 5300,
      callsign: 'N0CALL',
      authKey: 'secret',
      talkgroup: 9,
      clientName: 'test',
      clientVersion: '0.0.0',
      heartbeatIntervalMs: 5000
    },
    logger
  });

  let written = null;
  client.tcp = {
    destroyed: false,
    write(frame) {
      written = frame;
    }
  };

  const challenge = Buffer.from('challenge');
  const payload = Buffer.allocUnsafe(4 + challenge.length);
  payload.writeUInt16BE(MsgType.AUTH_CHALLENGE, 0);
  payload.writeUInt16BE(challenge.length, 2);
  challenge.copy(payload, 4);

  client.handleTcpPayload(payload);

  assert.ok(written);
  assert.equal(written.readUInt32BE(0), written.length - 4);
  assert.equal(written.readUInt16BE(4), MsgType.AUTH_RESPONSE);
  assert.equal(written.readUInt16BE(6), 6);
  assert.equal(written.subarray(8, 14).toString('utf8'), 'N0CALL');
  assert.equal(written.readUInt16BE(14), 20);
});

test('SvxReflector server info marks login complete and stores client id', () => {
  const client = new SvxReflectorClient({
    config: {
      host: '127.0.0.1',
      tcpPort: 5300,
      udpPort: 5300,
      callsign: 'N0CALL',
      authKey: 'secret',
      talkgroup: 9,
      clientName: 'test',
      clientVersion: '0.0.0',
      heartbeatIntervalMs: 5000
    },
    logger
  });

  client.tcp = {
    destroyed: false,
    write() {},
    remoteAddress: '127.0.0.1'
  };
  client.udp = {
    send() {}
  };

  const payload = Buffer.allocUnsafe(6);
  payload.writeUInt16BE(MsgType.SERVER_INFO, 0);
  payload.writeUInt16BE(0, 2);
  payload.writeUInt16BE(42, 4);

  client.handleTcpPayload(payload);
  client.stopHeartbeat();

  assert.equal(client.connected, true);
  assert.equal(client.clientId, 42);
});

test('SvxReflector monitor talkgroups frame uses count and sorted 32-bit TGs', () => {
  const client = new SvxReflectorClient({
    config: {
      monitorTalkgroups: [91, 11, '11', 0, 'bad']
    },
    logger
  });

  let written = null;
  client.tcp = {
    destroyed: false,
    write(frame) {
      written = frame;
    }
  };

  client.sendMonitorTalkgroups();

  assert.ok(written);
  assert.equal(written.readUInt32BE(0), written.length - 4);
  assert.equal(written.readUInt16BE(4), MsgType.TG_MONITOR);
  assert.equal(written.readUInt16BE(6), 2);
  assert.equal(written.readUInt32BE(8), 11);
  assert.equal(written.readUInt32BE(12), 91);
});

test('SvxReflector monitor talkgroup normalization drops invalid values', () => {
  assert.deepEqual(
    reflectorInternals.normalizeTalkgroups([11, '91', 0, -1, 11, 1.5, 'abc']),
    [11, 91]
  );
});

test('SvxReflector UDP audio parser emits opus payload', () => {
  const client = new SvxReflectorClient({
    config: {},
    logger
  });
  const audio = Buffer.from([1, 2, 3, 4]);
  const packet = Buffer.allocUnsafe(8 + audio.length);
  packet.writeUInt16BE(UdpMsgType.AUDIO, 0);
  packet.writeUInt16BE(42, 2);
  packet.writeUInt16BE(7, 4);
  packet.writeUInt16BE(audio.length, 6);
  audio.copy(packet, 8);

  let seen = null;
  client.on('opus', (payload, meta) => {
    seen = { payload, meta };
  });
  client.handleUdp(packet);

  assert.deepEqual([...seen.payload], [...audio]);
  assert.deepEqual(seen.meta, { clientId: 42, sequence: 7 });
});
