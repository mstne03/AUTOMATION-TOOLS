#!/usr/bin/env bash
# Ancla el InRelease del snapshot de Debian (R0 M4): su SHA-256 debe ser el de la fila `apt` de
# fuentes.lock y su `Date:` no puede ser posterior a la marca de tiempo fijada en la URL.
#   comprobar-inrelease.sh <InRelease> <fuentes.lock>
set -euo pipefail
[ $# -eq 2 ] && [ -f "$1" ] && [ -f "$2" ] || { echo "Uso: $0 <InRelease> <fuentes.lock>" >&2; exit 2; }
error() { echo "ERROR: $*" >&2; exit 1; }

IFS=$'\t' read -r _ _ _ url sha _ < <(awk -F'\t' '$3 == "apt"' "$2")
ts=$(sed -E 's|.*/archive/debian/([^/]+)/.*|\1|' <<<"${url:-}")
[[ "$ts" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || error "marca de tiempo del snapshot no válida en fuentes.lock: '$ts'"
[[ "${sha:-}" =~ ^[0-9a-f]{64}$ ]] || error "SHA-256 del InRelease no válido en fuentes.lock"

real=$(sha256sum "$1" | cut -d' ' -f1)
[ "$real" = "$sha" ] || error "InRelease con SHA-256 $real, fijado $sha"

fecha=$(sed -n 's/^Date: //p' "$1" | head -1)
[ -n "$fecha" ] || error "InRelease sin Date:"
t_rel=$(date -u -d "$fecha" +%s)
t_fijo=$(date -u -d "${ts:0:4}-${ts:4:2}-${ts:6:2}T${ts:9:2}:${ts:11:2}:${ts:13:2}Z" +%s)
[ "$t_rel" -le "$t_fijo" ] || error "InRelease del $fecha, posterior a la marca $ts"
echo "InRelease anclado ($ts)."
