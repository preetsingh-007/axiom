// Records short animated GIFs of the real app for the README and docs site.
//
//   npm run build && npx vite preview --port 4173 &   (or any running preview)
//   node scripts/record-demos.mjs [sceneName ...]
//
// Frames come from Chrome's screencast (only emitted when pixels change), are decoded with
// pngjs and encoded with gifenc — no ffmpeg needed. Output: docs/media/*.gif
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const BASE = process.env.AXIOM_URL ?? 'http://localhost:4173';
const OUT = join(process.cwd(), 'docs', 'media');
const FIX = join(process.cwd(), 'tests', 'fixtures');
mkdirSync(OUT, { recursive: true });

const exe = ['/opt/pw-browsers/chromium', process.env.AXIOM_CHROMIUM].find((p) => p && existsSync(p));
const browser = await chromium.launch({ executablePath: exe });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake cursor + touch dots, since screencasts don't show the pointer. */
function overlay() {
  const install = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-200px,-200px);transition:transform 40ms linear}
      #demo-cursor svg{filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))}
      #demo-cursor.down::after{content:'';position:absolute;left:-10px;top:-10px;width:22px;height:22px;border-radius:50%;background:rgba(61,91,217,.28)}
      .demo-touch{position:fixed;z-index:2147483647;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(61,91,217,.28);border:2px solid rgba(61,91,217,.8);pointer-events:none}`;
    document.head.appendChild(style);
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML = '<svg width="20" height="22" viewBox="0 0 20 22"><path d="M2 1.5v16.2l4.3-4.1 2.9 6.6 2.7-1.2-2.9-6.5h6.1z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const move = (x, y) => (c.style.transform = `translate(${x - 2}px,${y - 1}px)`);
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

async function openApp(page, vault, hash = '#/stream') {
  await page.goto(`${BASE}/?vault=${vault}&debug${hash}`);
  await page.waitForFunction(() => !!window.axiom);
  await page.waitForTimeout(700);
}

async function axiom(page, body, arg) {
  return page.evaluate(([b, a]) => new Function('axiom', 'arg', `return (async()=>{${b}})()`)(window.axiom, a), [body, arg]);
}

/** Smooth mouse glide so the fake cursor visibly travels. */
async function glide(page, x, y, steps = 18) {
  await page.mouse.move(x, y, { steps });
}

async function typeSlow(page, text, delay = 32) {
  await page.keyboard.type(text, { delay });
}

async function record(name, { width = 1180, height = 700, colors = 128 }, prepare, act, target = null) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript(overlay);
  const vault = `demo-${name}-${Date.now().toString(36)}`;
  const state = (await prepare(page, vault)) ?? {};
  const tgt = target ? await target(page) : page;
  const cdp = await ctx.newCDPSession(tgt === page ? page : page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  await sleep(400);
  await act(page, state);
  await sleep(1200);
  await cdp.send('Page.stopScreencast');
  await ctx.close();
  encode(name, frames, width, height, colors);
}

function encode(name, frames, width, height, colors) {
  // keep at most ~12 fps; each kept frame lasts until the next one
  const kept = [];
  for (const f of frames) {
    const last = kept[kept.length - 1];
    if (last && f.t - last.t < 0.083) kept[kept.length - 1] = { ...f, t: last.t };
    else kept.push(f);
  }
  const gif = GIFEncoder();
  let n = 0;
  let lastPng = null;
  for (let i = 0; i < kept.length; i++) {
    const png = PNG.sync.read(Buffer.from(kept[i].data, 'base64'));
    if (png.width !== width || png.height !== height) continue;
    const next = kept[i + 1];
    const delay = next ? Math.max(40, Math.round((next.t - kept[i].t) * 1000)) : 1800;
    if (process.env.DEMO_FRAMES && (n % 15 === 0 || i === kept.length - 1)) writeFileSync(join(process.env.DEMO_FRAMES, `${name}-${n}.png`), PNG.sync.write(png));
    const palette = quantize(png.data, colors);
    gif.writeFrame(applyPalette(png.data, palette), width, height, { palette, delay: Math.min(delay, 2500) });
    lastPng = png;
    n++;
  }
  gif.finish();
  const bytes = gif.bytes();
  writeFileSync(join(OUT, `${name}.gif`), bytes);
  // still poster (final state) for prefers-reduced-motion readers
  if (lastPng) writeFileSync(join(OUT, `${name}.png`), PNG.sync.write(lastPng));
  console.log(`${name}.gif  ${n} frames  ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
}

