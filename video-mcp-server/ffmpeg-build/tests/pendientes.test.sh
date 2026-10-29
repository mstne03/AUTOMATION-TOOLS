#!/usr/bin/env bash
# Ningún PENDIENTE-TAREA-10 puede llegar a una construcción real.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
P="$DIR_BUILD/comprobar-pendientes.sh"

printf 'a\tb\nx\tPENDIENTE-TAREA-10\n' >"$TMP_TEST/con.lock"
printf 'a\tb\n' >"$TMP_TEST/sin.lock"
ejecutar bash "$P" "$TMP_TEST/con.lock" "$TMP_TEST/sin.lock"
if [ "$CODIGO" -ne 0 ] && grep -q 'con.lock:2' <<<"$SALIDA"; then ok "marcador → ≠ 0 y dice fichero:línea"; else mal "marcador no detectado: $SALIDA"; fi
afirmar "sin marcadores → 0" bash "$P" "$TMP_TEST/sin.lock"
negar "fichero de entrada ausente → ≠ 0" bash "$P" "$TMP_TEST/no-existe"

# El fuentes.lock real tiene la forma correcta; lo único que le puede faltar son los PENDIENTE.
ejecutar bash "$DIR_BUILD/descargar-fuentes.sh" --solo-validar
if [ "${ESTRICTO:-0}" = 1 ]; then
  if [ "$CODIGO" -eq 0 ]; then ok "fuentes.lock real válido"; else mal "fuentes.lock real: $SALIDA"; fi
  afirmar "--estricto: ningún PENDIENTE-TAREA-10 en las entradas del build" bash "$P"
else
  if [ "$CODIGO" -eq 0 ] || grep -q PENDIENTE <<<"$SALIDA"; then ok "fuentes.lock real: solo bloquean los PENDIENTE"; else mal "fuentes.lock real mal formado: $SALIDA"; fi
  echo "  (marcadores pendientes: $(grep -c PENDIENTE-TAREA-10 "$DIR_BUILD/fuentes.lock") en fuentes.lock; --estricto los prohíbe)"
fi

fin
