import http from 'node:http';

const STREAMS = {
  svxlink: {
    label: 'SVXLink decoded Opus, 16 kHz PCM',
    sampleRate: 16000
  },
  asterisk: {
    label: 'Asterisk output PCM before u-law RTP, 8 kHz PCM',
    sampleRate: 8000
  },
  ulaw: {
    label: 'Asterisk RTP PCMU round-trip, 8 kHz PCM',
    sampleRate: 8000
  }
};

export class AudioMonitorServer {
  constructor({ config = {}, logger }) {
    this.config = config;
    this.logger = logger;
    this.server = null;
    this.clients = new Map(Object.keys(STREAMS).map((name) => [name, new Set()]));
  }

  get enabled() {
    return this.config.enabled === true;
  }

  async start() {
    if (!this.enabled || this.server) return;
    this.server = http.createServer((request, response) => this.handleRequest(request, response));
    await new Promise((resolve) => {
      this.server.listen(this.config.port ?? 8090, this.config.host ?? '127.0.0.1', resolve);
    });
    const address = this.server.address();
    this.logger.info('Audio monitor server listening', {
      url: `http://${address.address}:${address.port}/`,
      streams: Object.keys(STREAMS)
    });
  }

  stop() {
    for (const clients of this.clients.values()) {
      for (const client of clients) client.end();
      clients.clear();
    }
    this.server?.close();
    this.server = null;
  }

  write(streamName, pcmFrame) {
    if (!this.enabled || !pcmFrame?.length) return;
    const clients = this.clients.get(streamName);
    if (!clients?.size) return;
    for (const client of clients) {
      if (!client.write(pcmFrame)) {
        clients.delete(client);
        client.destroy();
      }
    }
  }

  handleRequest(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      this.sendIndex(response);
      return;
    }

    const match = url.pathname.match(/^\/(svxlink|asterisk|ulaw)\.wav$/);
    if (!match) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
      return;
    }

    this.addStreamClient(match[1], response);
  }

  sendIndex(response) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>ASL SVXLink Bridge Audio Monitor</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; color: #111; }
    main { max-width: 760px; }
    section { margin: 20px 0; }
    audio { display: block; width: 100%; margin-top: 8px; }
    code { background: #eee; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>ASL SVXLink Bridge Audio Monitor</h1>
    <section>
      <h2>SVXLink decoded Opus, 16 kHz PCM</h2>
      <audio controls src="/svxlink.wav"></audio>
      <p><code>/svxlink.wav</code></p>
    </section>
    <section>
      <h2>Asterisk output PCM before u-law RTP, 8 kHz PCM</h2>
      <audio controls src="/asterisk.wav"></audio>
      <p><code>/asterisk.wav</code></p>
    </section>
    <section>
      <h2>Asterisk RTP PCMU round-trip, 8 kHz PCM</h2>
      <audio controls src="/ulaw.wav"></audio>
      <p><code>/ulaw.wav</code></p>
    </section>
  </main>
</body>
</html>`);
  }

  addStreamClient(streamName, response) {
    const stream = STREAMS[streamName];
    response.writeHead(200, {
      'content-type': 'audio/wav',
      'cache-control': 'no-cache, no-store, must-revalidate',
      connection: 'close'
    });
    response.write(createWavHeader({
      sampleRate: stream.sampleRate,
      channels: 1,
      bitsPerSample: 16
    }));

    const clients = this.clients.get(streamName);
    clients.add(response);
    response.on('close', () => clients.delete(response));
  }
}

export function createWavHeader({ sampleRate, channels, bitsPerSample }) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(0xffffffff, 40);
  return header;
}
