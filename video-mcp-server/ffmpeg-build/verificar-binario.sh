#!/usr/bin/env bash
# Verifica un ffmpeg.exe/ffprobe.exe REAL en Windows (Git Bash): listados exactos, licencia,
# endurecimiento PE y pruebas funcionales con las muestras de tests/muestras (I12, I15).
#   verificar-binario.sh <dir con ffmpeg.exe y ffprobe.exe>
#   SIN_MF=1  omite h264_mf SOLO si se pide (entrada explícita del workflow, nunca deducida, R0 M6):
#             el resumen dice «NO VERIFICADO: h264_mf» y la prueba de Marc pasa a ser bloqueante.
# Cada comprobación lleva un grupo entre corchetes. Los grupos listados, licencia, pe-tamaño,
# importaciones y protocolos-red solo los pasa este build (BtbN los falla: así se prueba que la
# verificación muerde). No escribe en GITHUB_*: el workflow lo lanza sin esas variables y publica
# el resumen desde fuera.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=componentes.conf
source "$AQUI/componentes.conf"
[ $# -eq 1 ] && [ -f "$1/ffmpeg.exe" ] && [ -f "$1/ffprobe.exe" ] || { echo "Uso: $0 <dir con ffmpeg.exe y ffprobe.exe>" >&2; exit 2; }
FF="$1/ffmpeg.exe"; FP="$1/ffprobe.exe"; M="${MUESTRAS:-$AQUI/tests/muestras}"; SIN_MF=${SIN_MF:-0}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
FALLOS=0; RESUMEN=()

comprobar() { # comprobar <grupo> <descripción> comando…
  if "${@:3}" >"$T/log" 2>&1; then echo "OK    [$1] $2"
  else echo "FALLA [$1] $2"; tail -5 "$T/log" | sed 's/^/        /'; FALLOS=$((FALLOS + 1)); fi
}
ff() { timeout 30 "$FF" -hide_banner -nostdin -v error -y "$@"; }
fp() { "$FP" -v error "$@" | tr -d "\r"; }   # ffprobe en Windows escribe CRLF

# --- Listados exactos: componentes.conf ∪ autoseleccionados.txt (R0 M3) ---------------------
nombres() { # nombres <tipo> → lo que el binario dice tener de ese tipo, uno por línea
  case "$1" in
    demuxer | muxer)
      "$FF" -hide_banner "-${1}s" | awk 'f && substr($0,4,1) != "d" { split(substr($0,6),a," "); split(a[1],b,","); print b[1] } /^ ---/ {f=1}' ;;
    decoder | encoder) "$FF" -hide_banner "-${1}s" | awk 'f {print $2} /^ ------/ {f=1}' ;;
    filter) "$FF" -hide_banner -filters | awk '/^ [T.][S.][C.] / {print $2}' ;;
    protocol) "$FF" -hide_banner -protocols | awk '/^  [a-z]/ {print $1}' ;;
    bsf) "$FF" -hide_banner -bsfs | awk 'f {print $1} /^Bitstream filters:/ {f=1}' ;;
    indev) "$FF" -hide_banner -devices | awk 'f && substr($0,2,1) == "D" { split(substr($0,5),a," "); split(a[1],b,","); print b[1] } /^ ---/ {f=1}' ;;
    outdev) "$FF" -hide_banner -devices | awk 'f && substr($0,3,1) == "E" { split(substr($0,5),a," "); split(a[1],b,","); print b[1] } /^ ---/ {f=1}' ;;
  esac | sed '/^$/d' | sort -u
}
listado_exacto() { # listado_exacto <tipo> → igual a FF_LISTAS[tipo] ∪ autoseleccionados de ese tipo
  local tipo=$1 esperado real sobran faltan
  # shellcheck disable=SC2086 # la lista son palabras sueltas
  esperado=$( { printf '%s\n' ${FF_LISTAS[$tipo]:-}; awk -v t="$tipo" '$1 == t {print $2}' "$AQUI/autoseleccionados.txt"; } | sed '/^$/d' | sort -u)
  real=$(nombres "$tipo")
  sobran=$(comm -13 <(echo "$esperado") <(echo "$real") | paste -sd' ' -)
  faltan=$(comm -23 <(echo "$esperado") <(echo "$real") | paste -sd' ' -)
  [ -z "$sobran" ] || echo "sobran: $sobran"
  [ -z "$faltan" ] || echo "faltan: $faltan"
  [ -z "$sobran$faltan" ]
}
comprobar listados "autoseleccionados.txt revisado (sin PENDIENTE-TAREA-10)" bash -c "! grep -n PENDIENTE-TAREA-10 '$AQUI/autoseleccionados.txt'"
for t in protocol demuxer muxer decoder encoder bsf filter indev; do
  comprobar listados "-${t}s exactos (componentes.conf ∪ autoseleccionados)" listado_exacto "$t"
