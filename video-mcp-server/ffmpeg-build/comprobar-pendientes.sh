#!/usr/bin/env bash
# Puerta previa a cualquier construcción real: sale ≠ 0 y lista dónde, si en las entradas del
# build queda algún marcador PENDIENTE-TAREA-10 (hashes, digest, snapshot, SHA de acciones…).
#   comprobar-pendientes.sh [fichero…]   (sin argumentos: las entradas reales del build)
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ $# -eq 0 ]; then
  set -- "$AQUI/fuentes.lock" "$AQUI/Dockerfile" "$AQUI/componentes.conf" \
    "$AQUI/../../.github/workflows/ffmpeg-lgpl.yml"
fi
for f in "$@"; do [ -f "$f" ] || { echo "ERROR: falta $f" >&2; exit 1; }; done
if grep -n PENDIENTE-TAREA-10 "$@" >&2; then
  echo "ERROR: quedan marcadores PENDIENTE-TAREA-10: la Tarea 10 no está cerrada." >&2
  exit 1
fi
echo "Sin marcadores pendientes."
