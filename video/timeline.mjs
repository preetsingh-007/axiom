// Single source of truth for the demo video's timing.
//
//   node video/timeline.mjs            → writes video/build/timeline.json
//
// Every scene lasts a whole number of bars at 110 BPM, so cuts land on the downbeat; the music
// generator, the voice mixer, the caption/SRT writer and the frame compositor all read this file.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const BPM = 110;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;

const vo = JSON.parse(readFileSync(join(here, 'build', 'vo', 'manifest.json'), 'utf8'));
const dur = (id) => vo[id].dur;
const barsFor = (seconds, min = 1) => Math.max(min, Math.ceil(seconds / BAR - 0.02));

/** Feature scenes: lassoed title card, then real footage with narration. */
const FEATURES = [
  { id: 'f1', n: 1, title: 'Read left. Think right.', clip: 'f1-lasso', minBars: 6 },
  { id: 'f2', n: 2, title: 'Make room to think.', clip: 'f2-whiteboard' },
  { id: 'f3', n: 3, title: 'Write like a scientist.', clip: 'f3-writing' },
  { id: 'f4', n: 4, title: 'Never forget it.', clip: 'f4-flashcards' },
  { id: 'f5', n: 5, title: 'Find the thread.', clip: 'f5-navigate' },
  { id: 'f6', n: 6, title: 'Every device, live.', clip: 'f6-sync' },
  { id: 'f7', n: 7, title: 'Your notes, in your Git.', clip: 'f7-git' },
  { id: 'f8', n: 8, title: 'AI that costs $0.', clip: 'f8-ai', minBars: 7 },
];

/** Setup steps: stopwatch + checklist; `clock` is the simulated real-world seconds at step end. */
const STEPS = [
  { id: 's1', n: 1, title: 'Get it', clip: 'terminal', minBars: 4, clock: 74 },
  { id: 's2', n: 2, title: 'Install as an app', clip: 'install', minBars: 3, clock: 82 },
  { id: 's3', n: 3, title: 'Import a paper', clip: 's3-import', minBars: 3, clock: 95 },
  { id: 's4', n: 4, title: 'Link devices', clip: 's4-link', minBars: 4, clock: 121 },
  { id: 's5', n: 5, title: 'Connect Git', clip: 's5-git', minBars: 5, clock: 149 },
  { id: 's6', n: 6, title: 'Connect AI', clip: 's6-ai', minBars: 5, clock: 166 },
];

const TITLE_LEAD = 1.35; // seconds of title card before narration starts

export function build() {
  const scenes = [];
  let t = 0;
  const push = (s) => {
    s.start = +t.toFixed(4);
    s.dur = +(s.bars * BAR).toFixed(4);
    t += s.bars * BAR;
    scenes.push(s);
    return s;
  };

  // ACT 0 — cold open: windows pop in faster and faster (each pop is also a sound cue)
  const mess = push({ id: 'mess', act: 0, kind: 'mess', bars: barsFor(0.35 + dur('cold1') + 0.25, 3), vo: [{ id: 'cold1', at: 0.35 }] });
  mess.pops = [];
  for (let i = 0, gap = 0.62, at = 0.15; at < mess.dur - 0.35; i++, at += gap, gap = Math.max(0.07, gap * 0.86)) mess.pops.push(+at.toFixed(3));
  push({ id: 'zip', act: 0, kind: 'zip', bars: 1, vo: [{ id: 'cold2', at: 0.45 }] });
  push({ id: 'logo', act: 0, kind: 'logo', bars: 2, vo: [{ id: 'cold3', at: 0.55 }] });

  // ACT 1 — features
  for (const f of FEATURES) {
    push({ ...f, act: 1, kind: 'feature', bars: barsFor(TITLE_LEAD + dur(f.id) + 0.7, f.minBars ?? 3), vo: [{ id: f.id, at: TITLE_LEAD }] });
  }

  // Bridge
  push({ id: 'bridge', act: 1.5, kind: 'bridge', bars: 3, vo: [{ id: 'bridge1', at: 0.4 }, { id: 'bridge2', at: 0.4 + dur('bridge1') + 1.2 }] });

  // ACT 2 — setup
  let prevClock = 0;
  for (const s of STEPS) {
    const step = push({ ...s, act: 2, kind: 'step', clockFrom: prevClock, bars: barsFor(1.0 + dur(s.id) + 0.8, s.minBars ?? 3), vo: [{ id: s.id, at: 1.0 }] });
    step.tickAt = +(step.dur - BEAT).toFixed(4); // checklist ticks (with a chime) one beat before the cut
    prevClock = s.clock;
  }
  push({ id: 'done', act: 2, kind: 'done', clockFrom: prevClock, clock: prevClock, bars: 2, vo: [{ id: 'done', at: 0.5 }] });

  // OUTRO
  push({ id: 'outro', act: 3, kind: 'outro', bars: 4, vo: [{ id: 'out1', at: 2.6 }, { id: 'out2', at: 2.6 + dur('out1') + 0.35 }] });
  const end = t + 1.6; // let the last hit ring out

  // absolute voice placements + caption chunks
  const voice = [];
  for (const s of scenes) for (const v of s.vo) voice.push({ id: v.id, who: vo[v.id].who, text: vo[v.id].text, start: +(s.start + v.at).toFixed(3), dur: dur(v.id), scene: s.id });

  const act1 = scenes.filter((s) => s.act === 1);
  const act2 = scenes.filter((s) => s.act === 2);
  return {
    bpm: BPM,
    beat: BEAT,
    bar: BAR,
    duration: +end.toFixed(3),
    acts: {
      features: { start: act1[0].start, end: act1.at(-1).start + act1.at(-1).dur },
      setup: { start: act2[0].start, end: act2.at(-1).start + act2.at(-1).dur },
    },
    scenes,
    voice,
    captions: voice.flatMap(captionChunks),
  };
}

