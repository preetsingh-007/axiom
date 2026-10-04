// Records the real-app footage for the demo video.
//
//   npm run build && npx vite preview --port 4173 &
//   node server/relay.mjs --port 8787 --quiet &          (for the device-linking clip)
//   GEMINI_KEY=… node video/record-footage.mjs [clip …]
//
// Each clip is a scripted session captured as a stream of screenshots (1280×760 CSS px at 1.5× →
// crisp 1920×1140 frames; Chrome's screencast only delivers 1× frames). Screenshots at that size
// come at ~14 fps, so every clip is performed 2.5× slower than real time (scripted pauses, pointer
// paths, typing and CSS animations) and sped back up by the compositor. Frames are stored as JPEGs with their timestamps in
// video/build/clips/<clip>/index.json together with named marks, which the compositor uses to
// time-map the footage onto the timeline. Nothing is faked inside the app:
// the AI responses are live Gemini calls, sync goes through the real relay, and Git backup runs
// the real sync code against an in-memory GitHub API (github-sim.mjs).
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubSim } from './github-sim.mjs';
import { strokesFor } from './handwriting.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const BASE = process.env.AXIOM_URL ?? 'http://localhost:4173';
const RELAY = process.env.AXIOM_RELAY ?? 'ws://localhost:8787';
const OUT = join(here, 'build', 'clips');
const PAPERS = join(here, 'build', 'papers');
const GEMINI_KEY = process.env.GEMINI_KEY ?? '';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest';
const W = 1280;
const H = 760;
const DSF = 1.5;
/** clips are performed this many times slower than real time, then sped up in the compositor */
const SLOW = 2.5;

const exe = ['/opt/pw-browsers/chromium', process.env.AXIOM_CHROMIUM].find((p) => p && existsSync(p));
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
const browser = await chromium.launch({ executablePath: exe, proxy });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));

/** Visible cursor + touch dots (screencasts don't show the pointer), plus a dragged-file ghost. */
function overlay() {
  const install = () => {
    if (document.getElementById('demo-cursor') || /^\/demo-/.test(location.pathname)) return; // host pages: the frames draw their own
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-200px,-200px)}
      #demo-cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
      #demo-cursor::after{content:'';position:absolute;left:-12px;top:-12px;width:26px;height:26px;border-radius:50%;background:rgba(61,91,217,.0);transition:background 90ms}
      #demo-cursor.down::after{background:rgba(61,91,217,.3)}
      .demo-touch{position:fixed;z-index:2147483647;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;background:rgba(61,91,217,.25);border:2px solid rgba(61,91,217,.85);pointer-events:none}
      #demo-file{position:fixed;z-index:2147483646;pointer-events:none;display:none;align-items:center;gap:10px;padding:10px 14px 10px 10px;border-radius:12px;background:#fff;box-shadow:0 14px 40px rgba(20,24,40,.28);font:600 14px Inter,system-ui,sans-serif;color:#1d2230;transform:rotate(-3deg)}
      #demo-file i{display:grid;place-items:center;width:34px;height:42px;border-radius:5px;background:#e5484d;color:#fff;font:800 10px system-ui;font-style:normal}`;
    document.head.appendChild(style);
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML = '<svg width="22" height="24" viewBox="0 0 20 22"><path d="M2 1.5v16.2l4.3-4.1 2.9 6.6 2.7-1.2-2.9-6.5h6.1z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const f = document.createElement('div');
    f.id = 'demo-file';
    document.body.appendChild(f);
    const move = (x, y) => {
      c.style.transform = `translate(${x - 2}px,${y - 1}px)`;
      f.style.left = x + 14 + 'px';
      f.style.top = y + 10 + 'px';
    };
    window.__demoFile = (name) => {
      f.innerHTML = name ? `<i>PDF</i>${name}` : '';
      f.style.display = name ? 'flex' : 'none';
    };
    addEventListener('mousemove', (e) => move(e.clientX, e.clientY), true);
    addEventListener('pointermove', (e) => e.pointerType !== 'touch' && move(e.clientX, e.clientY), true);
    addEventListener('mousedown', () => c.classList.add('down'), true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
    const dots = new Map();
    const touches = (e) => {
      const seen = new Set();
      for (const t of e.touches) {
        seen.add(t.identifier);
        let d = dots.get(t.identifier);
        if (!d) {
          d = document.createElement('div');
          d.className = 'demo-touch';
          document.body.appendChild(d);
          dots.set(t.identifier, d);
        }
        d.style.left = t.clientX + 'px';
        d.style.top = t.clientY + 'px';
      }
      for (const [id, d] of dots) if (!seen.has(id)) (d.remove(), dots.delete(id));
      c.style.opacity = e.touches.length ? '0' : '1';
    };
    for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) addEventListener(ev, touches, { capture: true, passive: true });
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install);
  else install();
}

/**
 * Slow-motion input: pointer moves are interpolated with an ease-in-out curve and a pause per
 * step (so the cursor and lasso strokes visibly travel), typing and waits are stretched by SLOW.
 */
