#!/usr/bin/env bash
# Reproducibilidad bit a bit (R0 M5): dos construcciones independientes (CI a/b, o CI y la máquina
# de Marc como testigo) deben dar los mismos ffmpeg.exe y ffprobe.exe.
#   comparar-builds.sh <dirA> <dirB>
# Cada SHA256SUMS se comprueba contra sus propios ficheros y luego se comparan entre sí. Si
# difieren, nombra los ficheros y, si diffoscope está instalado, muestra la diferencia.
# No hay residuo aceptado: cualquier byte distinto falla. Aceptar uno exige una lista cerrada de
# secciones/offsets PE documentada aquí, con su test (R0 M5).
set -euo pipefail
[ $# -eq 2 ] || { echo "Uso: $0 <dirA> <dirB>" >&2; exit 2; }
for d in "$1" "$2"; do
  [ -f "$d/SHA256SUMS" ] || { echo "ERROR: falta $d/SHA256SUMS" >&2; exit 1; }
  (cd "$d" && sha256sum -c --quiet SHA256SUMS) || { echo "ERROR: SHA256SUMS no corresponde a los ficheros de $d" >&2; exit 1; }
done
if cmp -s "$1/SHA256SUMS" "$2/SHA256SUMS"; then
  echo "Reproducible: construcciones idénticas."; cat "$1/SHA256SUMS"; exit 0
fi
while read -r _ f; do
  cmp -s "$1/$f" "$2/$f" && continue
  echo "distinto: $f"
  if command -v diffoscope >/dev/null 2>&1; then diffoscope --text - "$1/$f" "$2/$f" | head -200 || true; fi
done <"$1/SHA256SUMS"
echo "ERROR: las construcciones NO son idénticas" >&2
exit 1
