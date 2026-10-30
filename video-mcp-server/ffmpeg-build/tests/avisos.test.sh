#!/usr/bin/env bash
# Avisos de licencia y código fuente correspondiente (I12) con fuentes de juguete, sin red.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
T=$TMP_TEST
R="$DIR_BUILD/recopilar-avisos.sh"; E="$DIR_BUILD/empaquetar-fuente.sh"

# --- Fuentes de juguete con la misma forma que las verificadas ---------------------------------
mkdir -p "$T/arbol" "$T/fuentes"
tarxz() { # tarxz <nombre-dir> <fichero-de-licencia>
  mkdir -p "$T/arbol/$1"; echo "Licencia de $1" >"$T/arbol/$1/$2"; echo "código" >"$T/arbol/$1/fuente.c"
  tar -C "$T/arbol" -cJf "$T/fuentes/$1.tar.xz" "$1"; echo firma >"$T/fuentes/$1.tar.xz.asc"
}
tarxz ffmpeg-7.1.5 COPYING.LGPLv2.1; tarxz dav1d-1.5.4 COPYING; tarxz zlib-1.3.2 LICENSE
mkdir -p "$T/arbol/nv/include/ffnvcodec" "$T/arbol/amf/AMF/core"
printf '/*\n * MIT de NVIDIA\n */\nint x;\n' >"$T/arbol/nv/include/ffnvcodec/nvEncodeAPI.h"
printf '//\n// MIT de AMD\n//\n#pragma once\n' >"$T/arbol/amf/AMF/core/Platform.h"
tar -C "$T/arbol/nv" -cf "$T/fuentes/nv-codec-headers-n12.1.14.0.tar" include
tar -C "$T/arbol/amf" -czf "$T/fuentes/AMF-headers-v1.4.36.tar.gz" AMF
sha() { sha256sum <"$T/fuentes/$1" | cut -d' ' -f1; }
fila() { local IFS=$'\t'; echo "$*"; }
{
  fila ffmpeg 7.1.5 tar https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz "$(sha ffmpeg-7.1.5.tar.xz)" - - x - - -
  fila dav1d 1.5.4 tar https://x.invalid/dav1d-1.5.4.tar.xz "$(sha dav1d-1.5.4.tar.xz)" - - x - - -
  fila zlib 1.3.2 tar https://zlib.net/zlib-1.3.2.tar.xz "$(sha zlib-1.3.2.tar.xz)" - - x - - -
  fila nv-codec-headers n12.1.14.0 git https://x.invalid/nv.git "$(sha nv-codec-headers-n12.1.14.0.tar)" - - - - - -
  fila amf-headers v1.4.36 tar https://github.com/x/AMF-headers-v1.4.36.tar.gz "$(sha AMF-headers-v1.4.36.tar.gz)" - - - - - https://gitlab.archlinux.org/x/PKGBUILD
  fila debian-inrelease trixie apt - - - - - - - -
  fila source-date-epoch 1767225600 meta - - - - - - - -
} >"$T/lock"

mkdir -p "$T/build/avisos-toolchain"
echo "--prefix=/tmp/ffbuild/prefix --disable-everything --enable-ffmpeg" >"$T/build/configuracion.txt"
printf 'aaaa  ffmpeg.exe\nbbbb  ffprobe.exe\n' >"$T/build/SHA256SUMS"
echo "MinGW-w64 runtime" >"$T/build/avisos-toolchain/mingw-w64-x86-64-dev-copyright.txt"
echo "GCC Runtime Library Exception" >"$T/build/avisos-toolchain/gcc-mingw-w64-copyright.txt"

# --- recopilar-avisos.sh ------------------------------------------------------------------------
ejecutar bash "$R" --lock "$T/lock" --repo mstne03/ffmpeg-lgpl --rev 7.1.5-abc "$T/fuentes" "$T/build" "$T/avisos"
if [ "$CODIGO" -eq 0 ]; then ok "recopilar-avisos → 0"; else mal "recopilar-avisos: $SALIDA"; fi
for l in ffmpeg-COPYING.LGPLv2.1.txt dav1d-COPYING.txt zlib-LICENSE.txt nv-codec-headers-LICENSE.txt amf-headers-LICENSE.txt \
  mingw-w64-x86-64-dev-copyright.txt gcc-mingw-w64-copyright.txt; do
  afirmar "LICENSES/$l no vacío" test -s "$T/avisos/LICENSES/$l"
done
afirmar "la licencia de NVIDIA sale del comentario de cabecera" grep -q 'MIT de NVIDIA' "$T/avisos/LICENSES/nv-codec-headers-LICENSE.txt"
negar "…y no arrastra el código" grep -q 'int x' "$T/avisos/LICENSES/nv-codec-headers-LICENSE.txt"
L="$T/avisos/LEEME-FFMPEG.txt"
afirmar "LEEME-FFMPEG con la oferta de código fuente (URL de la release)" grep -qF 'https://github.com/mstne03/ffmpeg-lgpl/releases/tag/ffmpeg-lgpl-7.1.5-abc' "$L"
afirmar "LEEME-FFMPEG con configuration:" grep -qF -- '--disable-everything' "$L"
afirmar "LEEME-FFMPEG con los SHA-256" grep -qF 'aaaa  ffmpeg.exe' "$L"
afirmar "LEEME-FFMPEG dice que se puede sustituir por una reconstrucción" grep -qi 'sustituir' "$L"

