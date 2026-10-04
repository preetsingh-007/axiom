"""Original soundtrack + sound design + voice mix for the demo video, synthesised from scratch
(no samples, no licensing).  Reads build/timeline.json and build/vo/*.wav.

    python3 video/audio.py                 → build/audio/mix.wav (+ music.wav, voice.wav)
    python3 video/audio.py --teaser        → build/audio/teaser-mix.wav (uses build/teaser.json)

A minor, 110 BPM, i–VI–III–VII (Am F C G).  Sections follow the scenes: a ticking cold open,
silence on the freeze, the drop on the logo, a driving groove with a riser into every feature
title, a filtered breakdown for the bridge, a lighter marimba groove under the setup guide with
a chime per checklist step, and a final hit.  Music ducks ~9 dB under the narration.
"""
import json, os, sys
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve, resample_poly

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 44100
rng = np.random.default_rng(7)

teaser = "--teaser" in sys.argv
TL = json.load(open(os.path.join(HERE, "build", "teaser.json" if teaser else "timeline.json")))
BEAT, BAR, TOTAL = TL["beat"], TL["bar"], TL["duration"]
N = int(TOTAL * SR) + SR
music = np.zeros((N, 2))
sfx = np.zeros((N, 2))
send = np.zeros((N, 2))  # reverb send


# ------------------------------------------------------------------ helpers
def t_(n): return np.arange(n) / SR
def env_exp(n, decay): return np.exp(-t_(n) / decay)
def lp(x, f, order=2): return sosfilt(butter(order, min(f, SR / 2 - 100) / (SR / 2), "low", output="sos"), x)
def hp(x, f, order=2): return sosfilt(butter(order, f / (SR / 2), "high", output="sos"), x)
def bp(x, lo, hi, order=2): return sosfilt(butter(order, [lo / (SR / 2), hi / (SR / 2)], "band", output="sos"), x)
def midi(m): return 440 * 2 ** ((m - 69) / 12)

def add(buf, at, sig, gain=1.0, pan=0.0, rev=0.0):
    i = int(at * SR)
    if i >= len(buf) or i + len(sig) <= 0: return
    if i < 0: sig, i = sig[-i:], 0
    sig = sig[: len(buf) - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[i:i + len(sig), 0] += sig * gain * l * 1.414
    buf[i:i + len(sig), 1] += sig * gain * r * 1.414
    if rev:
        send[i:i + len(sig), 0] += sig * gain * rev
        send[i:i + len(sig), 1] += sig * gain * rev

def saw(f, n, detune=0.0):
    ph = np.cumsum(np.full(n, f * (1 + detune) / SR)) + rng.random()
    return 2 * (ph % 1) - 1

# ------------------------------------------------------------------ instruments
def kick(soft=False):
    n = int(0.42 * SR); t = t_(n)
    f = 46 + 95 * np.exp(-t / 0.045)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(n, 0.16 if not soft else 0.11)
    s[: int(0.004 * SR)] += hp(rng.standard_normal(int(0.004 * SR)), 2000) * 0.5
    return np.tanh(s * 1.6) * (0.9 if not soft else 0.65)

def clap():
    n = int(0.25 * SR)
    noise = bp(rng.standard_normal(n), 900, 5200)
    e = env_exp(n, 0.07)
    for k in (0.0, 0.011, 0.022):  # three quick hits = clap
        i = int(k * SR); e[i:i + 60] += 0.6
    return noise * e * 0.55 + np.sin(2 * np.pi * 185 * t_(n)) * env_exp(n, 0.04) * 0.25

def rim():
    n = int(0.08 * SR)
    return bp(rng.standard_normal(n), 1500, 6000) * env_exp(n, 0.012) * 0.6 + np.sin(2 * np.pi * 820 * t_(n)) * env_exp(n, 0.015) * 0.4

def hat(open_=False):
    n = int((0.22 if open_ else 0.045) * SR)
    return hp(rng.standard_normal(n), 7000) * env_exp(n, 0.07 if open_ else 0.012) * 0.35

def tick():
    n = int(0.03 * SR)
    return bp(rng.standard_normal(n), 3000, 9000) * env_exp(n, 0.004) * 0.9 + np.sin(2 * np.pi * 2400 * t_(n)) * env_exp(n, 0.006) * 0.3

def bass(f, length):
    n = int(length * SR)
    s = (saw(f, n) + saw(f, n, 0.004)) * 0.5 + np.sin(2 * np.pi * f * t_(n)) * 0.6
    a = np.minimum(1, t_(n) / 0.006) * np.exp(-t_(n) / (length * 0.9))
    return lp(s, 900) * a * 0.55

def pad(freqs, length, cutoff=1800):
    n = int(length * SR)
    s = sum(saw(f, n, d) for f in freqs for d in (-0.006, 0.0, 0.006)) / (3 * len(freqs))
    a = np.minimum(1, t_(n) / 0.25) * np.minimum(1, (length - t_(n)) / 0.3)
    return lp(s, cutoff) * a

def pluck(f, length=0.22):
    n = int(length * SR)
    s = np.sign(np.sin(2 * np.pi * f * t_(n))) * 0.5 + saw(f, n) * 0.5
    return lp(s, 2600) * env_exp(n, 0.09) * 0.32

def marimba(f, length=0.5):
    n = int(length * SR); t = t_(n)
    return (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 3.93 * t) * env_exp(n, 0.03)) * env_exp(n, 0.18) * 0.38

