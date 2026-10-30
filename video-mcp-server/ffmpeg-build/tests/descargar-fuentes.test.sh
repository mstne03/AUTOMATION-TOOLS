#!/usr/bin/env bash
# descargar-fuentes.sh sin red: claves GPG desechables (también caducada, revocada y RSA con
# SHA-224), tarballs falsos, material de Debian de juguete y repos git locales.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
D="$DIR_BUILD/descargar-fuentes.sh"
T=$TMP_TEST
mkdir -p "$T/origen" "$T/deb"

# --- Claves desechables ------------------------------------------------------------------------
export GNUPGHOME="$T/gnupg"; mkdir -p "$GNUPGHOME"
gen() { gpg --batch --quiet --passphrase '' "${@:3}" --quick-gen-key "$1 <$2>" "${ALGO:-ed25519}" sign "${CADUCA:-never}" 2>/dev/null; }
huella() { gpg --batch --with-colons --list-keys "$1" 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}'; }
gen Buena b@x.invalid; gen Otra o@x.invalid
CADUCA=1d gen Caducada c@x.invalid --faked-system-time 20200101T000000
gen Revocada r@x.invalid
ALGO=rsa2048 gen Rsa s@x.invalid
K1=$(huella b@x.invalid); K2=$(huella o@x.invalid); KC=$(huella c@x.invalid); KR=$(huella r@x.invalid); KS=$(huella s@x.invalid)
claves() { mkdir -p "$T/claves-$1"; gpg --batch --armor --export "${@:2}" >"$T/claves-$1/paq.asc"; }
claves k1 "$K1"; claves k2 "$K2"; claves ambas "$K1" "$K2"; claves kc "$KC"; claves ks "$KS"

# Tarball y firmas: buena (K1), de otra clave (K2), caducada (KC firmó en 2020, cuando valía),
# revocada (KR), RSA con SHA-224 (KS) y una firma de K1 sobre OTRO contenido (BADSIG).
head -c 4096 /dev/urandom >"$T/tarball"
SHA=$(sha256sum <"$T/tarball" | cut -d' ' -f1)
firmar() { # firmar <dir-origen> <clave> [opciones gpg…]
  mkdir -p "$T/$1"; cp "$T/tarball" "$T/$1/paq-1.0.tar.xz"
  gpg --batch --yes --local-user "$2" "${@:3}" --armor --detach-sign -o "$T/$1/paq-1.0.tar.xz.asc" "$T/tarball" 2>/dev/null
}
firmar origen "$K1"; firmar o-k2 "$K2"; firmar o-kc "$KC" --faked-system-time 20200101T000100
firmar o-kr "$KR"; firmar o-ks "$KS" --digest-algo SHA224
mkdir -p "$T/o-bad"; cp "$T/tarball" "$T/o-bad/paq-1.0.tar.xz"; echo otro >"$T/otro"
gpg --batch --yes --local-user "$K1" --armor --detach-sign -o "$T/o-bad/paq-1.0.tar.xz.asc" "$T/otro" 2>/dev/null
# Revocación: el certificado que gpg deja en openpgp-revocs.d (con el «:» de seguridad quitado).
sed 's/^://' "$GNUPGHOME/openpgp-revocs.d/$KR.rev" | gpg --batch --quiet --import 2>/dev/null
claves kr "$KR"

# --- Material de Debian para el canal debian:paq (R1 LOW-3) ------------------------------------
debian() { # debian <dir> <huella de la clave que va en signing-key.asc>
  local d=$T/$1; mkdir -p "$d/m/debian/upstream"
  gpg --batch --armor --export "$2" >"$d/m/debian/upstream/signing-key.asc"
  tar -C "$d/m" -cJf "$d/paq_1.0-1.debian.tar.xz" debian; echo "Source: paq" >"$d/paq_1.0-1.dsc"
  sk() { echo " $(sha256sum <"$d/$1" | cut -d' ' -f1) $(wc -c <"$d/$1") $1"; }
  printf 'Package: otro\nDirectory: pool/main/o/otro\n\nPackage: paq\nVersion: 1.0-1\nDirectory: pool/main/p/paq\nChecksums-Sha256:\n%s\n%s\n' \
    "$(sk paq_1.0-1.dsc)" "$(sk paq_1.0-1.debian.tar.xz)" | xz -c >"$d/Sources.xz"
  printf 'Origin: Debian\nSuite: trixie\nDate: Tue, 14 Oct 2026 20:12:34 UTC\nSHA256:\n%s\n' \
    " $(sha256sum <"$d/Sources.xz" | cut -d' ' -f1) $(wc -c <"$d/Sources.xz") main/source/Sources.xz" >"$d/InRelease"
  rm -rf "$d/m"
}
debian deb "$K1"; debian deb-k2 "$K2"; debian deb-kc "$KC"; debian deb-kr "$KR"; debian deb-ks "$KS"
gpgconf --kill all 2>/dev/null || true
unset GNUPGHOME
INREL=$(sha256sum <"$T/deb/InRelease" | cut -d' ' -f1)

