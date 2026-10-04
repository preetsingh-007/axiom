"""Renders every narration line with Kokoro (offline, open weights) into build/vo/<id>.wav
and writes build/vo/manifest.json with durations.  Usage: python3 video/tts.py <model-dir>"""
import json, os, sys
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

here = os.path.dirname(os.path.abspath(__file__))
model_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "build", "kokoro")
spec = json.load(open(os.path.join(here, "narration.json")))
out = os.path.join(here, "build", "vo")
os.makedirs(out, exist_ok=True)
k = Kokoro(os.path.join(model_dir, "kokoro-v1.0.int8.onnx"), os.path.join(model_dir, "voices-v1.0.bin"))
manifest = {}
for line in spec["lines"]:
    samples, sr = k.create(line.get("say", line["text"]), voice=spec["voices"][line["who"]], speed=spec["speed"], lang="en-us")
    # trim leading/trailing near-silence so timing is tight
    a = np.abs(samples); idx = np.where(a > 0.01)[0]
    if len(idx): samples = samples[max(0, idx[0] - int(0.03 * sr)): idx[-1] + int(0.08 * sr)]
    sf.write(os.path.join(out, f"{line['id']}.wav"), samples, sr)
    # pauses (≥90 ms below -40 dBFS) let captions switch exactly between phrases
    hop = int(0.01 * sr); env = np.array([np.abs(samples[i:i + hop]).max() for i in range(0, len(samples), hop)])
    quiet = env < 0.01; pauses = []; i = 0
    while i < len(quiet):
        if quiet[i]:
            j = i
            while j < len(quiet) and quiet[j]: j += 1
            if j - i >= 9 and i > 0 and j < len(quiet): pauses.append(round((i + j) / 2 * 0.01, 3))
            i = j
        else: i += 1
    manifest[line["id"]] = {"who": line["who"], "text": line["text"], "dur": round(len(samples) / sr, 3), "pauses": pauses}
    print(f"{line['id']:8s} {line['who']} {len(samples)/sr:5.2f}s")
json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=1)