def bell(f, length=1.6):
    n = int(length * SR); t = t_(n)
    parts = [(1, 1, 0.9), (2.0, 0.5, 0.5), (3.01, 0.3, 0.3), (4.2, 0.18, 0.18)]
    return sum(a * np.sin(2 * np.pi * f * r * t) * env_exp(n, d) for r, a, d in parts) * 0.3

def riser(length):
    n = int(length * SR); t = t_(n); x = t / length
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    seg = n // 16
    for k in range(16):  # stepped band sweep up
        lo = 300 * 2 ** (k * 0.33); hi = min(lo * 3, 18000)
        sl = slice(k * seg, (k + 1) * seg if k < 15 else n)
        out[sl] = bp(noise[sl], lo, hi)
    tone = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (2 * x)) / SR) * 0.15
    return (out * 0.5 + tone) * x ** 2.2

def impact():
    n = int(1.8 * SR); t = t_(n)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.08)) / SR) * env_exp(n, 0.5)
    crash = hp(rng.standard_normal(n), 3500) * env_exp(n, 0.35) * 0.35
    return np.tanh(boom * 1.3) * 0.8 + crash

def whoosh(length=0.7):
    n = int(length * SR); x = t_(n) / length
    noise = rng.standard_normal(n); out = np.zeros(n); seg = n // 12
    for k in range(12):
        c = 400 * 2 ** (k * 0.45); sl = slice(k * seg, (k + 1) * seg if k < 11 else n)
        out[sl] = bp(noise[sl], c, min(c * 2.5, 18000))
    return out * np.sin(np.pi * x) ** 1.5 * 0.7

def pop(f):
    n = int(0.09 * SR); t = t_(n)
    return np.sin(2 * np.pi * (f + 600 * np.exp(-t / 0.01)) * t) * env_exp(n, 0.025) * 0.35

def thud():
    n = int(0.9 * SR); t = t_(n)
    return np.tanh(np.sin(2 * np.pi * np.cumsum(55 + 80 * np.exp(-t / 0.03)) / SR) * env_exp(n, 0.22) * 2) * 0.8 + bp(rng.standard_normal(n), 200, 2000) * env_exp(n, 0.05) * 0.4

def reverse_swell(length):
    s = impact()[: int(length * SR)][::-1]
    return s * np.linspace(0, 1, len(s)) ** 2 * 0.6

# ------------------------------------------------------------------ harmony
PROG = [  # (bass midi, chord midis)
    (45, [57, 60, 64]),  # Am
    (41, [57, 60, 65]),  # F
    (48, [55, 60, 64]),  # C
    (43, [55, 59, 62]),  # G
]

