#!/usr/bin/env bash
# Parte del despliegue en el VPS que NO necesita root. Se ejecuta como marc tras install.sh
# (y se puede repetir: es idempotente). Deja el timer diario activo.
#
#     bash ~/kb-seo/app/deploy/setup-user.sh
set -eu
BASE="$HOME/kb-seo"
APP="$BASE/app"
UV="$HOME/.local/bin/uv"

echo "== 1. uv"
[ -x "$UV" ] || curl -LsSf https://astral.sh/uv/install.sh | sh

echo "== 2. venv con los extras del VPS (fastembed, sqlite-vec, playwright)"
cd "$APP"
"$UV" sync --extra browser
"$UV" run playwright install chromium

echo "== 3. .env del VPS (ingesta a SQLite; sin Postgres ni Ollama)"
if [ ! -f "$APP/.env" ]; then
    cat > "$APP/.env" <<EOF
KB_BACKEND=sqlite
KB_SQLITE_PATH=$BASE/kb-work.sqlite
EMBED_BACKEND=fastembed
EMBED_MODEL=intfloat/multilingual-e5-small
EMBED_DIM=384
EMBED_CACHE_DIR=$BASE/models
HF_HUB_DISABLE_SYMLINKS_WARNING=1
EOF
    chmod 600 "$APP/.env"
fi

echo "== 4. Clave de firma (solo si no existe; la secreta no sale de esta maquina)"
if [ ! -f "$BASE/keys/kb.key" ]; then
    "$UV" run kb-sign keygen --out "$BASE/keys"
    chmod 700 "$BASE/keys"
fi
echo "Clave publica (va embebida en app-backend/app_backend/config.py):"
tail -1 "$BASE/keys/kb.pub"

echo "== 5. Timer de usuario"
mkdir -p "$HOME/.config/systemd/user"
cp "$APP/deploy/kb-seo-refresh.service" "$APP/deploy/kb-seo-refresh.timer" "$HOME/.config/systemd/user/"
chmod +x "$APP/deploy/refresh.sh"
systemctl --user daemon-reload
systemctl --user enable --now kb-seo-refresh.timer
systemctl --user list-timers kb-seo-refresh.timer --no-pager

echo "== 6. Primera ejecucion (tarda unos minutos: descarga el modelo y renderiza 4 paginas)"
systemctl --user start kb-seo-refresh.service
journalctl --user -u kb-seo-refresh.service -n 30 --no-pager
