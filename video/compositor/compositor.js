/* Axiom demo video compositor: a pure function of time.  window.seek(t) puts every layer in its
 * state for time t (seconds) and resolves once all images are decoded; render.mjs screenshots it.
 * Timing comes from build/timeline.json (scenes snapped to the 110 BPM bar grid), footage from
 * build/clips/<clip>/index.json (frames + marks, recorded in slow motion). */
'use strict';

const P = new URLSearchParams(location.search);
const LAYOUT = P.get('layout') === 'v' ? 'v' : 'h';
const W = LAYOUT === 'v' ? 1080 : 1920;
const H = LAYOUT === 'v' ? 1920 : 1080;
const CW = 1920; // clip frame size (CSS px × 1.5)
const CH = 1140;

const $ = (id) => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const prog = (t, a, b) => clamp((t - a) / (b - a));
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const easeIn = (k) => k * k * k;
const easeBack = (k) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
};
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const css = (el, o) => {
  for (const k in o) el.style[k] = o[k];
};
const show = (el, on) => el.classList.toggle('hide', !on);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// ------------------------------------------------------------------ layout

const L =
  LAYOUT === 'h'
    ? {
        act1: { x: 240, y: 72, w: 1440, bar: 34 },
        act2: { x: 56, y: 108, w: 1250, bar: 30 },
        panel: { x: 1340, y: 108, w: 524 },
        capTop: 978,
        capFont: 33,
        titleSize: 112,
      }
    : {
        act1: { x: 24, y: 520, w: 1032, bar: 26, crop: 1240 },
        act2: { x: 24, y: 520, w: 1032, bar: 26, crop: 1240 },
        panel: null,
        capTop: 1560,
        capFont: 46,
        titleSize: 86,
      };
const winH = (g) => g.bar + (g.w * CH) / (g.crop ?? CW);

// ------------------------------------------------------------------ data

let TL;
const CLIPS = {};
let REPO = null;
const SCENE = {};

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/** Parses 'mark', 'mark+0.4', 'mark-1', or a number (clip wall seconds). */
function at(clip, ref) {
  if (typeof ref === 'number') return ref;
  const m = /^([a-zA-Z0-9]+)([+-][\d.]+)?$/.exec(ref);
  const c = CLIPS[clip];
  if (!m || c.marks[m[1]] === undefined) throw new Error(`no mark ${ref} in ${clip}`);
  return c.marks[m[1]] + (m[2] ? Number(m[2]) * c.slow : 0);
}

function frameAt(clip, wall) {
  const fr = CLIPS[clip].frames;
  let lo = 0;
  let hi = fr.length - 1;
  if (wall <= fr[0].t) return fr[0].f;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fr[mid].t <= wall) lo = mid;
    else hi = mid - 1;
  }
  return fr[lo].f;
}
const frameUrl = (clip, wall) => `/build/clips/${clip}/${frameAt(clip, wall)}`;

// ------------------------------------------------------------------ per-scene content plans
// A plan is a list of segments shown in the window after `start` seconds: footage segments
// ({clip, from, to}) share the time left after fixed-length illustration segments ({html, dur}).

const PLANS = {
  f1: { segs: [{ clip: 'f1-lasso', from: 'lasso1-0.5', to: 'end' }] },
  f2: { segs: [{ clip: 'f2-whiteboard', from: 'spread-0.4', to: 'end' }] },
  f3: { segs: [{ clip: 'f3-writing', from: 'typing-0.6', to: 'end' }] },
  f4: { segs: [{ clip: 'f4-flashcards', from: 'typing-0.3', to: 'end' }] },
  f5: { segs: [{ clip: 'f5-navigate', from: 'search-0.4', to: 'end' }] },
  f6: { bare: true, segs: [{ clip: 'f6-sync', from: 'typeA-0.5', to: 'end' }] },
  f7: { segs: [{ clip: 's5-git', from: 'saved-0.4', to: 'synced+0.9', label: 'Settings → Git backup' }, { html: 'repo', dur: 'rest', label: 'Your repository', illus: 'Repository view · illustration of the files Axiom pushed' }] },
  f8: {
    segs: [
      { clip: 'f8-ink', from: 'lasso-0.2', to: 'done+0.6', label: 'Handwriting → text & LaTeX' },
      { clip: 'f8-math', from: 'lasso-0.1', to: 'latex+0.9', label: 'Equation crop → LaTeX' },
      { clip: 'f8-tags', from: 'card-0.2', to: 'end', label: 'Suggested tags' },
      { clip: 'f8-cloze', from: 'tagged-0.2', to: 'end', label: 'Flashcards written by AI' },
    ],
    providers: true,
  },
  s1: { start: 0.2, segs: [{ html: 'terminal', dur: 6.0, chrome: 'terminal' }, { clip: 's1-open', from: 0, to: 'end' }] },
  s2: { start: 0.2, segs: [{ html: 'install', dur: 'rest', illus: 'Illustration' }] },
  s3: { start: 0.2, segs: [{ clip: 's3-import', from: 'drag-0.3', to: 'end' }] },
  s4: { start: 0.2, segs: [{ html: 'relay', dur: 1.9, chrome: 'terminal' }, { clip: 's4-link', from: 'key-2.2', to: 'online+0.9', bare: true }] },
  s5: { start: 0.2, segs: [{ html: 'token', dur: 3.6, illus: 'Illustration · your Git host' }, { clip: 's5-git', from: 0.2, to: 'synced+0.8' }] },
  s6: { start: 0.2, segs: [{ html: 'aikey', dur: 3.0, illus: 'Illustration · Google AI Studio' }, { clip: 's6-ai', from: 0.2, to: 'end' }] },
};

/** Horizontal camera targets (clip px) for the vertical layout: [[mark or wall s, centre x], …]. */
const VCAM = {
  'f1-lasso': [[0, 780], ['sent1-0.1', 1450], ['card2-0.7', 760], ['sent2-0.1', 1450], ['anchor-0.4', 1250], ['flash-0.1', 780]],
  'f6-sync': [[0, 600], ['seenB-0.4', 1420]],
  'f8-ink': [[0, 720]],
  'f8-math': [[0, 960]],
  'f8-tags': [[0, 760]],
  'f8-cloze': [[0, 960]],
};
function camX(content) {
  const keys = VCAM[content.clip];
  if (!keys) return CW / 2;
  const c = CLIPS[content.clip];
  let x = keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const t0 = at(content.clip, keys[i][0]);
    const k = ease(prog(content.wall, t0, t0 + 0.55 * c.slow));
    if (k > 0) x = lerp(x, keys[i][1], k);
  }
  return x;
}

function buildPlan(scene) {
  const plan = PLANS[scene.id];
  if (!plan) return null;
  const start = plan.start ?? (scene.kind === 'feature' ? 1.2 : 0.2);
  const avail = scene.dur - start - 0.05;
  const fixed = plan.segs.filter((s) => s.html && s.dur !== 'rest').reduce((a, s) => a + s.dur, 0);
  const clipSegs = plan.segs.filter((s) => s.clip);
  const restSegs = plan.segs.filter((s) => s.dur === 'rest');
  const real = clipSegs.map((s) => (at(s.clip, s.to) - at(s.clip, s.from)) / CLIPS[s.clip].slow);
  const sumReal = real.reduce((a, b) => a + b, 0);
  let clipAvail = avail - fixed;
  let restDur = 0;
  if (restSegs.length) {
    // illustration fills what the footage (at up to 1.25×) leaves
    const need = sumReal / 1.25;
    clipAvail = Math.min(clipAvail - 1.6 * restSegs.length, Math.max(need, 0));
    restDur = (avail - fixed - clipAvail) / restSegs.length;
  }
  const speed = clipSegs.length ? Math.max(1, sumReal / clipAvail) : 1;
  if (speed > 1.9) console.warn(`scene ${scene.id}: footage plays at ${speed.toFixed(2)}×`);
  let t = start;
  const segs = plan.segs.map((s) => {
    let dur;
    if (s.html) dur = s.dur === 'rest' ? restDur : s.dur;
    else {
      const r = (at(s.clip, s.to) - at(s.clip, s.from)) / CLIPS[s.clip].slow;
      dur = clipSegs.length === 1 && !restSegs.length ? avail - fixed : r / speed;
    }
    const seg = { ...s, start: t, dur, speed, fromW: s.clip ? at(s.clip, s.from) : 0, toW: s.clip ? at(s.clip, s.to) : 0 };
    t += dur;
    return seg;
  });
  return { start, segs, bare: !!plan.bare, providers: !!plan.providers, speed };
}