negar "sin --repo (R7 sin decidir) → ≠ 0" bash "$R" --lock "$T/lock" --rev x "$T/fuentes" "$T/build" "$T/sin-repo"
cp -r "$T/fuentes" "$T/fuentes-mal"; rm "$T/fuentes-mal/dav1d-1.5.4.tar.xz"
mkdir -p "$T/arbol/d2/dav1d-1.5.4"; echo c >"$T/arbol/d2/dav1d-1.5.4/x.c"; tar -C "$T/arbol/d2" -cJf "$T/fuentes-mal/dav1d-1.5.4.tar.xz" dav1d-1.5.4
negar "falta la licencia de una fuente → ≠ 0" bash "$R" --lock "$T/lock" --repo a/b --rev x "$T/fuentes-mal" "$T/build" "$T/mal"
rm -f "$T/build/avisos-toolchain/gcc-mingw-w64-copyright.txt"
negar "falta el aviso del runtime de gcc → ≠ 0" bash "$R" --lock "$T/lock" --repo a/b --rev x "$T/fuentes" "$T/build" "$T/mal2"

# --- empaquetar-fuente.sh: completo y reproducible ---------------------------------------------
for i in 1 2; do
  ejecutar bash "$E" --lock "$T/lock" --rev 7.1.5-abc "$T/fuentes" "$T/avisos" "$T/paquete$i"
  [ "$CODIGO" -eq 0 ] || mal "empaquetar-fuente ($i): $SALIDA"
done
P1="$T/paquete1/ffmpeg-fuente-correspondiente-7.1.5-abc.tar.xz"
afirmar "existe el tarball de código fuente correspondiente" test -s "$P1"
if [ -s "$P1" ]; then
  contenido=$(tar -tJf "$P1")
  for f in ffmpeg-7.1.5.tar.xz ffmpeg-7.1.5.tar.xz.asc dav1d-1.5.4.tar.xz zlib-1.3.2.tar.xz nv-codec-headers-n12.1.14.0.tar AMF-headers-v1.4.36.tar.gz; do
    afirmar "contiene fuentes/$f" grep -q "/fuentes/$f\$" <<<"$contenido"
  done
  for f in ffmpeg-build/fuentes.lock ffmpeg-build/compilar.sh ffmpeg-build/Dockerfile LICENSES/zlib-LICENSE.txt LEEME-FUENTE.txt; do
    afirmar "contiene $f" grep -q "/$f\$" <<<"$contenido"
  done
  a=$(sha256sum <"$P1" | cut -d' ' -f1); b=$(sha256sum <"$T/paquete2/ffmpeg-fuente-correspondiente-7.1.5-abc.tar.xz" | cut -d' ' -f1)
  afirmar "dos ejecuciones dan el mismo SHA-256" test "$a" = "$b"

  # Reconstrucción desde el tarball (R1 punto 1): la puerta corre en el árbol desempaquetado,
  # sin el workflow (que no viaja); solo la detienen los marcadores, nunca un fichero ausente.
  mkdir -p "$T/desempaquetado"; tar -xJf "$P1" -C "$T/desempaquetado"
  U="$T/desempaquetado/ffmpeg-fuente-correspondiente-7.1.5-abc"
  ejecutar bash "$U/ffmpeg-build/comprobar-pendientes.sh"
  if ! grep -q 'falta' <<<"$SALIDA" && { [ "$CODIGO" -eq 0 ] || grep -q 'fuentes.lock' <<<"$SALIDA"; }; then
    ok "comprobar-pendientes.sh corre desde el árbol desempaquetado"
  else mal "comprobar-pendientes.sh en el tarball: $SALIDA"; fi
  afirmar "LEEME-FUENTE remite a construir.sh --sin-descarga" grep -q 'construir.sh --sin-descarga --fuentes fuentes' "$U/LEEME-FUENTE.txt"
  negar "LEEME-FUENTE no lleva órdenes docker propias" grep -q 'docker run' "$U/LEEME-FUENTE.txt"
fi

# Solo se empaqueta lo verificado (R1 LOW-8): una fuente alterada o un fichero ajeno → ≠ 0.
cp -r "$T/fuentes" "$T/f-alterada"; echo x >>"$T/f-alterada/zlib-1.3.2.tar.xz"
negar "fuente que no cuadra con el lock → ≠ 0" bash "$E" --lock "$T/lock" --rev r "$T/f-alterada" "$T/avisos" "$T/p3"
cp -r "$T/fuentes" "$T/f-ajena"; echo x >"$T/f-ajena/extra.tar"
negar "fichero ajeno al lock en las fuentes → ≠ 0" bash "$E" --lock "$T/lock" --rev r "$T/f-ajena" "$T/avisos" "$T/p4"
cp -r "$T/fuentes" "$T/f-oculta"; echo x >"$T/f-oculta/.oculto"
ejecutar bash "$E" --lock "$T/lock" --rev r "$T/f-oculta" "$T/avisos" "$T/p5"
if [ "$CODIGO" -ne 0 ] && grep -q 'ajeno al lock.*\.oculto' <<<"$SALIDA"; then ok "fichero oculto en las fuentes → ≠ 0"; else mal "fichero oculto: $SALIDA"; fi

fin
