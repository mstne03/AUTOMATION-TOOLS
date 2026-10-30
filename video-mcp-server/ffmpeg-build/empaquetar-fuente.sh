#!/usr/bin/env bash
# Código fuente correspondiente (LGPL §6 / I12), reproducible: mismas entradas → mismo SHA-256.
#   empaquetar-fuente.sh --rev REV [--lock F] <fuentes> <avisos> <salida>
# <fuentes>: tarballs y git archive tal como se verificaron, con sus .asc. <avisos>: la salida de
# recopilar-avisos.sh. Produce <salida>/ffmpeg-fuente-correspondiente-<REV>.tar.xz con
# fuentes/, ffmpeg-build/ (scripts, Dockerfile, fuentes.lock, claves), LICENSES/ y LEEME-FUENTE.txt.
# Orden, propietario, permisos (644/755) y fechas fijados; xz en un hilo (con varios, la salida cambia).
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$AQUI/fuentes.lock"; REV=""
while [[ "${1:-}" == --* ]]; do
  case "$1" in --lock) LOCK=$2 ;; --rev) REV=$2 ;; *) echo "Opción desconocida: $1" >&2; exit 2 ;; esac
  shift 2
done
[ $# -eq 3 ] && [[ "$REV" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Uso: $0 --rev REV [--lock F] <fuentes> <avisos> <salida>" >&2; exit 2; }
FUENTES=$1; AVISOS=$2; SALIDA=$3

epoch=$(awk -F'\t' '$1 == "source-date-epoch" {print $2}' "$LOCK")
[[ "$epoch" =~ ^[0-9]{9,11}$ ]] || { echo "ERROR: SOURCE_DATE_EPOCH no válido en fuentes.lock: '$epoch'" >&2; exit 1; }
[ -d "$AVISOS/LICENSES" ] || { echo "ERROR: faltan los avisos (recopilar-avisos.sh)" >&2; exit 1; }

# Se empaqueta exactamente lo verificado (R1 LOW-8): cada fuente con el SHA-256 del lock y ningún
# fichero que no sea una fuente del lock o su firma .asc.
bash "$AQUI/compilar.sh" --comprobar-fuentes "$FUENTES" "$LOCK" >/dev/null
esperados=" $(awk -F'\t' '$3 == "tar" { n = split($4, u, "/"); print u[n]; if ($8 != "-") print u[n] ".asc" }
  $3 == "git" { print $1 "-" $2 ".tar" }' "$LOCK" | tr '\n' ' ') "
shopt -s dotglob   # también los ocultos: cp -r los empaquetaría
for f in "$FUENTES"/*; do
  [[ "$esperados" == *" $(basename "$f") "* ]] || { echo "ERROR: fichero ajeno al lock en las fuentes: $(basename "$f")" >&2; exit 1; }
done
shopt -u dotglob

nombre=ffmpeg-fuente-correspondiente-$REV
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/$nombre"
cp -r "$FUENTES" "$T/$nombre/fuentes"
cp -r "$AVISOS/LICENSES" "$T/$nombre/LICENSES"
mkdir -p "$T/$nombre/ffmpeg-build"
(cd "$AQUI" && tar --exclude=./tests/muestras -cf - .) | tar -xf - -C "$T/$nombre/ffmpeg-build"
# Las órdenes de Docker (con su aislamiento) viven solo en construir.sh: aquí se remite a él.
cat >"$T/$nombre/LEEME-FUENTE.txt" <<EOF
Código fuente correspondiente de ffmpeg.exe/ffprobe.exe de SEO Studio ($REV).

fuentes/        las fuentes exactas usadas, con sus firmas (.asc) donde el proyecto firma
ffmpeg-build/   cómo se construye: componentes.conf, fuentes.lock (SHA-256, commits, huellas),
                claves/, Dockerfile y scripts; el árbol del repositorio (sin tests/muestras)
LICENSES/       avisos de licencia de FFmpeg y de todo lo enlazado estáticamente

Reconstruir con estas mismas fuentes (Docker y bash; la compilación no usa la red y vuelve a
comprobar el SHA-256 de cada fuente contra ffmpeg-build/fuentes.lock):
  bash ffmpeg-build/construir.sh --sin-descarga --fuentes fuentes --salida <dir vacío>
O descargándolas de nuevo y verificando firmas:
  bash ffmpeg-build/construir.sh --fuentes <dir vacío> --salida <dir vacío>
EOF

mkdir -p "$SALIDA"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" --mode='a-x,a+rX,u+w,go-w' \
  --format=gnu -C "$T" -cf - "$nombre" | xz -9 -T1 >"$SALIDA/$nombre.tar.xz"
(cd "$SALIDA" && sha256sum "$nombre.tar.xz")