function slowMotion(page) {
  if (page.__slow) return;
  page.__slow = true;
  const mouse = page.mouse;
  const move = mouse.move.bind(mouse);
  let at = { x: 0, y: 0 };
  mouse.move = async (x, y, o = {}) => {
    const steps = Math.max(1, o.steps ?? 1);
    if (steps === 1) {
      at = { x, y };
      return move(x, y);
    }
    const from = at;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      await move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await sleep(11);
    }
    at = { x, y };
  };
  const dbl = mouse.dblclick.bind(mouse);
  mouse.dblclick = async (x, y, o = {}) => {
    at = { x, y };
    return dbl(x, y, { delay: 60 * SLOW, ...o });
  };
  const type = page.keyboard.type.bind(page.keyboard);
  page.keyboard.type = (text, o = {}) => type(text, { ...o, delay: (o.delay ?? 0) * SLOW });
  const wait = page.waitForTimeout.bind(page);
  page.waitForTimeout = (ms) => wait(ms * SLOW);
}

async function newContext(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? W, height: opts.height ?? H }, deviceScaleFactor: DSF, hasTouch: !!opts.touch });
  await ctx.addInitScript(overlay);
  return ctx;
}

async function openApp(page, vault, hash = '#/stream') {
  await page.goto(`${BASE}/?vault=${vault}&debug${hash}`);
  await page.waitForFunction(() => !!window.axiom);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

async function axiom(page, body, arg) {
  return page.evaluate(([b, a]) => new Function('axiom', 'arg', `return (async()=>{${b}})()`)(window.axiom, a), [body, arg]);
}

async function setGemini(page, { apiKey = GEMINI_KEY, model = GEMINI_MODEL } = {}) {
  await axiom(
    page,
    `const cfg = { ...axiom.aiConfig.current, gemini: { apiKey: arg.apiKey, model: arg.model } };
     axiom.aiConfig.current = cfg; await axiom.vault.setLocal('ai-config', cfg);`,
    { apiKey, model },
  );
}

const vaultName = (name) => `video-${name}-${Date.now().toString(36)}`;

async function glide(page, x, y, steps = 20) {
  await page.mouse.move(x, y, { steps: Math.max(6, Math.round(steps * 0.7)) });
}
async function glideTo(page, locator, steps = 20, dx = 0.5, dy = 0.5) {
  const b = await locator.boundingBox();
  await glide(page, b.x + b.width * dx, b.y + b.height * dy, steps);
  return b;
}
async function clickOn(page, locator, steps = 20) {
  await glideTo(page, locator, steps);
  await sleep(120);
  await locator.click();
}
async function typeSlow(page, text, delay = 30) {
  await page.keyboard.type(text, { delay });
}

/** Imports a file through the Library's real file picker. */
async function importFile(page, file) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Import/ }).first().click();
  await (await chooser).setFiles(file);
}

/** Drags a file from "the desktop" onto the window: real drag events with a real File. */
async function dropFile(page, file, from, to) {
  const name = file.split('/').pop();
  const b64 = readFileSync(file).toString('base64');
  await page.mouse.move(from.x, from.y);
  await page.evaluate((n) => window.__demoFile(n), name);
  await page.evaluate(
    ([b, n]) => {
      const bytes = Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], n, { type: 'application/pdf' }));
      window.__demoDT = dt;
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    },
    [b64, name],
  );
  const steps = 26;
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await page.mouse.move(x, y);
    await page.evaluate(([cx, cy]) => window.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.__demoDT, bubbles: true, cancelable: true, clientX: cx, clientY: cy })), [x, y]);
    await sleep(22);
  }
  await sleep(250);
  await page.evaluate(([cx, cy]) => {
    window.__demoFile(null);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__demoDT, bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
  }, [to.x, to.y]);
}

// ------------------------------------------------------------------ recording

class Clip {
  constructor(name) {
    this.name = name;
    this.dir = join(OUT, name);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.marks = {};
    this.n = 0;
  }
  async start(page) {
    this.page = page;
    slowMotion(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW });
    this.wall0 = Date.now();
    this.running = true;
    let last = null;
    this.loop = (async () => {
      while (this.running) {
        const t = (Date.now() - this.wall0) / 1000;
        let buf;
        try {
          buf = await page.screenshot({ type: 'jpeg', quality: 90, animations: 'allow', caret: 'initial', scale: 'device' });
        } catch {
          break;
        }
        if (last && buf.equals(last)) continue; // unchanged: the previous frame holds
        last = buf;
        const file = `f${String(++this.n).padStart(5, '0')}.jpg`;
        writeFileSync(join(this.dir, file), buf);
        this.frames.push({ t: +t.toFixed(3), f: file });
      }
    })();
    await sleep(150);
  }
  mark(label) {
    this.marks[label] = +((Date.now() - this.wall0) / 1000).toFixed(3);
  }
  async stop(tail = 450) {
    await sleep(tail);
    this.mark('end');
    this.running = false;
    await this.loop;
    writeFileSync(
      join(this.dir, 'index.json'),
      JSON.stringify({ name: this.name, width: W * DSF, height: H * DSF, slow: SLOW, frames: this.frames, marks: this.marks }, null, 0),
    );
    console.log(`${this.name}: ${this.frames.length} frames, ${(this.marks.end / SLOW).toFixed(1)}s real time, marks ${Object.keys(this.marks).join(',')}`);
  }
}

