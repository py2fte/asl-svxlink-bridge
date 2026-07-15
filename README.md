# ASL SVXLink Bridge

`asl-svxlink-bridge` is a small daemon intended to run beside ASL3/Asterisk and connect an ASL node audio path to an SVXLink `SvxReflector`.

The bridge has two sides:

- **Asterisk / ASL3 side:** SIP registration plus RTP, or direct RTP when another Asterisk app already creates the media path.
- **SVXLink side:** SvxReflector TCP control plus UDP audio/heartbeat frames compatible with mobile clients such as Latry.

This repository starts with a dependency-light service core. It implements configuration, SvxReflector control/auth framing, UDP heartbeat/audio framing, and RTP/G.711 packet handling. Opus transcoding is isolated behind `src/codec/passthrough-opus.js`; replace that adapter with a libopus or FFmpeg-backed adapter for production audio.

## Quick Start

```powershell
npm test
node src/index.js --config config.example.json
```

On Linux/ASL3:

```bash
sudo install -d -o asl -g asl /etc/asl-svxlink-bridge
sudo install -m 0640 config.example.json /etc/asl-svxlink-bridge/config.json
sudo install -m 0644 systemd/asl-svxlink-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now asl-svxlink-bridge
```

## Asterisk Audio Hook

### SIP Mode

Set `asterisk.mode` to `sip`. In this mode the bridge registers to Asterisk as a normal SIP endpoint and answers an incoming call from Asterisk. Asterisk's SDP tells the bridge where to send RTP back.

Important config values:

```json
"asterisk": {
  "mode": "sip",
  "localRtpHost": "0.0.0.0",
  "localRtpPort": 41000,
  "rtpAdvertiseHost": "192.0.2.10",
  "sip": {
    "enabled": true,
    "serverHost": "192.0.2.20",
    "serverPort": 5060,
    "localHost": "0.0.0.0",
    "localPort": 5070,
    "advertiseHost": "192.0.2.10",
    "username": "svxbridge",
    "password": "change-me",
    "domain": "192.0.2.20"
  }
}
```

`localRtpHost` is the address the bridge binds to. Use `0.0.0.0` unless you are sure the address exists on the machine running the service. `rtpAdvertiseHost` and `sip.advertiseHost` are the address Asterisk should call back.

Example PJSIP endpoint:

```ini
[svxbridge]
type=endpoint
context=from-internal
disallow=all
allow=ulaw
auth=svxbridge
aors=svxbridge
direct_media=no

[svxbridge]
type=auth
auth_type=userpass
username=svxbridge
password=change-me

[svxbridge]
type=aor
max_contacts=1
remove_existing=yes
```

After the bridge registers, call `PJSIP/svxbridge` from your ASL3 dialplan, ARI flow, or test extension.

### Direct RTP Mode

Use Asterisk 20 ARI `ExternalMedia` or an equivalent dialplan bridge to send RTP to `asterisk.localRtpPort`.

Suggested media format for the first bridge version:

- RTP payload type `0`
- codec `ulaw`
- sample rate `8000`
- one channel
- 20 ms packets

The service advertises its RTP receive port in logs. Set `asterisk.remoteRtpHost` and `asterisk.remoteRtpPort` when Asterisk expects RTP back at a fixed address.

## SVXLink Notes

The default SvxReflector port is commonly `5300`. The bridge expects the same client credential style used by SVXLink clients:

- `callsign`
- `authKey`
- `clientName`
- `clientVersion`
- `talkgroup`

The implementation sends TCP control messages and UDP heartbeat/audio frames. The current codec adapter passes Opus frames through, so production deployments need an Opus transcoder between ASL G.711 and reflector Opus.

## Files

- `src/index.js` - daemon entry point and bridge wiring
- `src/svxreflector.js` - TCP/UDP SvxReflector client
- `src/asterisk-rtp.js` - RTP socket and G.711 payload handling
- `src/codec/ulaw.js` - local G.711 mu-law codec
- `src/codec/passthrough-opus.js` - codec adapter interface placeholder
- `config.example.json` - editable service configuration
- `systemd/asl-svxlink-bridge.service` - ASL3 service unit

## Next Production Step

Replace `PassthroughOpusCodec` with a real adapter:

- input from ASL: 8 kHz signed 16-bit PCM frames
- output to reflector: 48 kHz Opus frames, usually 20 ms
- input from reflector: Opus frames
- output to ASL: 8 kHz signed 16-bit PCM frames

That adapter can use Node native bindings to `libopus`, a small helper process written in C/Rust, or an FFmpeg pipeline if you prefer operational simplicity over minimal latency.
