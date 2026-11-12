#!/usr/bin/env bash
# Prepara el motor de vídeo para el instalador en src-tauri/binaries/video-engine (D10), que
# tauri.conf.json copia a <instalación>/video-engine. Layout (el que espera app_backend/video.py):
#
#   video-engine/node/node.exe                Node 22 LTS win-x64 (versión y SHA-256 fijados)
#   video-engine/app/                         dist/, plantilla/, catalogo/, package.json y
#                                             node_modules de producción (npm ci --omit=dev), con
#                                             el parche de HyperFrames aplicado (I3): --ignore-scripts
#                                             no ejecuta el postinstall, así que se aplica a mano.
#   (el navegador del render, Chrome for Testing, no va en el instalador: lo descarga el backend
#    en el primer uso, SEO-108)
#   video-engine/ffmpeg/ffmpeg.exe, ffprobe.exe         ffmpeg LGPL propio (W1.5, SHA-256 fijado), solo esos dos
#   video-engine/LICENSES/                    avisos de cada pieza
#
# Las descargas se cachean en %LOCALAPPDATA%\seo-studio-dev\descargas\<pieza>-<versión>\ (en CI,
# en un directorio temporal). Los archivos descargados son datos no confiables: se comprueba su
# SHA-256 antes de abrirlos y cada uno se extrae en su propia carpeta vacía. Aborta si un hash no
# coincide o si el ffmpeg trae libx264, libopenh264 (o cualquier parte GPL / nonfree).
#
#   bash scripts/prepare-video-engine.sh        # desde app-ui/, en Git Bash
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION=22.23.4
NODE_ZIP=node-v$NODE_VERSION-win-x64.zip
NODE_URL=https://nodejs.org/dist/v$NODE_VERSION/$NODE_ZIP
NODE_SHA256=cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20

# ffmpeg LGPL propio (W1.5, video-mcp-server/ffmpeg-build), reproducible: el SHA-256 es el control,
# venga de donde venga el fichero. FFMPEG_LGPL_DIR = carpeta con ffmpeg.exe, ffprobe.exe, LICENSES/ y
# LEEME-FFMPEG.txt (construir.sh + recopilar-avisos.sh, el mismo contenido que la release).
# ponytail: solo carpeta local hasta que exista la release de CI (W3.2 punto 2); entonces, descarga
# por URL con estos mismos hashes. Un bundle hecho así NO se distribuye: la oferta de código fuente
# de LEEME-FFMPEG.txt apunta a esa release.
FFMPEG_VERSION=7.1.5
FFMPEG_SHA256=f8a83b58b06c70f2e12a8c8b7af9fad5fcd26bd631f192dd77926a261d2b6d85
FFPROBE_SHA256=d22d908edd30f035c8b22563914dda439cdc22ad3084139fdf578f9672f36e01

HYPERFRAMES_VERSION=0.8.206

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

# parchear_hyperframes: el sandbox y el cierre de red viven en el parche; sin él, el motor empaquetado
# se niega a lanzar la CLI. aplicar-parche.mjs comprueba los SHA-256 y no sube al repo que contiene el
# bundle. No hay variable ni ruta para saltárselo (I4, I11).
parchear_hyperframes() {
  [ "$(node -p "require('./$DEST/app/node_modules/hyperframes/package.json').version")" = "$HYPERFRAMES_VERSION" ]     || falla "el bundle no trae hyperframes $HYPERFRAMES_VERSION"
  node "$MOTOR/scripts/aplicar-parche.mjs" "$DEST/app"     || falla "el parche de HyperFrames no se aplicó en el bundle (I3)"
}

echo "== Limpieza"
rm -rf "$DEST" src-tauri/target/release/video-engine
mkdir -p "$DEST"/{node,app,ffmpeg,LICENSES}

echo "== Motor: build"
# dist se borra antes: tsc no elimina los .js de fuentes que ya no existen. Este npm ci (de
# desarrollo, no se empaqueta) sí ejecuta scripts de instalación: esbuild, que usan tsx/vitest, los
# necesita para validar su binario; el lockfile fija versión e integridad de cada paquete.
(cd "$MOTOR" && rm -rf dist && npm ci --no-audit --no-fund && npm run build)
[ "$(cd "$MOTOR" && node -p 'require("./node_modules/hyperframes/package.json").version')" = "$HYPERFRAMES_VERSION" ] \
  || falla "video-mcp-server no usa hyperframes $HYPERFRAMES_VERSION"