/** Records one clip: prepare (unrecorded) → act (recorded). */
async function record(name, { width = W, height = H, touch = false, setup } = {}, prepare, act) {
  const ctx = await newContext({ width, height, touch });
  if (setup) await setup(ctx);
  const page = await ctx.newPage();
  slowMotion(page);
  page.on('pageerror', (e) => console.warn(`  [${name}] page error:`, e.message));
  const state = (await prepare(page, vaultName(name), ctx)) ?? {};
  const clip = new Clip(name);
  await clip.start(page);
  try {
    await act(page, clip, state, ctx);
  } finally {
    await clip.stop();
    await ctx.close();
  }
  return clip;
}

// ------------------------------------------------------------------ shared preparation

const RL_PAGES = [
  ['Policy gradients', 'REINFORCE is unbiased but noisy. Subtract a baseline to cut variance #rl [[Variance reduction]] [[Monte Carlo]]'],
  ['Actor-critic', 'The critic learns a [[Value function]] so the actor gets low-variance advantages #rl [[Variance reduction]]'],
  ['Seminar notes', 'Speaker compared [[Policy gradients]] with [[Actor-critic]] on long-horizon tasks #seminar'],
  ['Information theory', '[[Entropy]] and [[Mutual information]] bound what an agent can learn #theory'],
  ['Value function', 'Bellman expectation equation: $V^\\pi(s) = \\mathbb{E}[r + \\gamma V^\\pi(s\')]$ #rl [[Monte Carlo]]'],
  ['Variance reduction', 'Baselines, control variates and advantage normalisation #rl'],
  ['Contrastive learning', 'InfoNCE pulls positives together, pushes negatives apart #representation-learning'],
  ['Thesis outline', 'Ch. 3 — learned baselines for [[Policy gradients]]; Ch. 4 — [[Contrastive learning]] for control'],
];

/** Removes the Welcome page's sample #flashcard so Review starts with the clip's own cards. */
async function dropSampleCards(page) {
  await axiom(
    page,
    `const { doc } = await axiom.vault.openPage('p-welcome');
     for (const id of axiom.__blocks.blockIds(doc)) {
       const b = axiom.__blocks.getBlock(doc, id);
       const text = b?.get?.('text')?.toString?.() ?? '';
       if (text.includes('#flashcard')) axiom.__blocks.setBlockText(b, text.replace(/\\s*#flashcard/g, ''));
     }
     await axiom.graph.flush();`,
  );
  await page.waitForFunction(() => window.axiom.vault.cards.size === 0, null, { timeout: 10000 }).catch(() => console.warn('  sample cards still present'));
}

async function seedNotes(page, pages = RL_PAGES) {
  await axiom(
    page,
    `for (const [t, x] of arg) { const id = axiom.vault.createPage({ title: t }); const { doc } = await axiom.vault.openPage(id); axiom.__blocks.insertBlocks(doc, [{ type: 'text', text: x }]); }
     await axiom.graph.flush();`,
    pages,
  );
}

async function openPaper(page, file, zoomSteps = 1) {
  await openApp(page, page.__vault, '#/library');
  await importFile(page, file);
  await page.locator('.lib-card').first().waitFor();
  await page.locator('.lib-card').first().click();
  await page.waitForSelector('.pdfv-page[data-page="1"] canvas.ready');
  await page.evaluate(() => document.querySelector('.ui-toast button[aria-label="Dismiss"]')?.click());
  for (let i = 0; i < zoomSteps; i++) await page.getByRole('button', { name: /zoom in/i }).click();
  await page.waitForSelector('.pdfv-page[data-page="1"] .textLayer span');
  await page.waitForTimeout(900);
}

/** Lasso a region of the PDF page given in page fractions. */
async function lassoPdf(page, [x0, y0, x1, y1], steps = 9) {
  const pg = await page.locator('.pdfv-page[data-page="1"]').boundingBox();
  const X = (f) => pg.x + f * pg.width;
  const Y = (f) => pg.y + f * pg.height;
  const pts = [
    [x0, y0], [(x0 + x1) / 2, y0 - 0.008], [x1, y0 + 0.004], [x1 + 0.006, (y0 + y1) / 2], [x1, y1],
    [(x0 + x1) / 2, y1 + 0.008], [x0, y1 - 0.004], [x0 - 0.006, (y0 + y1) / 2], [x0 + 0.004, y0 + 0.002],
  ];
  await glide(page, X(pts[0][0]), Y(pts[0][1]), 16);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(X(x), Y(y), { steps });
  await page.mouse.up();
}

/** Where a piece of text sits on the PDF page, as page fractions [x0,y0,x1,y1]. */
async function pdfTextBox(page, re) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const pg = document.querySelector('.pdfv-page[data-page="1"]').getBoundingClientRect();
    const spans = [...document.querySelectorAll('.pdfv-page[data-page="1"] .textLayer span')].filter((s) => re.test(s.textContent));
    if (!spans.length) return null;
    const r = spans[0].getBoundingClientRect();
    return [(r.left - pg.left) / pg.width, (r.top - pg.top) / pg.height, (r.right - pg.left) / pg.width, (r.bottom - pg.top) / pg.height];
  }, re.source);
}

