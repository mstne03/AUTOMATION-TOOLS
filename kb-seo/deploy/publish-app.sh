#!/usr/bin/env bash
# Publica una release de la app de escritorio en el VPS (https://kb.mstne.dev/app/):
# baja de la release de GitHub el -setup.exe, su .sig y latest.json, reescribe las URLs
# de latest.json para que apunten a este servidor y los deja en /var/www/app de forma
# atomica (latest.json es lo ultimo que se mueve: nadie ve una version a medio publicar).
#
#     GITHUB_REPO=owner/repo bash ~/kb-seo/app/deploy/publish-app.sh v0.2.0
#
# Variables: GITHUB_REPO (owner/repo, obligatoria), GITHUB_TOKEN (solo si el repo es privado),
# APP_URL (base publica, por defecto https://kb.mstne.dev/app), WWW (por defecto /var/www/app).
# Requiere curl y jq. El VPS no necesita ninguna clave: la firma la hizo GitHub Actions
# y la verifica cada cliente con la clave publica embebida en la app.
set -euo pipefail
TAG="${1:?uso: publish-app.sh vX.Y.Z}"
REPO="${GITHUB_REPO:?Falta GITHUB_REPO=owner/repo}"
APP_URL="${APP_URL:-https://kb.mstne.dev/app}"
WWW="${WWW:-/var/www/app}"
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "== Release $TAG de $REPO"
curl -fsSL "${AUTH[@]}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/releases/tags/$TAG" > "$TMP/release.json"
# Assets por nombre -> URL de la API (con token hay que pedir el asset por su id, no por browser_download_url).
jq -r '.assets[] | select(.name | test("-setup\\.exe(\\.sig)?$|^latest\\.json$")) | "\(.name)\t\(.url)"' "$TMP/release.json" \
    | while IFS=$'\t' read -r nombre url; do
        echo "   $nombre"
        curl -fsSL "${AUTH[@]}" -H "Accept: application/octet-stream" -o "$TMP/$nombre" "$url"
    done
[ -f "$TMP/latest.json" ] || { echo "La release no tiene latest.json (includeUpdaterJson en el workflow)" >&2; exit 1; }
SETUP=$(ls "$TMP"/*-setup.exe)
[ -f "$SETUP.sig" ] || { echo "Falta la firma $SETUP.sig" >&2; exit 1; }

echo "== latest.json apuntando a $APP_URL"
jq --arg base "$APP_URL/" '.platforms[].url |= ($base + (. | sub("^.*/"; "")))' "$TMP/latest.json" > "$TMP/latest.rewritten.json"
cat "$TMP/latest.rewritten.json"

echo "== Publicando en $WWW"
install -m 644 "$SETUP" "$SETUP.sig" "$WWW/"
install -m 644 "$TMP/latest.rewritten.json" "$WWW/latest.json.tmp"
mv -f "$WWW/latest.json.tmp" "$WWW/latest.json"
echo "Publicado: $(basename "$SETUP") y latest.json. Las versiones anteriores se conservan en $WWW; borralas a mano cuando sobren."
