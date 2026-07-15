const LEVELS = new Map([
  ['debug', 10],
  ['info', 20],
  ['warn', 30],
  ['error', 40]
]);

export function createLogger(config = {}) {
  const threshold = LEVELS.get(config.level ?? 'info') ?? LEVELS.get('info');

  function write(level, message, meta) {
    if ((LEVELS.get(level) ?? 100) < threshold) return;
    const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
    process.stdout.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`);
  }

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta)
  };
}