def groove(start, end, style, bar_index0=0):
    """style: 'drive' (Act 1 / outro), 'light' (setup), 'break' (pad only)."""
    nb = int(round((end - start) / BAR))
    for b in range(nb):
        t0 = start + b * BAR
        root, chord = PROG[(bar_index0 + b) % 4]
        cutoff = 1800 if style != "break" else 500 + 2500 * (b / max(1, nb - 1)) ** 2
        add(music, t0, pad([midi(m) for m in chord], BAR + 0.25, cutoff), 0.22 if style == "drive" else 0.2, 0, 0.25)
        if style == "break":
            continue
        for q in range(4):
            tb = t0 + q * BEAT
            if style == "drive" or q in (0, 2):
                add(music, tb, kick(style == "light"), 0.8)
            if q in (1, 3):
                add(music, tb, clap() if style == "drive" else rim(), 0.45 if style == "drive" else 0.35, 0.1, 0.15)
            for e in range(2):
                add(music, tb + e * BEAT / 2, hat(open_=(e == 1 and style == "drive")), 0.33 if e else 0.25, 0.3 * (1 if e else -1))
            add(music, tb + BEAT / 2, bass(midi(root), BEAT / 2 * 0.9), 0.6 if style == "drive" else 0.45)
        arp = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[1] + 12]
        for s16 in range(16):
            n_ = arp[s16 % 4] + (12 if s16 >= 8 and style == "drive" and b % 2 else 0)
            if style == "drive":
                add(music, t0 + s16 * BEAT / 4, pluck(midi(n_)), 0.42, 0.35 * (1 if s16 % 2 else -1), 0.2)
            elif s16 % 2 == 0:
                add(music, t0 + s16 * BEAT / 4, marimba(midi(n_)), 0.5, 0.3 * (1 if s16 % 4 else -1), 0.2)


# ------------------------------------------------------------------ arrange
scenes = TL["scenes"]
S = {s["id"]: s for s in scenes}
for s in scenes:
    st, en, kind = s["start"], s["start"] + s["dur"], s["kind"]
    if kind == "mess":
        nbeats = int(round(s["dur"] / BEAT))
        for k in range(nbeats * 2):  # clock ticks on 8ths, growing
            add(music, st + k * BEAT / 2, tick(), 0.25 + 0.35 * k / (nbeats * 2), 0.2)
        for k in range(nbeats):  # heartbeat thump
            add(music, st + k * BEAT, kick(True), 0.25 + 0.5 * k / nbeats)
        drone = pad([midi(45), midi(52), midi(57)], s["dur"], 900) * np.linspace(0.05, 1, int(s["dur"] * SR)) ** 2
        add(music, st, drone, 0.35, 0, 0.3)
        add(music, en - BAR, riser(BAR), 0.35)
        for i, p in enumerate(s["pops"]):
            add(sfx, st + p, pop(500 + 90 * (i % 7)), 0.55, ((i * 37) % 11) / 5.5 - 1)
    elif kind == "zip":
        add(sfx, st + 0.25, whoosh(0.75), 0.55, -0.4, 0.2)    # lasso drawn around the mess
        add(sfx, st + 1.05, whoosh(0.45), 0.7, 0.6, 0.2)      # …and zipped away
        add(music, en - BEAT * 1.5, reverse_swell(BEAT * 1.5), 0.8)
    elif kind == "logo":
        add(music, st, impact(), 0.9, 0, 0.35)
        groove(st, en, "drive")
    elif kind in ("feature",):
        groove(st, en, "drive", int(round((st - S["logo"]["start"]) / BAR)))
        add(music, st, impact(), 0.5, 0, 0.3)
        nxt = scenes[scenes.index(s) + 1]
        if nxt["kind"] == "feature":
            add(music, en - BAR, riser(BAR), 0.3)
        add(sfx, st + 0.25, whoosh(0.6), 0.25, 0, 0.1)        # gold lasso drawing the title
    elif kind == "bridge":
        groove(st, en, "break")
        add(music, st, impact(), 0.55, 0, 0.5)
        add(music, en - BAR, riser(BAR), 0.35)
        for k in range(4):  # "start the clock"
            add(sfx, en - BEAT * (4 - k), tick(), 0.6)
    elif kind == "step":
        groove(st, en, "light", int(round((st - S["s1"]["start"]) / BAR)))
        for k in range(int(round(s["dur"] / BEAT)) * 2):  # stopwatch tick
            add(sfx, st + k * BEAT / 2, tick(), 0.08, 0.5)
        tk = st + s["tickAt"]
        for j, m in enumerate((76, 81, 88)):                  # checklist chime
            add(sfx, tk + j * 0.06, bell(midi(m)), 0.5, 0.2 * j, 0.4)
    elif kind == "done":
        add(sfx, st + 0.3, thud(), 0.9, 0, 0.3)
        add(music, st, pad([midi(57), midi(60), midi(64), midi(69)], s["dur"] + 0.2, 2200), 0.24, 0, 0.4)
        for j, m in enumerate((69, 72, 76, 81)):
            add(sfx, st + 0.35 + j * 0.09, bell(midi(m)), 0.4, -0.3 + 0.2 * j, 0.5)
    elif kind == "outro":
        groove(st, st + 3 * BAR, "drive")
        add(music, st, impact(), 0.5, 0, 0.3)
        add(music, st + 2 * BAR, riser(BAR), 0.35)
        hit = st + 3 * BAR
        add(music, hit, impact(), 1.0, 0, 0.6)
        add(music, hit, pad([midi(45), midi(57), midi(60), midi(64), midi(69)], 3.2, 2400) * np.exp(-t_(int(3.2 * SR)) / 1.2), 0.5, 0, 0.5)
        add(sfx, hit, bell(midi(81), 3.0), 0.35, 0, 0.6)
    elif kind == "teaser-end":
        groove(st, st + 2 * BAR, "drive")
        hit = st + 2 * BAR
        add(music, hit, impact(), 1.0, 0, 0.6)
        add(music, hit, pad([midi(45), midi(57), midi(60), midi(64)], 2.5, 2400) * np.exp(-t_(int(2.5 * SR)) / 1.0), 0.5, 0, 0.5)