/** Splits a line into short caption chunks, timed in proportion to their length. */
function captionChunks(v) {
  const parts = v.text.match(/[^.,:;?!]+[.,:;?!]*/g).map((p) => p.trim()).filter(Boolean);
  // merge tiny fragments and split long ones so chunks are ~2–7 words
  const chunks = [];
  for (const p of parts) {
    const words = p.split(/\s+/);
    if (words.length > 8) {
      const half = Math.ceil(words.length / 2);
      chunks.push(words.slice(0, half).join(' '), words.slice(half).join(' '));
    } else if (chunks.length && words.length <= 2 && chunks.at(-1).split(/\s+/).length <= 4 && !/[.?!]$/.test(chunks.at(-1))) {
      chunks[chunks.length - 1] += ' ' + p;
    } else chunks.push(p);
  }
  const weight = (c) => c.length + 6;
  const total = chunks.reduce((a, c) => a + weight(c), 0);
  // boundaries in proportion to length, then snapped to the nearest real pause in the audio
  const pauses = [...(vo[v.id].pauses ?? [])];
  const bounds = [0];
  let acc = 0;
  for (const c of chunks.slice(0, -1)) {
    acc += (weight(c) / total) * v.dur;
    let best = acc;
    let bestD = 0.7;
    for (const p of pauses) if (Math.abs(p - acc) < bestD && p > bounds.at(-1) + 0.3) (best = p), (bestD = Math.abs(p - acc));
    if (best !== acc) pauses.splice(pauses.indexOf(best), 1);
    bounds.push(best);
  }
  bounds.push(v.dur);
  return chunks.map((c, i) => ({ who: v.who, text: c, start: +(v.start + bounds[i]).toFixed(3), end: +(v.start + bounds[i + 1]).toFixed(3), line: v.id }));
}

/** The ~60 s vertical teaser: the cold open and three features, then an end card. */
export function buildTeaser() {
  const full = build();
  const pick = ['mess', 'zip', 'logo', 'f1', 'f6', 'f8'].map((id) => structuredClone(full.scenes.find((s) => s.id === id)));
  let t = 0;
  for (const s of pick) {
    s.start = +t.toFixed(4);
    t += s.dur;
  }
  const end = { id: 'end', act: 3, kind: 'teaser-end', bars: 3, start: +t.toFixed(4), dur: +(3 * BAR).toFixed(4), vo: [{ id: 'out2', at: 0.6 }] };
  pick.push(end);
  t += end.dur;
  const voice = [];
  for (const s of pick) for (const v of s.vo) voice.push({ id: v.id, who: vo[v.id].who, text: vo[v.id].text, start: +(s.start + v.at).toFixed(3), dur: dur(v.id), scene: s.id });
  const feats = pick.filter((s) => s.kind === 'feature');
  return {
    ...full,
    duration: +(t + 1.6).toFixed(3),
    acts: { features: { start: feats[0].start, end: feats.at(-1).start + feats.at(-1).dur }, setup: { start: t, end: t } },
    scenes: pick,
    voice,
    captions: voice.flatMap(captionChunks),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tl = build();
  mkdirSync(join(here, 'build'), { recursive: true });
  writeFileSync(join(here, 'build', 'timeline.json'), JSON.stringify(tl, null, 1));
  const teaser = buildTeaser();
  writeFileSync(join(here, 'build', 'teaser.json'), JSON.stringify(teaser, null, 1));
  console.log(`teaser ${teaser.duration.toFixed(1)} s`);
  for (const s of tl.scenes) console.log(`${s.id.padEnd(7)} ${String(s.bars).padStart(2)} bars  ${s.start.toFixed(2).padStart(7)}s  +${s.dur.toFixed(2)}s`);
  console.log(`total ${tl.duration.toFixed(1)} s`);
}