URL=https://zlib.net/rel/paq-1.0.tar.xz
ARCH=https://gitlab.archlinux.org/archlinux/packaging/packages/paq/-/raw/0123456789abcdef0123456789abcdef01234567/PKGBUILD
anc() { echo "debian:paq=$1;$ARCH=$1"; }

# --- Repo git local, espejo y espejo falso -------------------------------------------------------
g() { git -C "$1" -c core.autocrlf=false -c user.name=t -c user.email=t@x.invalid -c commit.gpgsign=false -c tag.gpgsign=false "${@:2}"; }
mkdir -p "$T/repos"; git init -q "$T/repos/repo.git"
mkdir -p "$T/repos/repo.git/inc"; echo uno >"$T/repos/repo.git/inc/a.h"
g "$T/repos/repo.git" add -A; g "$T/repos/repo.git" commit -qm uno
C1=$(git -C "$T/repos/repo.git" rev-parse HEAD)
echo dos >"$T/repos/repo.git/inc/a.h"; g "$T/repos/repo.git" commit -qam dos; g "$T/repos/repo.git" tag v2
C2=$(git -C "$T/repos/repo.git" rev-parse HEAD)
GSHA=$(git -C "$T/repos/repo.git" -c core.autocrlf=false archive --format=tar "$C2" inc | sha256sum | cut -d' ' -f1)
git clone -q "$T/repos/repo.git" "$T/repos/espejo.git"
git clone -q "$T/repos/repo.git" "$T/repos/espejo-falso.git"
g "$T/repos/espejo-falso.git" tag -f v2 "$C1" >/dev/null
GURL=https://github.com/org/repo.git
ESPEJO=https://code.videolan.org/x/espejo.git

