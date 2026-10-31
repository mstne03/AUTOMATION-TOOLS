#!/usr/bin/env bash
# parchear_hyperframes de prepare-video-engine.sh, sin red: extrae la función y la prueba sobre un árbol
# simulado (parche de una línea) dentro de un repo git, como el bundle dentro del checkout.
#   bash app-ui/scripts/prepare-video-engine.test.sh
set -euo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/prepare-video-engine.sh"
APLICAR="$(dirname "$SCRIPT")/../../video-mcp-server/scripts/aplicar-parche.mjs"
FALLOS=0
ok() { echo "  ok    $1"; }
mal() { echo "  FALLO $1"; FALLOS=$((FALLOS + 1)); }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git init -q "$TMP"
mkdir -p "$TMP/app-ui" "$TMP/video-mcp-server/scripts" "$TMP/video-mcp-server/patches"
cd "$TMP/app-ui"

HYPERFRAMES_VERSION=0.8.206
MOTOR=../video-mcp-server
DEST=src-tauri/binaries/video-engine
HF=$DEST/app/node_modules/hyperframes
JSON=$MOTOR/patches/hyperframes+$HYPERFRAMES_VERSION.sha256.json
eval "$(sed -n -e '/^falla()/p' -e '/^parchear_hyperframes()/,/^}/p' "$SCRIPT")"
declare -F parchear_hyperframes falla >/dev/null || { echo "No pude extraer las funciones de $SCRIPT"; exit 1; }

cat >"$MOTOR/patches/hyperframes+$HYPERFRAMES_VERSION.patch" <<'FIN'
diff --git a/node_modules/hyperframes/dist/cli.js b/node_modules/hyperframes/dist/cli.js
--- a/node_modules/hyperframes/dist/cli.js
+++ b/node_modules/hyperframes/dist/cli.js
@@ -1 +1 @@
-original
+parcheado
FIN
SHA_CLI=$(printf 'parcheado\n' | sha256sum | cut -d' ' -f1)
SHA_BIN=$(printf 'bin\n' | sha256sum | cut -d' ' -f1)
printf '{"version":"%s","ficheros":{"dist/cli.js":"%s"},"sinParche":{"bin/hyperframes.mjs":"%s"}}\n' \
  "$HYPERFRAMES_VERSION" "$SHA_CLI" "$SHA_BIN" >"$JSON"

# Árbol del bundle recién salido de npm ci: sin parche.
arbol() {
  rm -rf "$DEST"
  mkdir -p "$HF/dist" "$HF/bin"
  printf '{"version":"%s"}\n' "$HYPERFRAMES_VERSION" >"$HF/package.json"
  printf 'original\n' >"$HF/dist/cli.js"
  printf 'bin\n' >"$HF/bin/hyperframes.mjs"
}
# probar "descripción" CÓDIGO_ESPERADO TEXTO_ESPERADO CONTENIDO_FINAL_DE_CLI: en un subproceso, porque
# `falla` hace exit.
probar() {
  local salida codigo=0
  salida=$(parchear_hyperframes 2>&1) || codigo=$?
  if [ "$codigo" = "$2" ] && grep -q "$3" <<<"$salida" && [ "$(cat "$HF/dist/cli.js")" = "$4" ]; then ok "$1"; else
    mal "$1 (código $codigo, cli.js: $(cat "$HF/dist/cli.js")): $salida"
  fi
}

echo "== parchear_hyperframes"
cp "$APLICAR" "$MOTOR/scripts/aplicar-parche.mjs"

arbol
probar "aplica el parche dentro de un repo (GIT_CEILING_DIRECTORIES)" 0 "" parcheado
probar "repetirlo es idempotente" 0 "" parcheado

arbol
printf '{"version":"0.0.1"}\n' >"$HF/package.json"
probar "otra versión de hyperframes aborta antes de aplicar" 1 "no trae hyperframes" original

arbol
printf 'otra cosa\n' >"$HF/dist/cli.js"
probar "un dist que no casa con el parche aborta" 1 "no se aplicó" "otra cosa"

arbol
printf 'bin cambiado\n' >"$HF/bin/hyperframes.mjs"
probar "un fichero sinParche con otro hash aborta" 1 "SHA-256 inesperado" parcheado

echo "== Negativo real (R0 M10): sin GIT_CEILING_DIRECTORIES git se salta el parche en silencio"
sed -e 's/GIT_CEILING_DIRECTORIES: path.dirname(raiz)//' "$APLICAR" >"$MOTOR/scripts/aplicar-parche.mjs"
if cmp -s "$APLICAR" "$MOTOR/scripts/aplicar-parche.mjs"; then mal "la copia conserva el techo"; else ok "la copia no lleva el techo"; fi
arbol
probar "el SHA-256 lo detecta y aborta, con el dist sin tocar" 1 "SHA-256 inesperado" original

echo "== Lugar de la llamada en el script"
linea() { grep -nx -m1 -- "$1" "$SCRIPT" | cut -d: -f1 || true; }
ci=$(linea '(cd "$DEST/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)')
llamada=$(linea 'parchear_hyperframes')
borrado=$(linea 'rm "$DEST/app/package-lock.json"')
if [ -n "$ci" ] && [ -n "$llamada" ] && [ "$ci" -lt "$llamada" ] && [ "$llamada" -lt "$borrado" ]; then
  ok "se llama tras el npm ci de producción"
else
  mal "orden: npm ci=$ci llamada=$llamada borrado=$borrado"
fi

if [ "$FALLOS" -gt 0 ]; then echo "$FALLOS fallo(s)"; exit 1; fi
echo "Todos los tests pasan."
