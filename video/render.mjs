// Renders the compositor to video.
//
//   node video/render.mjs                        → video/out/axiom-demo.mp4 (+ .srt)
//   node video/render.mjs --teaser               → video/out/axiom-teaser-vertical.mp4 (+ .srt)
//   node video/render.mjs --stills 3.2,14,30     → video/build/stills/*.png (quick checks)
//
// Frames are rendered by calling window.seek(t) in headless Chromium and screenshotting the
// stage; several pages render disjoint ranges in parallel, each piping JPEGs into its own ffmpeg
// (H.264), then the parts are concatenated and muxed with the soundtrack from audio.py.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const teaser = args.includes('--teaser');
const stillsArg = args.includes('--stills') ? args[args.indexOf('--stills') + 1] : null;
const FPS = Number(process.env.FPS ?? 30);
const WORKERS = Number(process.env.WORKERS ?? 4);
const layout = teaser ? 'v' : 'h';
const timeline = teaser ? 'teaser.json' : 'timeline.json';
const name = teaser ? 'axiom-teaser-vertical' : 'axiom-demo';
const ffmpeg = process.env.FFMPEG ?? execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();

// ---------------------------------------------------------------- static server
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(here, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(here) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/compositor/?layout=${layout}&timeline=${timeline}`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--disable-lcd-text', '--font-render-hinting=none'] });
const [W, H] = layout === 'v' ? [1080, 1920] : [1920, 1080];

async function openPage() {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => (m.type() === 'warning' || m.type() === 'error') && console.log('  [page]', m.text()));
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  await page.goto(url);
  const info = await page.evaluate(() => window.ready);
  return { page, info };
}

const stage = (page) => page.locator('#stage');

if (stillsArg) {
  const outDir = join(here, 'build', 'stills');
  mkdirSync(outDir, { recursive: true });
  const { page, info } = await openPage();
  console.log('footage speeds:', info.plans.join('  '));
  for (const t of stillsArg.split(',').map(Number)) {
    await page.evaluate((x) => window.seek(x), t);
    const f = join(outDir, `${layout}-${t.toFixed(2)}.png`);
    await stage(page).screenshot({ path: f });
    console.log(f);
  }
  await browser.close();
  server.close();
  process.exit(0);
}

// ---------------------------------------------------------------- full render
const renderDir = join(here, 'build', 'render');
mkdirSync(renderDir, { recursive: true });
mkdirSync(join(here, 'out'), { recursive: true });
const probe = await openPage();
const duration = probe.info.duration;
console.log(`${name}: ${duration.toFixed(2)} s @ ${FPS} fps, ${W}×${H}; footage speeds: ${probe.info.plans.join('  ')}`);
await probe.page.close();
const total = Math.round(duration * FPS);
const per = Math.ceil(total / WORKERS);
const t0 = Date.now();
let doneFrames = 0;

async function renderPart(k) {
  const from = k * per;
  const to = Math.min(total, from + per);
  if (from >= to) return null;
  const { page } = await openPage();
  const out = join(renderDir, `${name}-part${k}.mp4`);
  const ff = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS), out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const closed = new Promise((r) => ff.on('close', r));
  for (let i = from; i < to; i++) {
    await page.evaluate((x) => window.seek(x), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 94, clip: { x: 0, y: 0, width: W, height: H } });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    doneFrames++;
    if (doneFrames % 150 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  ${doneFrames}/${total} frames  ${(doneFrames / el).toFixed(1)} fps  eta ${Math.round(((total - doneFrames) * el) / doneFrames)} s`);
    }
  }
  ff.stdin.end();
  await closed;
  await page.close();
  return out;
}

const parts = (await Promise.all(Array.from({ length: WORKERS }, (_, k) => renderPart(k)))).filter(Boolean);
await browser.close();
server.close();

const list = join(renderDir, `${name}-parts.txt`);
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
const silent = join(renderDir, `${name}-video.mp4`);
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);

const audio = join(here, 'build', 'audio', teaser ? 'teaser-mix.wav' : 'mix.wav');
const final = join(here, 'out', `${name}.mp4`);
execFileSync(ffmpeg, [
  '-y', '-loglevel', 'error', '-i', silent, '-i', audio,
  '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
  '-af', 'loudnorm=I=-14:TP=-1.0:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-shortest', '-movflags', '+faststart', final,
]);

// captions
const tl = JSON.parse(readFileSync(join(here, 'build', timeline), 'utf8'));
const ts = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const srt = tl.voice.map((v, i) => `${i + 1}\n${ts(v.start)} --> ${ts(v.start + v.dur + 0.3)}\n${v.text}\n`).join('\n');
writeFileSync(join(here, 'out', `${name}.srt`), srt);
console.log(`wrote ${final} (${(statSync(final).size / 1024 / 1024).toFixed(1)} MB) in ${Math.round((Date.now() - t0) / 1000)} s`);