// ---------------------------------------------------------------- scenes

const scenes = {
  async writing() {
    await record(
      'writing',
      {},
      async (page, vault) => openApp(page, vault),
      async (page) => {
        const tail = page.locator('.day-today .blist-tail');
        const b = await tail.boundingBox();
        await glide(page, b.x + 120, b.y + 20);
        await tail.click();
        await page.waitForSelector('.day-today .cm-editor');
        await typeSlow(page, 'Derived the **policy gradient** today: $\\nabla_\\theta J = \\mathbb{E}[\\nabla_\\theta \\log \\pi_\\theta(a|s)\\, Q(s,a)]$ — see [[Reinforcement Learning]]');
        await page.keyboard.press('Enter');
        await typeSlow(page, '/math', 90);
        await page.waitForSelector('.cm-tooltip-autocomplete');
        await sleep(700);
        await page.keyboard.press('Enter');
        await page.waitForSelector('.blk-math-edit');
        await typeSlow(page, 'V^\\pi(s) = \\sum_a \\pi(a|s) \\sum_{s\'} P(s\'|s,a)\\,[r + \\gamma V^\\pi(s\')]', 28);
        await sleep(600);
        await page.keyboard.press('Escape');
        await sleep(500);
        const link = page.locator('.day-today .md-wikilink').first();
        const lb = await link.boundingBox();
        await glide(page, lb.x + lb.width / 2, lb.y + lb.height / 2, 24);
        await sleep(500);
        await link.click();
        await page.waitForSelector('.page-title');
        await sleep(1400);
      },
    );
  },

  async lasso() {
    await record(
      'lasso',
      { width: 1120, height: 680, colors: 48 },
      async (page, vault) => {
        await openApp(page, vault, '#/library');
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: /^Import/ }).first().click();
        await (await chooser).setFiles(join(FIX, 'paper.pdf'));
        await page.locator('.lib-card').first().click();
        await page.waitForSelector('.pdfv-page[data-page="1"] canvas.ready');
        await page.evaluate(() => document.querySelector('.ui-toast button[aria-label="Dismiss"]')?.click());
        await page.waitForSelector('.pdfv-page[data-page="1"] .textLayer span');
        await sleep(600);
      },
      async (page) => {
        await glide(page, 400, 80);
        await page.getByRole('button', { name: 'Lasso tool' }).click();
        await sleep(300);
        const pg = await page.locator('.pdfv-page[data-page="1"]').boundingBox();
        const X = (f) => pg.x + f * pg.width;
        const Y = (f) => pg.y + f * pg.height;
        await glide(page, X(0.05), Y(0.27));
        await page.mouse.down();
        for (const [x, y] of [[0.3, 0.255], [0.51, 0.27], [0.52, 0.45], [0.5, 0.62], [0.25, 0.63], [0.05, 0.6], [0.04, 0.4], [0.05, 0.275]]) await page.mouse.move(X(x), Y(y), { steps: 10 });
        await page.mouse.up();
        await page.waitForSelector('.extract-card');
        await sleep(1600);
        const send = page.getByRole('button', { name: 'Send to Desk' });
        const sb = await send.boundingBox();
        await glide(page, sb.x + sb.width / 2, sb.y + sb.height / 2);
        await send.click();
        await page.waitForSelector('.pane-desk .blk-anchor');
        await sleep(1400);
        await page.locator('.pdfv-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight * 0.6, behavior: 'smooth' }));
        await sleep(900);
        const anchor = page.locator('.pane-desk .blk-anchor').first();
        await page.locator('.pane-desk .blk:has(.blk-anchor)').first().hover();
        const ab = await anchor.boundingBox();
        await glide(page, ab.x + ab.width / 2, ab.y + ab.height / 2);
        await sleep(300);
        await anchor.click();
        await page.waitForSelector('.pdfv-flash');
        await sleep(2400);
      },
    );
  },

  async whiteboard() {
    await record(
      'whiteboard',
      { width: 1100, height: 720 },
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
      async (page) => {
        const q1 = await page.locator('.blk', { hasText: 'Q1.' }).boundingBox();
        const q2 = await page.locator('.blk', { hasText: 'Q2.' }).boundingBox();
        const x = q1.x + q1.width / 2;
        const y = (q1.y + q1.height + q2.y) / 2;
        const cdp = await page.context().newCDPSession(page);
        const pts = (d) => [{ x, y: y - d / 2, id: 1 }, { x: x + 6, y: y + d / 2, id: 2 }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(40) });
        for (let i = 1; i <= 24; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(40 + i * 13) });
          await sleep(35);
        }
        await sleep(300);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForSelector('.blk-ink .ink-surface');
        await sleep(900);
        // sketch a circle and an arrow with the pen
        await page.keyboard.press('p');
        const box = await page.locator('.blk-ink .ink-surface').first().boundingBox();
        const cx = box.x + 180;
        const cy = box.y + box.height / 2;
        await glide(page, cx + 60, cy);
        await page.mouse.down();
        for (let i = 1; i <= 40; i++) {
          const a = (i / 40) * Math.PI * 2.05;
          await page.mouse.move(cx + 60 * Math.cos(a) + Math.sin(i) * 2, cy + 52 * Math.sin(a), { steps: 1 });
          await sleep(8);
        }
        await page.mouse.up();
        // arrow in one stroke: shaft, then the V of the head
        await glide(page, cx + 90, cy + 4, 8);
        await page.mouse.down();
        await page.mouse.move(cx + 300, cy - 4, { steps: 22 });
        await page.mouse.move(cx + 278, cy - 22, { steps: 6 });
        await page.mouse.move(cx + 300, cy - 4, { steps: 6 });
        await page.mouse.move(cx + 280, cy + 16, { steps: 6 });
        await page.mouse.up();
        await sleep(700);
        // lasso everything and double-tap → Beautify
        await page.keyboard.press('l');
        await glide(page, box.x + 90, box.y + 20);
        await page.mouse.down();
        for (const [px, py] of [[box.x + 520, box.y + 20], [box.x + 520, box.y + box.height - 20], [box.x + 90, box.y + box.height - 20], [box.x + 90, box.y + 24]]) await page.mouse.move(px, py, { steps: 10 });
        await page.mouse.up();
        await sleep(700);
        await glide(page, cx, cy, 10);
        await page.mouse.dblclick(cx, cy);
        await sleep(2200);
        await page.keyboard.press('v');
        await sleep(600);
      },
    );
  },

  async sync() {
    const vault = `demo-sync-${Date.now().toString(36)}`;
    const host = join(process.cwd(), 'dist', 'demo-sync.html');
    writeFileSync(
      host,
      `<!doctype html><meta charset="utf-8"><title>sync</title><style>
        body{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px;background:#e9e7e0;font:600 13px -apple-system,Segoe UI,sans-serif;color:#1d2230;height:100vh;box-sizing:border-box}
        figure{margin:0;display:flex;flex-direction:column;gap:8px;min-height:0}
        figcaption{display:flex;gap:8px;align-items:center}figcaption b{width:8px;height:8px;border-radius:50%;background:#2f9e6a}
        iframe{flex:1;border:0;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.14);background:#fff}
      </style>
      <figure><figcaption><b></b>Laptop</figcaption><iframe id="a" src="/?vault=${vault}&debug#/stream"></iframe></figure>
      <figure><figcaption><b></b>Tablet</figcaption><iframe id="b" src="/?vault=${vault}&debug#/stream"></iframe></figure>`,
    );
    await record(
      'sync',
      { width: 1280, height: 640 },
      async (page) => {
        await page.goto(`${BASE}/demo-sync.html`);
        for (const f of ['a', 'b']) await page.frameLocator(`#${f}`).locator('.app').waitFor();
        await page.waitForFunction(() => ['a', 'b'].every((id) => document.getElementById(id).contentWindow.axiom));
        await sleep(800);
      },
      async (page) => {
        const a = page.frameLocator('#a');
        const b = page.frameLocator('#b');
        await a.locator('.day-today .blist-tail').click();
        await typeSlow(page, 'Idea: variance of REINFORCE shrinks with a learned baseline b(s)', 34);
        await page.keyboard.press('Escape');
        await sleep(900);
        await b.locator('.day-today .blist-tail').click();
        await typeSlow(page, 'Tablet: sketch the proof after the seminar ✍️', 34);
        await page.keyboard.press('Escape');
        await sleep(2000);
      },
    );
  },

  async review() {
    await record(
      'review',
      { width: 1100, height: 680 },
      async (page, vault) => {
        await openApp(page, vault);
        await axiom(
          page,
          `const id = axiom.vault.ensureDaily();
           const { doc } = await axiom.vault.openPage(id);
           axiom.__blocks.insertBlocks(doc, [
             { type: 'text', text: 'The **Kullback–Leibler divergence** is always non-negative. #flashcard' },
             { type: 'text', text: 'In an MDP the discount factor {{c1::γ ∈ [0,1)}} guarantees the return is finite. #flashcard' },
           ]);`,
        );
        await page.waitForFunction(() => window.axiom.vault.cards.size >= 3, null, { timeout: 15000 });
        await page.evaluate(() => (location.hash = '#/review'));
        await page.getByRole('button', { name: /Show answer/i }).waitFor();
        await sleep(600);
      },
      async (page) => {
        for (let i = 0; i < 3; i++) {
          const show = page.getByRole('button', { name: /Show answer/i });
          if (!(await show.isVisible().catch(() => false))) break;
          const sb = await show.boundingBox();
          await glide(page, sb.x + sb.width / 2, sb.y + sb.height / 2);
          await sleep(900);
          await show.click();
          await sleep(1100);
          const good = page.getByRole('button', { name: /Good/ });
          const gb = await good.boundingBox();
          await glide(page, gb.x + gb.width / 2, gb.y + gb.height / 2);
          await sleep(400);
          await good.click();
          await sleep(900);
        }
        await sleep(800);
      },
    );
  },

  async navigate() {
    await record(
      'navigate',
      { width: 1180, height: 700 },
      async (page, vault) => {
        await openApp(page, vault);
        await axiom(
          page,
          `const pages = [['Policy gradients', 'REINFORCE is unbiased but noisy #rl [[Variance reduction]] [[Monte Carlo]]'],
             ['Actor-critic', 'Critic learns [[Value function]] to cut variance #rl [[Variance reduction]]'],
             ['Seminar notes', 'Speaker compared [[Policy gradients]] with [[Actor-critic]] #seminar'],
             ['Information theory', '[[Entropy]] and [[Mutual information]] bound what an agent can learn #theory'],
             ['Value function', 'Bellman expectation equation #rl [[Monte Carlo]]']];
           for (const [t, x] of pages) { const id = axiom.vault.createPage({ title: t }); const { doc } = await axiom.vault.openPage(id); axiom.__blocks.insertBlocks(doc, [{ type: 'text', text: x }]); }
           await axiom.graph.flush();`,
        );
        await sleep(500);
      },
      async (page) => {
        await page.keyboard.press('Control+k');
        await sleep(500);
        await typeSlow(page, 'variance', 90);
        await sleep(1300);
        await page.keyboard.press('Escape');
        await sleep(300);
        await page.evaluate(() => (location.hash = '#/graph'));
        await page.waitForSelector('.graph-route canvas');
        await sleep(2600);
        await page.evaluate(() => (location.hash = '#/lens?q=%23rl%20OR%20%5B%5BVariance%20reduction%5D%5D'));
        await page.waitForSelector('.lens-count');
        await sleep(2400);
      },
    );
  },
};

const wanted = process.argv.slice(2);
for (const [name, fn] of Object.entries(scenes)) {
  if (wanted.length && !wanted.includes(name)) continue;
  try {
    await fn();
  } catch (e) {
    console.error(`scene ${name} failed:`, e.message);
  }
}
await browser.close();
