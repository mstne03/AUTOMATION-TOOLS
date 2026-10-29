#!/usr/bin/env bash
# Ejecuta todos los tests de ffmpeg-build (sin red y sin Docker). Sale ≠ 0 si alguno falla.
#   bash tests/run.sh             tests normales: los marcadores PENDIENTE-TAREA-10 se toleran
#   bash tests/run.sh --estricto  además exige que no quede ninguno (cierre de la Tarea 10)
# Los tests de verificar-binario solo corren con FFMPEG_DIR apuntando a un ffmpeg.exe de Windows.
set -uo pipefail
cd "$(dirname "$0")"
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
