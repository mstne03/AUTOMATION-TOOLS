#!/usr/bin/env bash
# Imagen de construcción: base por digest, apt solo del snapshot fijado con versiones exactas,
# InRelease anclado (comprobar-inrelease.sh) y usuario no root. Estático: sin Docker ni red.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
DF="$DIR_BUILD/Dockerfile"
afirmar "existe el Dockerfile" test -f "$DF"
[ -f "$DF" ] || fin

marcador=PENDIENTE-TAREA-10
[ "${ESTRICTO:-0}" = 1 ] && marcador=NO-SE-ADMITE

# Base fijada por digest (o el marcador, que comprobar-pendientes.sh impide construir).
desde=$(grep -E '^FROM ' "$DF")
afirmar "un solo FROM" test "$(grep -c '^FROM ' "$DF")" -eq 1
if [[ "$desde" =~ @sha256:([0-9a-f]{64}|$marcador)$ ]]; then ok "FROM por digest"; else mal "FROM sin digest: $desde"; fi
negar "sin directiva # syntax= (bajaría otra imagen)" grep -qiE '^# *syntax=' "$DF"

# Nada móvil ni instaladores por tubería (sobre las instrucciones, no los comentarios).
grep -v '^[[:space:]]*#' "$DF" >"$TMP_TEST/instrucciones"
for p in ':latest' 'curl[^|]*\|[[:space:]]*(ba)?sh' 'wget[^|]*\|[[:space:]]*(ba)?sh' 'pip3? install' '\bnpm\b' '^ADD '; do
  negar "sin '$p'" grep -qE -- "$p" "$TMP_TEST/instrucciones"
done
negar "sin ENV con secretos" grep -qiE '^ENV .*(secret|token|password|passwd|clave|key)' "$TMP_TEST/instrucciones"

# apt: solo snapshot.debian.org con marca de tiempo fija, la misma que el InRelease de fuentes.lock.
mapfile -t marcas < <(grep -oE 'snapshot\.debian\.org/archive/debian/[^/ ]+/' "$DF" | sort -u)
afirmar "una sola marca de tiempo de snapshot" test "${#marcas[@]}" -eq 1
ts=$(sed -E 's|.*/debian/([^/]+)/|\1|' <<<"${marcas[0]:-}")
if [[ "$ts" =~ ^([0-9]{8}T[0-9]{6}Z|$marcador)$ ]]; then ok "marca de tiempo fija ($ts)"; else mal "marca de tiempo no válida: $ts"; fi
lock_url=$(awk -F'\t' '$3 == "apt" {print $4}' "$DIR_BUILD/fuentes.lock")
afirmar "la marca coincide con la del InRelease de fuentes.lock" grep -qF "/debian/$ts/" <<<"$lock_url"
negar "sin deb.debian.org ni security.debian.org" grep -qE '(deb|security)\.debian\.org' "$DF"
afirmar "las fuentes de la base se borran (solo el snapshot)" grep -q 'rm -f /etc/apt/sources.list.d/' "$DF"
afirmar "el grueso de paquetes va por https://snapshot" grep -q 'https://snapshot.debian.org' "$DF"
updates=$(grep -o 'apt-get update' "$DF" | wc -l)
comprobaciones=$(grep -o 'comprobar-inrelease.sh /var/lib/apt/lists' "$DF" | wc -l)
afirmar "cada apt-get update va seguido de comprobar-inrelease.sh" test "$updates" -ge 1 -a "$updates" -eq "$comprobaciones"
estrictos=$(grep -o 'apt-get update --error-on=any' "$DF" | wc -l)
afirmar "cada apt-get update con --error-on=any" test "$estrictos" -eq "$updates"
# R1 LOW-9 pedía apt sin redirecciones; snapshot.debian.org redirige todo (302 a /file/<sha1>) y la
# integridad la da el InRelease anclado. Lo que no se admite es relajar el salto https→http.
negar "apt sin AllowRedirect=false (snapshot redirige todo)" grep -q 'AllowRedirect=false' "$TMP_TEST/instrucciones"
for p in 'trusted=yes' 'allow-insecure' '--allow-unauthenticated' 'AllowInsecureRepositories' 'AllowDowngradeToInsecureRepositories' '--force-yes' 'Verify-Peer' 'AllowUnauthenticated'; do
  negar "apt sin '$p'" grep -qi -- "$p" "$TMP_TEST/instrucciones"
