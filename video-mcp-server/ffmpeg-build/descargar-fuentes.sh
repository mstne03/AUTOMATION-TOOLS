#!/usr/bin/env bash
# Descarga y verifica las fuentes de fuentes.lock (I9). Es la ÚNICA fase con red; corre dentro de
# la imagen fijada (construir.sh) y la compilación va después en otro contenedor sin red.
#   descargar-fuentes.sh --salida DIR [--lock F] [--claves DIR] [--directorio-origen DIR] [--arranque]
#   descargar-fuentes.sh --solo-validar [--lock F] [--claves DIR]
# --directorio-origen: toma los ficheros y repos de DIR por nombre (tests, sin red).
# --arranque: solo Tarea 10. Acepta PENDIENTE e imprime SHA-256/commits para revisarlos a mano.
# --solo-validar: la fase 1 y nada más (sin red); la usan los tests y la puerta del workflow.
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

host() { local h=${1#*://}; echo "${h%%/*}"; }
hex() { [[ "$1" =~ ^[0-9a-f]{$2}$ ]]; }
# Keyservers y el propio .asc no son canales de anclaje (R0 H1).
KEYSERVERS=" keys.openpgp.org keyserver.ubuntu.com pgp.mit.edu keys.gnupg.net "

validar_anclaje() { # <nombre> <url> <firma_url> <huella> <anclaje>
  local e canal fpr h vistos=" " n=0
  IFS=';' read -ra entradas <<<"$5"
  for e in "${entradas[@]}"; do
    canal=${e%=*}; fpr=${e##*=}
    [ "$fpr" = "$4" ] || error "$1: el anclaje '$canal' confirma $fpr, no la huella $4"
    case "$canal" in
      debian:?*) h=snapshot.debian.org ;;
      https://?*) h=$(host "$canal") ;;
      *) error "$1: canal de anclaje no válido '$canal' (debian:<paquete> o https://…)" ;;
    esac
    [ "$canal" != "$3" ] || error "$1: el anclaje no puede ser la propia firma"
    [[ "$KEYSERVERS" != *" $h "* ]] || error "$1: un keyserver no es canal de anclaje ($h)"
    [ "$h" != "$(host "$2")" ] && [ "$h" != "$(host "$3")" ] || error "$1: anclaje en el host de descarga ($h)"
    [[ "$vistos" != *" $h "* ]] || error "$1: dos canales de anclaje en el mismo host ($h)"
    vistos+="$h "; n=$((n + 1))
  done
  [ "$n" -ge 2 ] || error "$1: el anclaje necesita dos canales independientes del host de descarga ($n)"
}

validar_fila() { # campos de la fila
  local nombre=$1 version=$2 tipo=$3 url=$4 sha=$5 commit=$6 ruta=$7 firma=$8 huella=$9 anclaje=${10} canal2=${11}
  if [ "$ARRANQUE" = 0 ] && [[ "$*" == *PENDIENTE* ]]; then error "$nombre: celda PENDIENTE en fuentes.lock (Tarea 10)"; fi
  [[ "$url" == https://* ]] || error "$nombre: la URL debe ser https:// ($url)"
  [ "$firma" = - ] || [[ "$firma" == https://* ]] || error "$nombre: la firma debe ser https:// ($firma)"
  [ "$canal2" = - ] || [[ "$canal2" == https://* || "$canal2" == PENDIENTE* ]] || error "$nombre: canal2 debe ser https://"
  [ "$ARRANQUE" = 1 ] && return 0
  hex "$sha" 64 || error "$nombre: sha256 no válido"
  case "$tipo" in
    tar) ;;
    git) hex "$commit" 40 || error "$nombre: commit de 40 hex obligatorio"
         [ "$canal2" != - ] || error "$nombre: una fuente git (sin firma) necesita canal2" ;;
    *) error "$nombre: tipo '$tipo' desconocido" ;;
  esac
  if [ "$firma" != - ]; then
    [[ "$huella" =~ ^[0-9A-F]{40}$ ]] || error "$nombre: huella de 40 hex en mayúsculas obligatoria"
    [ -f "$CLAVES/$nombre.asc" ] || error "$nombre: falta la clave $CLAVES/$nombre.asc"
    validar_anclaje "$nombre" "$url" "$firma" "$huella" "$anclaje"
  elif [ "$tipo" = tar ] && [ "$canal2" = - ]; then
    error "$nombre: tarball sin firma y sin canal2"
  fi
}

obtener() { # <url> <destino>
  if [ -n "$ORIGEN" ]; then
    cp "$ORIGEN/$(basename "$1")" "$2" 2>/dev/null || error "no está en el origen: $(basename "$1")"
  else
    local codigo
    codigo=$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --max-redirs 0 \
      --max-filesize 209715200 -o "$2" -w '%{http_code}' "$1") || error "descarga fallida: $1"
    [ "$codigo" = 200 ] || error "respuesta $codigo (sin redirecciones) para $1"
  fi
}

verificar_firma() { # <nombre> <fichero> <asc> <huella>
  local gh estado primaria
  gh=$(mktemp -d)
  GNUPGHOME=$gh gpg --batch --quiet --import "$CLAVES/$1.asc" 2>/dev/null || error "$1: clave ilegible"
  estado=$(GNUPGHOME=$gh gpg --batch --status-fd 1 --verify "$3" "$2" 2>/dev/null || true)
  GNUPGHOME=$gh gpgconf --kill all 2>/dev/null || true
  rm -rf "$gh"
  if grep -qE '^\[GNUPG:\] (BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG) ' <<<"$estado"; then
    error "$1: firma no válida, caducada o de clave revocada"
  fi
  # VALIDSIG: el último campo es la huella de la clave primaria.
  primaria=$(awk '$2 == "VALIDSIG" {print $NF}' <<<"$estado")
  [ -n "$primaria" ] || error "$1: sin VALIDSIG"
  [ "$primaria" = "$4" ] || error "$1: firmado por $primaria, no por la huella fijada $4"
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
    if [ "$ARRANQUE" = 1 ]; then echo "$nombre	sha256=$real"; continue; fi
    [ "$real" = "$sha" ] || error "$nombre: SHA-256 $real ≠ fijado $sha"
    [ "$firma" = - ] || verificar_firma "$nombre" "$f" "$f.asc" "$huella"
    mv "$f" "$TRABAJO/ok/"; [ "$firma" = - ] || mv "$f.asc" "$TRABAJO/ok/"
  else
    f="$TRABAJO/$nombre-$version.tar"
    [ "$ARRANQUE" = 1 ] && commit=-
    c1=$(archivo_git "$url" "$version" "$commit" "$ruta" "$f")
    real=$(sha256sum "$f" | cut -d' ' -f1)
    if [ "$ARRANQUE" = 1 ]; then echo "$nombre	commit=$c1	sha256=$real"; continue; fi
    [ "$real" = "$sha" ] || error "$nombre: SHA-256 del git archive $real ≠ fijado $sha"
    # Segundo canal: si es otro repo git, debe dar el mismo commit y el mismo archive (L1).
    if [[ "$canal2" == *.git ]]; then
      archivo_git "$canal2" "$version" "$commit" "$ruta" "$f.2" >/dev/null
      [ "$(sha256sum "$f.2" | cut -d' ' -f1)" = "$sha" ] || error "$nombre: el espejo $canal2 da otro contenido"
      rm -f "$f.2"
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
