#!/usr/bin/env bash
# Prepara el motor de vídeo para el instalador en src-tauri/binaries/video-engine (D10), que
# tauri.conf.json copia a <instalación>/video-engine. Layout (el que espera app_backend/video.py):
#
#   video-engine/node/node.exe                Node 22 LTS win-x64 (versión y SHA-256 fijados)
#   video-engine/app/                         dist/, plantilla/, catalogo/, package.json y
#                                             node_modules de producción (npm ci --omit=dev)
#   video-engine/browser/chrome-headless-shell-win64/   Chrome for Testing de Google, la versión que
#                                             fija hyperframes (zip con SHA-256 fijado)
#   video-engine/ffmpeg/ffmpeg.exe, ffprobe.exe         build LGPL de la tarea 2 (SHA-256 fijado)
#   video-engine/LICENSES/                    avisos de cada pieza
#
# Las descargas se cachean en %LOCALAPPDATA%\seo-studio-dev\descargas\<pieza>-<versión>\ (en CI,
# en un directorio temporal). Los archivos descargados son datos no confiables: se comprueba su
# SHA-256 antes de abrirlos y cada uno se extrae en su propia carpeta vacía. Aborta si un hash no
# coincide o si el ffmpeg trae libx264 (o cualquier parte GPL / nonfree).
#
#   bash scripts/prepare-video-engine.sh        # desde app-ui/, en Git Bash
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION=22.23.4
NODE_ZIP=node-v$NODE_VERSION-win-x64.zip
NODE_URL=https://nodejs.org/dist/v$NODE_VERSION/$NODE_ZIP
NODE_SHA256=cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20

FFMPEG_PIEZA=ffmpeg-lgpl-7.1.5-12
FFMPEG_ZIP=ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-7.1.zip
FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/$FFMPEG_ZIP
FFMPEG_SHA256=b7c1c846dacca68ee4ebf5c390742c973b3d5d14a6d44b061f500d8e4ac74fc0

# chrome-headless-shell que fija hyperframes 0.8.206 (CHROME_VERSION de su CLI), bajado del
# almacén oficial de Chrome for Testing. Google no publica SHA-256: el fijado se calculó sobre la
# descarga, cuyo MD5 coincidía con el x-goog-hash del objeto y cuyo .exe era idéntico al que
# descarga la propia CLI de HyperFrames. No se copia la caché de usuario (~/.cache/hyperframes):
# es escribible y sus DLL/paks no estarían verificados.
HYPERFRAMES_VERSION=0.8.206
CHROME_VERSION=152.0.7977.30
CHROME_ZIP=chrome-headless-shell-win64.zip
CHROME_URL=https://storage.googleapis.com/chrome-for-testing-public/$CHROME_VERSION/win64/$CHROME_ZIP
CHROME_SHA256=5d7df999a6e4a65a1b16b25b61064f7337b8aa8ee2ed1b4e07bfdd24f6e4275e

MOTOR=../video-mcp-server
DEST=src-tauri/binaries/video-engine
LICENCIAS=scripts/licencias

if [ -n "${CI:-}" ]; then
  DESCARGAS="$(cygpath -u "${RUNNER_TEMP:-${TMPDIR:-/tmp}}")/seo-studio-descargas"
else
  [ -n "${LOCALAPPDATA:-}" ] || { echo "LOCALAPPDATA no está definida (ejecuta desde Git Bash en Windows)." >&2; exit 1; }
  DESCARGAS="$(cygpath -u "$LOCALAPPDATA")/seo-studio-dev/descargas"
fi
TRABAJO=$(mktemp -d)
LISTO=0
# Si el script falla a medias, no queda un DEST parcial que tauri build pudiera empaquetar.
trap 'rm -rf "$TRABAJO"; [ "$LISTO" = 1 ] || rm -rf "$DEST"' EXIT

falla() { echo "ERROR: $*" >&2; exit 1; }

# comprobar_sha FICHERO SHA256: aborta si no coincide.
comprobar_sha() {
  local real
  real=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$real" = "$2" ] || falla "SHA-256 de $1 no coincide: $real (esperado $2). Borra el fichero si es una descarga corrupta."
}

