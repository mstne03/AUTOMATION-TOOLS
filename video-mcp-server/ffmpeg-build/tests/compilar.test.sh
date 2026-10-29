#!/usr/bin/env bash
# compilar.sh y construir.sh: determinismo, aislamiento y las comprobaciones que hacen fallar el
# build en vez de desactivar algo en silencio (I11). Sin Docker ni red: se cargan las funciones de
# compilar.sh y se ejercitan con fixtures.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
C="$DIR_BUILD/compilar.sh"
B="$DIR_BUILD/construir.sh"
con() { bash -c "source '$C'; $*"; }   # ejecuta una función de compilar.sh

# --- Flags efectivos (los valores que usa compilar.sh, no texto suelto del script) ------------
flags=$(con 'echo "$CFLAGS_COMUNES | $LDFLAGS_COMUNES"')
for f in -ffile-prefix-map=/tmp/ffbuild=. -fno-ident -fstack-protector-strong -static \
  -Wl,--no-insert-timestamp -Wl,--build-id=none; do
  afirmar "flag de determinismo/endurecimiento: $f" grep -qF -- " $f " <<<" ${flags//|/ } "
done
orden=$(grep -oE '^  (construir_zlib|construir_dav1d|instalar_nvcodec|instalar_amf|construir_ffmpeg)\b' "$C" | tr -d ' ' | paste -sd' ' - || true)
afirmar "orden zlib → dav1d → nv → AMF → ffmpeg" test "$orden" = "construir_zlib construir_dav1d instalar_nvcodec instalar_amf construir_ffmpeg"
conf=$(bash "$C" --imprimir-configure)
afirmar "configure en orden fijo de tipos" grep -qE -- '--enable-protocol=.*--enable-demuxer=.*--enable-indev=lavfi$' <<<"$conf"

# --- SOURCE_DATE_EPOCH sale de fuentes.lock y no admite PENDIENTE ----------------------------
fila_meta() { printf 'source-date-epoch\t%s\tmeta\t-\t-\t-\t-\t-\t-\t-\t-\n' "$1" >"$TMP_TEST/lock"; }
fila_meta 1767225600
ejecutar con "leer_epoch '$TMP_TEST/lock'"
if [ "$CODIGO" -eq 0 ] && [ "$SALIDA" = 1767225600 ]; then ok "SOURCE_DATE_EPOCH leído de fuentes.lock"; else mal "leer_epoch: $SALIDA"; fi
fila_meta PENDIENTE-TAREA-10
negar "SOURCE_DATE_EPOCH PENDIENTE → ≠ 0" con "leer_epoch '$TMP_TEST/lock'"

# --- Log de configure (I11, R1 punto 4) -------------------------------------------------------
printf 'install prefix  /tmp/ffbuild/prefix\nEnabled encoders:\nh264_mf\n' >"$TMP_TEST/limpio.log"
printf 'install prefix\nWARNING: Option --enable-demuxer=hls did not match anything\n' >"$TMP_TEST/nomatch.log"
printf 'install prefix\nWARNING: pkg-config not found, library detection may fail.\n' >"$TMP_TEST/warning.log"
afirmar "log de configure limpio → 0" con "comprobar_log_configure '$TMP_TEST/limpio.log'"
negar "log con «did not match anything» → ≠ 0" con "comprobar_log_configure '$TMP_TEST/nomatch.log'"
negar "log con WARNING: → ≠ 0" con "comprobar_log_configure '$TMP_TEST/warning.log'"