# ------------------------------------------------------------------ reverb
ir_n = int(2.2 * SR)
ir = rng.standard_normal((ir_n, 2)) * np.exp(-t_(ir_n) / 0.55)[:, None]
ir = np.stack([lp(ir[:, 0], 6000), lp(ir[:, 1], 6000)], 1) * 0.06
for c in range(2):
    music[:, c] += fftconvolve(send[:, c], ir[:, c])[:N]

music = np.stack([hp(music[:, 0], 30), hp(music[:, 1], 30)], 1)

# ------------------------------------------------------------------ voice
voice = np.zeros(N)
for v in TL["voice"]:
    x, sr = sf.read(os.path.join(HERE, "build", "vo", f"{v['id']}.wav"))
    if x.ndim > 1: x = x.mean(1)
    if sr != SR: x = resample_poly(x, SR, sr)
    x = hp(x, 80)
    i = int(v["start"] * SR)
    voice[i:i + len(x)] += x[: N - i]
# gentle compression
pk = np.max(np.abs(voice)) or 1
voice = voice / pk
voice = np.sign(voice) * (1 - np.exp(-np.abs(voice) * 2.2)) / (1 - np.exp(-2.2))

# ducking envelope: fast attack, slow release
lvl = np.abs(voice)
hop = 256
frames = lvl[: len(lvl) // hop * hop].reshape(-1, hop).max(1)
env = np.zeros_like(frames); a = 0.0
for i, f in enumerate(frames):
    a = max(f, a * 0.985)  # ~0.3 s release at hop 256
    env[i] = a
env = np.minimum(1, env / 0.25)
env = np.convolve(env, np.ones(6) / 6, mode="same")
duck = np.repeat(1 - 0.65 * env, hop)
duck = np.pad(duck, (0, N - len(duck)), constant_values=1)

def norm(x, peak): return x / (np.max(np.abs(x)) or 1) * peak

music = norm(music, 0.5)
sfx = norm(sfx, 0.45)
mix = music * duck[:, None] + sfx * (1 - 0.35 * duck[:, None] * 0) + voice[:, None] * 0.62
mix = np.tanh(mix * 1.15) / np.tanh(1.15)  # soft limiter
mix = norm(mix, 0.94)[: int(TOTAL * SR)]

out = os.path.join(HERE, "build", "audio")
os.makedirs(out, exist_ok=True)
prefix = "teaser-" if teaser else ""
sf.write(os.path.join(out, f"{prefix}mix.wav"), mix, SR, subtype="PCM_16")
sf.write(os.path.join(out, f"{prefix}music.wav"), norm(music + sfx, 0.9)[: int(TOTAL * SR)], SR, subtype="PCM_16")
print(f"{prefix}mix.wav  {TOTAL:.1f}s  rms {20*np.log10(np.sqrt(np.mean(mix**2))):.1f} dBFS")
