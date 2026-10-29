#!/usr/bin/env bash
# descargar-fuentes.sh sin red: claves GPG desechables, tarballs falsos y repos git locales.
# Casos del plan (a)–(g) y del R0 (h, anclaje, canal2).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
D="$DIR_BUILD/descargar-fuentes.sh"
T=$TMP_TEST
mkdir -p "$T/origen" "$T/claves-buena" "$T/claves-ambas" "$T/claves-otra"

# --- Dos claves desechables: K1 (la buena) y K2 (otra) -------------------------------------
export GNUPGHOME="$T/gnupg"; mkdir -p "$GNUPGHOME"
gpg --batch --quiet --passphrase '' --quick-gen-key "Buena <b@ejemplo.invalid>" ed25519 sign never 2>/dev/null
gpg --batch --quiet --passphrase '' --quick-gen-key "Otra <o@ejemplo.invalid>" ed25519 sign never 2>/dev/null
huella() { gpg --batch --with-colons --list-keys "$1" 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}'; }
K1=$(huella b@ejemplo.invalid); K2=$(huella o@ejemplo.invalid)
gpg --batch --armor --export "$K1" >"$T/claves-buena/paq.asc"
gpg --batch --armor --export "$K2" >"$T/claves-otra/paq.asc"
gpg --batch --armor --export "$K1" "$K2" >"$T/claves-ambas/paq.asc"

# --- Tarball falso firmado por K1, y una copia firmada por K2 ---------------------------------
head -c 4096 /dev/urandom >"$T/origen/paq-1.0.tar.xz"
SHA=$(sha256sum "$T/origen/paq-1.0.tar.xz" | cut -d' ' -f1)
gpg --batch --yes --local-user "$K1" --armor --detach-sign -o "$T/origen/paq-1.0.tar.xz.asc" "$T/origen/paq-1.0.tar.xz"
mkdir -p "$T/origen-k2"; cp "$T/origen/paq-1.0.tar.xz" "$T/origen-k2/"
gpg --batch --yes --local-user "$K2" --armor --detach-sign -o "$T/origen-k2/paq-1.0.tar.xz.asc" "$T/origen/paq-1.0.tar.xz"
gpgconf --kill all 2>/dev/null || true
unset GNUPGHOME

URL=https://ejemplo.invalid/rel/paq-1.0.tar.xz
ANC="debian:paq=$K1;https://otro.invalid/paq.html=$K1"

# --- Repo git local con dos commits y una etiqueta en el segundo; un espejo y un espejo falso -
g() { git -C "$1" -c core.autocrlf=false -c user.name=t -c user.email=t@ejemplo.invalid -c commit.gpgsign=false -c tag.gpgsign=false "${@:2}"; }
git init -q "$T/origen/repo.git"
mkdir -p "$T/origen/repo.git/inc"; echo uno >"$T/origen/repo.git/inc/a.h"
g "$T/origen/repo.git" add -A; g "$T/origen/repo.git" commit -qm uno
C1=$(git -C "$T/origen/repo.git" rev-parse HEAD)
echo dos >"$T/origen/repo.git/inc/a.h"; g "$T/origen/repo.git" commit -qam dos; g "$T/origen/repo.git" tag v2
C2=$(git -C "$T/origen/repo.git" rev-parse HEAD)
GSHA=$(git -C "$T/origen/repo.git" -c core.autocrlf=false archive --format=tar "$C2" inc | sha256sum | cut -d' ' -f1)
git clone -q "$T/origen/repo.git" "$T/origen/espejo.git"
git clone -q "$T/origen/repo.git" "$T/origen/espejo-falso.git"
g "$T/origen/espejo-falso.git" tag -f v2 "$C1" >/dev/null
GURL=https://ejemplo.invalid/org/repo.git