done
# Ningún dispositivo de salida (sdl, opengl…): FF_LISTAS no declara outdev, así que la lista
# esperada es vacía (R1 LOW-10).
comprobar listados "-devices: cero dispositivos de salida" listado_exacto outdev
sin_prohibidos() {
  local todos p
  todos=" $( { nombres encoder; nombres decoder; nombres filter; } | tr '\n' ' ') "
  for p in "${FF_PROHIBIDOS[@]}"; do [[ "$todos" != *" $p "* ]] || { echo "presente: $p"; return 1; }; done
}
comprobar listados "ningún codificador, decodificador ni filtro prohibido (x264, openh264, movie, zmq…)" sin_prohibidos

# --- Licencia -------------------------------------------------------------------------------
"$FF" -hide_banner -buildconf >"$T/buildconf"; "$FF" -hide_banner -encoders >"$T/encoders"
comprobar licencia "-buildconf pasa la puerta de componentes.conf" bash "$AQUI/verificar-configuracion.sh" "$T/buildconf" "$T/encoders"
comprobar licencia "-version sin --enable-gpl ni --enable-nonfree" bash -c "! '$FF' -hide_banner -version | grep -E -- '--enable-(gpl|nonfree)'"
lgpl21() { "$1" -hide_banner -L | tr '\n' ' ' | grep -E 'GNU Lesser General Public License.*version 2\.1 of the License.*any later version'; }
comprobar licencia "ffmpeg -L: LGPL 2.1 o posterior" lgpl21 "$FF"
comprobar licencia "ffprobe -L: LGPL 2.1 o posterior" lgpl21 "$FP"

# --- PE: ASLR (también de 64 bits), DEP y tamaño ---------------------------------------------
pe_flags() { # DllCharacteristics: 0x20 HIGH_ENTROPY_VA, 0x40 DYNAMIC_BASE, 0x100 NX_COMPAT
  local pe dc
  pe=$(od -An -t u4 -j 60 -N 4 "$1" | tr -d ' ')
  [ "$(od -An -c -j "$pe" -N 2 "$1" | tr -d ' ')" = PE ] || { echo "no es PE"; return 1; }
  dc=$(od -An -t u2 -j $((pe + 24 + 70)) -N 2 "$1" | tr -d ' ')
  (( (dc & 0x20) && (dc & 0x40) && (dc & 0x100) )) || { printf 'DllCharacteristics=0x%x\n' "$dc"; return 1; }
}
# Tabla de importación (R1 LOW-10): solo DLL de System32 de una lista cerrada. Las que se cargan en
# tiempo de ejecución (NVENC, AMF) no aparecen aquí: van por win32_dlopen (compilar.sh lo exige).
# Lista deducida de las dependencias de FFmpeg 7.1 con MinGW (msvcrt o UCRT); se confirma con el
# primer build (Tarea 10).
DLL_PERMITIDAS=" kernel32.dll msvcrt.dll advapi32.dll bcrypt.dll ole32.dll oleaut32.dll shell32.dll user32.dll
  shlwapi.dll psapi.dll ws2_32.dll secur32.dll mfplat.dll mf.dll "