# --- Ayudas ----------------------------------------------------------------------------------
fila() { local IFS=$'\t'; echo "$*"; }
APT=$(fila debian-inrelease trixie apt https://snapshot.debian.org/archive/debian/20261015T000000Z/dists/trixie/InRelease "$INREL" - - - - - -)
lock() { local s; s=$(sha256sum <"$T/${DEBL:-deb}/InRelease" | cut -d" " -f1); { echo "# lock de prueba"; echo "${APT/$INREL/$s}"; for f in "$@"; do echo "$f"; done; } >"$T/fuentes.lock"; }
correr() { # correr <claves> <origen> [<debian>] [args…] → CODIGO/SALIDA; salida limpia en $T/salida
  local o="$T/run-origen"; rm -rf "$T/salida" "$o"; mkdir -p "$o"
  cp -r "$T/$2/." "$o/"; cp "$T/${3:-deb}/"* "$o/"
  if grep -q "	git	" "$T/fuentes.lock"; then cp -r "$T/repos/." "$o/"; fi
  ejecutar bash "$D" --lock "$T/fuentes.lock" --claves "$T/claves-$1" --directorio-origen "$o" --salida "$T/salida" "${@:4}"
}
debe_ir() { if [ "$CODIGO" -eq 0 ]; then ok "$1"; else mal "$1: $SALIDA"; fi; }
debe_fallar() { # debe_fallar <desc> [<texto esperado>]
  if [ "$CODIGO" -ne 0 ] && { [ -z "${2:-}" ] || grep -qi -- "$2" <<<"$SALIDA"; }; then ok "$1"; else mal "$1 (código $CODIGO): $SALIDA"; fi
  if [ -n "$(ls -A "$T/salida" 2>/dev/null)" ]; then mal "$1: dejó ficheros en --salida"; fi
}
tarfila() { fila paq 1.0 tar "${URL2:-$URL}" "$SHA" - - "${URL2:-$URL}.asc" "$1" "${2:-$(anc "$1")}" -; }
GIT_OK=$(fila cab v2 git "$GURL" "$GSHA" "$C2" inc - - - "$ESPEJO")

# (a) Todo correcto → 0, con el canal debian verificado de verdad.
lock "$(tarfila "$K1")" "$GIT_OK"; correr k1 origen
debe_ir "(a) tarball firmado + anclaje debian + git fijado → 0"
afirmar "(a) el anclaje debian se verificó" grep -q 'anclaje debian:paq verificado' <<<"$SALIDA"
afirmar "(a) tarball y .asc en --salida" test -f "$T/salida/paq-1.0.tar.xz" -a -f "$T/salida/paq-1.0.tar.xz.asc"
afirmar "(a) git archive en --salida con el SHA-256 fijado" bash -c "echo '$GSHA  $T/salida/cab-v2.tar' | sha256sum -c -"

# (b) Tarball alterado → ≠ 0 y no queda en --salida.
mkdir -p "$T/o-b"; cp "$T/origen/paq-1.0.tar.xz.asc" "$T/o-b/"; { cat "$T/tarball"; printf x; } >"$T/o-b/paq-1.0.tar.xz"
lock "$(tarfila "$K1")"; correr k1 o-b; debe_fallar "(b) tarball alterado → ≠ 0" sha-256

# (c) Firmas y claves: otra clave, dos claves en el fichero, clave que no es la huella fijada.
lock "$(tarfila "$K1")"; correr k1 o-k2; debe_fallar "(c) firma de otra clave → ≠ 0 (gpg sale ≠ 0)" "rechaza la firma"
lock "$(tarfila "$K1")"; correr ambas origen; debe_fallar "claves/paq.asc con dos claves primarias → ≠ 0" "exactamente una"
lock "$(tarfila "$K1")"; correr k2 o-k2; debe_fallar "claves/paq.asc que no es la huella fijada → ≠ 0" "no la huella fijada"

# R1 MEDIUM-2: caducada, revocada (gpg sale con 0 en ambas) y BADSIG; LOW-5: SHA-224.
DEBL=deb-kc lock "$(tarfila "$KC")"; correr kc o-kc deb-kc; debe_fallar "clave caducada (EXPKEYSIG) → ≠ 0" "caducada"
DEBL=deb-kr lock "$(tarfila "$KR")"; correr kr o-kr deb-kr; debe_fallar "clave revocada (REVKEYSIG) → ≠ 0" "revocada"
lock "$(tarfila "$K1")"; correr k1 o-bad; debe_fallar "BADSIG: el .asc firma otro contenido → ≠ 0"
DEBL=deb-ks lock "$(tarfila "$KS")"; correr ks o-ks deb-ks; debe_fallar "firma con SHA-224 → ≠ 0" "resumen"

# (d) La fila exige firma y no hay .asc → ≠ 0.
mkdir -p "$T/o-d"; cp "$T/tarball" "$T/o-d/paq-1.0.tar.xz"
lock "$(tarfila "$K1")"; correr k1 o-d; debe_fallar "(d) sin firma donde se exige → ≠ 0"

# (e) PENDIENTE → ≠ 0 antes de descargar nada; (f) http:// → ≠ 0.
lock "$(fila paq 1.0 tar "$URL" PENDIENTE-TAREA-10 - - "$URL.asc" "$K1" "$(anc "$K1")" -)"
correr k1 origen; debe_fallar "(e) PENDIENTE-TAREA-10 → ≠ 0" PENDIENTE
lock "$(URL2=http://zlib.net/rel/paq-1.0.tar.xz tarfila "$K1")"
correr k1 origen; debe_fallar "(f) URL http:// → ≠ 0" https

# Autoridad de la URL (R1 LOW-2): usuario, puerto y mayúsculas/punto final no engañan.
lock "$(URL2=https://zlib.net@x.invalid/paq-1.0.tar.xz tarfila "$K1")"; correr k1 origen; debe_fallar "URL con usuario (@) → ≠ 0" usuario
lock "$(URL2=https://zlib.net:8443/paq-1.0.tar.xz tarfila "$K1")"; correr k1 origen; debe_fallar "URL con puerto → ≠ 0" puerto
lock "$(tarfila "$K1" "debian:paq=$K1;https://ZLIB.net./claves.html=$K1")"; correr k1 origen; debe_fallar "anclaje en ZLIB.net. (mismo host normalizado) → ≠ 0" operador
# Lista blanca del host: nada que haga que la URL parezca de un operador y curl vaya a otro.
for mala in 'https://zlib.net?.debian.org/x' 'https://zlib.net#.debian.org/x' 'https://zlib.net\.debian.org/x' \
  'https://zlib.net%2f.debian.org/x' 'https://evil.com?.zlib.net/x'; do
  lock "$(fila paq 1.0 tar "$mala" "$SHA" - - "$URL.asc" "$K1" "$(anc "$K1")" -)"; correr k1 origen; debe_fallar "URL $mala → ≠ 0" "host válido"
  lock "$(fila paq 1.0 tar "$URL" "$SHA" - - "$URL.asc" "$K1" "debian:paq=$K1;$mala=$K1" -)"; correr k1 origen; debe_fallar "anclaje $mala → ≠ 0" anclaje
done

# (g) git: la etiqueta apunta a otro commit; espejo falso; canal2 no comparable o del mismo operador.
lock "$(fila cab v2 git "$GURL" "$GSHA" "$C1" inc - - - "$ESPEJO")"; correr k1 origen; debe_fallar "(g) commit distinto del de la etiqueta → ≠ 0" commit
lock "$(fila cab v2 git "$GURL" "$GSHA" "$C2" inc - - - https://code.videolan.org/x/espejo-falso.git)"; correr k1 origen; debe_fallar "espejo con otra etiqueta → ≠ 0" commit
lock "$(fila cab v2 git "$GURL" "$GSHA" "$C2" inc - - - https://code.videolan.org/x/pagina.html)"; correr k1 origen; debe_fallar "canal2 que no es un repo .git → ≠ 0" canal2
lock "$(fila cab v2 git "$GURL" "$GSHA" "$C2" inc - - - https://github.com/otro/espejo.git)"; correr k1 origen; debe_fallar "canal2 del mismo operador (github) → ≠ 0" operador

# (h) y anclaje (R0 H1, R1 LOW-2/LOW-3).
lock "$(tarfila "$K2" "$(anc "$K1")")"; correr k2 o-k2 deb-k2; debe_fallar "(h) huella que el anclaje no confirma → ≠ 0" anclaje
lock "$(tarfila "$K1" "debian:paq=$K1")"; correr k1 origen; debe_fallar "anclaje con un solo canal → ≠ 0" anclaje
lock "$(tarfila "$K1" "debian:paq=$K1;https://keys.openpgp.org/x=$K1")"; correr k1 origen; debe_fallar "anclaje en un keyserver → ≠ 0" anclaje
lock "$(tarfila "$K1" "debian:paq=$K1;https://madler.net/pgp.html=$K1")"; correr k1 origen; debe_fallar "madler.net y zlib.net son el mismo operador → ≠ 0" operador
lock "$(tarfila "$K1" "debian:paq=$K1;https://gitlab.archlinux.org/archlinux/packaging/packages/paq/-/raw/main/PKGBUILD=$K1")"
correr k1 origen; debe_fallar "PKGBUILD de Arch sin commit fijado → ≠ 0" commit
DEBL=deb-k2 lock "$(tarfila "$K1")"; correr k1 origen deb-k2; debe_fallar "el signing-key.asc de Debian es de otra clave → ≠ 0" signing-key
mkdir -p "$T/deb-mal"; cp "$T/deb/"* "$T/deb-mal/"; echo "Source: otra cosa" >"$T/deb-mal/paq_1.0-1.dsc"
lock "$(tarfila "$K1")"; correr k1 origen deb-mal; debe_fallar ".dsc que no coincide con Sources → ≠ 0" Sources
{ echo "# lock"; echo "${APT/$INREL/PENDIENTE-TAREA-10}"; tarfila "$K1"; } >"$T/fuentes.lock"
correr k1 origen; debe_fallar "anclaje debian sin InRelease anclado → ≠ 0"

# Tarball sin firma: canal2 (un .sha256 de otro operador) debe confirmar el SHA-256 (R1 M-6).
# Forma de la fila amf-headers: asset de GitHub y PKGBUILD de Arch fijado a commit (ruling AMF).
GHURL=https://github.com/GPUOpen/AMF/releases/download/v1/paq-1.0.tar.xz
mkdir -p "$T/o-sf"; cp "$T/tarball" "$T/o-sf/paq-1.0.tar.xz"; printf "sha256sums=('%s')\n" "$SHA" >"$T/o-sf/PKGBUILD"
lock "$(fila paq 1.0 tar "$GHURL" "$SHA" - - - - - "$ARCH")"; correr k1 o-sf; debe_ir "asset sin firma con PKGBUILD que contiene el SHA → 0"
afirmar "…y el tarball pasa a --salida" test -f "$T/salida/paq-1.0.tar.xz"
printf "sha256sums=('%064d')\n" 0 >"$T/o-sf/PKGBUILD"
correr k1 o-sf; debe_fallar "PKGBUILD que no contiene el SHA → ≠ 0" canal2
lock "$(fila paq 1.0 tar "$GHURL" "$SHA" - - - - - https://gitlab.archlinux.org/archlinux/packaging/packages/paq/-/raw/main/PKGBUILD)"
correr k1 o-sf; debe_fallar "canal2 de Arch sin commit fijado → ≠ 0" commit
lock "$(fila paq 1.0 tar "$GHURL" "$SHA" - - - - - https://raw.githubusercontent.com/x/y/PKGBUILD)"
correr k1 o-sf; debe_fallar "canal2 del mismo operador que el asset (github) → ≠ 0" operador

# Redirecciones (solo en descargas reales): un curl falso registra cada petición. Los assets de
# GitHub saltan a githubusercontent; a otro operador no se llega a conectar.
mkdir -p "$T/stub"
cat >"$T/stub/curl" <<EOF
#!/usr/bin/env bash
for a; do [ "\$p" = -o ] && o=\$a; p=\$a; done; u=\$a
echo "\$u" >>"$T/peticiones"
case "\$u" in
  https://github.com/bien/*) printf '302 https://objects.githubusercontent.com/f?sig=1' ;;
  https://github.com/mala/*) printf '302 https://evil.invalid/x' ;;
  https://github.com/plana/*) printf '302 http://objects.githubusercontent.com/x' ;;
  https://github.com/bucle/*) printf '302 https://github.com/bucle/x' ;;
  https://objects.githubusercontent.com/*) cp "$T/tarball" "\$o"; printf '200 ' ;;
  https://gitlab.archlinux.org/*) printf "sha256sums=('$SHA')\n" >"\$o"; printf '200 ' ;;
  *) printf '404 ' ;;