# --- Ayudas ---------------------------------------------------------------------------------
fila() { local IFS=$'\t'; echo "$*"; }
lock() { { echo "# nombre	version	tipo	url	sha256	commit	ruta	firma_url	huella	anclaje	canal2"; for f in "$@"; do echo "$f"; done; } >"$T/fuentes.lock"; }
correr() { # correr <claves> <origen> [args…] → CODIGO/SALIDA; salida limpia en $T/salida
  rm -rf "$T/salida"
  ejecutar bash "$D" --lock "$T/fuentes.lock" --claves "$1" --directorio-origen "$2" --salida "$T/salida" "${@:3}"
}
debe_ir() { if [ "$CODIGO" -eq 0 ]; then ok "$1"; else mal "$1: $SALIDA"; fi; }
debe_fallar() { # debe_fallar <desc> [<texto esperado>]
  if [ "$CODIGO" -ne 0 ] && { [ -z "${2:-}" ] || grep -qi -- "$2" <<<"$SALIDA"; }; then ok "$1"; else mal "$1 (código $CODIGO): $SALIDA"; fi
  if [ -n "$(ls -A "$T/salida" 2>/dev/null)" ]; then mal "$1: dejó ficheros en --salida"; fi
}
BUENA=$(fila paq 1.0 tar "$URL" "$SHA" - - "$URL.asc" "$K1" "$ANC" -)
GIT_OK=$(fila cab v2 git "$GURL" "$GSHA" "$C2" inc - - - https://espejo.invalid/x/espejo.git)

# (a) Todo correcto → 0, y el tarball, su firma y el git archive acaban en --salida.
lock "$BUENA" "$GIT_OK"; correr "$T/claves-buena" "$T/origen"
debe_ir "(a) tarball firmado + git fijado → 0"
afirmar "(a) tarball y .asc en --salida" test -f "$T/salida/paq-1.0.tar.xz" -a -f "$T/salida/paq-1.0.tar.xz.asc"
afirmar "(a) git archive en --salida con el SHA-256 fijado" bash -c "echo '$GSHA  $T/salida/cab-v2.tar' | sha256sum -c -"

# (b) Tarball alterado → ≠ 0 y no queda en --salida.
cp -r "$T/origen" "$T/origen-b"; printf x >>"$T/origen-b/paq-1.0.tar.xz"
lock "$BUENA"; correr "$T/claves-buena" "$T/origen-b"; debe_fallar "(b) tarball alterado → ≠ 0" sha-256

# (c) Firma válida de otra clave (K2) cuando la huella fijada es K1 → ≠ 0.
lock "$BUENA"; correr "$T/claves-ambas" "$T/origen-k2"; debe_fallar "(c) firma de otra clave → ≠ 0" huella

# (d) La fila exige firma y no hay .asc → ≠ 0.
mkdir -p "$T/origen-d"; cp "$T/origen/paq-1.0.tar.xz" "$T/origen-d/"
lock "$BUENA"; correr "$T/claves-buena" "$T/origen-d"; debe_fallar "(d) sin firma donde se exige → ≠ 0"

# (e) Una celda PENDIENTE → ≠ 0 antes de descargar nada.
lock "$(fila paq 1.0 tar "$URL" PENDIENTE-TAREA-10 - - "$URL.asc" "$K1" "$ANC" -)"
correr "$T/claves-buena" "$T/origen"; debe_fallar "(e) PENDIENTE-TAREA-10 → ≠ 0" PENDIENTE

# (f) URL http:// → ≠ 0.
lock "$(fila paq 1.0 tar "http://ejemplo.invalid/rel/paq-1.0.tar.xz" "$SHA" - - "$URL.asc" "$K1" "$ANC" -)"
correr "$T/claves-buena" "$T/origen"; debe_fallar "(f) URL http:// → ≠ 0" https

# (g) git: la etiqueta apunta a otro commit que el fijado → ≠ 0.
lock "$(fila cab v2 git "$GURL" "$GSHA" "$C1" inc - - - https://espejo.invalid/x/espejo.git)"
correr "$T/claves-buena" "$T/origen"; debe_fallar "(g) commit distinto del de la etiqueta → ≠ 0" commit

# (h) Firma válida de K2, huella K2, pero el anclaje confirma K1 → ≠ 0 (R0 H1).
lock "$(fila paq 1.0 tar "$URL" "$SHA" - - "$URL.asc" "$K2" "$ANC" -)"
correr "$T/claves-otra" "$T/origen-k2"; debe_fallar "(h) huella que el anclaje no confirma → ≠ 0" anclaje

# Anclaje: un solo canal, un keyserver o el host de descarga no cuentan (R0 H1).
lock "$(fila paq 1.0 tar "$URL" "$SHA" - - "$URL.asc" "$K1" "debian:paq=$K1" -)"
correr "$T/claves-buena" "$T/origen"; debe_fallar "anclaje con un solo canal → ≠ 0" anclaje
lock "$(fila paq 1.0 tar "$URL" "$SHA" - - "$URL.asc" "$K1" "debian:paq=$K1;https://keys.openpgp.org/x=$K1" -)"
correr "$T/claves-buena" "$T/origen"; debe_fallar "anclaje en un keyserver → ≠ 0" anclaje
lock "$(fila paq 1.0 tar "$URL" "$SHA" - - "$URL.asc" "$K1" "debian:paq=$K1;https://ejemplo.invalid/claves.html=$K1" -)"
correr "$T/claves-buena" "$T/origen"; debe_fallar "anclaje en el host de descarga → ≠ 0" anclaje

# Sin firma: hace falta un segundo canal (L1). git: el espejo debe dar el mismo commit.
lock "$(fila cab v2 git "$GURL" "$GSHA" "$C2" inc - - - -)"
correr "$T/claves-buena" "$T/origen"; debe_fallar "git sin canal2 → ≠ 0" canal2
lock "$(fila cab v2 git "$GURL" "$GSHA" "$C2" inc - - - https://espejo.invalid/x/espejo-falso.git)"
correr "$T/claves-buena" "$T/origen"; debe_fallar "espejo con otra etiqueta → ≠ 0" commit

# La puerta va antes de la red: con una fila mala no se descarga ni la buena.
lock "$BUENA" "$(fila cab v2 git "$GURL" PENDIENTE-TAREA-10 "$C2" inc - - - https://espejo.invalid/x/espejo.git)"
correr "$T/claves-buena" "$T/origen"; debe_fallar "una fila PENDIENTE detiene todas las descargas" PENDIENTE

# --arranque (Tarea 10): acepta PENDIENTE, calcula el SHA-256 y no escribe en --salida.
lock "$(fila paq 1.0 tar "$URL" PENDIENTE-TAREA-10 - - "$URL.asc" PENDIENTE-TAREA-10 PENDIENTE-TAREA-10 -)"
correr "$T/claves-buena" "$T/origen" --arranque
if [ "$CODIGO" -eq 0 ] && grep -q "$SHA" <<<"$SALIDA"; then ok "--arranque imprime el SHA-256"; else mal "--arranque: $SALIDA"; fi
afirmar "--arranque no escribe en --salida" test ! -e "$T/salida"

fin