/** Two app windows side by side ("laptop" and "tablet") on the video's dark backdrop. */
function writeDevicesHost(file, srcA, srcB) {
  writeFileSync(
    join(ROOT, 'dist', file),
    `<!doctype html><meta charset="utf-8"><title>devices</title><style>
      html,body{margin:0;height:100%;background:#10152a}
      body{display:grid;grid-template-columns:1.5fr 1fr;gap:26px;padding:34px 30px 26px;box-sizing:border-box;font:600 13px Inter,system-ui,sans-serif;color:#c9cfe6;letter-spacing:.06em;text-transform:uppercase}
      figure{margin:0;display:flex;flex-direction:column;gap:10px;min-height:0}
      figcaption{display:flex;align-items:center;gap:8px}figcaption b{width:8px;height:8px;border-radius:50%;background:#3fbf87;box-shadow:0 0 0 4px rgba(63,191,135,.18)}
      iframe{flex:1;width:100%;border:0;border-radius:14px;background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.45)}
    </style><figure><figcaption><b></b>Laptop</figcaption><iframe id="a" src="${srcA}"></iframe></figure><figure><figcaption><b></b>Tablet</figcaption><iframe id="b" src="${srcB}"></iframe></figure>`,
  );
}

// ------------------------------------------------------------------ clips

