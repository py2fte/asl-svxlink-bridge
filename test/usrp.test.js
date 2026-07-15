import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsteriskUsrpBridge } from '../src/asterisk-usrp.js';

const logger = {
  info() {},
  warn() {},
  error() {}
};

test('USRP packet parser emits 20 ms signed-linear PCM voice frames', async () => {
  const bridge = new AsteriskUsrpBridge({
    config: { localHost: '127.0.0.1', localPort: 0, remoteHost: '127.0.0.1', remotePort: 1 },
    logger
  });
  const pcm = Buffer.alloc(320, 0x11);
  const packet = Buffer.alloc(32 + pcm.length);
  packet.write('USRP', 0, 4, 'ascii');
  packet.writeUInt32BE(1, 4);
  packet.writeUInt32BE(1, 12);
  packet.writeUInt32BE(0, 20);
  pcm.copy(packet, 32);

  const emitted = once(bridge, 'pcm');
  bridge.handlePacket(packet, { address: '127.0.0.1', port: 4200 });
  const [frame, meta] = await emitted;

  assert.deepEqual(frame, pcm);
  assert.equal(meta.type, 'usrp');
  assert.equal(bridge.getReceivedPackets(), 1);
});

test('USRP packet builder writes chan_usrp compatible header', () => {
  const bridge = new AsteriskUsrpBridge({
    config: { localHost: '127.0.0.1', localPort: 0, remoteHost: '192.0.2.10', remotePort: 4300, talkgroup: 16 },
    logger
  });
  let sentPacket;
  bridge.socket.send = (packet, port, host, callback) => {
    sentPacket = packet;
    assert.equal(port, 4300);
    assert.equal(host, '192.0.2.10');
    callback?.();
  };

  const pcm = Buffer.alloc(320, 0x22);
  bridge.sendPacket(pcm, true);

  assert.equal(sentPacket.toString('ascii', 0, 4), 'USRP');
  assert.equal(sentPacket.readUInt32BE(12), 1);
  assert.equal(sentPacket.readUInt32BE(16), 16);
  assert.equal(sentPacket.readUInt32BE(20), 0);
  assert.deepEqual(sentPacket.subarray(32), pcm);
});
