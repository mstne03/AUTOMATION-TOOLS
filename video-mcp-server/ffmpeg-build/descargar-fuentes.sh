#!/usr/bin/env bash
# Descarga y verifica las fuentes de fuentes.lock (I9). Es la ÚNICA fase con red; corre dentro de
# la imagen fijada (construir.sh) y la compilación va después en otro contenedor sin red.
#   descargar-fuentes.sh --salida DIR [--lock F] [--claves DIR] [--directorio-origen DIR]
#   descargar-fuentes.sh --arranque [--lock F] [--claves DIR]   (solo Tarea 10)
#   descargar-fuentes.sh --solo-validar [--lock F] [--claves DIR]
# --directorio-origen: toma los ficheros y repos de DIR por nombre (tests, sin red).
# --arranque: acepta PENDIENTE e imprime SHA-256, commits y la huella que firma, para revisarlos a
#   mano; si claves/<nombre>.asc ya existe, verifica también la firma con ella.
# --solo-validar: solo la fase 1 (sin red); la usa tests/pendientes.test.sh.
# Primero valida TODAS las filas (sin red); si alguna falla, no se descarga nada. Después, cada
# fuente se verifica en un temporal y solo pasa a --salida si todo cuadra.
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$AQUI/fuentes.lock"; CLAVES="$AQUI/claves"; ORIGEN=""; SALIDA=""; ARRANQUE=0; SOLO_VALIDAR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --lock) LOCK=$2; shift 2 ;;
    --claves) CLAVES=$2; shift 2 ;;
    --directorio-origen) ORIGEN=$2; shift 2 ;;
    --salida) SALIDA=$2; shift 2 ;;
    --arranque) ARRANQUE=1; shift ;;
    --solo-validar) SOLO_VALIDAR=1; shift ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SALIDA" ] || [ "$ARRANQUE" = 1 ] || [ "$SOLO_VALIDAR" = 1 ] || { echo "Falta --salida" >&2; exit 2; }
error() { echo "ERROR: $*" >&2; exit 1; }
export GIT_TERMINAL_PROMPT=0 LC_ALL=C
hex() { [[ "$1" =~ ^[0-9a-f]{$2}$ ]]; }

# Autoridad de una URL https://, normalizada (minúsculas, sin punto final). Lista blanca de
# caracteres: con @, :, ?, #, \ o %, «https://zlib.net?.debian.org/» parecería de un host y curl
# iría a otro.
host() {
  local a=${1#https://}; a=${a%%/*}; a=${a,,}
  [[ "$a" =~ ^[a-z0-9.-]+$ ]] || return 1
  echo "${a%.}"
}
# Independencia por OPERADOR, no por nombre de host: tabla cerrada. Un host fuera de ella no vale
# como canal (tampoco los keyservers). Subdominios incluidos (downloads.videolan.org → videolan).
declare -A OPERADORES=(
  [ffmpeg.org]=ffmpeg [videolan.org]=videolan [zlib.net]=zlib-madler [madler.net]=zlib-madler
  [github.com]=github [githubusercontent.com]=github [debian.org]=debian [archlinux.org]=arch [fedoraproject.org]=fedora
)
operador() { # <host> → operador, o falla si no está en la tabla
  local d
  for d in "${!OPERADORES[@]}"; do
    if [ "$1" = "$d" ] || [[ "$1" == *."$d" ]]; then echo "${OPERADORES[$d]}"; return 0; fi
  done
  return 1
}
operador_url() { local h; h=$(host "$1") || return 1; operador "$h"; }

validar_anclaje() { # <nombre> <url> <firma_url> <huella> <anclaje>
  local e canal fpr op vistos=" " n=0 op_url op_firma
  op_url=$(operador_url "$2") || error "$1: la URL de descarga no está en la tabla de operadores"
  op_firma=$(operador_url "$3") || error "$1: la URL de la firma no está en la tabla de operadores"
  IFS=';' read -ra entradas <<<"$5"
  for e in "${entradas[@]}"; do
    canal=${e%=*}; fpr=${e##*=}
    [ "$fpr" = "$4" ] || error "$1: anclaje: '$canal' confirma $fpr, no la huella $4"
    case "$canal" in
      debian:?*) op=debian ;;
      https://?*)
        op=$(operador_url "$canal") || error "$1: anclaje: '$canal' no es de un operador conocido (ni keyserver ni host suelto)"
        [ "$op" != arch ] || [[ "$canal" =~ /-/raw/[0-9a-f]{40}/ ]] || error "$1: anclaje: el PKGBUILD de Arch va fijado a un commit (/-/raw/<40 hex>/)"
        [ "$op" != fedora ] || [[ "$canal" =~ /raw/[0-9a-f]{40}/ ]] || error "$1: anclaje: el dist-git de Fedora va fijado a un commit (/raw/<40 hex>/)" ;;
      *) error "$1: anclaje: canal no válido '$canal' (debian:<paquete> o https://…)" ;;
    esac
    [ "$op" != "$op_url" ] && [ "$op" != "$op_firma" ] || error "$1: anclaje en el operador de la descarga ($op)"
    [[ "$vistos" != *" $op "* ]] || error "$1: anclaje: dos canales del mismo operador ($op)"
    vistos+="$op "; n=$((n + 1))
  done
  [ "$n" -ge 2 ] || error "$1: anclaje: hacen falta dos canales independientes de la descarga ($n)"
}

