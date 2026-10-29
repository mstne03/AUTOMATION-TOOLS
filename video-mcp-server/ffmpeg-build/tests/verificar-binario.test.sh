#!/usr/bin/env bash
# verificar-binario.sh muerde: contra el ffmpeg de BtbN (FFMPEG_DIR) fallan los grupos que solo
# pasa nuestro build (listados, licencia, tamaño, red) y pasan todas las pruebas funcionales.
# Sin FFMPEG_DIR (Linux/CI de pruebas) solo se comprueban las muestras.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
M="$DIR_BUILD/tests/muestras"

for m in h264.mp4 hevc.mp4 av1.mp4 vp9.webm foto.jpg foto-cmyk.jpg foto.png foto16.png foto.webp animado.webp \
  musica.mp3 musica.wav musica.flac musica.ogg musica.m4a trampa-http.txt trampa.ffconcat; do
  if [ -f "$M/$m" ] && [ "$(wc -c <"$M/$m")" -le 30720 ]; then ok "muestra $m (≤ 30 KB)"; else mal "muestra $m ausente o > 30 KB"; fi
done
afirmar "PROCEDENCIA.md de las muestras" test -s "$M/PROCEDENCIA.md"
afirmar "trampa.ffconcat apunta a una ruta UNC y a ..\\" grep -qF '\\127.0.0.1\nada' "$M/trampa.ffconcat"

if [ -z "${FFMPEG_DIR:-}" ]; then
  echo "  OMITIDO: ejecución contra un binario (define FFMPEG_DIR con un ffmpeg.exe de Windows)"
  fin; exit 0
fi

ejecutar bash "$DIR_BUILD/verificar-binario.sh" "$FFMPEG_DIR"
if [ "$CODIGO" -ne 0 ]; then ok "BtbN no pasa la verificación (≠ 0)"; else mal "BtbN pasó la verificación"; fi
for g in listados licencia pe-tamaño protocolos-red; do
  if grep -q "^FALLA \[$g\]" <<<"$SALIDA"; then ok "muerde en [$g]"; else mal "no falla [$g] con BtbN"; fi
done
afirmar "detecta libopenh264 en los codificadores" grep -q 'libopenh264' <<<"$SALIDA"
afirmar "detecta la LGPL v3 de BtbN" grep -q '^FALLA \[licencia\] ffmpeg -L' <<<"$SALIDA"
for g in decodificación robustez tubería gpu protocolos rutas pe; do
  if grep -q "^FALLA \[$g\]" <<<"$SALIDA"; then mal "falla [$g] con un ffmpeg completo: $(grep "^FALLA \[$g\]" <<<"$SALIDA" | head -3)"
  elif grep -q "^OK    \[$g\]" <<<"$SALIDA"; then ok "pasa [$g]"; else mal "no hay comprobaciones de [$g]"; fi
done
afirmar "registra el resultado de ffconcat sin whitelist" grep -q '^REGISTRO: ffconcat' <<<"$SALIDA"

SIN_MF=1 ejecutar bash "$DIR_BUILD/verificar-binario.sh" "$FFMPEG_DIR"
afirmar "SIN_MF=1 → «NO VERIFICADO: h264_mf» en el resumen" grep -q '^NO VERIFICADO: h264_mf' <<<"$SALIDA"
negar "SIN_MF=1 no ejecuta h264_mf" grep -q 'h264_mf + AAC 192k' <<<"$SALIDA"

fin
