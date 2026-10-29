#!/usr/bin/env bash
# La puerta de licencia y superficie: verificar-configuracion.sh rompe el build ante cualquier
# opción fuera de componentes.conf (gpl, nonfree, version3, libs, listas distintas).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
V="$DIR_BUILD/verificar-configuracion.sh"
F="$DIR_BUILD/tests/fixtures"

# El «bueno» es la configuración que compone compilar.sh a partir de componentes.conf, en el
# formato de `ffmpeg -buildconf` (una opción por línea). Así el fixture no puede desfasarse.
bash "$DIR_BUILD/compilar.sh" --imprimir-configure | tr ' ' '\n' | sed 's/^/    /' >"$TMP_TEST/bueno.txt"
printf ' V....D h264_mf  H264 via MediaFoundation\n A....D aac  AAC\n' >"$TMP_TEST/encoders-bueno.txt"

ejecutar bash "$V" "$TMP_TEST/bueno.txt" "$TMP_TEST/encoders-bueno.txt"
if [ "$CODIGO" -eq 0 ]; then ok "configuración de compilar.sh → 0"; else mal "configuración buena rechazada: $SALIDA"; fi

# Variante = bueno + una línea; debe salir ≠ 0 y nombrar lo que la rompe.
variante() { # variante <nombre> <línea añadida> <texto esperado en el error>
  { cat "$TMP_TEST/bueno.txt"; echo "    $2"; } >"$TMP_TEST/$1.txt"
  ejecutar bash "$V" "$TMP_TEST/$1.txt"
  if [ "$CODIGO" -ne 0 ] && grep -q -- "$3" <<<"$SALIDA"; then ok "$1 → ≠ 0 y nombra '$3'"; else mal "$1 no rechazada bien (código $CODIGO): $SALIDA"; fi
}
variante gpl --enable-gpl enable-gpl
variante nonfree --enable-nonfree enable-nonfree
variante version3 --enable-version3 enable-version3
variante x264 --enable-libx264 libx264
variante openh264 --enable-libopenh264 libopenh264
variante mp3lame --enable-libmp3lame libmp3lame
variante hwaccel --enable-hwaccel=h264_d3d11va hwaccel
variante demuxer-hls --enable-demuxer=hls hls
variante filtro-movie --enable-filter=movie movie
variante todos-decoders --enable-decoders enable-decoders

# Listas: una lista con un elemento de más o de menos que componentes.conf.
sed -E 's/(--enable-demuxer=[^ ]*)/\1,hls/' "$TMP_TEST/bueno.txt" >"$TMP_TEST/hls-en-lista.txt"
ejecutar bash "$V" "$TMP_TEST/hls-en-lista.txt"
if [ "$CODIGO" -ne 0 ] && grep -q hls <<<"$SALIDA"; then ok "--enable-demuxer=mov,…,hls → ≠ 0"; else mal "demuxer extra en la lista no detectado: $SALIDA"; fi
sed -E 's/(--enable-protocol=)file,/\1/' "$TMP_TEST/bueno.txt" >"$TMP_TEST/sin-file.txt"
ejecutar bash "$V" "$TMP_TEST/sin-file.txt"
if [ "$CODIGO" -ne 0 ] && grep -q file <<<"$SALIDA"; then ok "protocolo que falta → ≠ 0"; else mal "protocolo ausente no detectado: $SALIDA"; fi
grep -v -- '--disable-everything' "$TMP_TEST/bueno.txt" >"$TMP_TEST/sin-disable.txt"
ejecutar bash "$V" "$TMP_TEST/sin-disable.txt"
if [ "$CODIGO" -ne 0 ] && grep -q disable-everything <<<"$SALIDA"; then ok "sin --disable-everything → ≠ 0"; else mal "falta de --disable-everything no detectada"; fi

# Codificadores: aunque la configuración pase, un listado con libopenh264 rompe.
printf ' V....D libopenh264  OpenH264\n' >"$TMP_TEST/encoders-malo.txt"
ejecutar bash "$V" "$TMP_TEST/bueno.txt" "$TMP_TEST/encoders-malo.txt"
if [ "$CODIGO" -ne 0 ] && grep -q libopenh264 <<<"$SALIDA"; then ok "-encoders con libopenh264 → ≠ 0"; else mal "-encoders con libopenh264 aceptado"; fi

# El build real de BtbN (salida de `ffmpeg -buildconf`, sin red) no pasa la puerta.
ejecutar bash "$V" "$F/buildconf-btbn.txt"
if [ "$CODIGO" -ne 0 ] && grep -q libopenh264 <<<"$SALIDA" && grep -q enable-version3 <<<"$SALIDA"; then
  ok "BtbN → ≠ 0 (libopenh264, version3…)"
else mal "BtbN no rechazado bien: $SALIDA"; fi

fin