// ------------------------------------------------------------------ static DOM built once

function buildGrain() {
  const c = $('grain');
  c.width = W / 2;
  c.height = H / 2;
  css(c, { width: W + 'px', height: H + 'px' });
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const r = rng(11);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 110 + r() * 145;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

const MESS_TYPES = ['browser', 'pdf', 'shot', 'note', 'browser', 'card', 'shot', 'browser', 'pdf', 'shot', 'browser', 'note', 'shot', 'browser', 'pdf'];
const TAB_TITLES = ['Policy gradients — lecture notes', 'variance of REINFORCE? — Q&A', 'Bellman equation — encyclopedia', 'papers/2310.04411.pdf', 'Sutton & Barto, ch. 13', 'baseline unbiased proof', 'Actor-critic tutorial (part 3)', 'GAE explained', 'citation style for theses', 'my notes (old) — Drive'];
const NOTE_TEXT = ['TODO: re-derive eq. (7)!!', 'where did I read the baseline trick??', 'ask Lin about variance bound', 'Thesis ch.3 — outline v4'];
const CARD_TEXT = ['What is the score function?', 'Define the advantage A(s,a)', 'Why is γ < 1?'];

function buildMess() {
  const box = $('mess');
  box.innerHTML = '';
  const pops = SCENE.mess.pops;
  const r = rng(7);
  const out = [];
  pops.forEach((p, i) => {
    const type = MESS_TYPES[i % MESS_TYPES.length];
    const size = { browser: [440, 290], pdf: [300, 390], shot: [270, 200], note: [260, 210], card: [310, 170] }[type];
    const sc = LAYOUT === 'v' ? 1.05 : 1;
    const w = size[0] * sc;
    const h = size[1] * sc;
    const el = document.createElement('div');
    el.className = `mw ${type}`;
    css(el, { width: w + 'px', height: h + 'px' });
    const ti = TAB_TITLES[i % TAB_TITLES.length];
    if (type === 'browser') {
      el.innerHTML = `<div class="tabs">${Array.from({ length: 4 + (i % 4) }, (_, k) => `<b>${esc(TAB_TITLES[(i + k) % TAB_TITLES.length])}</b>`).join('')}</div><div class="bar"><i></i><i></i><i></i><span>${esc(ti)}</span></div><div class="body">${'<div class="ln"></div>'.repeat(9)}</div>`;
    } else if (type === 'pdf') {
      el.innerHTML = `<div class="bar"><i></i><i></i><i></i><span>${esc(['paper_v2_final.pdf', 'lecture7.pdf', 'thesis-draft(3).pdf'][i % 3])}</span></div><div class="page">${'<div class="ln"></div>'.repeat(12)}</div>`;
    } else if (type === 'shot') {
      el.innerHTML = `<div class="img"></div><div class="cap">Screenshot_final_FINAL(${(i % 9) + 1}).png</div>`;
    } else if (type === 'note') {
      el.innerHTML = `<div class="bar"><i></i><i></i><i></i><span>Notes</span></div><div class="body">${esc(NOTE_TEXT[i % NOTE_TEXT.length])}</div>`;
    } else {
      el.innerHTML = `<div class="bar"><i></i><i></i><i></i><span>Flashcards</span></div><div class="q">${esc(CARD_TEXT[i % CARD_TEXT.length])}</div>`;
    }
    const x = 30 + r() * (W - w - 60);
    const y = (LAYOUT === 'v' ? 260 : 120) + r() * (H - h - (LAYOUT === 'v' ? 520 : 200));
    const rot = (r() - 0.5) * 14;
    box.appendChild(el);
    out.push({ el, p, x, y, rot, w, h });
  });
  SCENE.mess.els = out;
  const cnt = $('counters');
  if (LAYOUT === 'v') css(cnt, { left: '40px', top: '120px', flexDirection: 'column', alignItems: 'flex-start' });
  else css(cnt, { left: '60px', top: '42px' });
}

function buildPanel() {
  const steps = TL.scenes.filter((s) => s.kind === 'step');
  $('steps').innerHTML = steps.map((s) => `<div class="step" data-id="${s.id}"><div class="box">${s.n}</div><div>${esc(s.title)}</div></div>`).join('');
  if (L.panel) css($('panel'), { left: L.panel.x + 'px', top: L.panel.y + 'px', width: L.panel.w + 'px', height: winH(L.act2) + 'px' });
}

function buildOutro() {
  const box = $('outro');
  const shots = [
    ['f1-lasso', 'flash+0.4', 'Read left. Think right.'],
    ['f2-whiteboard', 'clean', 'Make room to think.'],
    ['f3-writing', 'page+0.6', 'Write like a scientist.'],
    ['f4-flashcards', 'review+1.2', 'Never forget it.'],
    ['f5-navigate', 'graph+1.2', 'Find the thread.'],
    ['f6-sync', 'typeB+1.0', 'Every device, live.'],
    ['s5-git', 'synced+0.4', 'Your notes, in your Git.'],
    ['f8-ink', 'done+0.4', 'AI that costs $0.'],
  ];
  const cols = LAYOUT === 'v' ? 2 : 4;
  const tw = LAYOUT === 'v' ? 470 : 404;
  const th = (tw * CH) / CW;
  const gap = 26;
  const gw = cols * tw + (cols - 1) * gap;
  const rows = Math.ceil(shots.length / cols);
  const gh = rows * th + (rows - 1) * gap;
  const x0 = (W - gw) / 2;
  const y0 = (H - gh) / 2 - (LAYOUT === 'v' ? 60 : 30);
  SCENE.tiles = shots.map(([clip, mark, label], i) => {
    const el = document.createElement('div');
    el.className = 'tile';
    const x = x0 + (i % cols) * (tw + gap);
    const y = y0 + Math.floor(i / cols) * (th + gap);
    css(el, { left: x + 'px', top: y + 'px', width: tw + 'px', height: th + 'px' });
    el.innerHTML = `<img src="${frameUrl(clip, at(clip, mark))}"><b>${esc(label)}</b>`;
    box.appendChild(el);
    return { el, x, y, w: tw, h: th };
  });
}

async function buildQR() {
  const svg = await (await fetch('/build/qr.svg')).text();
  $('qr').innerHTML = svg;
}

// ------------------------------------------------------------------ illustrated screens (1920×1140 space)

const HTML = {};
const CURSOR = '<svg class="cursor" viewBox="0 0 20 22"><path d="M2 1.5v16.2l4.3-4.1 2.9 6.6 2.7-1.2-2.9-6.5h6.1z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';

function typed(text, t, a, b) {
  const n = Math.round(text.length * prog(t, a, b));
  return text.slice(0, n);
}
function cursorAt(el, pts, t) {
  // pts: [[t, x, y], …] — eased glide between keyframes
  const c = el.classList.contains('cursor') ? el : el.querySelector('.cursor');
  let x = pts[0][1];
  let y = pts[0][2];
  for (let i = 1; i < pts.length; i++) {
    if (t >= pts[i - 1][0]) {
      const k = ease(prog(t, pts[i - 1][0], pts[i][0]));
      x = lerp(pts[i - 1][1], pts[i][1], k);
      y = lerp(pts[i - 1][2], pts[i][2], k);
    }
  }
  css(c, { left: x + 'px', top: y + 'px' });
}

HTML.terminal = {
  build() {
    return `<div class="term" style="width:1920px;height:1140px"><div id="tm"></div><div class="speed hide" id="tmSpeed">fast-forward ×6</div></div>`;
  },
  render(lt) {
    const L1 = 'git clone https://github.com/preetsingh-007/axiom';
    const L2 = 'cd axiom && npm install';
    const L3 = 'npm run dev';
    const fill = prog(lt, 2.35, 4.2);
    let s = `<span class="p">~ $</span> ${esc(typed(L1, lt, 0.2, 1.2))}`;
    if (lt > 1.35) s += `\n<span class="d">Cloning into 'axiom'… done.</span>`;
    if (lt > 1.5) s += `\n\n<span class="p">~/axiom $</span> ${esc(typed(L2, lt, 1.5, 2.2))}`;
    if (lt > 2.35) s += `\n<span class="bar"><i style="width:${(fill * 100).toFixed(1)}%"></i></span>  <span class="d">${Math.round(fill * 444)} / 444 packages</span>`;
    if (lt > 4.25) s += `\n<span class="y">added 444 packages in 12s</span>`;
    if (lt > 4.4) s += `\n\n<span class="p">~/axiom $</span> ${esc(typed(L3, lt, 4.4, 4.8))}`;
    if (lt > 5.0) s += `\n\n  <span class="b">VITE</span> <span class="d">v8.3.1</span>  ready in 342 ms\n\n  <span class="p">➜</span>  Local:   <span class="b">http://localhost:5173/</span>`;
    const blink = Math.floor(lt * 2.2) % 2 === 0 ? '█' : ' ';
    $('tm').innerHTML = s + blink;
    show($('tmSpeed'), lt > 2.35 && lt < 4.25);
  },
};

HTML.relay = {
  build() {
    return `<div class="term" style="width:1920px;height:1140px"><div id="rl"></div></div>`;
  },
  render(lt) {
    let s = `<span class="p">~/axiom $</span> ${esc(typed('npm run relay', lt, 0.15, 0.8))}`;
    if (lt > 1.0) s += `\n\n<span class="d">> axiom@1.0.0 relay\n> node server/relay.mjs</span>\n\n<span class="y">[axiom relay] listening on :8787</span>`;
    $('rl').innerHTML = s + (Math.floor(lt * 2.2) % 2 ? ' ' : '█');
  },
};

HTML.install = {
  build() {
    const shot = frameUrl('s1-open', at('s1-open', 'end'));
    return `<div class="page" style="width:1920px;height:1140px;background:#e9e7e1">
      <img id="inShot" src="${shot}" style="position:absolute;left:0;top:0;width:1920px;height:1140px">
      <div id="inDim" style="position:absolute;inset:0;background:rgba(10,14,31,.35)"></div>
      <div id="inDlg" class="sheet" style="left:1210px;top:40px;width:640px;padding:40px 44px">
        <div style="font:700 34px Inter;color:#1f2430">Install app?</div>
        <div style="display:flex;align-items:center;gap:22px;margin:30px 0 36px"><div style="width:84px;height:84px;border-radius:22px;background:#1d2230;display:grid;place-items:center;font:700 52px Fraunces;color:#f0bd4f">A</div><div><div style="font:700 30px Inter;color:#1f2430">Axiom</div><div style="font:24px Inter;color:#6a7086">localhost:5173</div></div></div>
        <div style="display:flex;justify-content:flex-end;gap:16px"><span class="btn ghost">Cancel</span><span class="btn blue" id="inBtn">Install</span></div>
      </div>
      <div id="inPad" class="ipad" style="left:470px;top:60px;width:980px;height:1020px"><div class="scrn">
        <img src="${shot}" style="position:absolute;left:0;top:0;width:1440px;height:855px;transform-origin:0 0;transform:scale(.646)">
        <div id="inSheet" class="sheet" style="left:30px;right:30px;bottom:-10px;height:470px;border-radius:30px 30px 0 0;padding:34px 40px">
          <div style="font:700 30px Inter;color:#1f2430;margin-bottom:24px">Share</div>
          ${['Copy', 'Add to Reading List', 'Add to Home Screen', 'Find on Page'].map((x, i) => `<div class="perm" ${i === 2 ? 'id="inA2HS"' : ''} style="font-size:27px">${x}<span style="color:#7a8094">${['⧉', '◎', '⊞', '⌕'][i]}</span></div>`).join('')}
        </div>
        <div id="inHome" style="position:absolute;inset:0;background:linear-gradient(160deg,#3a4bb0,#1b2250);display:grid;place-items:center">
          <div style="text-align:center"><div style="width:150px;height:150px;border-radius:36px;background:#1d2230;display:grid;place-items:center;font:700 92px Fraunces;color:#f0bd4f;box-shadow:0 20px 50px rgba(0,0,0,.4)">A</div><div style="font:600 30px Inter;color:#fff;margin-top:16px">Axiom</div></div>
        </div>
      </div></div>
      ${CURSOR}
    </div>`;
  },
  render(lt, seg) {
    const d = seg.dur;
    const split = d * 0.47; // desktop part, then iPad part
    const desk = lt < split;
    show($('inShot'), desk);
    show($('inDim'), desk && lt > 1.0);
    const dlg = prog(lt, 1.0, 1.3);
    css($('inDlg'), { opacity: desk ? dlg : 0, transform: `translateY(${(1 - easeOut(dlg)) * -20}px)` });
    css($('inBtn'), { filter: lt > 2.0 && lt < 2.25 ? 'brightness(.85)' : 'none' });
    $('urlInstall').classList.toggle('hide', !desk);
    css($('urlInstall'), { background: lt > 0.3 && lt < 1.1 ? 'rgba(61,91,217,.15)' : 'transparent' });
    const pad = !desk;
    const k = lt - split;
    css($('inPad'), { opacity: pad ? easeOut(prog(k, 0, 0.35)) : 0, transform: `translateY(${pad ? (1 - easeOut(prog(k, 0, 0.35))) * 60 : 60}px)` });
    css($('inSheet'), { transform: `translateY(${(1 - easeOut(prog(k, 0.35, 0.7))) * 480}px)` });
    css($('inA2HS'), { background: k > 1.25 ? 'rgba(108,123,255,.15)' : '#fff', borderColor: k > 1.25 ? '#6c7bff' : '#e3e5ee' });
    css($('inHome'), { opacity: prog(k, 1.7, 2.0) });
    // cursor: to the install icon, click; to Install; then to the iPad sheet item
    cursorAt(document.querySelector('#html .cursor'), desk
      ? [[0, 1300, 600], [0.9, 1236, 20], [1.4, 1236, 20], [1.9, 1760, 232], [2.6, 1760, 232]]
      : [[0, 1100, 1000], [1.0, 1100, 1000], [1.25, 1100, 806], [3, 1100, 806]].map(([t, x, y]) => [t, x, y]), desk ? lt : k);
    css(document.querySelector('#html .cursor'), { opacity: !desk && k > 1.7 ? 0 : 1 });
  },
};

HTML.token = {
  build() {
    return `<div class="page" style="width:1920px;height:1140px">
      <div class="top"><span class="crumb">Settings › Developer settings › Personal access tokens ›</span> Fine-grained tokens</div>
      <div class="main" style="max-width:1300px">
        <h1>New fine-grained personal access token</h1>
        <p class="lead">Give Axiom access to one repository, nothing else.</p>
        <div class="fld"><label>Token name</label><div class="in" id="tkName"></div></div>
        <div class="fld"><label>Repository access · Only select repositories</label><div class="in" id="tkRepo"></div></div>
        <div class="fld"><label>Permissions</label><div class="perm">Contents <b id="tkPerm">Read and write</b></div></div>
        <span class="btn" id="tkGen">Generate token</span>
        <div class="tokenbox" id="tkBox"><span>github_pat_11AXIOMDEMO••••••••••••••••••</span><span class="btn ghost" style="height:50px;font-size:20px">Copy</span></div>
      </div>${CURSOR}</div>`;
  },
  render(lt) {
    $('tkName').textContent = typed('axiom-vault backup', lt, 0.15, 0.8);
    $('tkName').classList.toggle('focus', lt < 0.9);
    $('tkRepo').textContent = lt > 1.0 ? typed('maya-okafor/axiom-vault', lt, 1.0, 1.6) : '';
    $('tkRepo').classList.toggle('focus', lt > 0.9 && lt < 1.8);
    css($('tkPerm'), { opacity: lt > 1.75 ? 1 : 0.25 });
    css($('tkGen'), { filter: lt > 2.25 && lt < 2.45 ? 'brightness(.85)' : 'none' });
    css($('tkBox'), { opacity: prog(lt, 2.45, 2.7) });
    cursorAt(document.querySelector('#html .cursor'), [[0, 900, 420], [1.0, 900, 532], [1.8, 1000, 640], [2.25, 270, 745], [2.6, 270, 745], [3.1, 1180, 860], [4, 1180, 860]], lt);
  },
};

HTML.aikey = {
  build() {
    return `<div class="page" style="width:1920px;height:1140px">
      <div class="top"><span style="font:700 28px Inter;color:#3d5bd9">AI Studio</span><span class="crumb">› API keys</span></div>
      <div class="main">
        <h1>API keys</h1>
        <p class="lead">Free tier · no credit card needed for Gemini Flash models.</p>
        <span class="btn blue" id="akBtn">＋ Create API key</span>
        <div class="tokenbox" id="akBox" style="border-color:#b8c3ff;background:#f1f3ff;color:#2a3a9c"><span>AIza••••••••••••••••••••••••••••••••</span><span class="btn ghost" style="height:50px;font-size:20px">Copy</span></div>
      </div>${CURSOR}</div>`;
  },
  render(lt) {
    css($('akBtn'), { filter: lt > 0.75 && lt < 0.95 ? 'brightness(.85)' : 'none' });
    css($('akBox'), { opacity: prog(lt, 1.0, 1.25), marginTop: '40px' });
    cursorAt(document.querySelector('#html .cursor'), [[0, 1100, 700], [0.7, 300, 335], [1.2, 300, 335], [1.9, 1230, 460], [3, 1230, 460]], lt);
  },
};

HTML.repo = {
  build() {
    const files = (REPO?.files ?? []).map((f) => f.path);
    const pages = files.filter((p) => p.startsWith('axiom/markdown/pages/')).map((p) => p.split('/').pop());
    const docs = files.filter((p) => p.startsWith('axiom/docs/')).length;
    const commit = REPO?.history?.[0]?.message ?? 'Axiom sync';
    const page = REPO?.files?.find((f) => /Policy gradients\.md$/.test(f.path))?.content ?? '';
    const rows = [
      ['📁', 'axiom/markdown/pages', commit, 'now'],
      ['📁', `axiom/docs  (${docs} CRDT docs)`, commit, 'now'],
      ['📄', 'axiom/vault.json', commit, 'now'],
      ['📄', 'README.md', 'Initial commit', '3 days ago'],
    ];
    return `<div class="page repo" style="width:1920px;height:1140px">
      <div class="top">${esc(REPO?.owner ?? 'you')} / <b>${esc(REPO?.repo ?? 'axiom-vault')}</b> <span style="font:600 18px Inter;border:2px solid #d6d9e4;border-radius:999px;padding:2px 12px;color:#7a8094">Private</span></div>
      <div class="main" style="padding:36px 90px;display:grid;grid-template-columns:1.25fr 1fr;gap:36px">
        <div>
          <div class="files"><div class="hd"><span>⎇ main · ${REPO?.history?.length ?? 2} commits</span><span style="color:#1f8f5f">✓ ${esc(commit)}</span></div>
            ${rows.map((r) => `<div class="row"><span>${r[0]}</span><span>${esc(r[1])}</span><span class="m">${esc(r[2])}</span><span class="w">${r[3]}</span></div>`).join('')}
          </div>
          <div class="files" id="rpPages" style="margin-top:24px"><div class="hd"><span>axiom/markdown/pages</span><span style="color:#7a8094">${pages.length} files</span></div>
            ${pages.slice(0, 8).map((p) => `<div class="row"><span>📝</span><span>${esc(p)}</span><span class="m"></span><span class="w">now</span></div>`).join('')}
          </div>
        </div>
        <div><div class="md" id="rpMd"><span style="color:#7a8094">Policy gradients.md</span>\n\n${esc(page)}</div></div>
      </div></div>`;
  },
  render(lt) {
    css($('rpPages'), { opacity: prog(lt, 0.5, 0.9), transform: `translateY(${(1 - easeOut(prog(lt, 0.5, 0.9))) * 30}px)` });
    css($('rpMd'), { opacity: prog(lt, 1.2, 1.6), transform: `translateY(${(1 - easeOut(prog(lt, 1.2, 1.6))) * 30}px)` });
  },
};

// ------------------------------------------------------------------ window

let currentHtml = null;
let CROP = CW;
const pendingDecodes = [];

function setImg(img, src) {
  if (img.getAttribute('src') !== src) {
    img.setAttribute('src', src);
    pendingDecodes.push(img.decode().catch(() => {}));
  }
}

/** Places the app window: geometry g, plus a transform (scale/translate/opacity/blur/dim). */
function placeWindow(g, fx = {}) {
  const win = $('win');
  const h = winH(g);
  css(win, {
    left: g.x + 'px',
    top: g.y + 'px',
    width: g.w + 'px',
    height: h + 'px',
    opacity: fx.opacity ?? 1,
    transform: `translate(${fx.dx ?? 0}px, ${fx.dy ?? 0}px) scale(${fx.scale ?? 1})`,
    filter: `${fx.blur ? `blur(${fx.blur}px)` : ''} ${fx.dim ? `brightness(${1 - fx.dim})` : ''}`.trim() || 'none',
  });
  css($('winbar'), { height: g.bar + 'px', padding: `0 ${g.bar * 0.55}px` });
  for (const d of $('winbar').querySelectorAll('.dots i')) css(d, { width: g.bar * 0.36 + 'px', height: g.bar * 0.36 + 'px', background: ['#ec6a5e', '#f4bf4f', '#61c554'][[...d.parentNode.children].indexOf(d)] });
  css($('winbar').querySelector('.url'), { height: g.bar * 0.68 + 'px', padding: `0 ${g.bar * 0.5}px`, font: `500 ${g.bar * 0.42}px Inter`, minWidth: g.w * 0.32 + 'px' });
  css($('wincontent'), { top: g.bar + 'px' });
  CROP = g.crop ?? CW;
  return g.w / CROP;
}

/** Shows content in the window: a clip frame (with optional focus zoom) or an illustration. */
function windowContent(s, content) {
  const img = $('clipimg');
  const html = $('html');
  if (content.html) {
    show(img, false);
    show(html, true);
    if (currentHtml !== content.html) {
      html.innerHTML = HTML[content.html].build();
      currentHtml = content.html;
      for (const im of html.querySelectorAll('img')) pendingDecodes.push(im.decode().catch(() => {}));
    }
    css(html, { transform: `scale(${s})` });
    HTML[content.html].render(content.lt, content.seg);
  } else {
    show(img, true);
    show(html, false);
    setImg(img, frameUrl(content.clip, content.wall));
    // vertical layout: a crop of the frame that pans between regions ("camera")
    const ox = CROP < CW ? clamp(camX(content) - CROP / 2, 0, CW - CROP) : 0;
    css(img, { transform: `scale(${s}) translate(${-ox}px, 0px)` });
  }
  const chrome = content.chrome ?? 'browser';
  $('win').classList.toggle('bare', !!content.bare);
  const url = $('urlText');
  url.textContent = chrome === 'terminal' ? 'Terminal — ~/axiom' : content.html === 'token' ? 'your Git host · settings' : content.html === 'aikey' ? 'aistudio.google.com' : content.html === 'repo' ? 'your Git host · repository' : 'localhost:5173';
  css($('winbar'), { background: chrome === 'terminal' ? '#1b1f30' : '#eceae4', borderBottomColor: chrome === 'terminal' ? '#262b40' : '#dcd9d1' });
  css($('winbar').querySelector('.url'), { background: chrome === 'terminal' ? 'transparent' : '#fff', color: chrome === 'terminal' ? '#9aa3c7' : '#4a4f5e', borderColor: chrome === 'terminal' ? 'transparent' : '#ddd9cf' });
  show($('winbar').querySelector('.lock'), chrome !== 'terminal');
  if (chrome === 'terminal' || content.html !== 'install') show($('urlInstall'), false);
}

/** Content of a scene's window at local time lt (null before the plan starts). */
function planContent(scene, lt) {
  const plan = scene.plan;
  const segs = plan.segs;
  let seg = segs[0];
  for (const s of segs) if (lt >= s.start) seg = s;
  const k = Math.max(0, lt - seg.start);
  if (seg.html) return { html: seg.html, lt: k, seg, chrome: seg.chrome, label: seg.label, illus: seg.illus };
  const c = CLIPS[seg.clip];
  const wall = Math.min(seg.toW, seg.fromW + k * seg.speed * c.slow);
  return { clip: seg.clip, wall, bare: plan.bare || seg.bare, label: seg.label, seg };
}

// ------------------------------------------------------------------ lasso path

function lassoPath(cx, cy, rx, ry, seed, overshoot = 0.22) {
  const r = rng(seed);
  const pts = [];
  const n = 64;
  const a0 = -Math.PI * 0.62;
  const ph1 = r() * 6;
  const ph2 = r() * 6;
  for (let i = 0; i <= n * (1 + overshoot); i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    const wob = 1 + 0.035 * Math.sin(a * 3 + ph1) + 0.025 * Math.sin(a * 5 + ph2) + (i / n) * 0.05;
    pts.push([cx + Math.cos(a) * rx * wob, cy + Math.sin(a) * ry * wob]);
  }
  return 'M' + pts.map((p) => p.map((v) => v.toFixed(1)).join(' ')).join(' L');
}

function drawLasso(d, k, width = 6, opacity = 1, transform = '') {
  const p = $('lassoPath');
  if (!d || k <= 0) {
    p.setAttribute('d', '');
    return;
  }
  if (p.getAttribute('d') !== d) {
    p.setAttribute('d', d);
    p.__len = p.getTotalLength();
  }
  css(p, { strokeWidth: width + 'px', strokeDasharray: `${p.__len} ${p.__len}`, strokeDashoffset: `${(1 - k) * p.__len}`, opacity, transform, transformOrigin: '0 0' });
}

// ------------------------------------------------------------------ HUD pieces

function placeChip(t, text, flip = 1) {
  const chip = $('chip');
  chip.textContent = text;
  if (LAYOUT === 'h') css(chip, { left: L.act1.x + 'px', top: '16px' });
  else css(chip, { left: '50%', top: '1820px', marginLeft: '-' + chip.offsetWidth / 2 + 'px' });
  css(chip, { transform: `scaleY(${flip})` });
}

function ring(remaining, total, opacity) {
  const box = $('ringBox');
  if (LAYOUT === 'v') opacity = 0; // the teaser shows only part of the tour
  const size = LAYOUT === 'h' ? 54 : 70;
  css(box, { width: size + 'px', height: size + 'px', opacity, left: (LAYOUT === 'h' ? L.act1.x + L.act1.w - size : W - size - 40) + 'px', top: (LAYOUT === 'h' ? 12 : 60) + 'px' });
  const r = size / 2 - 4;
  const C = 2 * Math.PI * r;
  for (const c of [$('ringBg'), $('ringFg')]) {
    c.setAttribute('cx', size / 2);
    c.setAttribute('cy', size / 2);
    c.setAttribute('r', r);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', 5);
  }
  $('ringBg').setAttribute('stroke', 'rgba(255,255,255,.14)');
  $('ringFg').setAttribute('stroke', '#f0bd4f');
  $('ringFg').setAttribute('stroke-linecap', 'round');
  $('ringFg').setAttribute('stroke-dasharray', `${C * clamp(remaining / total)} ${C}`);
  $('ringNum').textContent = Math.max(0, Math.ceil(remaining));
  css($('ringNum'), { fontSize: (LAYOUT === 'h' ? 19 : 24) + 'px' });
}

function fmtClock(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ captions

function captions(t, hidden) {
  const box = $('captions');
  const cap = $('cap');
  let cur = null;
  for (const c of TL.captions) {
    if (t >= c.start - 0.05 && t < c.end + 0.35) cur = c;
  }
  // don't linger into the next chunk's start
  if (cur) {
    const next = TL.captions.find((c) => c.start > cur.start);
    if (next && t >= next.start - 0.05) cur = next;
  }
  if (!cur || hidden) {
    css(box, { opacity: 0 });
    return;
  }
  const k = prog(t, cur.start - 0.05, cur.start + 0.12);
  const out = prog(t, cur.end + 0.2, cur.end + 0.35);
  css(box, { top: L.capTop + 'px', opacity: k * (1 - out), transform: `translateY(${(1 - easeOut(k)) * 10}px)` });
  css(cap, { font: `600 ${L.capFont}px Inter`, padding: LAYOUT === 'h' ? '13px 26px' : '20px 30px', maxWidth: (LAYOUT === 'h' ? 1500 : 1000) + 'px' });
  cap.querySelector('i').className = cur.who;
  cap.querySelector('span').textContent = cur.text;
}

// ------------------------------------------------------------------ scenes

function resetLayers() {
  for (const id of ['mess', 'counters', 'logo', 'win', 'titles', 'outro', 'endCard', 'stamp', 'panel', 'providers']) show($(id), false);
  show($('segLabel'), false);
  show($('illus'), false);
  drawLasso(null, 0);
  css($('titles'), { opacity: 1, transform: 'none' });
  css($('chip'), { opacity: 0 });
  css($('ringBox'), { opacity: 0 });
  css($('featLabel'), { opacity: 0 });
  css($('stepLabel'), { opacity: 0 });
  css($('mess'), { transform: 'none', filter: 'none', opacity: 1 });
}

function bg(t) {
  const W2 = W / 2;
  css($('blob1'), { width: W * 0.6 + 'px', height: W * 0.6 + 'px', left: W2 - W * 0.55 + Math.sin(t * 0.13) * 120 + 'px', top: H * 0.1 + Math.cos(t * 0.11) * 90 + 'px', background: '#3a47b8' });
  css($('blob2'), { width: W * 0.5 + 'px', height: W * 0.5 + 'px', left: W2 + Math.cos(t * 0.09) * 140 + 'px', top: H * 0.45 + Math.sin(t * 0.12) * 80 + 'px', background: '#5a2d8c', opacity: 0.35 });
  css($('blob3'), { width: W * 0.32 + 'px', height: W * 0.32 + 'px', left: W2 - W * 0.1 + Math.sin(t * 0.07 + 2) * 200 + 'px', top: H * 0.7 + Math.cos(t * 0.1) * 60 + 'px', background: '#b07a1f', opacity: 0.16 });
}

function renderMess(t, lt, s) {
  show($('mess'), true);
  show($('counters'), true);
  let popped = 0;
  for (const m of s.els) {
    const k = prog(lt, m.p, m.p + 0.22);
    if (k > 0) popped++;
    css(m.el, { left: m.x + 'px', top: m.y + 'px', opacity: k > 0 ? 1 : 0, transform: `rotate(${m.rot}deg) scale(${k > 0 ? 0.55 + 0.45 * easeBack(k) : 0.5})` });
  }
  const f = popped / s.els.length;
  $('cTabs').textContent = Math.round(23 * f);
  $('cApps').textContent = Math.min(4, Math.ceil(4 * f * 1.6));
  $('cShots').textContent = Math.round(112 * Math.pow(f, 1.4));
  const push = 1 + 0.05 * ease(prog(lt, 0, s.dur));
  css($('mess'), { transform: `scale(${push})`, transformOrigin: '50% 50%' });
}

function renderZip(t, lt, s) {
  const mess = SCENE.mess;
  renderMess(t, mess.dur, mess);
  const zip = easeIn(prog(lt, 1.0, 1.42));
  const sc = 1.05 * (1 - zip * 0.985);
  const dx = zip * W * 0.55;
  css($('mess'), { transform: `translate(${dx}px, 0) scale(${sc})`, filter: `grayscale(${0.6 * prog(lt, 0, 0.25)}) brightness(${1 - 0.25 * prog(lt, 0, 0.25)})` });
  css($('counters'), { opacity: 1 - prog(lt, 0.9, 1.1) });
  const d = lassoPath(W / 2, H / 2, W * 0.47, H * 0.44, 3, 0.18);
  const lk = easeOut(prog(lt, 0.18, 0.95));
  // the lasso zips away with the mess (scale toward the centre, then off to the right)
  drawLasso(d, lk, LAYOUT === 'h' ? 9 : 10, 1 - prog(lt, 1.3, 1.45), `translate(${W / 2 + dx}px, ${H / 2}px) scale(${sc / 1.05}) translate(${-W / 2}px, ${-H / 2}px)`);
  // the line itself
  show($('titles'), true);
  const tk = prog(lt, 1.32, 1.6);
  $('kicker').textContent = '';
  const title = $('title');
  title.innerHTML = 'Research shouldn’t<br>look like this.';
  css(title, { top: H / 2 - L.titleSize * 1.05 + 'px', fontSize: L.titleSize * 0.85 + 'px', opacity: tk, transform: `translateY(${(1 - easeOut(tk)) * 16}px)` });
}

function placeLogo(cx, cy, size, k, wordK) {
  const mark = $('logoMark');
  const word = $('logoWord');
  const fs = size * 0.86;
  word.style.fontSize = fs + 'px';
  const ww = word.offsetWidth || fs * 2.8;
  const gap = size * 0.22;
  const total = size + gap + ww;
  const x0 = cx - total / 2;
  css(mark, { width: size + 'px', height: size + 'px', left: x0 + 'px', top: cy - size / 2 + 'px', transform: `scale(${lerp(2.3, 1, easeBack(k))}) rotate(${lerp(-10, 0, easeOut(k))}deg)`, opacity: clamp(k * 3) });
  mark.querySelector('span').style.fontSize = size * 0.62 + 'px';
  css(word, { left: x0 + size + gap + 'px', top: cy - fs * 0.62 + 'px', opacity: wordK, transform: `translateX(${(1 - easeOut(wordK)) * -30}px)` });
}

function renderLogo(t, lt, s) {
  show($('logo'), true);
  const k = prog(lt, 0, 0.38);
  const size = LAYOUT === 'h' ? 170 : 150;
  const out = easeIn(prog(lt, s.dur - 0.3, s.dur));
  placeLogo(W / 2, H * 0.42, size, k, prog(lt, 0.22, 0.6));
  css($('logo'), { opacity: 1 - out, transform: `scale(${1 - out * 0.08})` });
  const ring1 = $('ring1');
  const rk = prog(lt, 0, 0.9);
  const rs = size * (1 + rk * 4);
  css(ring1, { width: rs + 'px', height: rs + 'px', left: W / 2 - rs / 2 + 'px', top: H * 0.42 - rs / 2 + 'px', opacity: (1 - rk) * 0.9, borderWidth: 4 * (1 - rk) + 1 + 'px' });
  const tag = $('tagline');
  const words = ['Read.', 'Think.', 'Remember.', 'One place.'];
  if (tag.children.length !== 4) tag.innerHTML = words.map((w, i) => `<span${i === 3 ? ' style="color:#f0bd4f"' : ''}>${w}</span>`).join('');
  css(tag, { top: H * 0.42 + size * 0.95 + 'px', fontSize: (LAYOUT === 'h' ? 36 : 40) + 'px' });
  [...tag.children].forEach((el, i) => {
    const wk = prog(lt, 1.64 + i * TL.beat, 1.64 + i * TL.beat + 0.18);
    css(el, { opacity: wk, transform: `translateY(${(1 - easeOut(wk)) * 14}px)` });
  });
  // flash on the drop
  css($('stage'), { boxShadow: lt < 0.25 ? `inset 0 0 0 ${W}px rgba(255,255,255,${0.35 * (1 - lt / 0.25)})` : 'none' });
  const ck = prog(lt, 3.3, 3.55);
  placeChip(t, '$0 / month');
  css($('chip'), { opacity: ck * (1 - out * 0), transform: `scale(${0.6 + 0.4 * easeBack(ck)})` });
}

function titleCard(lt, scene, g) {
  // big lassoed title over the dimmed window, then the window comes forward
  show($('titles'), true);
  const kick = $('kicker');
  const title = $('title');
  const num = String(scene.n).padStart(2, '0');
  kick.textContent = scene.kind === 'feature' ? `${num} / 08` : '';
  title.textContent = scene.title;
  const inK = prog(lt, 0.02, 0.32);
  const outK = easeIn(prog(lt, 0.98, 1.28));
  const size = L.titleSize;
  const cy = LAYOUT === 'h' ? H * 0.47 : 300;
  css(title, { fontSize: size + 'px', top: cy - size * 0.55 + 'px', opacity: inK * (1 - outK), transform: `translateY(${(1 - easeOut(inK)) * 20 - outK * 40}px) scale(${1 - outK * 0.1})` });
  css(kick, { top: cy - size * 1.5 + 'px', opacity: inK * (1 - outK), transform: `translateY(${-outK * 40}px)` });
  // lasso around the title text
  const tw = Math.min(W * 0.9, measureTitle(scene.title, size));
  const d = lassoPath(W / 2, cy, tw / 2 + size * 0.55, size * 0.95, scene.n * 13 + 1, 0.16);
  drawLasso(d, easeOut(prog(lt, 0.12, 0.78)), LAYOUT === 'h' ? 6 : 6, 1 - outK, `translate(0px, ${-outK * 40}px)`);
  const dim = 1 - ease(prog(lt, 0.98, 1.3));
  return { scale: 1 - 0.06 * dim, blur: 7 * dim, dim: 0.62 * dim };
}

const titleWidths = {};
function measureTitle(text, size) {
  const key = text + size;
  if (!titleWidths[key]) {
    const c = document.createElement('canvas').getContext('2d');
    c.font = `600 ${size}px Fraunces`;
    titleWidths[key] = c.measureText(text).width;
  }
  return titleWidths[key];
}

function renderFeature(t, lt, s) {
  const g = L.act1;
  show($('win'), true);
  const fx = titleCard(lt, s, g);
  const sc = placeWindow(g, fx);
  const content = lt < s.plan.start ? planContent(s, s.plan.start) : planContent(s, lt);
  windowContent(sc, content);
  segLabel(content, lt, s);
  // HUD
  placeChip(t, '$0 / month');
  css($('chip'), { opacity: 1 });
  const a1 = TL.acts.features;
  ring(a1.end - t, a1.end - a1.start, 1);
  $('ringCap').textContent = LAYOUT === 'h' ? '8 ideas · under 90 s' : '';
  const fl = $('featLabel');
  fl.innerHTML = `<b>${String(s.n).padStart(2, '0')}</b>${esc(s.title)}`;
  if (LAYOUT === 'h') css(fl, { left: '50%', top: '24px', transform: 'translateX(-50%)', opacity: prog(lt, 1.15, 1.45) });
  else css(fl, { left: '50%', top: '440px', transform: 'translateX(-50%)', fontSize: '36px', opacity: prog(lt, 1.15, 1.45) });
  if (s.plan.providers) providers(lt, s);
}

function segLabel(content, lt, s) {
  const el = $('segLabel');
  const on = !!content.label && lt >= s.plan.start;
  show(el, on);
  if (on) {
    el.querySelector('span').textContent = content.label;
    const k = prog(lt - content.seg.start, s.plan.start * 0 + 0.0, 0.25);
    // sits in the window's title bar, right-aligned
    const bar = parseFloat($('winbar').style.height) || 30;
    css(el, { right: bar * 0.3 + 'px', left: 'auto', top: bar * 0.1 + 'px', height: bar * 0.8 + 'px', padding: `0 ${bar * 0.45}px`, fontSize: bar * 0.46 + 'px', opacity: k, transform: `translateY(${(1 - easeOut(k)) * -6}px)` });
  }
  const il = $('illus');
  show(il, !!content.illus);
  if (content.illus) {
    il.textContent = content.illus;
    css(il, { right: '16px', bottom: '14px' });
  }
}

function providers(lt, s) {
  const el = $('providers');
  const startAt = s.dur - 3.0;
  const on = lt > startAt;
  show(el, on);
  if (!on) return;
  const list = [['Gemini free tier', true], ['Claude', false], ['OpenAI-compatible · Ollama', false], ['In-browser model', false], ['No key: copy & paste', true]];
  if (el.children.length !== list.length) el.innerHTML = list.map(([n, f]) => `<span class="${f ? 'free' : ''}">${n}</span>`).join('');
  const g = L.act1;
  css(el, { left: g.x + 40 + 'px', width: g.w - 80 + 'px', top: g.y + winH(g) - (LAYOUT === 'h' ? 150 : 170) + 'px' });
  [...el.children].forEach((c, i) => {
    const k = prog(lt, startAt + i * TL.beat * 0.5, startAt + i * TL.beat * 0.5 + 0.2);
    css(c, { opacity: k, transform: `translateY(${(1 - easeBack(k)) * 24}px) scale(${0.8 + 0.2 * k})` });
  });
}

function renderBridge(t, lt, s) {
  const prev = TL.scenes[TL.scenes.indexOf(s) - 1];
  // window flies off with the last feature's final frame
  const out = easeIn(prog(lt, 0, 0.5));
  if (out < 1) {
    show($('win'), true);
    const sc = placeWindow(L.act1, { opacity: 1 - out, scale: 1 - out * 0.15, dy: out * 160 });
    windowContent(sc, planContent(prev, prev.dur));
  }
  // ring hits zero, pulses and fades
  ring(0, 1, 1 - prog(lt, 0.8, 1.1));
  css($('ringBox'), { transform: `scale(${1 + 0.25 * Math.sin(prog(lt, 0, 0.6) * Math.PI)})` });
  // chip flips to "Free & open source"
  const f1 = prog(lt, 1.45, 1.6);
  const f2 = prog(lt, 1.6, 1.78);
  const flip = lt < 1.6 ? 1 - f1 : f2;
  placeChip(t, lt < 1.6 ? '$0 / month' : 'Free & open source', Math.max(0.02, flip));
  css($('chip'), { opacity: 1 });
  show($('titles'), true);
  $('kicker').textContent = '';
  const title = $('title');
  const v2 = s.vo[1].at;
  const second = lt >= v2 - 0.1;
  title.textContent = second ? 'Now, set it up.' : 'That’s Axiom.';
  const k = second ? prog(lt, v2 - 0.1, v2 + 0.2) : prog(lt, 0.3, 0.6);
  const o = second ? prog(lt, s.dur - 1.2, s.dur - 0.7) : prog(lt, v2 - 0.4, v2 - 0.1);
  css(title, { fontSize: L.titleSize + 'px', top: H * 0.44 - L.titleSize * 0.55 + 'px', opacity: k * (1 - o), transform: `translateY(${(1 - easeOut(k)) * 18}px)` });
  // the setup layout slides in during the last second
  const lay = ease(prog(lt, s.dur - 1.1, s.dur));
  if (lay > 0) setupHud(t, null, lay);
}

function setupHud(t, step, k = 1) {
  if (L.panel) {
    show($('panel'), true);
    css($('panel'), { opacity: k, transform: `translateX(${(1 - k) * 120}px)` });
  } else {
    show($('panel'), false);
  }
  const steps = TL.scenes.filter((x) => x.kind === 'step');
  const done = TL.scenes.find((x) => x.kind === 'done');
  let clock = 0;
  let ff = 0;
  if (step) {
    const lt = t - step.start;
    if (step.kind === 'done') clock = step.clock;
    else {
      clock = lerp(step.clockFrom, step.clock, prog(lt, 0.15, step.dur - 0.2));
      ff = (step.clock - step.clockFrom) / Math.max(0.1, step.dur - 0.35);
    }
  }
  $('watchT').textContent = fmtClock(clock);
  show($('watchFF'), false);
  void ff;
  for (const el of $('steps').children) {
    const sc = steps.find((x) => x.id === el.dataset.id);
    const isDone = t >= sc.start + sc.tickAt || t >= done.start;
    const active = step && step.id === sc.id && !isDone;
    el.classList.toggle('done', isDone);
    el.classList.toggle('active', !!active);
    el.querySelector('.box').textContent = isDone ? '✓' : sc.n;
  }
  if (LAYOUT === 'v') {
    // compact stopwatch for the vertical layout
    css($('panel'), {});
  }
}

function renderStep(t, lt, s) {
  const g = L.act2;
  show($('win'), true);
  const intro = easeOut(prog(lt, 0, 0.3));
  const first = s.n === 1;
  const sc = placeWindow(g, first ? { opacity: intro, dx: (1 - intro) * -80 } : {});
  const content = planContent(s, Math.max(lt, s.plan.start));
  windowContent(sc, content);
  segLabel(content, lt, s);
  setupHud(t, s);
  placeChip(t, 'Free & open source');
  css($('chip'), { opacity: 1, left: L.panel ? L.panel.x + 'px' : $('chip').style.left, top: '40px' });
  const sl = $('stepLabel');
  sl.innerHTML = `Step ${s.n}<span>${esc(s.title)}</span>`;
  const k = prog(lt, 0.05, 0.3);
  css(sl, { left: g.x + 'px', top: '52px', opacity: k, transform: `translateY(${(1 - easeOut(k)) * 10}px)` });
}

function renderDone(t, lt, s) {
  const prev = TL.scenes[TL.scenes.indexOf(s) - 1];
  const g = L.act2;
  show($('win'), true);
  const sc = placeWindow(g, { dim: 0.45 * prog(lt, 0, 0.3), blur: 3 * prog(lt, 0, 0.3) });
  windowContent(sc, planContent(prev, prev.dur));
  setupHud(t, s);
  placeChip(t, 'Free & open source');
  css($('chip'), { opacity: 1, left: L.panel ? L.panel.x + 'px' : $('chip').style.left, top: '40px' });
  const st = $('stamp');
  show(st, true);
  const k = prog(lt, 0.22, 0.42);
  const shake = lt > 0.42 && lt < 0.7 ? Math.sin(lt * 90) * 6 * (1 - prog(lt, 0.42, 0.7)) : 0;
  const cx = LAYOUT === 'h' ? g.x + g.w / 2 : W / 2;
  const cy = LAYOUT === 'h' ? g.y + winH(g) / 2 : g.y + winH(g) / 2;
  css(st, { left: cx + 'px', top: cy + 'px', opacity: k > 0 ? 1 : 0, transform: `translate(-50%, -50%) translate(${shake}px, 0) rotate(${lerp(-18, -6, easeOut(k))}deg) scale(${lerp(2.6, 1, easeOut(k))})` });
  const out = prog(lt, s.dur - 0.35, s.dur);
  css($('win'), { opacity: 1 - out });
  css($('panel'), { opacity: 1 - out });
  css(st, { opacity: (k > 0 ? 1 : 0) * (1 - out) });
}

function renderOutro(t, lt, s, { teaser = false } = {}) {
  const hit = teaser ? 2 * TL.bar : 3 * TL.bar;
  const gridOut = ease(prog(lt, hit - 4.4, hit - 3.9));
  if (!teaser) {
    show($('outro'), true);
    SCENE.tiles.forEach((tile, i) => {
      const k = prog(lt, 0.1 + i * TL.beat * 0.5, 0.1 + i * TL.beat * 0.5 + 0.35);
      const drift = 1 + 0.03 * prog(lt, 0, hit);
      css(tile.el, { opacity: k * (1 - gridOut * 0.82), transform: `perspective(1200px) rotateY(${(1 - easeOut(k)) * 85}deg) scale(${drift * (1 - gridOut * 0.08)})`, filter: `blur(${gridOut * 6}px)` });
    });
  }
  // logo, words, then the URL + QR on the final hit
  show($('logo'), true);
  const lk = teaser ? prog(lt, 0.0, 0.38) : prog(lt, hit - 4.1, hit - 3.7);
  const size = LAYOUT === 'h' ? 130 : 140;
  const cy = LAYOUT === 'h' ? H * 0.33 : H * 0.3;
  placeLogo(W / 2, cy, size, lk, lk);
  css($('logo'), { opacity: 1, transform: 'none' });
  css($('ring1'), { opacity: 0 });
  const tag = $('tagline');
  const words = ['Free.', 'Open source.', 'Yours.'];
  if (tag.children.length !== 3) tag.innerHTML = words.map((w, i) => `<span${i === 2 ? ' style="color:#f0bd4f"' : ''}>${w}</span>`).join('');
  const out2 = TL.voice.find((v) => v.id === 'out2');
  const wStart = out2 ? out2.start - s.start : hit - 2.5;
  css(tag, { top: cy + size * 0.85 + 'px', fontSize: (LAYOUT === 'h' ? 46 : 52) + 'px', fontFamily: 'Fraunces', fontWeight: 600, color: '#f5f6fb' });
  [...tag.children].forEach((el, i) => {
    const k = prog(lt, wStart + i * 0.42, wStart + i * 0.42 + 0.2);
    css(el, { opacity: k, transform: `translateY(${(1 - easeOut(k)) * 14}px)` });
  });
  const ek = prog(lt, hit, hit + 0.3);
  show($('endCard'), ek > 0);
  const qs = LAYOUT === 'h' ? 220 : 300;
  css($('qr'), { width: qs + 'px', height: qs + 'px', left: W / 2 - qs / 2 + 'px', top: (LAYOUT === 'h' ? H * 0.6 : H * 0.55) + 'px', opacity: ek, transform: `scale(${0.7 + 0.3 * easeBack(ek)})` });
  css($('endUrl'), { top: (LAYOUT === 'h' ? H * 0.6 + qs + 26 : H * 0.55 + qs + 34) + 'px', opacity: ek, fontSize: (LAYOUT === 'h' ? 30 : 36) + 'px' });
  if (teaser) {
    $('endUrl').innerHTML = 'github.com/preetsingh-007/axiom<br><span style="font:600 30px Inter;color:#a9b0cf">Set it up in 3 minutes — full guide in the video</span>';
  }
  css($('stage'), { boxShadow: lt >= hit && lt < hit + 0.25 ? `inset 0 0 0 ${W}px rgba(255,255,255,${0.35 * (1 - (lt - hit) / 0.25)})` : 'none' });
  placeChip(t, 'Free & open source');
  css($('chip'), { opacity: 0 });
}

// ------------------------------------------------------------------ main

function sceneAt(t) {
  let cur = TL.scenes[0];
  for (const s of TL.scenes) if (t >= s.start) cur = s;
  return cur;
}

window.seek = async (t) => {
  pendingDecodes.length = 0;
  resetLayers();
  css($('stage'), { boxShadow: 'none' });
  bg(t);
  const s = sceneAt(t);
  const lt = t - s.start;
  let hideCaps = false;
  switch (s.kind) {
    case 'mess':
      renderMess(t, lt, s);
      break;
    case 'zip':
      renderZip(t, lt, s);
      hideCaps = true;
      break;
    case 'logo':
      renderLogo(t, lt, s);
      hideCaps = true;
      break;
    case 'feature':
      renderFeature(t, lt, s);
      break;
    case 'bridge':
      renderBridge(t, lt, s);
      hideCaps = true;
      break;
    case 'step':
      renderStep(t, lt, s);
      break;
    case 'done':
      renderDone(t, lt, s);
      break;
    case 'outro':
      renderOutro(t, lt, s);
      hideCaps = lt > 2.0;
      break;
    case 'teaser-end':
      renderOutro(t, lt, s, { teaser: true });
      hideCaps = true;
      break;
  }
  captions(t, hideCaps);
  await Promise.all(pendingDecodes);
};

window.ready = (async () => {
  const stage = $('stage');
  css(stage, { width: W + 'px', height: H + 'px' });
  TL = await getJSON('/build/' + (P.get('timeline') ?? 'timeline.json'));
  const names = new Set(['s1-open']);
  for (const p of Object.values(PLANS)) for (const s of p.segs) if (s.clip) names.add(s.clip);
  for (const n of ['f1-lasso', 'f2-whiteboard', 'f3-writing', 'f4-flashcards', 'f5-navigate', 'f6-sync', 's5-git', 'f8-ink']) names.add(n);
  await Promise.all([...names].map(async (n) => (CLIPS[n] = await getJSON(`/build/clips/${n}/index.json`))));
  REPO = await getJSON('/build/clips/s5-git/repo.json').catch(() => null);
  for (const s of TL.scenes) {
    SCENE[s.id] = s;
    s.plan = buildPlan(s);
  }
  buildGrain();
  if (SCENE.mess) buildMess();
  buildPanel();
  buildOutro();
  await buildQR();
  await document.fonts.load('600 100px Fraunces');
  await document.fonts.load('600 30px Inter');
  await document.fonts.load('400 30px Mono');
  await document.fonts.ready;
  return { duration: TL.duration, width: W, height: H, plans: TL.scenes.filter((s) => s.plan).map((s) => `${s.id}: ${s.plan.speed.toFixed(2)}×`) };
})();