validar_fila() { # campos de la fila
  local nombre=$1 version=$2 tipo=$3 url=$4 sha=$5 commit=$6 ruta=$7 firma=$8 huella=$9 anclaje=${10} canal2=${11}
  if [ "$ARRANQUE" = 0 ] && [[ "$*" == *PENDIENTE* ]]; then error "$nombre: celda PENDIENTE en fuentes.lock (Tarea 10)"; fi
  host "$url" >/dev/null && [[ "$url" == https://* ]] || error "$nombre: la URL debe ser https:// con host válido, sin usuario ni puerto ($url)"
  [ "$firma" = - ] || { host "$firma" >/dev/null && [[ "$firma" == https://* ]]; } || error "$nombre: firma no válida ($firma)"
  [ "$ARRANQUE" = 1 ] && return 0
  hex "$sha" 64 || error "$nombre: sha256 no válido"
  case "$tipo" in
    tar) [ "$firma" != - ] || [ "$canal2" != - ] || error "$nombre: tarball sin firma necesita canal2 (un fichero de otro operador con su SHA-256)" ;;
    git) hex "$commit" 40 || error "$nombre: commit de 40 hex obligatorio"
         [[ "$canal2" == https://*.git || "$canal2" == https://gitlab.archlinux.org/*/PKGBUILD ]]            || error "$nombre: canal2 de una fuente git debe ser otro repositorio .git comparable o un PKGBUILD de Arch que fije el commit" ;;
    *) error "$nombre: tipo '$tipo' desconocido" ;;
  esac
  if [ "$canal2" != - ]; then
    local op2 op
    op2=$(operador_url "$canal2") || error "$nombre: canal2 no es de un operador conocido ($canal2)"
    op=$(operador_url "$url") || error "$nombre: la URL no está en la tabla de operadores"
    [ "$op2" != "$op" ] || error "$nombre: canal2 es del mismo operador que la descarga ($op)"
    [ "$op2" != arch ] || [[ "$canal2" =~ /-/raw/[0-9a-f]{40}/ ]] || error "$nombre: canal2: el PKGBUILD de Arch va fijado a un commit (/-/raw/<40 hex>/)"
  fi
  if [ "$firma" != - ]; then
    [[ "$huella" =~ ^[0-9A-F]{40}$ ]] || error "$nombre: huella de 40 hex en mayúsculas obligatoria"
    [ -f "$CLAVES/$nombre.asc" ] || error "$nombre: falta la clave $CLAVES/$nombre.asc"
    validar_anclaje "$nombre" "$url" "$firma" "$huella" "$anclaje"
    if [[ ";$anclaje" == *";debian:"* ]]; then
      hex "${INRELEASE_SHA:-}" 64 || error "$nombre: el anclaje debian necesita la fila apt (InRelease) completa"
    fi
  fi
}

# curl nunca sigue una redirección por su cuenta: cada salto se comprueba antes de hacer la
# petición y debe quedarse en el mismo operador (los assets de GitHub saltan a
# *.githubusercontent.com). A otro operador no se llega a conectar.
obtener() { # <url> <destino>
  if [ -n "$ORIGEN" ]; then
    cp "$ORIGEN/$(basename "$1")" "$2" 2>/dev/null || error "no está en el origen: $(basename "$1")"
    return 0
  fi
  local u=$1 op r codigo siguiente
  op=$(operador_url "$u") || error "la URL no está en la tabla de operadores: $u"
  for _ in 1 2 3 4; do
    r=$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --max-redirs 0 \
      --max-filesize 209715200 -o "$2" -w '%{http_code} %{redirect_url}' "$u") || error "descarga fallida: $u"
    codigo=${r%% *}; siguiente=${r#* }
    case "$codigo" in
      200) return 0 ;;
      301 | 302 | 303 | 307 | 308) ;;
      *) error "respuesta $codigo para $u" ;;
    esac
    [[ "$siguiente" == https://* ]] || error "redirección no https desde $u: $siguiente"
    [ "$(operador_url "$siguiente" || true)" = "$op" ] || error "redirección a otro operador desde $u: $siguiente"
    u=$siguiente
  done
  error "demasiadas redirecciones: $1"
}

# Firma OpenPGP (R0 M4, R1 LOW-5): claves/<nombre>.asc con exactamente una clave primaria, que es la
# de la huella fijada; gpg sale con 0; ni caducada ni revocada ni mala; VALIDSIG de esa primaria y
# con SHA-256/384/512 (8, 9, 10). <huella> «-» solo en --arranque: imprime la que firma.
verificar_firma() { # <nombre> <fichero> <asc> <huella o ->
  local gh estado primaria algoritmo claves fallo=""
  gh=$(mktemp -d)
  if ! GNUPGHOME=$gh gpg --batch --quiet --no-autostart --import "$CLAVES/$1.asc" 2>/dev/null; then fallo="clave ilegible"
  else
    claves=$(GNUPGHOME=$gh gpg --batch --with-colons --list-keys 2>/dev/null | awk -F: '/^pub/ {p = 1; next} p && /^fpr/ {print $10; p = 0}')
    if [ -z "$claves" ] || [ "$(wc -l <<<"$claves")" -ne 1 ]; then fallo="claves/$1.asc debe tener exactamente una clave primaria"
    elif [ "$4" != - ] && [ "$claves" != "$4" ]; then fallo="claves/$1.asc es $claves, no la huella fijada $4"
    elif ! estado=$(GNUPGHOME=$gh gpg --batch --status-fd 1 --verify "$3" "$2" 2>/dev/null); then fallo="gpg rechaza la firma"
    fi
  fi
  GNUPGHOME=$gh gpgconf --kill all 2>/dev/null || true
  rm -rf "$gh"
  [ -z "$fallo" ] || error "$1: $fallo"
  # gpg sale con 0 aunque la clave esté caducada o revocada: esta línea es la que lo impide.
  if grep -qE '^\[GNUPG:\] (BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG) ' <<<"$estado"; then
    error "$1: firma no válida, caducada o de clave revocada"
  fi
  primaria=$(awk '$2 == "VALIDSIG" {print $NF}' <<<"$estado")
  algoritmo=$(awk '$2 == "VALIDSIG" {print $10}' <<<"$estado")
  [ -n "$primaria" ] || error "$1: sin VALIDSIG"
  [ "$primaria" = "$claves" ] || error "$1: firmado por $primaria, no por la clave de claves/ ($claves)"
  [[ " 8 9 10 " == *" $algoritmo "* ]] || error "$1: firma con algoritmo de resumen $algoritmo (se exige SHA-256/384/512)"
  echo "$primaria"
}

# Canal debian:<paquete> (R1 LOW-3): el signing-key.asc del paquete fuente de Debian en el mismo
# snapshot, encadenado al InRelease anclado: InRelease (SHA-256 del lock) → Sources.xz (SHA-256
# del InRelease) → .dsc y debian.tar.* (SHA-256 de Sources) → debian/upstream/signing-key.asc.
verificar_anclaje_debian() { # <nombre> <paquete> <huella>
  local d base dir sha nombre_f f deb="" dsc="" claves
  d=$(mktemp -d -p "$TRABAJO")
  base=${INRELEASE_URL%/dists/*}
  obtener "$INRELEASE_URL" "$d/InRelease"
  bash "$AQUI/comprobar-inrelease.sh" "$d/InRelease" "$LOCK" >/dev/null || error "$1: InRelease de Debian no anclado"
  sha=$(awk '/^SHA256:/ {f = 1; next} /^[^ ]/ {f = 0} f && $3 == "main/source/Sources.xz" {print $1}' "$d/InRelease")
  hex "$sha" 64 || error "$1: el InRelease no lista main/source/Sources.xz"
  obtener "${INRELEASE_URL%/InRelease}/main/source/Sources.xz" "$d/Sources.xz"
  [ "$(sha256sum <"$d/Sources.xz" | cut -d' ' -f1)" = "$sha" ] || error "$1: Sources.xz no coincide con el InRelease"
  xz -dc "$d/Sources.xz" >"$d/Sources"
  # Primera estrofa del paquete: «Directory sha nombre» por cada fichero de Checksums-Sha256.
  awk -v p="$2" 'BEGIN {RS = ""; FS = "\n"}
    !hecho { pkg = ""; for (i = 1; i <= NF; i++) if ($i ~ /^Package: /) pkg = substr($i, 10)
      if (pkg != p) next
      # Directory va después de Checksums-Sha256 en la estrofa: se imprime al terminar de leerla.
      dir = ""; cs = 0; n = 0; hecho = 1
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^Directory: /) dir = substr($i, 12)
        if ($i ~ /^Checksums-Sha256:/) { cs = 1; continue }
        if (cs && $i ~ /^ /) { split($i, a, " "); n++; s[n] = a[1]; f[n] = a[3] } else cs = 0 }
      if (dir == "") exit 1
      for (i = 1; i <= n; i++) print dir, s[i], f[i] }' "$d/Sources" >"$d/ficheros" || error "$1: el paquete fuente $2 no tiene Directory en Sources"
  [ -s "$d/ficheros" ] || error "$1: el paquete fuente $2 no está en Sources"
  while read -r dir sha nombre_f; do
    case "$nombre_f" in *.dsc) dsc=$nombre_f ;; *.debian.tar.*) deb=$nombre_f ;; *) continue ;; esac
    f="$d/$nombre_f"
    obtener "$base/$dir/$nombre_f" "$f"
    [ "$(sha256sum <"$f" | cut -d' ' -f1)" = "$sha" ] || error "$1: $nombre_f no coincide con Sources"
  done <"$d/ficheros"
  [ -n "$dsc" ] && [ -n "$deb" ] || error "$1: falta el .dsc o el debian.tar del paquete $2"
  tar -xOf "$d/$deb" debian/upstream/signing-key.asc >"$d/clave.asc" 2>/dev/null || error "$1: $deb sin debian/upstream/signing-key.asc"
  claves=$(GNUPGHOME=$d gpg --batch --quiet --no-autostart --import "$d/clave.asc" 2>/dev/null; GNUPGHOME=$d gpg --batch --with-colons --list-keys 2>/dev/null |
    awk -F: '/^pub/ {p = 1; next} p && /^fpr/ {print $10; p = 0}')
  GNUPGHOME=$d gpgconf --kill all 2>/dev/null || true
  grep -qx "$3" <<<"$claves" || error "$1: anclaje: el signing-key.asc de Debian ($2) no contiene la huella $3"
  echo "  anclaje debian:$2 verificado"
}

archivo_git() { # <url> <version> <commit-esperado o -> <ruta> <tar-salida> → imprime commit
  local repo commit
  repo=$(mktemp -d)
  if [ -n "$ORIGEN" ]; then
    git -c protocol.allow=never -c protocol.file.allow=always clone -q --no-checkout \
      "$ORIGEN/$(basename "$1")" "$repo/r" 2>/dev/null || error "no está en el origen: $1"
  else
    git -c protocol.allow=never -c protocol.https.allow=always clone -q --filter=blob:none \
      --no-checkout "$1" "$repo/r" || error "clon fallido: $1"
  fi
  commit=$(git -C "$repo/r" rev-parse --verify -q "refs/tags/$2^{commit}") || error "$1: no existe la etiqueta $2"
  [ "$3" = - ] || [ "$commit" = "$3" ] || error "$1: la etiqueta $2 apunta al commit $commit, no al fijado $3"
  if [ "$4" = - ]; then git -C "$repo/r" -c core.autocrlf=false archive --format=tar "$commit" >"$5"
  else git -C "$repo/r" -c core.autocrlf=false archive --format=tar "$commit" "$4" >"$5"; fi
  rm -rf "$repo"
  echo "$commit"
}

# --- 1. Validación de todas las filas, sin red ----------------------------------------------
INRELEASE_URL=$(awk -F'\t' '$3 == "apt" {print $4}' "$LOCK")
INRELEASE_SHA=$(awk -F'\t' '$3 == "apt" {print $5}' "$LOCK")
filas=()
while IFS= read -r linea; do
  [[ -z "$linea" || "$linea" == \#* ]] && continue
  IFS=$'\t' read -r -a c <<<"$linea"
  [ "${#c[@]}" -eq 11 ] || error "fila con ${#c[@]} columnas (11 esperadas): $linea"
  case "${c[2]}" in apt | meta) continue ;; esac   # los consume el Dockerfile / compilar.sh
  validar_fila "${c[@]}"
  filas+=("$linea")
done <"$LOCK"
[ "${#filas[@]}" -gt 0 ] || error "fuentes.lock sin fuentes"
if [ "$SOLO_VALIDAR" = 1 ]; then echo "fuentes.lock válido (${#filas[@]} fuentes)."; exit 0; fi

# --- 2. Descarga y verificación, fila a fila -------------------------------------------------
TRABAJO=$(mktemp -d); trap 'rm -rf "$TRABAJO"' EXIT
mkdir -p "$TRABAJO/ok"
for linea in "${filas[@]}"; do
  IFS=$'\t' read -r nombre version tipo url sha commit ruta firma huella anclaje canal2 <<<"$linea"
  if [ "$tipo" = tar ]; then
    f="$TRABAJO/$(basename "$url")"
    obtener "$url" "$f"
    real=$(sha256sum "$f" | cut -d' ' -f1)
    [ "$firma" = - ] || obtener "$firma" "$f.asc"
    if [ "$ARRANQUE" = 1 ]; then
      linea_arranque="$nombre	sha256=$real"
      if [ "$firma" != - ] && [ -f "$CLAVES/$nombre.asc" ]; then
        h=$huella; [[ "$h" =~ ^[0-9A-F]{40}$ ]] || h=-
        linea_arranque+="	firma=OK huella=$(verificar_firma "$nombre" "$f" "$f.asc" "$h")"
      fi
      echo "$linea_arranque"; continue
    fi
    [ "$real" = "$sha" ] || error "$nombre: SHA-256 $real ≠ fijado $sha"
    if [ "$firma" != - ]; then
      verificar_firma "$nombre" "$f" "$f.asc" "$huella" >/dev/null
      IFS=';' read -ra entradas <<<"$anclaje"
      for e in "${entradas[@]}"; do
        [[ "$e" != debian:* ]] || { e=${e#debian:}; verificar_anclaje_debian "$nombre" "${e%=*}" "$huella"; }
      done
    else
      # Sin firma: el segundo canal (de otro operador) debe contener el SHA-256 o el SHA-512 de estos
      # mismos bytes (los PKGBUILD de Arch traen sha512sums). Las firmas DSA/SHA-1 de dav1d y zlib
      # no se aceptan: van por aquí (decisión de la Tarea 10).
      obtener "$canal2" "$TRABAJO/canal2"
      grep -qw -e "$sha" -e "$(sha512sum "$f" | cut -d' ' -f1)" "$TRABAJO/canal2" || error "$nombre: canal2 no confirma el SHA-256 ni el SHA-512"
    fi
    mv "$f" "$TRABAJO/ok/"; [ "$firma" = - ] || mv "$f.asc" "$TRABAJO/ok/"
  else
    f="$TRABAJO/$nombre-$version.tar"
    [ "$ARRANQUE" = 1 ] && commit=-
    c1=$(archivo_git "$url" "$version" "$commit" "$ruta" "$f")
    real=$(sha256sum "$f" | cut -d' ' -f1)
    if [ "$ARRANQUE" = 1 ]; then echo "$nombre	commit=$c1	sha256=$real"; continue; fi
    [ "$real" = "$sha" ] || error "$nombre: SHA-256 del git archive $real ≠ fijado $sha"
    # Segundo canal: otro repositorio, de otro operador, con el mismo commit y archive (L1), o un
    # PKGBUILD de Arch fijado a commit que nombra ese commit (AMF no tiene espejo).
    if [[ "$canal2" == *.git ]]; then
      archivo_git "$canal2" "$version" "$commit" "$ruta" "$f.2" >/dev/null
      [ "$(sha256sum "$f.2" | cut -d' ' -f1)" = "$sha" ] || error "$nombre: el espejo $canal2 da otro contenido"
      rm -f "$f.2"
    else
      obtener "$canal2" "$TRABAJO/canal2"
      grep -qw "$commit" "$TRABAJO/canal2" || error "$nombre: canal2 no fija el commit $commit"
    fi
    mv "$f" "$TRABAJO/ok/"
  fi
  echo "verificado: $nombre $version"
done

[ "$ARRANQUE" = 1 ] && exit 0
mkdir -p "$SALIDA"
[ -z "$(ls -A "$SALIDA")" ] || error "--salida debe estar vacía: $SALIDA"
mv "$TRABAJO/ok/"* "$SALIDA/"
echo "Fuentes verificadas en $SALIDA"
