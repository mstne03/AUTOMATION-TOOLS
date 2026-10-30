#!/usr/bin/env bash
# Reúne los avisos de licencia que exige distribuir el binario (I12, LGPL y BSD/MIT/zlib estáticas).
#   recopilar-avisos.sh --repo OWNER/REPO --rev REV [--lock F] <fuentes> <construcción> <salida>
# <fuentes>: las verificadas por descargar-fuentes.sh. <construcción>: la salida de compilar.sh.
# <salida>/LICENSES/*.txt + <salida>/LEEME-FFMPEG.txt (versión, configuración, SHA-256, oferta de
# código fuente y cómo reconstruir). Falta una licencia → ≠ 0: nunca se publica sin avisos.
# --repo es el repositorio PÚBLICO donde vive la release con el código fuente (R7, decide Marc).
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$AQUI/fuentes.lock"; REPO=""; REV=""
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --lock) LOCK=$2 ;; --repo) REPO=$2 ;; --rev) REV=$2 ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
  shift 2
done
[ $# -eq 3 ] || { echo "Uso: $0 --repo OWNER/REPO --rev REV [--lock F] <fuentes> <construcción> <salida>" >&2; exit 2; }
FUENTES=$1; BUILD=$2; SALIDA=$3
error() { echo "ERROR: $*" >&2; exit 1; }
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || error "--repo OWNER/REPO obligatorio (repositorio público de la oferta, R7)"
[[ "$REV" =~ ^[A-Za-z0-9_.-]+$ ]] || error "--rev obligatorio"

# Dónde está la licencia de cada fuente: «fichero:<ruta>» (se copia) o «cabecera:<ruta>» (primer
# bloque de comentario del fichero: nv-codec-headers y los headers de AMF llevan su MIT ahí).
declare -A LICENCIA=(
  [ffmpeg]="fichero:COPYING.LGPLv2.1"
  [dav1d]="fichero:COPYING"
  [zlib]="fichero:LICENSE"
  [nv-codec-headers]="cabecera:include/ffnvcodec/nvEncodeAPI.h"
  [amf-headers]="cabecera:core/Platform.h"
)
declare -A DESTINO=([ffmpeg]=ffmpeg-COPYING.LGPLv2.1.txt [dav1d]=dav1d-COPYING.txt [zlib]=zlib-LICENSE.txt
  [nv-codec-headers]=nv-codec-headers-LICENSE.txt [amf-headers]=amf-headers-LICENSE.txt)

mkdir -p "$SALIDA/LICENSES"
version_ffmpeg=""
while IFS=$'\t' read -r nombre version tipo url _; do
  case "$tipo" in tar) archivo=$FUENTES/$(basename "$url") ;; git) archivo=$FUENTES/$nombre-$version.tar ;; *) continue ;; esac
  [ "$nombre" = ffmpeg ] && version_ffmpeg=$version
  [ -n "${LICENCIA[$nombre]:-}" ] || error "$nombre: sin regla de licencia en recopilar-avisos.sh"
  modo=${LICENCIA[$nombre]%%:*}; ruta=${LICENCIA[$nombre]#*:}
  # Miembro exacto: <ruta> o <directorio-raíz>/<ruta>.
  # (Sin `exit` en awk tras una tubería: con pipefail, el SIGPIPE de tar abortaría el script.)
  miembro=$(tar -tf "$archivo" | awk -v r="$ruta" '!f && ($0 == r || substr($0, index($0, "/") + 1) == r) { print; f = 1 }')
  [ -n "$miembro" ] || error "$nombre: no está $ruta en $(basename "$archivo")"
  destino=$SALIDA/LICENSES/${DESTINO[$nombre]}
  if [ "$modo" = fichero ]; then tar -xOf "$archivo" "$miembro" >"$destino"
  else tar -xOf "$archivo" "$miembro" | awk 'fin { next } /^[[:space:]]*(\/\*|\*|\/\/)/ { print; if (/\*\//) fin = 1; next } { fin = 1 }' >"$destino"; fi
  [ -s "$destino" ] || error "$nombre: licencia vacía"
done < <(grep -v '^#' "$LOCK")
[ -n "$version_ffmpeg" ] || error "fuentes.lock sin ffmpeg"

for f in mingw-w64-x86-64-dev-copyright.txt gcc-mingw-w64-copyright.txt; do
  [ -s "$BUILD/avisos-toolchain/$f" ] || error "falta el aviso del runtime enlazado: $f"
  cp "$BUILD/avisos-toolchain/$f" "$SALIDA/LICENSES/"
done

URL="https://github.com/$REPO/releases/tag/ffmpeg-lgpl-$REV"
cat >"$SALIDA/LEEME-FFMPEG.txt" <<EOF
ffmpeg y ffprobe de SEO Studio — FFmpeg $version_ffmpeg, build propia LGPL-2.1-o-posterior

Son programas aparte: SEO Studio los ejecuta como procesos y no enlaza con ellos.

Licencias: FFmpeg se distribuye bajo la GNU Lesser General Public License 2.1 o posterior
(LICENSES/ffmpeg-COPYING.LGPLv2.1.txt). Llevan enlazadas estáticamente dav1d (BSD-2), zlib
(licencia zlib), las cabeceras de NVIDIA y AMD (MIT) y el runtime de MinGW-w64 y de GCC (con la
GCC Runtime Library Exception). Sus avisos están en LICENSES/.

Código fuente correspondiente: ffmpeg-fuente-correspondiente-$REV.tar.xz, publicado en
  $URL
Contiene las fuentes exactas (con sus firmas), los scripts y el Dockerfile de la construcción y
estas licencias. La oferta se mantiene mientras se distribuya este binario y tres años más.

Reconstruir: descomprime ese archivo y ejecuta
  bash ffmpeg-build/construir.sh --fuentes <dir vacío> --salida <dir vacío>
Puedes sustituir ffmpeg.exe y ffprobe.exe de la instalación por tu propia reconstrucción o
modificación de FFmpeg.

Configuración (configuration:):
$(cat "$BUILD/configuracion.txt")

SHA-256:
$(cat "$BUILD/SHA256SUMS")
EOF
echo "Avisos en $SALIDA"
