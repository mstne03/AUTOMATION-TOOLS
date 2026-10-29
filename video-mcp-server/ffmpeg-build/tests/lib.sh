# Ayudas mínimas para los tests de ffmpeg-build (se cargan con `source`).
# Cada test cuenta sus fallos en FALLOS y termina con `fin`, que sale ≠ 0 si hubo alguno.
FALLOS=0
DIR_BUILD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR_REPO="$(cd "$DIR_BUILD/../.." && pwd)"

ok() { echo "  ok    $1"; }
mal() { echo "  FALLO $1"; FALLOS=$((FALLOS + 1)); }

# afirmar "descripción" comando…  → el comando debe salir con 0.
afirmar() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else mal "$d"; fi; }
# negar "descripción" comando…  → el comando debe salir con ≠ 0.
negar() { local d=$1; shift; if "$@" >/dev/null 2>&1; then mal "$d"; else ok "$d"; fi; }

# ejecutar comando… → deja la salida (stdout+stderr) en SALIDA y el código en CODIGO.
ejecutar() { set +e; SALIDA=$("$@" 2>&1); CODIGO=$?; set -e; }

# Directorio temporal propio del test, borrado al salir.
temporal() {
  TMP_TEST=$(mktemp -d)
  trap 'rm -rf "$TMP_TEST"' EXIT
}

fin() { if [ "$FALLOS" -gt 0 ]; then echo "  $FALLOS fallo(s)"; exit 1; fi; }
