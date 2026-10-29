#!/usr/bin/env bash
# Orquesta una construcción completa en Docker (CI o la máquina de Marc como segundo testigo, M5):
#   construir.sh --fuentes DIR --salida DIR
# 1. Puerta: ningún PENDIENTE-TAREA-10 (antes de tocar la red).
# 2. Imagen fijada (digest + snapshot), sin caché de capas.
# 3. Descarga y verificación de fuentes, dentro de la imagen, con red.
# 4. Compilación en OTRO contenedor sin red; fuentes y scripts en solo lectura.
# Ambos contenedores: sin capacidades, no-new-privileges, raíz de solo lectura, usuario del host,
# sin socket de Docker ni el repo en escritura. --fuentes y --salida deben estar vacías.
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUENTES=""; SALIDA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fuentes) FUENTES=$2; shift 2 ;;
    --salida) SALIDA=$2; shift 2 ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done
[ -n "$FUENTES" ] && [ -n "$SALIDA" ] || { echo "Uso: $0 --fuentes DIR --salida DIR" >&2; exit 2; }

bash "$AQUI/comprobar-pendientes.sh"

mkdir -p "$FUENTES" "$SALIDA"
for d in "$FUENTES" "$SALIDA"; do [ -z "$(ls -A "$d")" ] || { echo "ERROR: $d no está vacía" >&2; exit 1; }; done

# En Git Bash (máquina de Marc), Docker necesita rutas de Windows y que MSYS no las reescriba.
ruta() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }
export MSYS_NO_PATHCONV=1
BUILD=$(ruta "$AQUI"); F=$(ruta "$(cd "$FUENTES" && pwd)"); S=$(ruta "$(cd "$SALIDA" && pwd)")
IMAGEN="seo-studio/ffmpeg-build:$(cat "$AQUI/Dockerfile" "$AQUI/fuentes.lock" | sha256sum | cut -c1-12)"
USUARIO="$(id -u):$(id -g)"

docker build --no-cache --pull -t "$IMAGEN" "$BUILD"

docker run --rm --cap-drop ALL --security-opt no-new-privileges --read-only \
  --user "$USUARIO" -e HOME=/tmp --tmpfs /tmp:rw,size=2g \
  -v "$BUILD:/build/ffmpeg-build:ro" -v "$F:/build/fuentes" \
  "$IMAGEN" bash /build/ffmpeg-build/descargar-fuentes.sh --salida /build/fuentes

docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only \
  --user "$USUARIO" -e HOME=/tmp --tmpfs /tmp:rw,exec,size=8g \
  -v "$BUILD:/build/ffmpeg-build:ro" -v "$F:/build/fuentes:ro" -v "$S:/build/out" \
  "$IMAGEN" bash /build/ffmpeg-build/compilar.sh

echo "Construcción en $SALIDA:"
cat "$SALIDA/SHA256SUMS"
