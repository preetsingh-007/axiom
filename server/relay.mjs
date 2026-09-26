#!/usr/bin/env node
// CLI wrapper around relay-core.mjs.
//   node server/relay.mjs [--port 8787] [--host 0.0.0.0] [--max-room 32] [--max-frame-mb 8] [--quiet]
// Environment: PORT, HOST (CLI flags win).
import { startRelay } from './relay-core.mjs';

/** @param {string} name */
function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

/** @param {string | undefined} v @param {number} fallback */
function num(v, fallback) {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node server/relay.mjs [--port N] [--host ADDR] [--max-room N] [--max-frame-mb N] [--quiet]');
  process.exit(0);
}

const quiet = process.argv.includes('--quiet');
const relay = await startRelay({
  port: num(arg('port') ?? process.env.PORT, 8787),
  host: arg('host') ?? process.env.HOST,
  maxRoomSize: num(arg('max-room'), 32),
  maxFrameBytes: num(arg('max-frame-mb'), 8) * 1024 * 1024,
  log: quiet ? undefined : (m) => console.log(m),
});

let stopping = false;
/** @param {string} signal */
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (!quiet) console.log(`[axiom relay] ${signal} received, shutting down`);
  const hard = setTimeout(() => process.exit(1), 5000);
  hard.unref();
  await relay.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
