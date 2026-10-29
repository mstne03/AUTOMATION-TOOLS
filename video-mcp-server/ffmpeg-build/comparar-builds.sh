#!/usr/bin/env bash
# Reproducibilidad bit a bit (R0 M5): dos construcciones independientes (CI a/b, o CI y la máquina
# de Marc como testigo) deben dar los mismos ffmpeg.exe y ffprobe.exe.
#   comparar-builds.sh <dirA> <dirB>
# Cada SHA256SUMS debe listar exactamente ffmpeg.exe y ffprobe.exe y corresponder a sus ficheros;
# luego se comparan entre sí y, si difieren, se nombran los ficheros distintos (el triage con
# diffoscope es manual, Tarea 10).
# No hay residuo aceptado: cualquier byte distinto falla. Aceptar uno exige una lista cerrada de
# secciones/offsets PE documentada aquí, con su test (R0 M5).
set -euo pipefail
[ $# -eq 2 ] || { echo "Uso: $0 <dirA> <dirB>" >&2; exit 2; }
for d in "$1" "$2"; do
  [ -f "$d/SHA256SUMS" ] || { echo "ERROR: falta $d/SHA256SUMS" >&2; exit 1; }
  [ "$(awk '{sub(/^[*]/, "", $2); print $2}' "$d/SHA256SUMS" | sort | paste -sd' ' -)" = "ffmpeg.exe ffprobe.exe" ] \
    || { echo "ERROR: $d/SHA256SUMS debe listar exactamente ffmpeg.exe y ffprobe.exe" >&2; exit 1; }
  (cd "$d" && sha256sum -c --quiet SHA256SUMS) || { echo "ERROR: SHA256SUMS no corresponde a los ficheros de $d" >&2; exit 1; }
done
if cmp -s "$1/SHA256SUMS" "$2/SHA256SUMS"; then
  echo "Reproducible: construcciones idénticas."; cat "$1/SHA256SUMS"; exit 0
fi
for f in ffmpeg.exe ffprobe.exe; do cmp -s "$1/$f" "$2/$f" || echo "distinto: $f"; done
echo "ERROR: las construcciones NO son idénticas" >&2
exit 1
