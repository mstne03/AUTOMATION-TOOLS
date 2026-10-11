#!/usr/bin/env bash
# Parte del despliegue en el VPS que necesita root. Se ejecuta UNA vez:
#
#     sudo bash /home/marc/kb-seo/app/deploy/install.sh
#
# Todo lo demas (venv, Chromium, claves, timer de usuario, primera ejecucion) lo hace
# deploy/setup-user.sh como marc, sin sudo. Idempotente: se puede repetir.
set -eu
USUARIO="${KB_USER:-marc}"
APP="/home/$USUARIO/kb-seo/app"
WWW="/var/www/kb"
DOMINIO="kb.mstne.dev"

echo "== 1. Librerias de sistema de Chromium headless (faltaban libnss3 y libnspr4)"
# Como root, el playwright del venv de marc instala con apt lo que falte.
"$APP/.venv/bin/playwright" install-deps chromium \
    || apt-get install -y --no-install-recommends libnss3 libnspr4

echo "== 2. $WWW, propiedad de $USUARIO (asi el timer publica sin sudo); nginx solo lee"
install -d -o "$USUARIO" -g "$USUARIO" -m 755 "$WWW"
# Instalador y latest.json de la app de escritorio (deploy/publish-app.sh).
install -d -o "$USUARIO" -g "$USUARIO" -m 755 /var/www/app

echo "== 3. Nginx: $DOMINIO (estatico, solo lectura)"
install -o root -g root -m 644 "$APP/deploy/nginx-$DOMINIO.conf" "/etc/nginx/sites-available/$DOMINIO"
ln -sf "/etc/nginx/sites-available/$DOMINIO" "/etc/nginx/sites-enabled/$DOMINIO"
nginx -t
systemctl reload nginx

echo "== 4. TLS con certbot (anade el bloque 443 y la redireccion)"
if [ ! -d "/etc/letsencrypt/live/$DOMINIO" ]; then
    certbot --nginx -d "$DOMINIO" --non-interactive --agree-tos --keep-until-expiring \
        --email "$(grep -m1 -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' /etc/letsencrypt/renewal/*.conf 2>/dev/null | head -1 || true)" \
        || certbot --nginx -d "$DOMINIO" --non-interactive --agree-tos --register-unsafely-without-email
fi

echo "== 5. Linger: las unidades de usuario de $USUARIO corren sin sesion abierta"
loginctl enable-linger "$USUARIO"

echo "== listo. Ahora, como $USUARIO: bash $APP/deploy/setup-user.sh"
