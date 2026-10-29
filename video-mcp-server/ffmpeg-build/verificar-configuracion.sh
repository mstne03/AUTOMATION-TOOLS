#!/usr/bin/env bash
# Puerta de licencia y superficie (I12, I15). Uso:
#   verificar-configuracion.sh <configuración> [<listado de -encoders>]
# <configuración>: salida de `ffmpeg -buildconf` o la línea FFMPEG_CONFIGURATION de config.h.
# Sale con 0 solo si la configuración es exactamente la de componentes.conf: lista blanca de
# --enable-X, listas --enable-<tipo>= idénticas, --disable-everything presente y nada prohibido.
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=componentes.conf
source "$AQUI/componentes.conf"

[ $# -ge 1 ] && [ -f "$1" ] || { echo "Uso: $0 <configuración> [<encoders>]" >&2; exit 2; }
errores=0
error() { echo "ERROR: $*" >&2; errores=$((errores + 1)); }

mapfile -t opciones < <(grep -oE -- '--(enable|disable)-[a-z0-9_-]+(=[^[:space:]]*)?' "$1" || true)
[[ " ${opciones[*]} " == *" --disable-everything "* ]] \
  || error "falta --disable-everything: el build habilitaría todos los componentes"

declare -A listas=(
  [protocol]="${FF_PROTOCOLS[*]}" [demuxer]="${FF_DEMUXERS[*]}" [muxer]="${FF_MUXERS[*]}"
  [decoder]="${FF_DECODERS[*]}" [encoder]="${FF_ENCODERS[*]}" [parser]="${FF_PARSERS[*]}"
  [bsf]="${FF_BSFS[*]}" [filter]="${FF_FILTERS[*]}" [indev]="${FF_INDEVS[*]}"
)
declare -A reales=()

for o in "${opciones[@]}"; do
  [[ "$o" == --enable-* ]] || continue
  case "$o" in
    --enable-gpl | --enable-nonfree | --enable-version3) error "$o: el build dejaría de ser LGPL-2.1-o-posterior"; continue ;;
    --enable-hwaccel*) error "$o: ningún hwaccel en este build (superficie de GPU, R0 M3)"; continue ;;
  esac
  if [[ "$o" == *=* ]]; then
    tipo=${o%%=*}; tipo=${tipo#--enable-}
    if [ -z "${listas[$tipo]+x}" ]; then error "$o: tipo '$tipo' que componentes.conf no declara"; continue; fi
    reales[$tipo]+=" ${o#*=}"
  elif [[ " ${FF_LISTA_BLANCA_ENABLE[*]} " != *" $o "* ]]; then
    error "$o: fuera de la lista blanca de componentes.conf"
  fi
done

# Cada lista debe coincidir exactamente (como conjunto) con la declarada. Bash puro: en Git Bash
# cada proceso cuesta y esto corre muchas veces en los tests.
set -f
for tipo in "${!listas[@]}"; do
  declare -A esp=() rea=()
  for x in ${listas[$tipo]}; do esp[$x]=1; done
  real=${reales[$tipo]:-}
  for x in ${real//,/ }; do rea[$x]=1; done
  sobran=""; faltan=""
  for x in "${!rea[@]}"; do [ -n "${esp[$x]+x}" ] || sobran+=" $x"; done
  for x in "${!esp[@]}"; do [ -n "${rea[$x]+x}" ] || faltan+=" $x"; done
  [ -z "$sobran" ] || error "--enable-$tipo: sobran$sobran"
  [ -z "$faltan" ] || error "--enable-$tipo: faltan$faltan"
  unset esp rea
done
set +f

# Listado de -encoders (opcional): ningún codificador prohibido, se llame como se llame la opción.
if [ $# -ge 2 ]; then
  nombres=" $(awk '{print $2}' "$2" | tr '\n' ' ') "
  for p in libx264 libx265 libopenh264 "${FF_PROHIBIDOS[@]}"; do
    [[ "$nombres" != *" $p "* ]] || error "-encoders lista $p"
  done
fi

if [ "$errores" -gt 0 ]; then echo "La configuración NO pasa la puerta de licencia ($errores error(es))." >&2; exit 1; fi
echo "Configuración conforme a componentes.conf."
