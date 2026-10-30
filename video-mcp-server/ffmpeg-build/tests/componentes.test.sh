#!/usr/bin/env bash
# componentes.conf: listas completas, sin nada GPL/nonfree y cubriendo lo que usa el motor.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# shellcheck source=../componentes.conf
source "$DIR_BUILD/componentes.conf"

# (a) Cada tipo de FF_TIPOS tiene su lista no vacía en FF_LISTAS, y no hay tipos sueltos.
afirmar "FF_TIPOS y FF_LISTAS tienen los mismos tipos" test "$(printf '%s\n' "${FF_TIPOS[@]}" | sort)" = "$(printf '%s\n' "${!FF_LISTAS[@]}" | sort)"
for t in "${FF_TIPOS[@]}"; do
  if [ -n "${FF_LISTAS[$t]:-}" ]; then ok "lista $t"; else mal "lista $t vacía"; fi
done

todo=" ${FF_CONFIGURE_ENABLE[*]} ${FF_LISTAS[*]} "

# (b) Nada con patentes/GPL ni lo que el R0 dejó fuera, en ninguna lista ni opción.
for p in "${FF_PROHIBIDOS[@]}"; do
  if [[ "$todo" == *" $p "* || "$todo" == *"--enable-$p "* ]]; then mal "prohibido presente: $p"; else ok "sin $p"; fi
done

# (c) Configuración: sin hwaccel ni red; protocolos y dispositivos exactos.
for o in "${FF_CONFIGURE_ENABLE[@]}"; do
  case "$o" in --enable-hwaccel* | --enable-libmfx) mal "opción prohibida: $o" ;; esac
done
afirmar "--disable-everything presente" grep -q -- '--disable-everything' <<<"${FF_CONFIGURE_ENABLE[*]}"
afirmar "--disable-network presente" grep -q -- '--disable-network' <<<"${FF_CONFIGURE_ENABLE[*]}"
afirmar "protocolos: exactamente file y pipe" test "${FF_LISTAS[protocol]}" = "file pipe"
afirmar "lavfi va como indev, no como demuxer" test "${FF_LISTAS[indev]}" = "lavfi"
negar "lavfi no es demuxer" grep -qw lavfi <<<"${FF_LISTAS[demuxer]}"

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
for c in "${cods[@]}"; do cubre "${FF_LISTAS[encoder]}" "$c" "codificador"; done
# `-f` es muxer de salida o dispositivo de entrada (lavfi, de las sondas de render.ts).
for f in "${fmts[@]}"; do cubre "${FF_LISTAS[muxer]} ${FF_LISTAS[indev]}" "$f" "formato"; done
for f in "${fils[@]}"; do cubre "${FF_LISTAS[filter]}" "$f" "filtro"; done

fin
