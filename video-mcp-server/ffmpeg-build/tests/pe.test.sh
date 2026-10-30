#!/usr/bin/env bash
# Parser PE y lista cerrada de DLL (pe.sh) con ejecutables PE32+ mínimos generados aquí: no
# dependen de BtbN, de FFMPEG_DIR ni de Windows, así que también corren en el job `pruebas`.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
temporal
# shellcheck source=../pe.sh
source "$DIR_BUILD/pe.sh"

# Los bytes se acumulan en S como secuencias \xHH para printf (sin subshells: en Git Bash cuestan).
le() { # le <bytes> <valor>: añade el valor a S en little-endian
  local i v=$2 b
  for ((i = 0; i < $1; i++)); do printf -v b '\\x%02x' $((v & 255)); S+=$b; v=$((v >> 8)); done
}
# pe_minimo <fichero> <DllCharacteristics> <dll…>: cabecera PE32+, una sección en VA 0x1000 y
# fichero 0x400, descriptores de importación al principio y los nombres detrás.
pe_minimo() {
  local f=$1 dc=$2 cabecera seccion nombres="" pos dll; shift 2
  pos=$((20 * ($# + 1))); S=""
  for dll in "$@"; do
    le 12 0; le 4 $((0x1000 + pos)); le 4 0
    nombres+="$dll\\x00"; pos=$((pos + ${#dll} + 1))
  done
  le 20 0; seccion=$S$nombres
  S='MZ'; le 58 0; le 4 128; le 64 0                    # e_lfanew = 0x80 en 0x3C
  S+='PE\x00\x00'; le 2 34404; le 2 1; le 12 0; le 2 240; le 2 34   # COFF: x86-64, 1 sección
  le 2 523; le 68 0; le 2 "$dc"; le 40 0                # opcional: 0x20B; DllCharacteristics en +70
  le 8 0; le 4 4096; le 4 "$pos"; le 112 0              # directorios: 1 = importaciones
  S+='.idata\x00\x00'; le 4 4096; le 4 4096; le 4 4096; le 4 1024; le 16 0   # sección
  cabecera=$S
  # shellcheck disable=SC2059 # el formato son los propios bytes
  printf "$cabecera" >"$f"
  truncate -s 1024 "$f"
  # shellcheck disable=SC2059
  printf "$seccion" >>"$f"
  truncate -s 5120 "$f"
}

T=$TMP_TEST
BIEN=$((0x160)); SIN_ASLR=$((0x120))

# Cubre TODA la lista: si una entrada dejara de casar (el fallo de user32.dll seguida de salto de
# línea), este caso lo detecta. Con mayúsculas, como las escribe el enlazador.
pe_minimo "$T/todas.exe" "$BIEN" "${DLL_PERMITIDAS[@]^^}" api-ms-win-crt-runtime-l1-1-0.dll
ejecutar importaciones "$T/todas.exe"
if [ "$CODIGO" -eq 0 ] && [ "$(wc -l <<<"$SALIDA")" -eq $((${#DLL_PERMITIDAS[@]} + 1)) ]; then ok "el parser lee las ${#DLL_PERMITIDAS[@]} + 1 DLL del fixture"; else mal "importaciones: $SALIDA"; fi
afirmar "nombres en minúsculas" grep -qx 'kernel32.dll' <<<"$SALIDA"
afirmar "lista completa + UCRT → pasa" solo_dll_permitidas "$T/todas.exe"

pe_minimo "$T/user32.exe" "$BIEN" KERNEL32.dll USER32.dll
afirmar "con user32.dll → pasa" solo_dll_permitidas "$T/user32.exe"

pe_minimo "$T/gdi32.exe" "$BIEN" KERNEL32.dll gdi32.dll USER32.dll
ejecutar solo_dll_permitidas "$T/gdi32.exe"
if [ "$CODIGO" -ne 0 ] && grep -q 'fuera de la lista cerrada: gdi32.dll$' <<<"$SALIDA"; then ok "gdi32.dll fuera de la lista → ≠ 0 y la nombra"; else mal "gdi32.dll: $SALIDA"; fi
pe_minimo "$T/nv.exe" "$BIEN" kernel32.dll nvEncodeAPI64.dll
negar "una DLL del driver en la tabla estática → ≠ 0" solo_dll_permitidas "$T/nv.exe"
pe_minimo "$T/crt.exe" "$BIEN" api-ms-win-crt-falsa.dll
negar "api-ms-win-crt-* con otra forma → ≠ 0" solo_dll_permitidas "$T/crt.exe"

pe_minimo "$T/vacio.exe" "$BIEN"
negar "tabla de importación vacía → ≠ 0" solo_dll_permitidas "$T/vacio.exe"
head -c 2048 /dev/zero >"$T/noesp.exe"
negar "fichero que no es PE → ≠ 0" solo_dll_permitidas "$T/noesp.exe"

afirmar "ASLR, ASLR de 64 bits y DEP → pasa" pe_flags "$T/user32.exe"
pe_minimo "$T/sin-aslr.exe" "$SIN_ASLR" kernel32.dll
negar "sin DYNAMIC_BASE → ≠ 0" pe_flags "$T/sin-aslr.exe"
negar "pe_flags de algo que no es PE → ≠ 0" pe_flags "$T/noesp.exe"

fin
