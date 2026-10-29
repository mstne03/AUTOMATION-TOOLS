#!/usr/bin/env bash
# componentes.conf: listas completas, sin nada GPL/nonfree y cubriendo lo que usa el motor.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# shellcheck source=../componentes.conf
source "$DIR_BUILD/componentes.conf"

# (a) Cada lista existe y no está vacía.
for a in FF_CONFIGURE_ENABLE FF_LISTA_BLANCA_ENABLE FF_PROTOCOLS FF_DEMUXERS FF_MUXERS FF_DECODERS \
  FF_ENCODERS FF_PARSERS FF_BSFS FF_FILTERS FF_INDEVS; do
  declare -n ref="$a"
  if [ "${#ref[@]}" -gt 0 ]; then ok "$a definida (${#ref[@]})"; else mal "$a vacía o sin definir"; fi
  unset -n ref
done

todo=" ${FF_CONFIGURE_ENABLE[*]} ${FF_ENCODERS[*]} ${FF_DECODERS[*]} ${FF_FILTERS[*]} ${FF_DEMUXERS[*]} "

# (b) Ningún codificador con patentes/GPL ni bibliotecas que el R0 dejó fuera.
for p in "${FF_PROHIBIDOS[@]}"; do
  if [[ "$todo" == *" $p "* || "$todo" == *"--enable-$p "* ]]; then mal "prohibido presente: $p"; else ok "sin $p"; fi
done

# (c) Configuración: sin gpl/nonfree/version3, sin hwaccel, sin indevs/protocolos de red.
for o in "${FF_CONFIGURE_ENABLE[@]}"; do
  case "$o" in
    --enable-gpl | --enable-nonfree | --enable-version3 | --enable-hwaccel* | --enable-libvpl | --enable-libmfx)
      mal "opción prohibida en FF_CONFIGURE_ENABLE: $o" ;;
  esac
done
afirmar "--disable-everything presente" grep -q -- '--disable-everything' <<<"${FF_CONFIGURE_ENABLE[*]}"
afirmar "--disable-network presente" grep -q -- '--disable-network' <<<"${FF_CONFIGURE_ENABLE[*]}"
afirmar "protocolos: exactamente file y pipe" test "${FF_PROTOCOLS[*]}" = "file pipe"
afirmar "lavfi va como indev, no como demuxer" test "${FF_INDEVS[*]}" = "lavfi"
negar "lavfi no está en FF_DEMUXERS" grep -qw lavfi <<<"${FF_DEMUXERS[*]}"
negar "sin h264_qsv (ruling R0: fuera libvpl/QSV)" grep -qw h264_qsv <<<"${FF_ENCODERS[*]}"

# Toda opción --enable-X de la configuración está en la lista blanca (la puerta de la Tarea 2).
for o in "${FF_CONFIGURE_ENABLE[@]}"; do
  [[ "$o" == --enable-* ]] || continue
  if [[ " ${FF_LISTA_BLANCA_ENABLE[*]} " == *" $o "* ]]; then ok "en lista blanca: $o"; else mal "fuera de la lista blanca: $o"; fi
done

# (d) Cobertura contra el motor: cada -c:v/-c:a, -f y filtro literal de src/*.ts está en las listas
# o en FF_EXCLUIDOS_CONOCIDOS (que se imprime: es la «puerta W3.2» del LEEME).
fuentes_ts=("$DIR_BUILD"/../src/*.ts)
excluido() {
  local e
  for e in "${FF_EXCLUIDOS_CONOCIDOS[@]}"; do
    if [ "${e%%|*}" = "$1" ]; then echo "  EXCLUIDO CONOCIDO: $1 (${e#*|})"; return 0; fi
  done
  return 1
}
cubre() { # cubre <lista> <nombre> <qué>
  if [[ " $1 " == *" $2 "* ]]; then ok "$3 $2 cubierto"; elif excluido "$2"; then :; else mal "$3 $2 que usa el motor y no está en componentes.conf"; fi
}
mapfile -t cods < <(cat "${fuentes_ts[@]}" | grep -oE '"-c:[va]", "[a-z0-9_]+"' | sed -E 's/.*", "//; s/"$//' | sort -u)
mapfile -t fmts < <(cat "${fuentes_ts[@]}" | grep -oE '"-f", "[a-z0-9_]+"' | sed -E 's/.*", "//; s/"$//' | sort -u)
mapfile -t fils < <(cat "${fuentes_ts[@]}" | grep -oE '[]"`,;}][a-z][a-z0-9_]*=' | sed -E 's/^.//; s/=$//' | sort -u)
[ "${#cods[@]}" -gt 0 ] && [ "${#fils[@]}" -gt 0 ] || mal "la extracción de src/*.ts no encontró nada (¿cambió el formato?)"
for c in "${cods[@]}"; do cubre "${FF_ENCODERS[*]}" "$c" "codificador"; done
for f in "${fmts[@]}"; do cubre "${FF_MUXERS[*]}" "$f" "formato"; done
for f in "${fils[@]}"; do cubre "${FF_FILTERS[*]}" "$f" "filtro"; done

fin
