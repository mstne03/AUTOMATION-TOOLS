#!/usr/bin/env bash
# Reproducibilidad: dos construcciones independientes deben dar exactamente los mismos bytes.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
C="$DIR_BUILD/comparar-builds.sh"

construccion() { # construccion <dir> <byte final de ffprobe.exe>
  mkdir -p "$TMP_TEST/$1"
  printf 'MZ-ffmpeg' >"$TMP_TEST/$1/ffmpeg.exe"; printf 'MZ-ffprobe%s' "$2" >"$TMP_TEST/$1/ffprobe.exe"
  (cd "$TMP_TEST/$1" && sha256sum ffmpeg.exe ffprobe.exe >SHA256SUMS)
}
construccion a x; construccion b x; construccion c y

afirmar "dos construcciones idénticas → 0" bash "$C" "$TMP_TEST/a" "$TMP_TEST/b"
ejecutar bash "$C" "$TMP_TEST/a" "$TMP_TEST/c"
if [ "$CODIGO" -ne 0 ] && grep -q ffprobe.exe <<<"$SALIDA" && ! grep -q 'distinto: ffmpeg.exe' <<<"$SALIDA"; then
  ok "un byte distinto → ≠ 0 y nombra solo ffprobe.exe"
else mal "diferencia no detectada bien: $SALIDA"; fi

# SHA256SUMS que no corresponde a los ficheros (artefacto manipulado) → ≠ 0.
construccion d x; printf 'otro' >>"$TMP_TEST/d/ffmpeg.exe"
negar "SHA256SUMS que no cuadra con el .exe → ≠ 0" bash "$C" "$TMP_TEST/a" "$TMP_TEST/d"
negar "construcción sin SHA256SUMS → ≠ 0" bash "$C" "$TMP_TEST/a" "$TMP_TEST/no-existe"
# SHA256SUMS que lista otra cosa (R1 LOW-8): uno de más o uno de menos → ≠ 0.
construccion e x; printf 'z' >"$TMP_TEST/e/otro.dll"; (cd "$TMP_TEST/e" && sha256sum ffmpeg.exe ffprobe.exe otro.dll >SHA256SUMS)
negar "SHA256SUMS con un fichero de más → ≠ 0" bash "$C" "$TMP_TEST/a" "$TMP_TEST/e"
construccion g x; (cd "$TMP_TEST/g" && sha256sum ffmpeg.exe >SHA256SUMS)
negar "SHA256SUMS sin ffprobe.exe → ≠ 0" bash "$C" "$TMP_TEST/g" "$TMP_TEST/a"

fin
