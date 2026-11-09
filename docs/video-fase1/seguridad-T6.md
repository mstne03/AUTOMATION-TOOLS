# Seguridad de T6

Revisión Opus (`cyber-security-auditor`, solo lectura) sobre el diff de T6: `auditoria-T6-opus.md`. Re-revisión del cierre de
M-1 y L-3: hallazgos LOW-R2, LOW-N1 y LOW-N2 (más LOW-R1 e Info). Ninguna Critical ni High.

| Id | Estado | Cobertura |
|---|---|---|
| M-1 barrido al arrancar/por tool reiniciaba el motor | Corregido | `barrido-arranque.test.ts` (arranque y tool no reinician; tras timeout sí) |
| L-3 / LOW-R2 temporales de la caché de voz solo con pid | Corregido: temporal con `randomBytes` en `ensamblarVoz` y `normalizadaEnCache`, y `prepararProyecto` del render en `enSerie` | `montaje.test.ts`: tres `ensamblarVoz` concurrentes sin WAV truncado ni temporales; preparación serializada (revertir el `enSerie` de `render.ts` hace fallar el test, comprobado) |
| LOW-N1 la tool decía «hecho» con restos vivos | Corregido: `barrido:false` y aviso sin rutas ni pids; el log del `catch` ya no engaña | `barrido-arranque.test.ts` (restos y WMI caído) |
| LOW-N2 sin cobertura del `true` del timeout ni del `enSerie` | Corregido | revertir el `true` de `lanzar` hace fallar el test (comprobado) |
| L-1 filtro CDP del parche | Corregido: minúsculas, prefijo `-`, `--` o `/`, forma `=valor` y con espacio; manifiesto SHA-256 y test actualizados | `render_sin_puerto_cdp` |
| L-2 `_composicion`/`_render` por junction | Corregido: `carpetaDeSalida` con `pasaPorEnlace` (falla cerrado, también los padres hasta la raíz de la unidad) | test con junction, solo win32 |
| L-7 `_render/<job>` huérfanas | Corregido: `barrerRenderHuerfanos` al arrancar, con `borrarArbol`, solo bajo `VIDEO_ROOT/<id>/_render`. Hay dos motores vivos: es huérfana si su marca `.motor` apunta a un pid muerto, o sin marca con más de 10 min | `montaje.test.ts` |
| L-4 tool de barrido visible en modo independiente | Pendiente (ya no puede forzar `exit(70)`) | — |
| L-5 dev: `HYPERFRAMES_BROWSER_PATH` al Chrome del usuario | Pendiente (solo desarrollo) | — |
| L-6 rutas absolutas en `reserva`/`avisos` (I6) | Pendiente; el backend sanea avisos | — |
| LOW-R1 un fallo de CLI con un ffmpeg elevado ajeno sigue saliendo con `exit(70)` | Aceptado como diseño (sin bucle) | — |
| INFO la normalizada del job puede borrarse mientras espera en cola | Pendiente (falla visible, sin corrupción) | — |

Pendiente de la re-revisión de estas correcciones (la lanza la sesión coordinadora).