echo "== Motor: copia y dependencias de producción"
cp -r "$MOTOR/dist" "$DEST/app/dist"
cp "$MOTOR/package.json" "$MOTOR/package-lock.json" "$DEST/app/"
mkdir -p "$DEST/app/patches" && cp "$MOTOR/patches/hyperframes+$HYPERFRAMES_VERSION.sha256.json" "$DEST/app/patches/"
# plantilla y catalogo: solo lo versionado (nada de salidas locales que se hayan colado).
git -C "$MOTOR" ls-files -z plantilla catalogo | tar -C "$MOTOR" --null -T - -cf - | tar -C "$DEST/app" -xf -
# --ignore-scripts: ningún script de instalación de terceros se ejecuta al empaquetar; los binarios
# nativos (sharp, esbuild, lightningcss…) llegan como paquetes opcionales precompilados.
(cd "$DEST/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
parchear_hyperframes
rm "$DEST/app/package-lock.json"
# I12 (SEO-113): hyperframes trae copias de GSAP que solo usa Studio. dist/vendor/npm y dist/studio no están en el
# manifiesto de SHA-256 y el render no los carga. Se busca la cabecera de licencia, no la palabra GreenSock: un chunk
# que no se puede borrar (chunk-2MLMO25E.js) la nombra en detectores de código. Control positivo: la misma búsqueda
# tiene que ver la copia de muestra antes de borrarla; si no la ve, la puerta no mide nada.
LICENCIA_GSAP='Copyright [0-9-]+, GreenSock|gsap\.com/standard-license'
HF_APP="$DEST/app/node_modules/hyperframes/dist"
grep -IqE "$LICENCIA_GSAP" "$HF_APP/vendor/npm/gsap@3.15.0/dist/gsap.min.js" || falla "la búsqueda de la licencia de GSAP no ve la copia de muestra (I12)"
rm -rf "$HF_APP/vendor/npm" "$HF_APP/studio"
rc=0
grep -rIlE "$LICENCIA_GSAP" "$DEST/app" || rc=$?
[ "$rc" -eq 1 ] || falla "el bundle lleva GSAP, o la búsqueda falló (I12)"
# three147: el motor solo copia build/three.min.js (composicion.ts, con SHA-256 fijado). examples/ (~30 MB) trae
# rutas de más de 140 caracteres que, desde un worktree profundo, pasan del MAX_PATH de 260 y makensis aborta.
rm -rf "$DEST/app/node_modules/three147/examples"
[ -f "$DEST/app/node_modules/three147/build/three.min.js" ] || falla "falta three147/build/three.min.js en el bundle"

echo "== Node $NODE_VERSION"
zip=$(descargar "node-$NODE_VERSION" "$NODE_URL" "$NODE_ZIP" "$NODE_SHA256")
x=$(extraer "$zip")
cp "$x/node-v$NODE_VERSION-win-x64/node.exe" "$DEST/node/node.exe"
cp "$x/node-v$NODE_VERSION-win-x64/LICENSE" "$DEST/LICENSES/node-LICENSE.txt"
[ "$("$DEST/node/node.exe" --version | tr -d '\r')" = "v$NODE_VERSION" ] || falla "node.exe no es v$NODE_VERSION"

echo "== ffmpeg LGPL propio $FFMPEG_VERSION"
[ -n "${FFMPEG_LGPL_DIR:-}" ] || falla "falta FFMPEG_LGPL_DIR (carpeta con el ffmpeg de video-mcp-server/ffmpeg-build, ver su LEEME): hasta la release de CI no hay descarga"
origen=$(cygpath -u "$FFMPEG_LGPL_DIR")
# Se comprueban las copias, no el origen: lo que se empaqueta es lo que se verificó.
cp "$origen/ffmpeg.exe" "$origen/ffprobe.exe" "$DEST/ffmpeg/"
comprobar_sha "$DEST/ffmpeg/ffmpeg.exe" "$FFMPEG_SHA256"
comprobar_sha "$DEST/ffmpeg/ffprobe.exe" "$FFPROBE_SHA256"
# La carpeta lleva exactamente esos dos ficheros: el motor rechaza cualquier otro (DLL plantada, I4).
[ "$(ls -A "$DEST/ffmpeg" | sort | paste -sd' ' -)" = "ffmpeg.exe ffprobe.exe" ] || falla "la carpeta ffmpeg del bundle tiene ficheros de más"
codificadores=$("$DEST/ffmpeg/ffmpeg.exe" -hide_banner -encoders)
for prohibido in libx264 libx264rgb libx265 libopenh264; do
  ! grep -qE "^\s*\S+\s+$prohibido\s" <<<"$codificadores" || falla "el ffmpeg del bundle lista $prohibido (debe ser el LGPL propio)"
done
for f in "$origen"/LICENSES/*.txt; do cp "$f" "$DEST/LICENSES/ffmpeg-$(basename "$f")"; done
cp "$origen/LEEME-FFMPEG.txt" "$DEST/LICENSES/ffmpeg-LEEME.txt"
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
  echo "ffmpeg $FFMPEG_VERSION LGPL-2.1-o-posterior, build propio y reproducible (sin libx264 ni libopenh264):"
  echo "  ver ffmpeg-LEEME.txt (código fuente correspondiente y cómo sustituirlo)"
  echo "  SHA-256 ffmpeg.exe $FFMPEG_SHA256"
  echo "  SHA-256 ffprobe.exe $FFPROBE_SHA256"
  echo "hyperframes $HYPERFRAMES_VERSION (Apache-2.0) y el resto de dependencias de npm: cada"
  echo "  paquete conserva su licencia en app/node_modules/<paquete>/."
  echo
  echo "Mapa de España (es-atlas): datos derivados del Instituto Geográfico Nacional (IGN),"
  echo "  licencia CC BY 4.0 — © Instituto Geográfico Nacional. Mapa del mundo (world-atlas):"
  echo "  Natural Earth, dominio público."
} > "$DEST/LICENSES/LEEME.txt"

echo "== Listo"
[ ! -e "$DEST/browser" ] || falla "el bundle no debe llevar navegador (I12)"
du -sh "$DEST"/*
LISTO=1
echo "Motor de vídeo listo en $DEST ($(du -sh "$DEST" | cut -f1))"
