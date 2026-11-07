#!/bin/bash
# Spike: render con el sandbox de Chromium activado (sandbox-preload.cjs quita --no-sandbox de cada arranque).
# Uso: sandbox.sh <video-mcp-server> <video-engine> <dir salidas> [composición] [mp4] [--browser-gpu|--no-browser-gpu]
# Entorno: NAVEGADOR=<exe> cambia el navegador (por defecto el CfT del motor); SANDBOX_GPU=off mantiene el sandbox
# del renderer y quita solo el del proceso de GPU. Log del render en <dir salidas>/<mp4>.txt.
M="$1"; E="$2"; C="$3"; COMP="${4:-comp-css}"; MP4="${5:-css-cft-sandbox.mp4}"
export HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 CI=1 FFMPEG_DIR="$E/ffmpeg" PATH="$E/ffmpeg:$PATH"
export HYPERFRAMES_BROWSER_PATH="${NAVEGADOR:-$E/browser/chrome-headless-shell-win64/chrome-headless-shell.exe}" SANDBOX_LOG="$C/$MP4.sandbox.log"
cd "$C" && rm -f "$MP4" "$SANDBOX_LOG"
node --require "$M/spikes/chromium/sandbox-preload.cjs" "$M/node_modules/hyperframes/dist/cli.js" render "$COMP" -o "$MP4" --fps 30 --format mp4 --quality delivery "${6:---no-browser-gpu}" > "$MP4.txt" 2>&1
echo "render exit=$?"
