# Seguridad de T2 (audio interno en WAV, sin LAME)

Rama `feat/2-audio-wav`. Revisión Opus (`cyber-security-auditor`, solo lectura) sobre el diff de T2 y re-revisión acotada
al diff de la corrección. Sin Critical ni High.

## R1 (diff `290bbc0..1f3017e`)

| ID | Sev. | Hallazgo | Estado |
|---|---|---|---|
| M-1 | Medium | `duracionAudio` (hasta 24 h en `palabras.json`) fijaba el `-t` del bucle de música antes de aplicar el máximo de 180 s; el PCM ocupa ~7× más que el MP3 → GB en el temporal hasta el timeout | Cerrado: `render.ts` valida `duracionAudio ≤ DURACION_MAXIMA` antes de cualquier ffmpeg (NaN también corta) y `-fs` 64 MiB en las dos salidas |
| L-1 | Low | `normalizarVoz` sin `-t` | Cerrado: `-t 190` + `-fs` |
| L-2 | Low | Sin `-map` ni `-ac`: pista con muchos canales multiplica el WAV | Cerrado en la R2: `-map 0:a:0` + `-ac 2` |
| L-3 | Low | Fixtures de tests con `libmp3lame` (`e2e-mock`, `matriz`, `seguridad`, `render-modos`, `herramientas`) fallarían con el ffmpeg LGPL | Abierto → `pendientes-T2.md` |
| I-1 | Info | `-stream_loop -1` con pista sin paquetes gira hasta el timeout (anterior a T2) | Aceptado |
| I-2 | Info | `componentes.test.sh` solo ve literales (no filtros implícitos como `aresample`) | Aceptado; la verificación real es `verificar-binario.sh` |
| I-3 | Info | `fmtWav` del test supone `fmt ` en el byte 12 | Aceptado (lo escribe ffmpeg) |

## R2 (diff `1f3017e..5fe4ea5`)

M-1 y L-1 cerrados; orden de opciones correcto (`-map/-t/-fs` tras el último `-i`). L-2 parcial y L-4 nuevo (Low): `-fs` podía
cortar en silencio música de ≥ 5 canales (ffmpeg sale con 0). Se cierra con `-ac 2` (commit posterior a la R2: el tope ya no se
alcanza con D ≤ 180,4 s; cambio de dos argumentos, sin lógica nueva, verificado con `audio-wav.test.ts`).

## Licencias (I12)
`pcm_s16le`, `wav` y `loudnorm` están en la lista LGPL; `src/` no nombra `libmp3lame` (test `sin_lame`). `FF_EXCLUIDOS_CONOCIDOS=()`.
Informes completos de los revisores: no versionados (scratchpad de la sesión).
