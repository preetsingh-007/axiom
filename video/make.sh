#!/usr/bin/env bash
# Rebuilds the Axiom demo video from scratch:
#   video/out/axiom-demo.mp4            16:9, ~2:50 (pitch + setup guide)
#   video/out/axiom-teaser-vertical.mp4 9:16, ~60 s (cold open + 3 features)
#   video/out/*.srt                     captions
#
# Needs: Node 20+, Python 3.10+, Chromium for Playwright, network access to npm/PyPI/GitHub
# (voice model + fonts), and GEMINI_KEY for the live AI footage (a free Google AI Studio key).
#
#   GEMINI_KEY=… bash video/make.sh            everything
#   bash video/make.sh audio render            selected stages: assets voice audio record render
set -euo pipefail
cd "$(dirname "$0")/.."
B=video/build
stages=${*:-assets voice audio record render}
has() { [[ " $stages " == *" $1 "* ]]; }

if has assets; then
  pip install -q kokoro-onnx soundfile numpy scipy imageio-ffmpeg qrcode
  mkdir -p $B/kokoro $B/fonts
  rel=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
  [ -f $B/kokoro/kokoro-v1.0.int8.onnx ] || curl -sSL -o $B/kokoro/kokoro-v1.0.int8.onnx $rel/kokoro-v1.0.int8.onnx
  [ -f $B/kokoro/voices-v1.0.bin ] || curl -sSL -o $B/kokoro/voices-v1.0.bin $rel/voices-v1.0.bin
  if [ ! -f $B/fonts/inter.woff2 ]; then
    (cd $B/fonts && npm pack -s @fontsource-variable/inter@5 @fontsource-variable/fraunces@5 @fontsource/jetbrains-mono@5 >/dev/null &&
      for f in *.tgz; do tar xzf "$f" && rm -rf "${f%.tgz}" && mv package "${f%.tgz}"; done &&
      cp fontsource-variable-inter-*/files/inter-latin-wght-normal.woff2 inter.woff2 &&
      cp fontsource-variable-fraunces-*/files/fraunces-latin-full-normal.woff2 fraunces.woff2 &&
      cp fontsource-variable-fraunces-*/files/fraunces-latin-full-italic.woff2 fraunces-italic.woff2 &&
      cp fontsource-jetbrains-mono-*/files/jetbrains-mono-latin-400-normal.woff2 mono.woff2 &&
      cp fontsource-jetbrains-mono-*/files/jetbrains-mono-latin-700-normal.woff2 mono-bold.woff2)
  fi
  python3 -c "import qrcode, qrcode.image.svg; qrcode.make('https://github.com/preetsingh-007/axiom', image_factory=qrcode.image.svg.SvgPathImage, border=1).save('$B/qr.svg')"
  node video/assets/papers.mjs
fi

if has voice; then
  python3 video/tts.py "$B/kokoro"
  node video/timeline.mjs
fi

if has audio; then
  python3 video/audio.py
  python3 video/audio.py --teaser
fi

if has record; then
  npm run build
  npx vite preview --port 4173 >/dev/null 2>&1 & preview=$!
  node server/relay.mjs --port 8787 --quiet & relay=$!
  trap 'kill $preview $relay 2>/dev/null || true' EXIT
  sleep 3
  node video/record-footage.mjs
fi

if has render; then
  node video/render.mjs
  node video/render.mjs --teaser
fi
