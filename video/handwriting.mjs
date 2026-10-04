// A tiny single-stroke "handwriting" font, used to scribble on the whiteboard during the
// recording so the AI has real ink to read. Glyphs live in an em box: x from 0, y from 0
// (ascender) to 1 (baseline); x-height is at y = 0.5 and descenders reach y ≈ 1.35.
// `^` raises the next glyph as a superscript. Points get a little deterministic jitter.

const arc = (cx, cy, rx, ry, a0, a1, n = 18) => Array.from({ length: n + 1 }, (_, i) => {
  const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
  return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
});
const line = (x0, y0, x1, y1, n = 6) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

const G = {
  B: { w: 0.62, s: [line(0.04, 0.02, 0.04, 1), [...line(0.04, 0.02, 0.24, 0.02, 2), ...arc(0.24, 0.255, 0.22, 0.235, -90, 90), ...line(0.24, 0.49, 0.06, 0.49, 2)], [...line(0.06, 0.49, 0.28, 0.49, 2), ...arc(0.28, 0.745, 0.26, 0.255, -90, 90), ...line(0.28, 1, 0.04, 1, 2)]] },
  e: { w: 0.5, s: [[...line(0.03, 0.76, 0.46, 0.76, 4), ...arc(0.245, 0.755, 0.215, 0.245, 0, -315, 24)]] },
  l: { w: 0.22, s: [[...line(0.06, 0.02, 0.07, 0.9, 8), ...arc(0.14, 0.9, 0.07, 0.1, 180, 110, 5)]] },
  m: { w: 0.58, s: [[...line(0.03, 0.5, 0.03, 1, 4), ...arc(0.155, 0.64, 0.125, 0.13, 180, 360, 10), ...line(0.28, 0.64, 0.28, 1, 4), ...arc(0.405, 0.64, 0.125, 0.13, 180, 360, 10), ...line(0.53, 0.64, 0.53, 1, 4)]] },
  a: { w: 0.52, s: [[...arc(0.235, 0.75, 0.2, 0.245, -20, -380, 26), ...line(0.43, 0.52, 0.44, 1, 4)]] },
  n: { w: 0.52, s: [[...line(0.03, 0.5, 0.03, 1, 4), ...arc(0.19, 0.66, 0.16, 0.15, 180, 360, 10), ...line(0.35, 0.66, 0.35, 1, 4)]] },
  b: { w: 0.5, s: [line(0.05, 0.02, 0.05, 1, 8), arc(0.25, 0.755, 0.2, 0.235, 180, -180, 24)] },
  c: { w: 0.46, s: [arc(0.24, 0.755, 0.2, 0.235, -40, -320, 20)] },
  x: { w: 0.5, s: [line(0.02, 0.5, 0.42, 1), line(0.42, 0.5, 0.02, 1)] },
  y: { w: 0.5, s: [line(0.02, 0.5, 0.22, 0.98), [...line(0.44, 0.5, 0.18, 1.18, 8), ...arc(0.11, 1.18, 0.07, 0.14, 0, 150, 5)]] },
  2: { w: 0.5, s: [[...arc(0.22, 0.27, 0.19, 0.22, 200, 375, 12), ...line(0.405, 0.33, 0.03, 0.99, 8), ...line(0.03, 0.99, 0.44, 0.99, 4)]] },
  1: { w: 0.32, s: [[...line(0.02, 0.18, 0.18, 0.0, 3), ...line(0.18, 0.0, 0.18, 1, 8)]] },
  '+': { w: 0.6, s: [line(0.28, 0.48, 0.28, 0.94), line(0.06, 0.71, 0.5, 0.71)] },
  '=': { w: 0.62, s: [line(0.06, 0.6, 0.52, 0.6), line(0.06, 0.82, 0.52, 0.82)] },
  ' ': { w: 0.4, s: [] },
};

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

/** Strokes (arrays of [x, y] page points) for `text` with its top-left at (x, y). */
export function strokesFor(text, x, y, size) {
  const out = [];
  let pen = x;
  let sup = false;
  for (const ch of text) {
    if (ch === '^') {
      sup = true;
      continue;
    }
    const g = G[ch];
    if (!g) throw new Error(`no glyph for "${ch}"`);
    const s = sup ? size * 0.5 : size;
    const oy = sup ? y + size * 0.12 : y;
    const slant = 0.12;
    for (const stroke of g.s) {
      out.push(stroke.map(([gx, gy]) => [pen + (gx + (1 - gy) * slant) * s + rnd() * size * 0.012, oy + gy * s + rnd() * size * 0.012]));
    }
    pen += (g.w + 0.08) * s;
    sup = false;
  }
  return out;
}