esac
EOF
chmod +x "$T/stub/curl"
red() { # red <ruta de GitHub>: descarga «real» con el curl falso
  rm -rf "$T/salida" "$T/peticiones"
  lock "$(fila paq 1.0 tar "https://github.com/$1/paq-1.0.tar.xz" "$SHA" - - - - - "$ARCH")"
  ejecutar env PATH="$T/stub:$PATH" bash "$D" --lock "$T/fuentes.lock" --claves "$T/claves-k1" --salida "$T/salida"
}
red bien; debe_ir "redirección dentro del operador → 0"
afirmar "…se siguió el salto" grep -q objects.githubusercontent.com "$T/peticiones"
red mala; debe_fallar "redirección a otro operador → ≠ 0" "otro operador"
negar "…sin conectar con el otro host" grep -q evil.invalid "$T/peticiones"
red plana; debe_fallar "redirección a http:// → ≠ 0" "no https"
red bucle; debe_fallar "bucle de redirecciones → ≠ 0" demasiadas

# La puerta va antes de la red: con una fila mala no se descarga ni la buena.
lock "$(tarfila "$K1")" "$(fila cab v2 git "$GURL" PENDIENTE-TAREA-10 "$C2" inc - - - "$ESPEJO")"
correr k1 origen; debe_fallar "una fila PENDIENTE detiene todas las descargas" PENDIENTE

# --arranque (Tarea 10): acepta PENDIENTE y no escribe en --salida; con la clave presente
# verifica también la firma e imprime la huella que firma (R1 LOW-4).
lock "$(fila paq 1.0 tar "$URL" PENDIENTE-TAREA-10 - - "$URL.asc" PENDIENTE-TAREA-10 PENDIENTE-TAREA-10 -)"
correr k1 origen deb --arranque
if [ "$CODIGO" -eq 0 ] && grep -q "$SHA" <<<"$SALIDA" && grep -q "huella=$K1" <<<"$SALIDA"; then ok "--arranque imprime SHA-256 y huella verificada"; else mal "--arranque: $SALIDA"; fi
afirmar "--arranque no escribe en --salida" test ! -e "$T/salida"
correr k1 o-bad deb --arranque; debe_fallar "--arranque con una firma mala → ≠ 0"

fin
