#!/usr/bin/env bash
# Compila ffmpeg/ffprobe LGPL para win64. Corre DENTRO del contenedor y sin red (construir.sh lo
# lanza con --network none, raíz de solo lectura y /tmp como único sitio de trabajo).
#   compilar.sh [--fuentes DIR] [--salida DIR]   (por defecto /build/fuentes y /build/out)
#   compilar.sh --imprimir-configure             opciones de ./configure (las usa la puerta)
#   compilar.sh --comprobar-fuentes DIR [LOCK]   SHA-256 de cada fuente de DIR contra el lock
# Salida: ffmpeg.exe, ffprobe.exe, configuracion.txt, avisos-toolchain/, SHA256SUMS.
# Nada se desactiva en silencio (I11): si configure no activa algo de componentes.conf, falla.
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=componentes.conf
source "$AQUI/componentes.conf"

RAIZ=/tmp/ffbuild                 # ruta fija: aparece en la configuración y en el binario
PREFIX=$RAIZ/prefix
CROSS=x86_64-w64-mingw32
CFLAGS_COMUNES="-ffile-prefix-map=$RAIZ=. -fno-ident -fstack-protector-strong"
LDFLAGS_COMUNES="-static -fstack-protector-strong -Wl,--no-insert-timestamp -Wl,--build-id=none -Wl,--dynamicbase -Wl,--nxcompat -Wl,--high-entropy-va"

error() { echo "ERROR: $*" >&2; exit 1; }
unir() { local IFS=,; echo "$*"; }

# Las opciones de configure salen SOLO de componentes.conf (más las fijas de la cruzada).
opciones_configure() {
  OPC=(
    --prefix="$PREFIX" --arch=x86_64 --target-os=mingw32 --cross-prefix="$CROSS-"
    --enable-cross-compile --pkg-config=pkg-config --pkg-config-flags=--static
    "${FF_CONFIGURE_ENABLE[@]}"
  )
  local t
  # shellcheck disable=SC2086 # las listas son palabras sueltas a propósito
  for t in "${FF_TIPOS[@]}"; do OPC+=("--enable-$t=$(unir ${FF_LISTAS[$t]})"); done
}

# columna <fichero-lock> <nombre> <nº de columna>
columna() { awk -F'\t' -v n="$2" -v c="$3" '$1 == n {print $c}' "$1"; }

leer_epoch() { # SOURCE_DATE_EPOCH = fecha de la release de ffmpeg, fijada en fuentes.lock
  local e; e=$(columna "$1" source-date-epoch 2)
  [[ "$e" =~ ^[0-9]{9,11}$ ]] || error "SOURCE_DATE_EPOCH no válido en fuentes.lock: '$e'"
  echo "$e"
}

# NVENC, AMF y Media Foundation cargan DLL en tiempo de ejecución: debe ser por win32_dlopen
# (LOAD_LIBRARY_SEARCH_APPLICATION_DIR | SYSTEM32: nunca el cwd ni el PATH; la carpeta del .exe sí
# y antes que System32, ver LEEME). Patrones de ffmpeg 7.1 y nv-codec-headers 12.1 (R0 M3, LOW-6).
comprobar_carga_dll() { # <árbol de ffmpeg> <árbol de nv-codec-headers>
  local s=$1 nv=$2 f amf=0 directas
  grep -q 'win32_dlopen' "$s/compat/w32dlfcn.h" && grep -q 'LOAD_LIBRARY_SEARCH_SYSTEM32' "$s/compat/w32dlfcn.h" \
    && grep -qE '#define dlopen\(name, *flags\) *win32_dlopen\(name\)' "$s/compat/w32dlfcn.h" \
    || error "compat/w32dlfcn.h no restringe la búsqueda de DLL como se espera"
  grep -q 'compat/w32dlfcn.h' "$s/compat/cuda/dynlink_loader.h" \
    && grep -qE 'define FFNV_LOAD_FUNC\(path\) *dlopen\(' "$s/compat/cuda/dynlink_loader.h" \
    || error "compat/cuda/dynlink_loader.h no carga NVENC por win32_dlopen"
  cat "$s/libavcodec/nvenc.h" "$s/libavcodec/nvenc.c" 2>/dev/null | grep -qE '#include +"compat/cuda/dynlink_loader.h"' \
    || error "nvenc no incluye compat/cuda/dynlink_loader.h"
  # La cabecera de NVIDIA solo puede definir FFNV_LOAD_FUNC dentro de un #ifndef/#if !defined de
  # FFNV_LOAD_FUNC: así manda la definición de ffmpeg (win32_dlopen).
  awk '/^[ \t]*#[ \t]*if/ { cond[++d] = $0 } /^[ \t]*#[ \t]*endif/ { d-- }
       /^[ \t]*#[ \t]*define[ \t]+FFNV_LOAD_FUNC/ { n++; bien = 0
         for (i = 1; i <= d; i++) if (cond[i] ~ /ifndef[ \t]+FFNV_LOAD_FUNC|!defined\(FFNV_LOAD_FUNC\)/) bien = 1
         if (!bien) mal = 1 }
       END { exit (mal || !n) }' "$nv/include/ffnvcodec/dynlink_loader.h" \
    || error "nv-codec-headers define FFNV_LOAD_FUNC sin guarda: pisaría la carga por win32_dlopen"
  while IFS= read -r f; do
    amf=$((amf + 1))
    grep -q 'w32dlfcn.h' "$f" || error "$f carga AMF sin compat/w32dlfcn.h"
  done < <(grep -rlE 'AMF_DLL_NAME' "$s/libavcodec" "$s/libavutil" 2>/dev/null || true)
  [ "$amf" -ge 1 ] || error "ningún fichero carga AMF_DLL_NAME: el patrón de ffmpeg cambió, revisar"
  # Por la salida y no por el código: una ruta que no exista en esta versión hace que grep salga
  # con 2 aunque haya coincidencias en las demás.
  directas=$(grep -snE '\bLoadLibrary(Ex)?[AW]?[[:space:]]*\(' "$s/libavcodec/nvenc.c" "$s/libavcodec"/amfenc*.c \
    "$s/libavutil"/hwcontext_amf*.c "$s/libavcodec/mfenc.c" "$s/libavcodec/mf_utils.c" \
    "$s/compat/cuda/dynlink_loader.h" || true)
  [ -z "$directas" ] || error "NVENC/AMF/MF llaman a LoadLibrary directamente: $directas"
}