done

# Cada paquete con versión exacta: paquete=versión.
# Se unen las líneas con «\», se parte cada RUN por «&&» y se toman los argumentos de cada
# `apt-get install` que no son opciones.
paquetes=()
while IFS= read -r segmento; do
  read -ra palabras <<<"$segmento"
  [ "${palabras[0]:-}" = apt-get ] && [ "${palabras[1]:-}" = install ] || continue
  for w in "${palabras[@]:2}"; do [[ "$w" == -* ]] || paquetes+=("$w"); done
done < <(sed -e ':a' -e '/\\$/N; s/\\\n//; ta' "$DF" | grep -E '^RUN ' | sed -E 's/^RUN //; s/&&/\n/g' | sed -E 's/^[[:space:]]+//')
afirmar "hay paquetes instalados" test "${#paquetes[@]}" -gt 0
for p in "${paquetes[@]}"; do
  if [[ "$p" =~ ^[a-z0-9.+-]+=([0-9a-zA-Z.+~:-]+|$marcador)$ ]]; then ok "versión fijada: $p"; else mal "sin versión exacta: $p"; fi
done
for imprescindible in gcc-mingw-w64-x86-64-posix nasm meson ninja-build gpg curl git xz-utils ca-certificates; do
  afirmar "instala $imprescindible" grep -qE "(^| )$imprescindible=" <(printf '%s\n' "${paquetes[@]}")
done
afirmar "gcc de MinGW en variante posix" grep -qE 'update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix' "$DF"

# Usuario no root al final.
ultimo_user=$(grep -nE '^USER ' "$DF" | tail -1)
ultimo_run=$(grep -nE '^RUN ' "$DF" | tail -1 | cut -d: -f1)
afirmar "USER build (no root)" test "${ultimo_user#*:}" = "USER build"
afirmar "USER build después del último RUN" test "${ultimo_user%%:*}" -gt "${ultimo_run:-0}"
afirmar "UID 10001" grep -q 'useradd .*--uid 10001' "$DF"

# comprobar-inrelease.sh: Date ≤ marca de tiempo y SHA-256 igual al de fuentes.lock.
CI="$DIR_BUILD/comprobar-inrelease.sh"
printf 'Origin: Debian\nSuite: trixie\nDate: Tue, 14 Oct 2026 20:12:34 UTC\n' >"$TMP_TEST/InRelease"
sha=$(sha256sum "$TMP_TEST/InRelease" | cut -d' ' -f1)
fila() { printf 'debian-inrelease\ttrixie\tapt\thttps://snapshot.debian.org/archive/debian/%s/dists/trixie/InRelease\t%s\t-\t-\t-\t-\t-\t-\n' "$1" "$2" >"$TMP_TEST/lock"; }
fila 20261015T000000Z "$sha"; afirmar "InRelease anclado y anterior a la marca → 0" bash "$CI" "$TMP_TEST/InRelease" "$TMP_TEST/lock"
fila 20261014T000000Z "$sha"; negar "Date posterior a la marca de tiempo → ≠ 0" bash "$CI" "$TMP_TEST/InRelease" "$TMP_TEST/lock"
fila 20261015T000000Z "$(printf '0%.0s' {1..64})"; negar "SHA-256 distinto del de fuentes.lock → ≠ 0" bash "$CI" "$TMP_TEST/InRelease" "$TMP_TEST/lock"
fila PENDIENTE-TAREA-10 PENDIENTE-TAREA-10; negar "lock con PENDIENTE → ≠ 0" bash "$CI" "$TMP_TEST/InRelease" "$TMP_TEST/lock"

fin