u() { od -An -t "u$3" -j "$2" -N "$3" "$1" | tr -d ' '; }
importaciones() { # <exe> → DLL importadas, en minúsculas (parser PE32+ propio: sin objdump en el runner)
  local f=$1 pe opt nsec tam irva i n min max datos nombre LC_ALL=C
  local -a sec d offs=()
  pe=$(u "$f" 60 4); nsec=$(u "$f" $((pe + 6)) 2); tam=$(u "$f" $((pe + 20)) 2); opt=$((pe + 24))
  [ "$(u "$f" "$opt" 2)" = 523 ] || { echo "no es PE32+"; return 1; }
  irva=$(u "$f" $((opt + 112 + 8)) 4)   # directorio de datos 1: importaciones
  read -ra sec <<<"$(od -An -v -t u4 -j $((opt + tam)) -N $((40 * nsec)) "$f" | tr -s ' \n' '  ')"
  rva2off() { local j b t; for ((j = 0; j < nsec; j++)); do b=$((10 * j)); t=${sec[b+2]}; (( sec[b+4] > t )) && t=${sec[b+4]}
    if (( $1 >= sec[b+3] && $1 < sec[b+3] + t )); then R=$(( $1 - sec[b+3] + sec[b+5] )); return 0; fi; done; return 1; }
  rva2off "$irva" || { echo "sin tabla de importación"; return 1; }
  read -ra d <<<"$(od -An -v -t u4 -j "$R" -N 2000 "$f" | tr -s ' \n' '  ')"
  for ((i = 0; i < 100; i++)); do
    n=${d[5 * i + 3]}; [ "$n" -eq 0 ] && break
    rva2off "$n" || return 1; offs+=("$R")
  done
  min=${offs[0]}; max=${offs[0]}
  for n in "${offs[@]}"; do (( n < min )) && min=$n; (( n > max )) && max=$n; done
  datos=$(dd if="$f" iflag=skip_bytes,count_bytes skip="$min" count=$((max - min + 256)) 2>/dev/null | tr '\0' '\001')
  for n in "${offs[@]}"; do nombre=${datos:n-min:255}; nombre=${nombre%%$'\001'*}; echo "${nombre,,}"; done
}
solo_dll_permitidas() {
  local dll fuera="" lista
  lista=$(importaciones "$1") || { echo "$lista"; return 1; }
  [ -n "$lista" ] || { echo "tabla de importación vacía o ilegible"; return 1; }
  while read -r dll; do [[ "$DLL_PERMITIDAS" == *" $dll "* || "$dll" == api-ms-win-crt-*-l1-1-0.dll ]] || fuera+=" $dll"; done <<<"$lista"
  [ -z "$fuera" ] || { echo "DLL fuera de la lista cerrada:$fuera"; return 1; }
}
for exe in "$FF" "$FP"; do
  comprobar pe "$(basename "$exe"): DYNAMIC_BASE, NX_COMPAT y HIGH_ENTROPY_VA" pe_flags "$exe"
  comprobar pe-tamaño "$(basename "$exe") ≤ 40 MB" test "$(stat -c %s "$exe")" -le 41943040
  comprobar importaciones "$(basename "$exe"): solo DLL de System32 de la lista cerrada" solo_dll_permitidas "$exe"
done

# --- Decodificación real (focos 1 y 5) -------------------------------------------------------
for m in h264.mp4 hevc.mp4 av1.mp4 vp9.webm foto.jpg foto.png foto16.png foto.webp \
  musica.mp3 musica.wav musica.flac musica.ogg musica.m4a; do
  comprobar decodificación "$m" ff -i "$M/$m" -f null -
done
# Sin cuelgue ni caída: termina en < 10 s y, si falla, con mensaje (una caída no escribe nada).
controlado() {
  local rc; timeout 10 "$FF" -hide_banner -nostdin -v error -i "$1" -f null - 2>"$T/err"; rc=$?
  [ "$rc" -ne 124 ] || { echo "no terminó en 10 s"; return 1; }
  [ "$rc" -eq 0 ] || [ -s "$T/err" ] || { echo "código $rc sin mensaje: ¿caída?"; return 1; }
}
for m in animado.webp foto-cmyk.jpg; do comprobar robustez "$m termina limpio (0 o error legible)" controlado "$M/$m"; done

# --- Tubería de HyperFrames y del motor -----------------------------------------------------
prores() {
  for _ in $(seq 30); do cat "$M/foto.png"; done |
    ff -f image2pipe -c:v png -framerate 30 -i - -c:v prores_ks -profile:v 4 -vendor apl0 -pix_fmt yuva444p12le "$T/intermedio.mov" &&
    fp -select_streams v:0 -show_entries stream=codec_name,profile -of csv=p=0 "$T/intermedio.mov" | grep -E '^prores,4444'
}
comprobar tubería "image2pipe PNG → ProRes 4444 .mov" prores
final=$M/h264.mp4
if [ "$SIN_MF" = 1 ]; then
  RESUMEN+=("NO VERIFICADO: h264_mf (SIN_MF=1): la prueba manual de Marc es bloqueante de W3.2")
  echo "NO VERIFICADO [tubería] .mov → h264_mf + AAC (SIN_MF=1)"
else
  mf() {
    ff -i "$T/intermedio.mov" -i "$M/musica.wav" -map 0:v -map 1:a -c:v h264_mf -pix_fmt yuv420p \
      -c:a aac -b:a 192k -movflags +faststart "$T/final.mp4" || return 1
    [ "$(fp -show_entries stream=codec_name -of csv=p=0 "$T/final.mp4" | paste -sd, -)" = "h264,aac" ] || { echo "códecs inesperados"; return 1; }
    awk -v d="$(fp -show_entries format=duration -of csv=p=0 "$T/final.mp4")" 'BEGIN { exit !(d >= 0.9 && d <= 1.1) }' || { echo "duración fuera de 1 ± 0,1 s"; return 1; }
  }
  comprobar tubería ".mov → h264_mf + AAC 192k +faststart; h264+aac y 1 ± 0,1 s" mf
  final=$T/final.mp4