# I11: configure no puede desactivar ni ignorar nada en silencio.
comprobar_log_configure() { # <configure.log>
  if grep -nE 'did not match anything|WARNING:' "$1" >&2; then error "configure avisó: no se acepta (I11)"; fi
}

# Cada componente declarado está activo en config_components.h; nada GPL, hwaccel ni prohibido.
comprobar_config_h() { # <directorio con config.h y config_components.h>
  local d=$1 n c t errores=0 macro valor
  if grep -qE '#define CONFIG_(GPL|NONFREE|VERSION3) 1' "$d/config.h"; then error "config.h: gpl/nonfree/version3 activo"; fi
  local -A activo=()
  while read -r _ macro valor; do [ "$valor" = 1 ] && activo[$macro]=1; done < <(grep '^#define CONFIG_' "$d/config_components.h")
  for t in "${FF_TIPOS[@]}"; do
    for n in ${FF_LISTAS[$t]}; do
      [ -n "${activo[CONFIG_${n^^}_${t^^}]+x}" ] || { echo "ERROR: configure no activó $n ($t)" >&2; errores=1; }
    done
  done
  for c in "${!activo[@]}"; do
    case "$c" in *_HWACCEL | *_OUTDEV) echo "ERROR: activo y no permitido: $c" >&2; errores=1 ;; esac
    # Protocolos: solo los declarados (la red no entra ni autoseleccionada).
    if [[ "$c" == *_PROTOCOL ]]; then
      n=${c#CONFIG_}; n=${n%_PROTOCOL}; n=${n,,}
      [[ " ${FF_LISTAS[protocol]} " == *" $n "* ]] || { echo "ERROR: protocolo no declarado activo: $n" >&2; errores=1; }
    fi
    for n in "${FF_PROHIBIDOS[@]}"; do
      [[ "$c" != "CONFIG_${n^^}_"* ]] || { echo "ERROR: prohibido activo: $c" >&2; errores=1; }
    done
  done
  [ "$errores" = 0 ] || error "config_components.h no corresponde a componentes.conf"
}

comprobar_fuentes() { # <lock> <dir>: re-verifica el SHA-256 de cada fuente (llegan de otro contenedor)
  local nombre version tipo url sha f n=0
  while IFS=$'\t' read -r nombre version tipo url sha _; do
    case "$tipo" in tar) f=$(basename "$url") ;; git) f=$nombre-$version.tar ;; *) continue ;; esac
    echo "$sha  $2/$f" | sha256sum -c --quiet - || error "fuente alterada o ausente: $f"
    n=$((n + 1))
  done < <(grep -v '^#' "$1")
  [ "$n" -gt 0 ] || error "el lock no tiene fuentes"
}

extraer() { # <nombre-en-lock> → imprime el directorio extraído
  local version tipo url d
  version=$(columna "$AQUI/fuentes.lock" "$1" 2); tipo=$(columna "$AQUI/fuentes.lock" "$1" 3)
  url=$(columna "$AQUI/fuentes.lock" "$1" 4); d=$RAIZ/src/$1
  mkdir -p "$d"
  if [ "$tipo" = tar ]; then tar -xf "$FUENTES/$(basename "$url")" -C "$d" --strip-components=1 --no-same-owner
  else tar -xf "$FUENTES/$1-$version.tar" -C "$d" --no-same-owner; fi
  echo "$d"
}

