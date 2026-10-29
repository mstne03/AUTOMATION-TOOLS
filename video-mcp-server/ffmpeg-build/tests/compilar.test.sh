#!/usr/bin/env bash
# compilar.sh y construir.sh: determinismo, endurecimiento, aislamiento y las comprobaciones que
# hacen fallar el build en vez de desactivar algo en silencio (I11). Sin Docker ni red.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
C="$DIR_BUILD/compilar.sh"
B="$DIR_BUILD/construir.sh"
afirmar "existe construir.sh" test -f "$B"

# --- Determinismo y endurecimiento (estático) -----------------------------------------------
for patron in 'export SOURCE_DATE_EPOCH' 'TZ=UTC' 'LC_ALL=C' 'umask 022' \
  '-ffile-prefix-map=' '-fno-ident' '-fstack-protector-strong' \
  '-Wl,--no-insert-timestamp' '-Wl,--build-id=none' '-Wl,--dynamicbase' '-Wl,--nxcompat' '-Wl,--high-entropy-va' \
  '-static' 'strip --strip-all' '-Ddefault_library=static' '-Denable_tools=false' '-Denable_tests=false' \
  '--wrap-mode=nodownload' 'did not match anything' 'WARNING:'; do
  afirmar "compilar.sh contiene '$patron'" grep -qF -- "$patron" "$C"
done
for p in --enable-gpl --enable-nonfree --enable-version3 libx264 libopenh264 libvpl; do
  negar "compilar.sh no contiene $p" grep -qF -- "$p" "$C"
done
# Orden de construcción: zlib → dav1d → nv-codec-headers → AMF → ffmpeg.
orden=$(grep -oE '^  (construir_zlib|construir_dav1d|instalar_nvcodec|instalar_amf|construir_ffmpeg)\b' "$C" | tr -d ' ' | paste -sd' ' - || true)
afirmar "orden zlib → dav1d → nv → AMF → ffmpeg ($orden)" test "$orden" = "construir_zlib construir_dav1d instalar_nvcodec instalar_amf construir_ffmpeg"

# --- SOURCE_DATE_EPOCH sale de fuentes.lock y no admite PENDIENTE ----------------------------
fila_meta() { printf 'source-date-epoch\t%s\tmeta\t-\t-\t-\t-\t-\t-\t-\t-\n' "$1" >"$TMP_TEST/lock"; }
fila_meta 1767225600
ejecutar bash -c "source '$C'; leer_epoch '$TMP_TEST/lock'"
if [ "$CODIGO" -eq 0 ] && [ "$SALIDA" = 1767225600 ]; then ok "SOURCE_DATE_EPOCH leído de fuentes.lock"; else mal "leer_epoch: $SALIDA"; fi
fila_meta PENDIENTE-TAREA-10
negar "SOURCE_DATE_EPOCH PENDIENTE → ≠ 0" bash -c "source '$C'; leer_epoch '$TMP_TEST/lock'"

# --- Carga de DLL de NVENC/AMF solo por win32_dlopen (R0 M3) ---------------------------------
arbol() { # árbol de fuentes mínimo con los patrones de ffmpeg 7.1
  local r=$TMP_TEST/$1; rm -rf "$r"; mkdir -p "$r/compat/cuda" "$r/libavcodec" "$r/libavutil"
  cat >"$r/compat/w32dlfcn.h" <<'EOF'
static inline HMODULE win32_dlopen(const char *name)
{ return LoadLibraryExW(name_w, NULL, LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32); }
#define dlopen(name, flags) win32_dlopen(name)
EOF
  printf '#include "compat/w32dlfcn.h"\n#define FFNV_LOAD_FUNC(path) dlopen((path), RTLD_LAZY)\n#include <ffnvcodec/dynlink_loader.h>\n' >"$r/compat/cuda/dynlink_loader.h"
  printf '#include "compat/cuda/dynlink_loader.h"\n' >"$r/libavcodec/nvenc.c"
  printf '#include "compat/w32dlfcn.h"\nlib = dlopen(AMF_DLL_NAMEA, RTLD_NOW | RTLD_LOCAL);\n' >"$r/libavcodec/amfenc.c"
  echo "$r"
}
bueno=$(arbol bueno)
afirmar "árbol con win32_dlopen → 0" bash -c "source '$C'; comprobar_carga_dll '$bueno'"
malo=$(arbol amf-loadlibrary); printf 'lib = LoadLibraryA(AMF_DLL_NAMEA);\n' >>"$malo/libavcodec/amfenc.c"
negar "amfenc con LoadLibrary directo → ≠ 0" bash -c "source '$C'; comprobar_carga_dll '$malo'"
malo=$(arbol amf-sin-w32); printf 'lib = dlopen(AMF_DLL_NAMEA, 0);\n' >"$malo/libavutil/hwcontext_amf.c"
negar "otro fichero que carga AMF sin w32dlfcn.h → ≠ 0" bash -c "source '$C'; comprobar_carga_dll '$malo'"
malo=$(arbol nv-sin-w32); sed -i '/w32dlfcn/d' "$malo/compat/cuda/dynlink_loader.h"
negar "dynlink_loader.h sin w32dlfcn.h → ≠ 0" bash -c "source '$C'; comprobar_carga_dll '$malo'"
malo=$(arbol sin-system32); sed -i 's/ | LOAD_LIBRARY_SEARCH_SYSTEM32//' "$malo/compat/w32dlfcn.h"
negar "win32_dlopen sin LOAD_LIBRARY_SEARCH_SYSTEM32 → ≠ 0" bash -c "source '$C'; comprobar_carga_dll '$malo'"