# descargar PIEZA URL FICHERO SHA256 -> imprime la ruta del fichero verificado.
descargar() {
  local carpeta="$DESCARGAS/$1" f="$DESCARGAS/$1/$3"
  mkdir -p "$carpeta"
  if [ ! -f "$f" ]; then
    echo "Descargando $2" >&2
    curl -fL --proto '=https' --tlsv1.2 --retry 3 -o "$f.part" "$2"
    mv "$f.part" "$f"
  fi
  comprobar_sha "$f" "$4"
  echo "$f"
}

# extraer ZIP -> imprime una carpeta nueva y vacía con su contenido.
extraer() {
  local x
  x=$(mktemp -d "$TRABAJO/x.XXXXXX")
  unzip -q "$1" -d "$x"
  echo "$x"
}

echo "== Limpieza"
rm -rf "$DEST" src-tauri/target/release/video-engine
mkdir -p "$DEST"/{node,app,browser,ffmpeg,LICENSES}

echo "== Motor: build"
# dist se borra antes: tsc no elimina los .js de fuentes que ya no existen. Este npm ci (de
# desarrollo, no se empaqueta) sí ejecuta scripts de instalación: esbuild, que usan tsx/vitest, los
# necesita para validar su binario; el lockfile fija versión e integridad de cada paquete.
(cd "$MOTOR" && rm -rf dist && npm ci --no-audit --no-fund && npm run build)
[ "$(cd "$MOTOR" && node -p 'require("./node_modules/hyperframes/package.json").version')" = "$HYPERFRAMES_VERSION" ] \
  || falla "video-mcp-server no usa hyperframes $HYPERFRAMES_VERSION"
grep -rqF "CHROME_VERSION = \"$CHROME_VERSION\"" "$MOTOR/node_modules/hyperframes/dist" \
  || falla "hyperframes $HYPERFRAMES_VERSION ya no fija chrome-headless-shell $CHROME_VERSION: actualiza CHROME_*"

