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

echo "== Retirada de GSAP (I12, R2-L2)"
# El bloque real del script, entre LICENCIA_GSAP= y su comprobación, sobre un árbol simulado.
BLOQUE_GSAP=$(sed -n '/^LICENCIA_GSAP=/,/^\[ "\$rc" -eq 1 \]/p' "$SCRIPT")
grep -q 'rm -rf "\$HF_APP/vendor/npm" "\$HF_APP/studio"' <<<"$BLOQUE_GSAP" || mal "no pude extraer el bloque de GSAP"
CABECERA='/*! GSAP 3.15.0 https://gsap.com | Copyright 2008-2025, GreenSock. Subject to https://gsap.com/standard-license */'
arbol_gsap() {
  rm -rf "$DEST"
  mkdir -p "$HF/dist/vendor/npm/gsap@3.15.0/dist" "$HF/dist/studio/assets"
  printf '%s\n' "$CABECERA" >"$HF/dist/vendor/npm/gsap@3.15.0/dist/gsap.min.js"
  printf '%s\n' "$CABECERA" >"$HF/dist/studio/assets/index.js"
  # Como chunk-2MLMO25E.js: nombra GreenSock sin llevar la cabecera de licencia; no debe hacer saltar la puerta.
  printf 'const detector = /GreenSock|gsap/;\n' >"$HF/dist/chunk-detector.js"
}
# probar_gsap "descripción" CÓDIGO_ESPERADO TEXTO_ESPERADO: en un subproceso, porque `falla` hace exit.
probar_gsap() {
  local salida codigo=0
  salida=$( (eval "$BLOQUE_GSAP") 2>&1) || codigo=$?
  if [ "$codigo" = "$2" ] && grep -q "$3" <<<"$salida"; then ok "$1"; else mal "$1 (código $codigo): $salida"; fi
}
arbol_gsap
probar_gsap "retira vendor/npm y studio y la puerta pasa" 0 ""
if [ -e "$HF/dist/vendor/npm" ] || [ -e "$HF/dist/studio" ] || [ ! -f "$HF/dist/chunk-detector.js" ]; then
  mal "el árbol no quedó como debe tras la retirada"
else ok "solo se borra lo de Studio; el chunk que nombra GreenSock se queda"; fi
arbol_gsap
mkdir -p "$HF/dist/otro" && printf '%s\n' "$CABECERA" >"$HF/dist/otro/gsap.js"
probar_gsap "una copia de GSAP fuera de vendor/studio aborta" 1 "el bundle lleva GSAP"
arbol_gsap
rm "$HF/dist/vendor/npm/gsap@3.15.0/dist/gsap.min.js"
probar_gsap "sin la copia de muestra el control positivo aborta" 1 "no ve la copia de muestra"
gsap=$(grep -n -m1 '^LICENCIA_GSAP=' "$SCRIPT" | cut -d: -f1 || true)
if [ -n "$gsap" ] && [ -n "$llamada" ] && [ "$llamada" -lt "$gsap" ]; then ok "se retira tras aplicar el parche"; else
  mal "orden: parche=$llamada gsap=$gsap"
fi

if [ "$FALLOS" -gt 0 ]; then echo "$FALLOS fallo(s)"; exit 1; fi
echo "Todos los tests pasan."