construir_zlib() {
  local d; d=$(extraer zlib)
  make -C "$d" -f win32/Makefile.gcc PREFIX=$CROSS- CFLAGS="-O2 -Wall $CFLAGS_COMUNES" libz.a
  install -D -m 644 "$d/libz.a" "$PREFIX/lib/libz.a"
  install -D -m 644 -t "$PREFIX/include" "$d/zlib.h" "$d/zconf.h"
}

construir_dav1d() {
  local d; d=$(extraer dav1d)
  cat >"$RAIZ/cruzado.meson" <<EOF
[binaries]
c = '$CROSS-gcc'
ar = '$CROSS-ar'
strip = '$CROSS-strip'
windres = '$CROSS-windres'
pkg-config = 'pkg-config'
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
  CFLAGS="$CFLAGS_COMUNES" meson setup "$d/build" "$d" --cross-file "$RAIZ/cruzado.meson" \
    --prefix "$PREFIX" --libdir lib --buildtype release --wrap-mode=nodownload \
    -Ddefault_library=static -Denable_tools=false -Denable_tests=false -Denable_examples=false -Denable_docs=false
  ninja -C "$d/build" install
}

instalar_nvcodec() { NV=$(extraer nv-codec-headers); make -C "$NV" install PREFIX="$PREFIX"; }

instalar_amf() {
  local d; d=$(extraer amf-headers)
  mkdir -p "$PREFIX/include/AMF"
  cp -r "$d/amf/public/include/." "$PREFIX/include/AMF/"
}

construir_ffmpeg() {
  local d log conf
  d=$(extraer ffmpeg); log=$RAIZ/configure.log
  comprobar_carga_dll "$d" "$NV"
  opciones_configure
  (cd "$d" && PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" ./configure "${OPC[@]}" \
    --extra-cflags="-I$PREFIX/include $CFLAGS_COMUNES" --extra-ldflags="-L$PREFIX/lib $LDFLAGS_COMUNES" \
    --extra-version=seo-studio) >"$log" 2>&1 || { cat "$log" >&2; error "configure falló"; }
  comprobar_log_configure "$log"
  comprobar_config_h "$d"
  conf=$(sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' "$d/config.h")
  echo "$conf" >"$RAIZ/configuracion.txt"
  bash "$AQUI/verificar-configuracion.sh" "$RAIZ/configuracion.txt"
  make -C "$d" -j"$(nproc)" ffmpeg.exe ffprobe.exe
  $CROSS-strip --strip-all -o "$SALIDA/ffmpeg.exe" "$d/ffmpeg_g.exe"
  $CROSS-strip --strip-all -o "$SALIDA/ffprobe.exe" "$d/ffprobe_g.exe"
  cp "$RAIZ/configuracion.txt" "$SALIDA/"
}

# Avisos del runtime enlazado estáticamente (CRT de MinGW, winpthreads, libgcc con su excepción).
# Rutas de la imagen fijada: si falta una, el build falla (se confirman en la Tarea 10).
avisos_toolchain() {
  mkdir -p "$SALIDA/avisos-toolchain"
  cp /usr/share/doc/mingw-w64-x86-64-dev/copyright "$SALIDA/avisos-toolchain/mingw-w64-x86-64-dev-copyright.txt"
  cp /usr/share/doc/gcc-mingw-w64-base/copyright "$SALIDA/avisos-toolchain/gcc-mingw-w64-copyright.txt"
}

main() {
  FUENTES=/build/fuentes; SALIDA=/build/out
  while [ $# -gt 0 ]; do
    case "$1" in
      --fuentes) FUENTES=$2; shift 2 ;;
      --salida) SALIDA=$2; shift 2 ;;
      *) error "opción desconocida: $1" ;;
    esac
  done
  SOURCE_DATE_EPOCH=$(leer_epoch "$AQUI/fuentes.lock")
  export SOURCE_DATE_EPOCH TZ=UTC LC_ALL=C
  umask 022
  [ -z "$(ls -A "$SALIDA")" ] || error "--salida debe estar vacía"
  rm -rf "$RAIZ"; mkdir -p "$RAIZ/src" "$PREFIX"
  comprobar_fuentes "$AQUI/fuentes.lock" "$FUENTES"
  construir_zlib
  construir_dav1d
  instalar_nvcodec
  instalar_amf
  construir_ffmpeg
  avisos_toolchain
  (cd "$SALIDA" && sha256sum ffmpeg.exe ffprobe.exe >SHA256SUMS)
  cat "$SALIDA/SHA256SUMS"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    --imprimir-configure) opciones_configure; echo "${OPC[*]}"; exit 0 ;;
    --comprobar-fuentes) comprobar_fuentes "${3:-$AQUI/fuentes.lock}" "$2"; echo "Fuentes conformes al lock."; exit 0 ;;
  esac
  main "$@"
fi
