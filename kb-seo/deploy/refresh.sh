#!/usr/bin/env bash
# Refresco diario de la KB publica en el VPS. Lo lanza kb-seo-refresh.timer como `marc`.
#
#   ingest all  -> fichero de trabajo SQLite (KB_SQLITE_PATH, en .env)
#   ingest prune-> borra lo que ya no esta en sources.yaml
#   kb-export   -> dist/kb-public.sqlite + manifest.json (atomico)
#   kb-sign     -> dist/manifest.json.minisig (clave en keys/kb.key, 0600)
#   publicar    -> copia a /var/www/kb de forma atomica (temporal + mv), manifest el ultimo
#
# Si falla una fuente, `ingest all` devuelve 1 pero el resto sigue: una fuente caida no
# debe dejar a los clientes sin actualizaciones de las demas.
set -u
BASE="${KB_BASE:-$HOME/kb-seo}"
APP="$BASE/app"
DIST="$BASE/dist"
KEY="$BASE/keys/kb.key"
WWW="${KB_WWW:-/var/www/kb}"
UV="${UV:-$HOME/.local/bin/uv}"

cd "$APP" || exit 1
echo "== $(date -Is) ingest all"
"$UV" run ingest all || echo "AVISO: alguna fuente fallo (ver arriba); se continua."
"$UV" run ingest prune || exit 1
echo "== kb-export"
"$UV" run kb-export --out "$DIST" || exit 1
echo "== kb-sign"
"$UV" run kb-sign sign --key "$KEY" "$DIST/manifest.json" || exit 1

echo "== publicar en $WWW"
mkdir -p "$WWW" || exit 1
for f in kb-public.sqlite manifest.json.minisig manifest.json; do
    cp "$DIST/$f" "$WWW/.$f.tmp" && chmod 644 "$WWW/.$f.tmp" && mv -f "$WWW/.$f.tmp" "$WWW/$f" || exit 1
done
echo "== hecho: $(grep '"version"' "$WWW/manifest.json")"