# --- config.h / config_components.h: todo lo declarado está activo y nada prohibido ----------
config_bueno() {
  local d=$TMP_TEST/$1; rm -rf "$d"; mkdir -p "$d"
  printf '#define CONFIG_GPL 0\n#define CONFIG_NONFREE 0\n#define CONFIG_VERSION3 0\n' >"$d/config.h"
  bash -c "source '$DIR_BUILD/componentes.conf'
    for n in \${FF_PROTOCOLS[@]}; do echo \"#define CONFIG_\${n^^}_PROTOCOL 1\"; done
    for n in \${FF_DEMUXERS[@]}; do echo \"#define CONFIG_\${n^^}_DEMUXER 1\"; done
    for n in \${FF_MUXERS[@]}; do echo \"#define CONFIG_\${n^^}_MUXER 1\"; done
    for n in \${FF_DECODERS[@]}; do echo \"#define CONFIG_\${n^^}_DECODER 1\"; done
    for n in \${FF_ENCODERS[@]}; do echo \"#define CONFIG_\${n^^}_ENCODER 1\"; done
    for n in \${FF_PARSERS[@]}; do echo \"#define CONFIG_\${n^^}_PARSER 1\"; done
    for n in \${FF_BSFS[@]}; do echo \"#define CONFIG_\${n^^}_BSF 1\"; done
    for n in \${FF_FILTERS[@]}; do echo \"#define CONFIG_\${n^^}_FILTER 1\"; done
    for n in \${FF_INDEVS[@]}; do echo \"#define CONFIG_\${n^^}_INDEV 1\"; done
    echo '#define CONFIG_HTTP_PROTOCOL 0'; echo '#define CONFIG_H264_D3D11VA_HWACCEL 0'" >"$d/config_components.h"
  echo "$d"
}
d=$(config_bueno ok)
afirmar "config con todo lo declarado → 0" bash -c "source '$C'; comprobar_config_h '$d'"
d=$(config_bueno falta); sed -i 's/CONFIG_H264_MF_ENCODER 1/CONFIG_H264_MF_ENCODER 0/' "$d/config_components.h"
negar "h264_mf desactivado en silencio por configure → ≠ 0" bash -c "source '$C'; comprobar_config_h '$d'"
d=$(config_bueno gpl); sed -i 's/CONFIG_GPL 0/CONFIG_GPL 1/' "$d/config.h"
negar "CONFIG_GPL 1 → ≠ 0" bash -c "source '$C'; comprobar_config_h '$d'"
d=$(config_bueno hwaccel); echo '#define CONFIG_HEVC_DXVA2_HWACCEL 1' >>"$d/config_components.h"
negar "un hwaccel activo → ≠ 0" bash -c "source '$C'; comprobar_config_h '$d'"
d=$(config_bueno movie); echo '#define CONFIG_MOVIE_FILTER 1' >>"$d/config_components.h"
negar "filtro movie activo (autoseleccionado) → ≠ 0" bash -c "source '$C'; comprobar_config_h '$d'"
d=$(config_bueno http); sed -i 's/CONFIG_HTTP_PROTOCOL 0/CONFIG_HTTP_PROTOCOL 1/' "$d/config_components.h"
negar "un protocolo no declarado activo → ≠ 0" bash -c "source '$C'; comprobar_config_h '$d'"

# --- construir.sh: puerta de PENDIENTE y aislamiento de los contenedores (R0 M4) -------------
if [ -f "$B" ]; then
  logica=$(sed -e ':a' -e '/\\$/N; s/\\\n//; ta' "$B")
  pend=$(grep -n 'comprobar-pendientes.sh' <<<"$logica" | head -1 | cut -d: -f1)
  build=$(grep -n 'docker build' <<<"$logica" | head -1 | cut -d: -f1)
  afirmar "comprobar-pendientes.sh antes de docker build" test -n "$pend" -a -n "$build" -a "${pend:-0}" -lt "${build:-0}"
  afirmar "docker build --no-cache (sin cachés)" grep -q 'docker build .*--no-cache' <<<"$logica"
  compilacion=$(grep 'compilar.sh' <<<"$logica" | grep 'docker run' || true)
  descarga=$(grep 'descargar-fuentes.sh' <<<"$logica" | grep 'docker run' || true)
  afirmar "hay un docker run para descargar y otro para compilar" test -n "$compilacion" -a -n "$descarga"
  for o in '--network none' '--cap-drop ALL' '--security-opt no-new-privileges' '--read-only' 'fuentes:ro'; do
    afirmar "compilación con '$o'" grep -qF -- "$o" <<<"$compilacion"
  done
  for o in '--cap-drop ALL' '--security-opt no-new-privileges' '--read-only'; do
    afirmar "descarga con '$o'" grep -qF -- "$o" <<<"$descarga"
  done
  afirmar "ffmpeg-build montado solo lectura en ambos" test "$(grep -c '/build/ffmpeg-build:ro' <<<"$logica")" -ge 2
  negar "sin socket de Docker" grep -q 'docker.sock' "$B"
  negar "sin GITHUB_WORKSPACE" grep -q 'GITHUB_WORKSPACE' "$B"
  negar "sin --network host" grep -q -- '--network host' "$B"
fi

fin
