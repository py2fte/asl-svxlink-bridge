import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsteriskRtpBridge } from '../src/asterisk-rtp.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

test('RTP packet builder emits version 2 packet with configured payload type', () => {
  const bridge = new AsteriskRtpBridge({
    config: {
      localRtpHost: '127.0.0.1',
      localRtpPort: 0,
      remoteRtpHost: '127.0.0.1',
      remoteRtpPort: 0,
      payloadType: 0
    },
    logger
  });

  const packet = bridge.buildRtpPacket(Buffer.alloc(160, 0xff));
  assert.equal(packet[0] >> 6, 2);
  assert.equal(packet[1] & 0x7f, 0);
  assert.equal(packet.length, 172);
});

test('RTP queue dropper keeps latest packets within configured limit', () => {
  const bridge = new AsteriskRtpBridge({
    config: {
      localRtpHost: '127.0.0.1',
      localRtpPort: 0,
      payloadType: 0,
      rtpMaxQueuePackets: 2
    },
    logger
  });

  bridge.txQueue.push(Buffer.from([1]), Buffer.from([2]), Buffer.from([3]));
  bridge.dropExcessQueuedAudio();

  assert.equal(bridge.droppedTxPackets, 1);
  assert.deepEqual(bridge.txQueue.map((packet) => packet[0]), [2, 3]);
});
