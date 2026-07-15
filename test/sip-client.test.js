import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sipInternals } from '../src/sip-client.js';

test('SDP parser reads connection address and audio port', () => {
  const sdp = [
    'v=0',
    'o=asterisk 1 1 IN IP4 192.0.2.20',
    's=Asterisk',
    'c=IN IP4 192.0.2.20',
    't=0 0',
    'm=audio 18122 RTP/AVP 0',
    'a=rtpmap:0 PCMU/8000',
    ''
  ].join('\r\n');

  assert.deepEqual(sipInternals.parseSdp(sdp), {
    connectionAddress: '192.0.2.20',
    audioPort: 18122
  });
});

test('SDP builder advertises PCMU RTP endpoint', () => {
  const sdp = sipInternals.buildSdp({
    address: '192.0.2.10',
    port: 41000,
    payloadType: 0
  });

  assert.match(sdp, /c=IN IP4 192\.0\.2\.10/);
  assert.match(sdp, /m=audio 41000 RTP\/AVP 0/);
  assert.match(sdp, /a=rtpmap:0 PCMU\/8000/);
  assert.match(sdp, /a=ptime:20/);
});

test('digest challenge parser handles quoted comma separated values', () => {
  const challenge = sipInternals.parseDigestChallenge(
    'Digest realm="asterisk", nonce="abc123", algorithm=MD5, qop="auth"'
  );

  assert.equal(challenge.realm, 'asterisk');
  assert.equal(challenge.nonce, 'abc123');
  assert.equal(challenge.qop, 'auth');
});
