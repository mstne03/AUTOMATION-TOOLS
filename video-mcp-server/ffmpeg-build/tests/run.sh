#!/usr/bin/env bash
# Ejecuta todos los tests de ffmpeg-build (sin red y sin Docker). Sale ≠ 0 si alguno falla.
#   bash tests/run.sh             tests normales: los marcadores PENDIENTE-TAREA-10 se toleran
#   bash tests/run.sh --estricto  ESTRICTO=1: pendientes, dockerfile y workflow dejan de tolerar el
#                                 marcador en fuentes.lock, Dockerfile y acciones (cierre de la
#                                 Tarea 10). autoseleccionados.txt lo vigila verificar-binario.sh.
# La parte de verificar-binario que ejecuta el .exe solo corre con FFMPEG_DIR (ffmpeg.exe de Windows).
set -uo pipefail
cd "$(dirname "$0")" || exit 1
export ESTRICTO=0
[ "${1:-}" = "--estricto" ] && ESTRICTO=1

fallidos=()
for t in ./*.test.sh; do
  echo "== ${t#./}"
  bash "$t" || fallidos+=("${t#./}")
done

if [ ${#fallidos[@]} -gt 0 ]; then
  echo "FALLAN: ${fallidos[*]}"
  exit 1
fi
echo "Todos los tests pasan."