# --- Carga de DLL solo por win32_dlopen (R0 M3, R1 LOW-6) ------------------------------------
arbol() { # árbol mínimo de ffmpeg 7.1 + nv-codec-headers con los patrones reales
  local r=$TMP_TEST/$1; rm -rf "$r"; mkdir -p "$r/ff/compat/cuda" "$r/ff/libavcodec" "$r/ff/libavutil" "$r/nv/include/ffnvcodec"
  cat >"$r/ff/compat/w32dlfcn.h" <<'EOF'
static inline HMODULE win32_dlopen(const char *name)
{ return LoadLibraryExW(name_w, NULL, LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32); }
#define dlopen(name, flags) win32_dlopen(name)
EOF
  printf '#include "compat/w32dlfcn.h"\n#define FFNV_LOAD_FUNC(path) dlopen((path), RTLD_LAZY)\n#include <ffnvcodec/dynlink_loader.h>\n' >"$r/ff/compat/cuda/dynlink_loader.h"
  printf '#include "compat/cuda/dynlink_loader.h"\n' >"$r/ff/libavcodec/nvenc.h"
  printf '#include "nvenc.h"\n' >"$r/ff/libavcodec/nvenc.c"
  printf '#include "compat/w32dlfcn.h"\nlib = dlopen(AMF_DLL_NAMEA, RTLD_NOW | RTLD_LOCAL);\n' >"$r/ff/libavcodec/amfenc.c"
  printf 'static HRESULT init(void) { return MFStartup(MF_VERSION, 0); }\n' >"$r/ff/libavcodec/mfenc.c"
  cat >"$r/nv/include/ffnvcodec/dynlink_loader.h" <<'EOF'
#if !defined(FFNV_LOAD_FUNC) || !defined(FFNV_SYM_FUNC)
# ifdef _WIN32
#  define FFNV_LOAD_FUNC(path) LoadLibrary(TEXT(path))
# else
#  define FFNV_LOAD_FUNC(path) dlopen((path), RTLD_LAZY)
# endif
#endif
EOF
  echo "$r"
}
dll() { con "comprobar_carga_dll '$1/ff' '$1/nv'"; }
r=$(arbol bueno); afirmar "árbol con win32_dlopen → 0" dll "$r"
r=$(arbol amf-loadlibrary); printf 'lib = LoadLibraryA(AMF_DLL_NAMEA);\n' >>"$r/ff/libavcodec/amfenc.c"
negar "amfenc con LoadLibrary directo → ≠ 0" dll "$r"
r=$(arbol amf-sin-w32); printf 'lib = dlopen(AMF_DLL_NAMEA, 0);\n' >"$r/ff/libavutil/hwcontext_amf.c"
negar "otro fichero que carga AMF sin w32dlfcn.h → ≠ 0" dll "$r"
r=$(arbol sin-amf); rm "$r/ff/libavcodec/amfenc.c"
negar "ningún fichero con AMF_DLL_NAME → ≠ 0 (patrón cambiado)" dll "$r"
r=$(arbol mf-loadlibrary); printf 'h = LoadLibraryW(L"mfplat.dll");\n' >"$r/ff/libavcodec/mf_utils.c"
negar "mf_utils.c con LoadLibrary directo → ≠ 0" dll "$r"
r=$(arbol nv-sin-w32); sed -i '/w32dlfcn/d' "$r/ff/compat/cuda/dynlink_loader.h"
negar "compat/cuda/dynlink_loader.h sin w32dlfcn.h → ≠ 0" dll "$r"
r=$(arbol nvenc-sin-loader); printf '#include <ffnvcodec/dynlink_loader.h>\n' >"$r/ff/libavcodec/nvenc.h"
negar "nvenc que no incluye compat/cuda/dynlink_loader.h → ≠ 0" dll "$r"
r=$(arbol nv-sin-guarda); printf '#define FFNV_LOAD_FUNC(path) LoadLibrary(TEXT(path))\n' >"$r/nv/include/ffnvcodec/dynlink_loader.h"
negar "nv-codec-headers define FFNV_LOAD_FUNC sin guarda → ≠ 0" dll "$r"
r=$(arbol sin-system32); sed -i 's/ | LOAD_LIBRARY_SEARCH_SYSTEM32//' "$r/ff/compat/w32dlfcn.h"
negar "win32_dlopen sin LOAD_LIBRARY_SEARCH_SYSTEM32 → ≠ 0" dll "$r"

