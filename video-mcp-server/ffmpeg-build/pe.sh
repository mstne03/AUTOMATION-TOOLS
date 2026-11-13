# shellcheck shell=bash
# Lectura de ejecutables PE32+ con od y dd (el runner de Windows no tiene objdump). Lo carga
# verificar-binario.sh; tests/pe.test.sh lo prueba con PE mínimos, sin ffmpeg.

# Lista cerrada de DLL de System32 que puede nombrar la tabla de importación estática (R1 LOW-10).
# Más las api-ms-win-crt-*-l1-1-0.dll de UCRT. Deducida de las dependencias de FFmpeg 7.1 con
# MinGW; se confirma con el primer build (Tarea 10). NO cubre delay-imports ni lo que se carga en
# ejecución (NVENC y AMF van por win32_dlopen: lo exige compilar.sh).
DLL_PERMITIDAS=(
  kernel32.dll msvcrt.dll advapi32.dll bcrypt.dll ole32.dll oleaut32.dll shell32.dll user32.dll
  shlwapi.dll psapi.dll ws2_32.dll secur32.dll mfplat.dll mf.dll
)

u() { od -An -t "u$3" -j "$2" -N "$3" "$1" | tr -d ' '; }

pe_flags() { # DllCharacteristics: 0x20 HIGH_ENTROPY_VA, 0x40 DYNAMIC_BASE, 0x100 NX_COMPAT
  local pe dc
  pe=$(u "$1" 60 4)
  [ "$(od -An -c -j "$pe" -N 2 "$1" | tr -d ' ')" = PE ] || { echo "no es PE"; return 1; }
  dc=$(u "$1" $((pe + 24 + 70)) 2)
  (( (dc & 0x20) && (dc & 0x40) && (dc & 0x100) )) || { printf 'DllCharacteristics=0x%x\n' "$dc"; return 1; }
}

importaciones() { # <exe> → DLL de la tabla de importación estática, en minúsculas
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
    n=${d[5 * i + 3]:-0}; [ "$n" -eq 0 ] && break
    rva2off "$n" || { echo "nombre de DLL fuera de las secciones"; return 1; }
    offs+=("$R")
  done
  [ "${#offs[@]}" -gt 0 ] || return 0
  min=${offs[0]}; max=${offs[0]}
  for n in "${offs[@]}"; do (( n < min )) && min=$n; (( n > max )) && max=$n; done
  datos=$(dd if="$f" iflag=skip_bytes,count_bytes skip="$min" count=$((max - min + 256)) 2>/dev/null | tr '\0' '\001')
  for n in "${offs[@]}"; do nombre=${datos:n-min:255}; nombre=${nombre%%$'\001'*}; echo "${nombre,,}"; done
}

solo_dll_permitidas() { # <exe>: cada DLL importada está en la lista cerrada
  local dll fuera="" lista
  lista=$(importaciones "$1") || { echo "$lista"; return 1; }
  [ -n "$lista" ] || { echo "tabla de importación vacía o ilegible"; return 1; }
  while read -r dll; do
    [[ " ${DLL_PERMITIDAS[*]} " == *" $dll "* || "$dll" == api-ms-win-crt-*-l1-1-0.dll ]] || fuera+=" $dll"
  done <<<"$lista"
  [ -z "$fuera" ] || { echo "DLL fuera de la lista cerrada:$fuera"; return 1; }
}
