#!/usr/bin/env bash
# Compila ffmpeg/ffprobe LGPL para win64. Corre DENTRO del contenedor y sin red (construir.sh).
#   compilar.sh --imprimir-configure   imprime las opciones de ./configure (las usa la puerta)
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=componentes.conf
source "$AQUI/componentes.conf"

PREFIX=/build/prefix
unir() { local IFS=,; echo "$*"; }

# Las opciones de configure salen SOLO de componentes.conf (más las fijas de la cruzada).
opciones_configure() {
  OPC=(
    --prefix="$PREFIX" --arch=x86_64 --target-os=mingw32 --cross-prefix=x86_64-w64-mingw32-
    --enable-cross-compile --pkg-config=pkg-config --pkg-config-flags=--static
    "${FF_CONFIGURE_ENABLE[@]}"
    --enable-protocol="$(unir "${FF_PROTOCOLS[@]}")"
    --enable-demuxer="$(unir "${FF_DEMUXERS[@]}")"
    --enable-muxer="$(unir "${FF_MUXERS[@]}")"
    --enable-decoder="$(unir "${FF_DECODERS[@]}")"
    --enable-encoder="$(unir "${FF_ENCODERS[@]}")"
    --enable-parser="$(unir "${FF_PARSERS[@]}")"
    --enable-bsf="$(unir "${FF_BSFS[@]}")"
    --enable-filter="$(unir "${FF_FILTERS[@]}")"
    --enable-indev="$(unir "${FF_INDEVS[@]}")"
  )
}

if [ "${1:-}" = "--imprimir-configure" ]; then
  opciones_configure
  echo "${OPC[*]}"
  exit 0
fi