# --- config.h / config_components.h: todo lo declarado está activo y nada prohibido ----------
config_bueno() {
  local d=$TMP_TEST/$1; rm -rf "$d"; mkdir -p "$d"
  printf '#define CONFIG_GPL 0\n#define CONFIG_NONFREE 0\n#define CONFIG_VERSION3 0\n' >"$d/config.h"
  bash -c "source '$DIR_BUILD/componentes.conf'
    for t in \"\${FF_TIPOS[@]}\"; do for n in \${FF_LISTAS[\$t]}; do echo \"#define CONFIG_\${n^^}_\${t^^} 1\"; done; done
    echo '#define CONFIG_HTTP_PROTOCOL 0'; echo '#define CONFIG_H264_D3D11VA_HWACCEL 0'" >"$d/config_components.h"
  echo "$d"
}
cfg() { con "comprobar_config_h '$1'"; }
d=$(config_bueno ok); afirmar "config con todo lo declarado → 0" cfg "$d"
d=$(config_bueno falta); sed -i 's/CONFIG_H264_MF_ENCODER 1/CONFIG_H264_MF_ENCODER 0/' "$d/config_components.h"
negar "h264_mf desactivado en silencio por configure → ≠ 0" cfg "$d"
d=$(config_bueno gpl); sed -i 's/CONFIG_GPL 0/CONFIG_GPL 1/' "$d/config.h"
negar "CONFIG_GPL 1 → ≠ 0" cfg "$d"
d=$(config_bueno hwaccel); echo '#define CONFIG_HEVC_DXVA2_HWACCEL 1' >>"$d/config_components.h"
negar "un hwaccel activo → ≠ 0" cfg "$d"
d=$(config_bueno outdev); echo '#define CONFIG_SDL2_OUTDEV 1' >>"$d/config_components.h"
negar "un outdev activo → ≠ 0" cfg "$d"
d=$(config_bueno movie); echo '#define CONFIG_MOVIE_FILTER 1' >>"$d/config_components.h"
negar "filtro movie activo (autoseleccionado) → ≠ 0" cfg "$d"
d=$(config_bueno http); sed -i 's/CONFIG_HTTP_PROTOCOL 0/CONFIG_HTTP_PROTOCOL 1/' "$d/config_components.h"
negar "un protocolo no declarado activo → ≠ 0" cfg "$d"

# --- --comprobar-fuentes (lo usa también el job empaquetar) ----------------------------------
mkdir -p "$TMP_TEST/f"; echo x >"$TMP_TEST/f/a-1.tar.xz"
s=$(sha256sum <"$TMP_TEST/f/a-1.tar.xz" | cut -d' ' -f1)
printf 'a\t1\ttar\thttps://x.invalid/a-1.tar.xz\t%s\t-\t-\t-\t-\t-\t-\n' "$s" >"$TMP_TEST/lockf"
afirmar "--comprobar-fuentes con el SHA del lock → 0" bash "$C" --comprobar-fuentes "$TMP_TEST/f" "$TMP_TEST/lockf"
echo y >>"$TMP_TEST/f/a-1.tar.xz"
negar "--comprobar-fuentes con una fuente alterada → ≠ 0" bash "$C" --comprobar-fuentes "$TMP_TEST/f" "$TMP_TEST/lockf"

# --- construir.sh: puerta de pendientes y aislamiento de los contenedores (R0 M4) ------------
logica=$(sed -e ':a' -e '/\\$/N; s/\\\n//; ta' "$B")
pend=$(grep -n 'comprobar-pendientes.sh' <<<"$logica" | head -1 | cut -d: -f1)
build=$(grep -n 'docker build' <<<"$logica" | head -1 | cut -d: -f1)
afirmar "comprobar-pendientes.sh antes de docker build" test -n "$pend" -a -n "$build" -a "${pend:-0}" -lt "${build:-0}"
afirmar "docker build --no-cache (sin cachés)" grep -q 'docker build .*--no-cache' <<<"$logica"
compilacion=$(grep 'compilar.sh' <<<"$logica" | grep 'docker run' || true)
descarga=$(grep 'descargar-fuentes.sh' <<<"$logica" | grep 'docker run' || true)
for o in '--network none' '--cap-drop ALL' '--security-opt no-new-privileges' '--read-only' 'fuentes:ro' '--user' '-e HOME=/tmp'; do
  afirmar "compilación con '$o'" grep -qF -- "$o" <<<"$compilacion"
done
for o in '--cap-drop ALL' '--security-opt no-new-privileges' '--read-only' '--user' '-e HOME=/tmp'; do
  afirmar "descarga con '$o'" grep -qF -- "$o" <<<"$descarga"
done
afirmar "ffmpeg-build montado solo lectura en ambos" test "$(grep -c '/build/ffmpeg-build:ro' <<<"$logica")" -ge 2
negar "sin socket de Docker ni GITHUB_WORKSPACE" grep -qE 'docker.sock|GITHUB_WORKSPACE' "$B"
negar "--sin-descarga con --fuentes vacío → ≠ 0 (antes de Docker)" bash -c "cd '$TMP_TEST' && sed 's#bash \"\$AQUI/comprobar-pendientes.sh\"#:#' '$B' >c.sh && bash c.sh --sin-descarga --fuentes vacio --salida s"

fin
