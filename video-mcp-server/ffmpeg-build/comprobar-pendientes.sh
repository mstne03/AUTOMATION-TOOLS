#!/usr/bin/env bash
# Puerta previa a cualquier construcción real: sale ≠ 0 y lista dónde, si en las entradas del
# build queda algún marcador PENDIENTE-TAREA-10 (hashes, digest, snapshot, SHA de acciones…).
#   comprobar-pendientes.sh [fichero…]   (sin argumentos: las entradas reales del build)
# Sin argumentos mira fuentes.lock y el Dockerfile (obligatorios) y el workflow si está: en el
# tarball del código fuente correspondiente no viaja, y la reconstrucción no lo necesita.
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ $# -eq 0 ]; then
  set -- "$AQUI/fuentes.lock" "$AQUI/Dockerfile"
  flujo="$AQUI/../../.github/workflows/ffmpeg-lgpl.yml"
  [ ! -f "$flujo" ] || set -- "$@" "$flujo"
fi
for f in "$@"; do [ -f "$f" ] || { echo "ERROR: falta $f" >&2; exit 1; }; done
if grep -n PENDIENTE-TAREA-10 "$@" >&2; then
  echo "ERROR: quedan marcadores PENDIENTE-TAREA-10: la Tarea 10 no está cerrada." >&2
  exit 1
fi
echo "Sin marcadores pendientes."