const clips = {
  /** f1: lasso a paragraph and an equation from the paper, then jump back through the anchor. */
  async 'f1-lasso'() {
    await record(
      'f1-lasso',
      {},
      async (page, vault) => {
        page.__vault = vault;
        await openApp(page, vault);
        await setGemini(page);
        await openPaper(page, join(PAPERS, 'variance-reduction.pdf'), 1);
        await page.locator('.pdfv-scroll').evaluate((el) => el.scrollTo({ top: 150 }));
        await sleep(500);
      },
      async (page, clip) => {
        await clickOn(page, page.getByRole('button', { name: 'Lasso tool' }));
        // paragraph: the first paragraph of the introduction
        const intro = await pdfTextBox(page, /Reinforcement learning agents improve/);
        const para = [0.075, intro[1] - 0.004, 0.49, intro[1] + 0.128];
        clip.mark('lasso1');
        await lassoPdf(page, para);
        await page.waitForSelector('.extract-card');
        clip.mark('card1');
        await sleep(1100);
        await clickOn(page, page.getByRole('button', { name: 'Send to Desk' }));
        await page.waitForSelector('.pane-desk .blk-anchor');
        clip.mark('sent1');
        await sleep(700);
        // equation (1)
        const eq = await pdfTextBox(page, /^\(1\)$/);
        await lassoPdf(page, [0.07, eq[1] - 0.03, 0.49, eq[3] + 0.028], 7);
        await page.waitForSelector('.extract-card');
        clip.mark('card2');
        await page.waitForSelector('.extract-meta:has-text("Transcribed by AI"), .extract-meta:has-text("Converted from text layer")', { timeout: 30000 });
        clip.mark('latex');
        await sleep(1100);
        await clickOn(page, page.getByRole('button', { name: 'Send to Desk' }));
        await page.waitForSelector('.pane-desk .blk-math, .pane-desk .katex-display, .pane-desk .blk:nth-of-type(2)');
        clip.mark('sent2');
        await sleep(900);
        await page.locator('.pdfv-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
        await sleep(800);
        const row = page.locator('.pane-desk .blk:has(.blk-anchor)').first();
        await row.hover();
        const anchor = row.locator('.blk-anchor').first();
        await glideTo(page, anchor);
        await sleep(200);
        clip.mark('anchor');
        await anchor.click();
        await page.waitForSelector('.pdfv-flash');
        clip.mark('flash');
        await sleep(1600);
      },
    );
  },

  /** f2: spread two fingers to open whiteboard space, sketch, Beautify. */
  async 'f2-whiteboard'() {
    await record(
      'f2-whiteboard',
      { touch: true },
      async (page, vault) => {
        await openApp(page, vault);
        const id = await axiom(
          page,
          `const id = axiom.vault.createPage({ title: 'Problem set 3' });
           const { doc } = await axiom.vault.openPage(id);
           axiom.__blocks.insertBlocks(doc, [
             { type: 'text', text: '**Q1.** Show the Bellman operator is a $\\\\gamma$-contraction in $\\\\|\\\\cdot\\\\|_\\\\infty$.' },
             { type: 'text', text: '**Q2.** Derive the REINFORCE estimator and its variance with a baseline.' },
             { type: 'text', text: '**Q3.** Prove policy improvement for greedy updates.' },
           ]);
           return id;`,
        );
        await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
        await page.waitForSelector('.blk-rendered');
        await sleep(600);
      },
      async (page, clip) => {
        const q1 = await page.locator('.blk', { hasText: 'Q1.' }).boundingBox();
        const q2 = await page.locator('.blk', { hasText: 'Q2.' }).boundingBox();
        const x = q1.x + q1.width / 2;
        const y = (q1.y + q1.height + q2.y) / 2;
        const cdp = await page.context().newCDPSession(page);
        const pts = (d) => [{ x, y: y - d / 2, id: 1 }, { x: x + 6, y: y + d / 2, id: 2 }];
        clip.mark('spread');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(40) });
        for (let i = 1; i <= 22; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(40 + i * 14) });
          await sleep(30);
        }
        await sleep(200);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForSelector('.blk-ink .ink-surface');
        clip.mark('opened');
        await sleep(500);
        await page.keyboard.press('p');
        const box = await page.locator('.blk-ink .ink-surface').first().boundingBox();
        const cx = box.x + 200;
        const cy = box.y + box.height / 2;
        clip.mark('sketch');
        await glide(page, cx + 62, cy, 12);
        await page.mouse.down();
        for (let i = 1; i <= 36; i++) {
          const a = (i / 36) * Math.PI * 2.06;
          await page.mouse.move(cx + 62 * Math.cos(a) + Math.sin(i * 1.7) * 3, cy + 50 * Math.sin(a) + Math.cos(i) * 2, { steps: 1 });
          await sleep(7);
        }
        await page.mouse.up();
        await glide(page, cx + 95, cy + 5, 6);
        await page.mouse.down();
        await page.mouse.move(cx + 320, cy - 6, { steps: 18 });
        await page.mouse.move(cx + 296, cy - 26, { steps: 5 });
        await page.mouse.move(cx + 320, cy - 6, { steps: 5 });
        await page.mouse.move(cx + 298, cy + 15, { steps: 5 });
        await page.mouse.up();
        // a rough triangle
        const tx = cx + 430;
        await glide(page, tx, cy - 45, 8);
        await page.mouse.down();
        for (const [px, py] of [[tx + 60, cy + 40], [tx - 58, cy + 44], [tx + 2, cy - 43]]) await page.mouse.move(px + Math.random() * 3, py, { steps: 10 });
        await page.mouse.up();
        await sleep(350);
        await page.keyboard.press('l');
        await glide(page, box.x + 100, box.y + 14, 10);
        await page.mouse.down();
        for (const [px, py] of [[box.x + 700, box.y + 14], [box.x + 700, box.y + box.height - 14], [box.x + 100, box.y + box.height - 14], [box.x + 100, box.y + 18]]) await page.mouse.move(px, py, { steps: 8 });
        await page.mouse.up();
        await sleep(350);
        await glide(page, cx, cy, 8);
        clip.mark('beautify');
        await page.mouse.dblclick(cx, cy);
        await sleep(1500);
        await page.keyboard.press('v');
        clip.mark('clean');
        await sleep(500);
      },
    );
  },

  /** f3: live LaTeX, a [[link]] and the backlinks on the linked page. */
  async 'f3-writing'() {
    await record(
      'f3-writing',
      {},
      async (page, vault) => {
        await openApp(page, vault);
        await seedNotes(page);
        await page.evaluate(() => (location.hash = '#/stream'));
        await sleep(600);
      },
      async (page, clip) => {
        const tail = page.locator('.day-today .blist-tail');
        await clickOn(page, tail, 16);
        await page.waitForSelector('.day-today .cm-editor');
        clip.mark('typing');
        await typeSlow(page, 'Gradient of the objective: $\\nabla_\\theta J = \\mathbb{E}[\\nabla_\\theta \\log \\pi_\\theta(a|s)\\, A(s,a)]$ — see [[Variance reduction]]', 16);
        await page.keyboard.press('Escape');
        clip.mark('rendered');
        await sleep(900);
        const link = page.locator('.day-today .md-wikilink', { hasText: 'Variance reduction' }).first();
        await glideTo(page, link, 18);
        await sleep(250);
        await link.click();
        await page.waitForSelector('.page-title');
        clip.mark('page');
        await sleep(400);
        const bl = page.locator('.backlinks, [class*="backlink"]').first();
        if (await bl.count()) await bl.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(1500);
      },
    );
  },

  /** f4: tag a note as a flashcard, then review it. */
  async 'f4-flashcards'() {
    await record(
      'f4-flashcards',
      {},
      async (page, vault) => {
        await openApp(page, vault);
        await dropSampleCards(page);
        await axiom(
          page,
          `const id = axiom.vault.ensureDaily();
           const { doc } = await axiom.vault.openPage(id);
           axiom.__blocks.insertBlocks(doc, [
             { type: 'text', text: 'In an MDP the discount factor {{c1::$\\\\gamma \\\\in [0,1)$}} keeps the return finite. #flashcard' },
           ]);`,
        );
        await sleep(1200);
      },
      async (page, clip) => {
        const tail = page.locator('.day-today .blist-tail');
        await clickOn(page, tail, 14);
        await page.waitForSelector('.day-today .cm-editor');
        clip.mark('typing');
        await typeSlow(page, 'The **Kullback–Leibler divergence** is always non-negative. #flashcard', 18);
        await page.keyboard.press('Escape');
        clip.mark('tagged');
        await page.waitForFunction(() => window.axiom.vault.cards.size >= 2, null, { timeout: 15000 });
        await sleep(500);
        await clickOn(page, page.locator('nav, .sidebar').getByText('Review', { exact: true }).first(), 18);
        await page.getByRole('button', { name: /Show answer/i }).waitFor();
        clip.mark('review');
        for (let i = 0; i < 2; i++) {
          const show = page.getByRole('button', { name: /Show answer/i });
          if (!(await show.isVisible().catch(() => false))) break;
          await sleep(500);
          await clickOn(page, show, 12);
          await sleep(750);
          await clickOn(page, page.getByRole('button', { name: /Good/ }), 12);
          await sleep(600);
        }
      },
    );
  },

  /** f5: search, graph, lens. */
  async 'f5-navigate'() {
    await record(
      'f5-navigate',
      {},
      async (page, vault) => {
        await openApp(page, vault);
        await seedNotes(page);
        await sleep(500);
      },
      async (page, clip) => {
        await page.keyboard.press('Control+k');
        await sleep(350);
        clip.mark('search');
        await typeSlow(page, 'variance', 70);
        await sleep(1000);
        await page.keyboard.press('Escape');
        await page.evaluate(() => (location.hash = '#/graph'));
        await page.waitForSelector('.graph-route canvas');
        clip.mark('graph');
        await sleep(2300);
        await page.evaluate(() => (location.hash = '#/lens?q=%23rl%20OR%20%5B%5BVariance%20reduction%5D%5D'));
        await page.waitForSelector('.lens-count');
        clip.mark('lens');
        await sleep(2000);
      },
    );
  },

  /** f6: two devices typing into the same vault, live (BroadcastChannel between tabs). */
  async 'f6-sync'() {
    const vault = vaultName('sync');
    writeDevicesHost('demo-sync.html', `/?vault=${vault}&debug#/stream`, `/?vault=${vault}&debug#/stream`);
    await record(
      'f6-sync',
      {},
      async (page) => {
        await page.goto(`${BASE}/demo-sync.html`);
        await page.waitForFunction(() => ['a', 'b'].every((id) => document.getElementById(id).contentWindow.axiom));
        await sleep(900);
      },
      async (page, clip) => {
        const a = page.frameLocator('#a');
        const b = page.frameLocator('#b');
        await clickOn(page, a.locator('.day-today .blist-tail'), 16);
        clip.mark('typeA');
        await typeSlow(page, 'Idea: a learned baseline b(s) shrinks REINFORCE variance', 26);
        await page.keyboard.press('Escape');
        clip.mark('seenB');
        await sleep(700);
        await clickOn(page, b.locator('.day-today .blist-tail'), 16);
        clip.mark('typeB');
        await typeSlow(page, 'Tablet: sketch the proof after the seminar', 26);
        await page.keyboard.press('Escape');
        await sleep(1300);
      },
    );
  },

  /** f7 + s5: connect Git backup in Settings and watch it sync. */
  async 's5-git'() {
    const sim = createGitHubSim();
    await record(
      's5-git',
      { setup: (ctx) => sim.install(ctx) },
      async (page, vault) => {
        await openApp(page, vault);
        await seedNotes(page);
        await page.evaluate(() => (location.hash = '#/settings/sync'));
        await page.waitForSelector('#settings-sync');
        await page.locator('#settings-sync h3', { hasText: 'Git backup' }).scrollIntoViewIfNeeded();
        await page.evaluate(() => document.querySelector('.settings')?.closest('[class*="scroll"], main')?.scrollBy?.(0, -60));
        await sleep(500);
      },
      async (page, clip) => {
        const sec = page.locator('#settings-sync');
        await clickOn(page, sec.getByLabel('Repository'), 16);
        await typeSlow(page, `${sim.owner}/${sim.repo}`, 28);
        await clickOn(page, sec.getByLabel('Personal access token'), 14);
        clip.mark('token');
        await page.keyboard.insertText('github_pat_11AXIOMDEMO0000000000000000');
        await sleep(300);
        await clickOn(page, sec.getByText('Commit changes to Git in the background'), 14);
        await sleep(250);
        await clickOn(page, sec.getByRole('button', { name: 'Save' }), 14);
        clip.mark('saved');
        await page.locator('.set-status').scrollIntoViewIfNeeded();
        await page.waitForFunction(() => /Git: idle · /.test(document.querySelector('#settings-sync .set-status')?.textContent ?? ''), null, { timeout: 30000 });
        clip.mark('synced');
        await sleep(1400);
      },
    );
    // a later edit, so the history shows more than one Axiom commit
    writeFileSync(join(OUT, 's5-git', 'repo.json'), JSON.stringify(sim.snapshot(), null, 1));
    console.log('  github sim:', sim.log.length, 'requests');
  },

  /** s6: paste a Gemini key, Save, Test. */
  async 's6-ai'() {
    await record(
      's6-ai',
      {},
      async (page, vault) => {
        await openApp(page, vault);
        // the model field shows the model used for the recording; the key is pasted on camera
        await setGemini(page, { apiKey: '', model: GEMINI_MODEL });
        await page.evaluate(() => (location.hash = '#/settings/ai'));
        await page.waitForSelector('#settings-ai');
        await sleep(700);
      },
      async (page, clip) => {
        const sec = page.locator('#settings-ai');
        await clickOn(page, sec.getByLabel('Gemini API key'), 18);
        clip.mark('paste');
        await page.keyboard.insertText(GEMINI_KEY);
        await sleep(450);
        await clickOn(page, sec.getByRole('button', { name: 'Save' }), 14);
        clip.mark('saved');
        await sleep(500);
        await clickOn(page, sec.getByRole('button', { name: /^Test$/ }), 14);
        clip.mark('test');
        await page.waitForSelector('#settings-ai .set-probe li', { timeout: 60000 });
        clip.mark('result');
        await sleep(1600);
      },
    );
  },

  /** s1: the app on first launch. */
  async 's1-open'() {
    await record(
      's1-open',
      {},
      async (page) => {
        await page.goto('about:blank');
      },
      async (page, clip) => {
        await page.goto(`${BASE}/?vault=${vaultName('fresh')}#/page/p-welcome`);
        await page.waitForSelector('.page-title');
        clip.mark('loaded');
        await sleep(1600);
      },
    );
  },

  /** s3: drop a PDF onto the window → Library card with citation key + AI ghost tags. */
  async 's3-import'() {
    await record(
      's3-import',
      {},
      async (page, vault) => {
        page.__vault = vault;
        await openApp(page, vault, '#/library');
        await seedNotes(page);
        await setGemini(page);
        await importFile(page, join(PAPERS, 'variance-reduction.pdf'));
        await page.locator('.lib-card').first().waitFor();
        await sleep(2500);
        await page.evaluate(() => document.querySelector('.ui-toast button[aria-label="Dismiss"]')?.click());
        await sleep(500);
      },
      async (page, clip) => {
        clip.mark('drag');
        await dropFile(page, join(PAPERS, 'contrastive-manipulation.pdf'), { x: 1180, y: 700 }, { x: 760, y: 330 });
        clip.mark('dropped');
        await page.locator('.lib-card').nth(1).waitFor();
        clip.mark('card');
        await page.waitForFunction(() => document.querySelectorAll('.lib-card')[0]?.querySelector('.ui-chip.ghost') || document.querySelectorAll('.lib-card')[1]?.querySelectorAll('.ui-chip.ghost').length > 1, null, { timeout: 30000 }).catch(() => {});
        clip.mark('tags');
        await sleep(1800);
        const ghost = page.locator('.lib-card .ghost-confirm').first();
        if (await ghost.count()) {
          await clickOn(page, ghost, 16);
          clip.mark('confirm');
        }
        await sleep(1200);
      },
    );
  },

  /** s4: create a sync key on the laptop, join from the tablet through the real relay. */
  async 's4-link'() {
    const ctx = await newContext({ width: W, height: H });
    const page = await ctx.newPage();
    slowMotion(page);
    const vaultA = vaultName('laptop');
    const vaultB = vaultName('tablet');
    writeDevicesHost('demo-link.html', `/?vault=${vaultA}&debug#/settings/sync`, `/?vault=${vaultB}&debug#/settings/sync`);
    await page.goto(`${BASE}/demo-link.html`);
    await page.waitForFunction(() => ['a', 'b'].every((id) => document.getElementById(id).contentWindow.axiom));
    const a = page.frameLocator('#a');
    const b = page.frameLocator('#b');
    await sleep(800);
    const clip = new Clip('s4-link');
    await clip.start(page);
    try {
      await clickOn(page, a.getByPlaceholder('wss://relay.example.com'), 14);
      await typeSlow(page, RELAY, 22);
      await clickOn(page, a.getByRole('button', { name: /Create a sync key/ }), 18);
      clip.mark('key');
      await sleep(400);
      await clickOn(page, a.locator('#settings-sync').getByRole('button', { name: 'Save' }), 12);
      await sleep(500);
      const code = (await a.locator('.set-code code').innerText()).trim();
      await clickOn(page, a.getByRole('button', { name: /Copy code/ }), 12);
      clip.mark('copied');
      await sleep(400);
      await clickOn(page, b.getByPlaceholder(/paste a join code/), 18);
      await page.keyboard.insertText(code);
      await sleep(250);
      await clickOn(page, b.getByRole('button', { name: 'Join' }), 10);
      await sleep(350);
      await clickOn(page, b.locator('#settings-sync').getByRole('button', { name: 'Save' }), 12);
      clip.mark('joined');
      await page.waitForFunction(() => /1 other device online/.test(document.getElementById('a').contentDocument.querySelector('#settings-sync .set-status')?.textContent ?? ''), null, { timeout: 20000 });
      clip.mark('online');
      await sleep(1600);
    } finally {
      await clip.stop();
      await ctx.close();
    }
  },

  /** f8 sub-clips: handwriting → text + LaTeX (live Gemini). */
  async 'f8-ink'() {
    await record(
      'f8-ink',
      {},
      async (page, vault) => {
        await openApp(page, vault);
        await setGemini(page);
        const id = await axiom(
          page,
          `const id = axiom.vault.createPage({ title: 'Lecture 7 — scribbles' });
           const { doc } = await axiom.vault.openPage(id);
           axiom.__blocks.insertBlocks(doc, [{ type: 'text', text: 'Handwritten during the lecture:' }, { type: 'ink', height: 330 }]);
           return id;`,
        );
        await page.evaluate((pid) => (location.hash = `#/page/${pid}`), id);
        await page.waitForSelector('.blk-ink .ink-surface');
        await sleep(500);
        await page.keyboard.press('p');
        const box = await page.locator('.blk-ink .ink-surface').first().boundingBox();
        // pre-write the scribbles (recorded clip starts with the ink already on the page)
        const write = async (text, x, y, size) => {
          for (const stroke of strokesFor(text, x, y, size)) {
            await page.mouse.move(stroke[0][0], stroke[0][1]);
            await page.mouse.down();
            for (const [px, py] of stroke.slice(1)) await page.mouse.move(px, py);
            await page.mouse.up();
          }
        };
        await write('Bellman', box.x + 60, box.y + 30, 60);
        await write('a^2+b^2=c^2', box.x + 70, box.y + 165, 56);
        await sleep(600);
        await page.keyboard.press('v');
        await page.mouse.move(box.x + box.width - 40, box.y + box.height + 30);
        await sleep(400);
      },
      async (page, clip) => {
        const box = await page.locator('.blk-ink .ink-surface').first().boundingBox(); // the surface grows with the ink
        await page.keyboard.press('l');
        clip.mark('lasso');
        await glide(page, box.x + 30, box.y + 14, 10);
        await page.mouse.down();
        for (const [px, py] of [[box.x + 560, box.y + 14], [box.x + 560, box.y + box.height - 12], [box.x + 30, box.y + box.height - 12], [box.x + 30, box.y + 18]]) await page.mouse.move(px, py, { steps: 7 });
        await page.mouse.up();
        await sleep(300);
        const btn = page.locator('button.ink-bar-primary');
        await clickOn(page, btn, 12);
        clip.mark('beautify');
        await page.waitForSelector('.ink-overlay .ink-text, .ink-overlay .ink-latex, .ink-notice', { timeout: 60000 });
        await page.waitForFunction(() => !document.querySelector('.ink-busy'), null, { timeout: 60000 });
        clip.mark('done');
        console.log('  beautified:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.ink-overlay .ink-item')].map((e) => e.textContent))));
        await page.keyboard.press('v');
        await page.mouse.move(box.x + box.width - 40, box.y + box.height + 30, { steps: 8 });
        await sleep(1500);
      },
    );
  },

  /** f8: an equation crop read by AI. */
  async 'f8-math'() {
    await record(
      'f8-math',
      {},
      async (page, vault) => {
        page.__vault = vault;
        await openApp(page, vault);
        await setGemini(page);
        await openPaper(page, join(PAPERS, 'variance-reduction.pdf'), 2);
        const eq = await pdfTextBox(page, /^\(2\)$/);
        await page.locator('.pdfv-scroll').evaluate((el, y) => el.scrollTo({ top: Math.max(0, y) }), eq ? eq[1] * (await page.locator('.pdfv-page[data-page="1"]').boundingBox()).height - 240 : 300);
        await sleep(600);
        await page.getByRole('button', { name: 'Lasso tool' }).click();
      },
      async (page, clip) => {
        const eq = await pdfTextBox(page, /^\(2\)$/);
        clip.mark('lasso');
        await lassoPdf(page, [0.515, eq[1] - 0.034, 0.935, eq[3] + 0.03], 7);
        await page.waitForSelector('.extract-card');
        clip.mark('card');
        await page.waitForSelector('.extract-meta:has-text("Transcribed by AI"), .extract-meta:has-text("Converted from text layer")', { timeout: 30000 });
        clip.mark('latex');
        await sleep(1800);
      },
    );
  },

  /** f8: AI ghost tags on a freshly imported paper. */
  async 'f8-tags'() {
    await record(
      'f8-tags',
      {},
      async (page, vault) => {
        await openApp(page, vault, '#/library');
        await seedNotes(page);
        await setGemini(page);
        await sleep(300);
      },
      async (page, clip) => {
        await importFile(page, join(PAPERS, 'contrastive-manipulation.pdf'));
        await page.locator('.lib-card').first().waitFor();
        clip.mark('card');
        await page.waitForSelector('.lib-card .ui-chip.ghost', { timeout: 30000 });
        clip.mark('tags');
        await sleep(1000);
        const ghost = page.locator('.lib-card .ghost-confirm').first();
        await clickOn(page, ghost, 14);
        clip.mark('confirm');
        await sleep(1200);
      },
    );
  },

  /** f8: flashcards written by AI. */
  async 'f8-cloze'() {
    await record(
      'f8-cloze',
      {},
      async (page, vault) => {
        await openApp(page, vault);
        await dropSampleCards(page);
        await setGemini(page);
        await page.evaluate(() => (location.hash = '#/stream'));
        await sleep(500);
      },
      async (page, clip) => {
        const tail = page.locator('.day-today .blist-tail');
        await clickOn(page, tail, 12);
        await page.waitForSelector('.day-today .cm-editor');
        clip.mark('typing');
        await page.keyboard.insertText('A learned state baseline keeps the policy gradient estimator unbiased while cutting its variance by about 4x. #flashcard');
        await page.keyboard.press('Escape');
        clip.mark('tagged');
        await page.waitForFunction(() => [...window.axiom.vault.cards.values()].filter((c) => /baseline/.test(c.front ?? '')).length >= 2, null, { timeout: 40000 }).catch(() => console.warn('  f8-cloze: AI cards not detected'));
        await sleep(300);
        await page.evaluate(() => (location.hash = '#/review'));
        await page.getByRole('button', { name: /Show answer/i }).waitFor();
        clip.mark('review');
        await sleep(1200);
        await clickOn(page, page.getByRole('button', { name: /Show answer/i }), 10);
        clip.mark('answer');
        await sleep(1300);
      },
    );
  },
};

const wanted = process.argv.slice(2);
for (const [name, fn] of Object.entries(clips)) {
  if (wanted.length && !wanted.includes(name)) continue;
  try {
    await fn();
  } catch (e) {
    console.error(`clip ${name} failed:`, e.message.split('\n')[0]);
  }
}
await browser.close();