echo "== Motor: copia y dependencias de producción"
cp -r "$MOTOR/dist" "$DEST/app/dist"
cp "$MOTOR/package.json" "$MOTOR/package-lock.json" "$DEST/app/"
# plantilla y catalogo: solo lo versionado (nada de salidas locales que se hayan colado).
git -C "$MOTOR" ls-files -z plantilla catalogo | tar -C "$MOTOR" --null -T - -cf - | tar -C "$DEST/app" -xf -
# --ignore-scripts: ningún script de instalación de terceros se ejecuta al empaquetar; los binarios
# nativos (sharp, esbuild, lightningcss…) llegan como paquetes opcionales precompilados.
(cd "$DEST/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
rm "$DEST/app/package-lock.json"

echo "== Node $NODE_VERSION"
zip=$(descargar "node-$NODE_VERSION" "$NODE_URL" "$NODE_ZIP" "$NODE_SHA256")
x=$(extraer "$zip")
cp "$x/node-v$NODE_VERSION-win-x64/node.exe" "$DEST/node/node.exe"
cp "$x/node-v$NODE_VERSION-win-x64/LICENSE" "$DEST/LICENSES/node-LICENSE.txt"
[ "$("$DEST/node/node.exe" --version | tr -d '\r')" = "v$NODE_VERSION" ] || falla "node.exe no es v$NODE_VERSION"

echo "== Navegador (chrome-headless-shell $CHROME_VERSION, Chrome for Testing)"
zip=$(descargar "chrome-headless-shell-$CHROME_VERSION" "$CHROME_URL" "$CHROME_ZIP" "$CHROME_SHA256")
x=$(extraer "$zip")
origen="$x/chrome-headless-shell-win64"
[ -f "$origen/chrome-headless-shell.exe" ] || falla "el zip de Chrome no trae chrome-headless-shell-win64/chrome-headless-shell.exe"
cp -r "$origen" "$DEST/browser/chrome-headless-shell-win64"
cp "$origen/LICENSE.headless_shell" "$DEST/LICENSES/chrome-headless-shell-LICENSE.txt"
cp "$origen/ABOUT" "$DEST/LICENSES/chrome-headless-shell-ABOUT.txt"

echo "== ffmpeg LGPL"
zip=$(descargar "$FFMPEG_PIEZA" "$FFMPEG_URL" "$FFMPEG_ZIP" "$FFMPEG_SHA256")
x=$(extraer "$zip")
bin="$x/${FFMPEG_ZIP%.zip}/bin"
cp "$bin/ffmpeg.exe" "$bin/ffprobe.exe" "$DEST/ffmpeg/"
cp "$x/${FFMPEG_ZIP%.zip}/LICENSE.txt" "$DEST/LICENSES/ffmpeg-LICENSE.txt"
codificadores=$("$DEST/ffmpeg/ffmpeg.exe" -hide_banner -encoders)
! grep -q libx264 <<<"$codificadores" || falla "el ffmpeg del bundle lista libx264 (debe ser LGPL)"
version=$("$DEST/ffmpeg/ffmpeg.exe" -hide_banner -version)
! grep -q -e '--enable-gpl' -e '--enable-nonfree' <<<"$version" || falla "el ffmpeg del bundle es GPL o nonfree"
grep -e '^ffmpeg version' -e '^configuration:' <<<"$version" > "$DEST/LICENSES/ffmpeg-version.txt"

echo "== Licencias"
M="$DEST/app/node_modules"
{
  echo "hyperframes $HYPERFRAMES_VERSION — Apache-2.0 — https://github.com/heygen-com/hyperframes"
  echo "(El paquete de npm no incluye el fichero; texto tomado del repositorio en la etiqueta v$HYPERFRAMES_VERSION.)"
  echo
  cat "$LICENCIAS/hyperframes-$HYPERFRAMES_VERSION-LICENSE.txt"
} > "$DEST/LICENSES/hyperframes-LICENSE.txt"
{
  echo "gsap $(node -p "require('./$M/gsap/package.json').version") — GreenSock"
  echo "Licencia: $(node -p "require('./$M/gsap/package.json').license")"
  echo "El paquete de npm no incluye fichero de licencia; texto completo en https://gsap.com/standard-license"
} > "$DEST/LICENSES/gsap-LICENSE.txt"
cp "$M/three/LICENSE" "$DEST/LICENSES/three-LICENSE.txt"
cp "$M/three147/LICENSE" "$DEST/LICENSES/three-0.147-LICENSE.txt"
for fuente in anton inter-tight jetbrains-mono; do
  cp "$M/@fontsource/$fuente/LICENSE" "$DEST/LICENSES/fuente-$fuente-OFL.txt"
done
cp "$MOTOR/catalogo/compositions/assets/fonts/Geist-OFL.txt" "$DEST/LICENSES/fuente-geist-OFL.txt"
cp "$MOTOR/catalogo/compositions/assets/fonts/OFL.txt" "$DEST/LICENSES/fuente-recursive-OFL.txt"
cp "$MOTOR/plantilla/vendor/shaders.THIRD-PARTY-LICENSES.txt" "$DEST/LICENSES/shaders-THIRD-PARTY-LICENSES.txt"
{
  echo "Motor de vídeo de SEO Studio — piezas de terceros"
  echo
  echo "Node.js v$NODE_VERSION win-x64   $NODE_URL"
  echo "  SHA-256 $NODE_SHA256"
  echo "ffmpeg $FFMPEG_ZIP (LGPL, sin libx264)   $FFMPEG_URL"
  echo "  SHA-256 $FFMPEG_SHA256"
  echo "chrome-headless-shell $CHROME_VERSION win64 (Chrome for Testing)   $CHROME_URL"
  echo "  SHA-256 $CHROME_SHA256"
  echo "hyperframes $HYPERFRAMES_VERSION (Apache-2.0) y el resto de dependencias de npm: cada"
  echo "  paquete conserva su licencia en app/node_modules/<paquete>/."
  echo
  echo "Mapa de España (es-atlas): datos derivados del Instituto Geográfico Nacional (IGN),"
  echo "  licencia CC BY 4.0 — © Instituto Geográfico Nacional. Mapa del mundo (world-atlas):"
  echo "  Natural Earth, dominio público."
} > "$DEST/LICENSES/LEEME.txt"

echo "== Listo"
du -sh "$DEST"/*
LISTO=1
echo "Motor de vídeo listo en $DEST ($(du -sh "$DEST" | cut -f1))"