fi
comprobar tubería "loudnorm I=-14 sobre WAV (musica.ts)" ff -i "$M/musica.wav" -af loudnorm=I=-14:TP=-1.5:LRA=11 -ar 44100 -f null -
fotograma() { ff -ss 0.5 -i "$final" -frames:v 1 -vf scale=540:960 -f image2pipe -c:v png pipe:1 >"$T/f.png" && [ "$(od -An -c -N 4 "$T/f.png" | tr -d ' ')" = '211PNG' ]; }
comprobar tubería "fotograma PNG por stdout (fotograma.ts)" fotograma
comprobar tubería "hoja de contacto con hstack (herramientas.ts)" ff -i "$M/foto.png" -i "$M/foto.png" \
  -filter_complex "[0:v]scale=270:480[e0];[1:v]scale=270:480[e1];[e0][e1]hstack=inputs=2[out]" -map "[out]" -frames:v 1 "$T/hoja.png"
comprobar tubería "sonda de color a rawvideo (capacidades.ts)" ff -ss 0.5 -i "$final" -frames:v 1 -vf scale=1:1,format=gray -f rawvideo "$T/px.raw"

# Codificadores de GPU (foco 4): con GPU codifican; sin ella fallan rápido y con mensaje.
gpu() {
  local rc; timeout 10 "$FF" -hide_banner -nostdin -v error -f lavfi -i color=size=320x240:rate=1:duration=1 -c:v "$1" -f null - 2>"$T/err"; rc=$?
  [ "$rc" -ne 124 ] || { echo "$1 no terminó en 10 s"; return 1; }
  if [ "$rc" -eq 0 ]; then echo "$1: codifica (hay GPU)"; else [ -s "$T/err" ] || { echo "$1: código $rc sin mensaje"; return 1; }; fi
}
for e in h264_nvenc h264_amf; do comprobar gpu "$e: codifica o falla en < 10 s con mensaje" gpu "$e"; done

# --- Protocolos y listas (foco 2, R0 M2) ----------------------------------------------------
falla_sin_colgarse() { local rc; timeout 10 "$@" >/dev/null 2>&1; rc=$?; [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ]; }
comprobar protocolos "concat con http:// y -protocol_whitelist file → error" \
  falla_sin_colgarse "$FF" -hide_banner -nostdin -protocol_whitelist file -f concat -safe 0 -i "$M/trampa-http.txt" -f null -
red() { local s; s=$(timeout 10 "$FF" -hide_banner -nostdin -i http://127.0.0.1:1/x -f null - 2>&1); echo "$s" | tail -2; grep -q 'Protocol not found' <<<"$s"; }
comprobar protocolos-red "-i http://… → «Protocol not found» (el build no tiene red)" red
comprobar protocolos "ffconcat con UNC y ..\\ con -f mp3 -format_whitelist → error" \
  falla_sin_colgarse "$FF" -hide_banner -nostdin -f mp3 -format_whitelist mp3,wav,flac,ogg,mov,matroska -i "$M/trampa.ffconcat" -f null -
# Sin -f pero con -format_whitelist (R1 MEDIUM-1): la sonda detecta concat y la whitelist la para.
whitelist_sin_f() {
  local s rc; s=$(timeout 10 "$FF" -hide_banner -nostdin -format_whitelist mp3,wav,flac,ogg,mov,matroska -i "$M/trampa.ffconcat" -f null - 2>&1); rc=$?
  echo "$s" | tail -3
  [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] && grep -q 'Format not on whitelist' <<<"$s"
}
comprobar protocolos "ffconcat sin -f y con -format_whitelist → «Format not on whitelist»" whitelist_sin_f
timeout 10 "$FF" -hide_banner -nostdin -v error -i "$M/trampa.ffconcat" -f null - >"$T/log" 2>&1; rc=$?
RESUMEN+=("REGISTRO: ffconcat sin -f ni whitelist → código $rc: $(tail -1 "$T/log") (el motor siempre pasa -f y -format_whitelist)")

# --- Rutas con espacios y ñ (foco 3) --------------------------------------------------------
rutas() {
  local d="$T/Vídeo ñandú"; mkdir -p "$d"; cp "$M/foto.png" "$d/foto ñ.png"
  ff -i "$d/foto ñ.png" "$d/salida ñ.png" && [ -s "$d/salida ñ.png" ]
}
comprobar rutas "lee y escribe en «Vídeo ñandú/foto ñ.png»" rutas

echo "----"
for r in "${RESUMEN[@]}"; do echo "$r"; done
echo "$("$FF" -hide_banner -version | head -1)"
if [ "$FALLOS" -gt 0 ]; then echo "RESULTADO: $FALLOS comprobación(es) fallida(s)"; exit 1; fi
echo "RESULTADO: todo verificado"
