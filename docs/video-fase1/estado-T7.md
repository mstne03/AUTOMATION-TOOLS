# T7 · Estado (2026-11-11)

Rama `feat/7-recursos`. Recursos normalizados (foto, clip, música) y capas de foto y clip en el motor, con su cableado en el backend (T11).

## Qué hay

- `video-mcp-server/src/recursos.ts`: identificación por bytes, límites I15 antes de decodificar, normalización (foto → PNG, clip → MP4 H.264 sin audio con el mejor codificador de `ordenSegundaPasada`, música → M4A AAC), bandeja de un solo uso, borrado con `en_uso`, biblioteca de música.
- Tools: `video_recurso_importar`, `video_recurso_borrar`, `video_musica_listar`, `video_musica_importar`.
- Capas en `composicion.ts` y `montaje.ts`, con las piezas `capa-foto.html` y `capa-clip.html`.
- Backend: `video_rest.py` conecta las tools (rutas de música, `nombre_original`, timeout de importación); el simulador y los tests están actualizados (30 tools).
- `?hf-proxy`: `montarProyecto` escribe `hyperframes.json` con `media.autoProxy=false`; detalle en `seguridad-T7.md`.

## Pruebas (2026-11-11, máquina de Marc, ffmpeg full build de WinGet)

- vitest `recursos.test.ts` + `piezas-capas.test.ts`: 50 pasan, 2 `skip` («falta Chrome verificado»).
- vitest completo: 1151 pasan, 90 `skip`, 9 fallan. Los 9 son renders reales (`matriz` ×8, `e2e-mock`, `sandbox-render`) que fallan con «Falta el navegador del motor de vídeo»: necesitan Chrome y no se ha lanzado ninguno.
- pytest (`app-backend`): 623 pasan, 11 `skip`, 0 fallos.
- Los fallos que vi al principio (8 de `parche-hyperframes`, ficheros sin cargar) eran del disco lleno; con 30 s por test bajo carga también fallaba `voz.test.ts` (aislado, 44/44).

## Seguridad

Informe en `seguridad-T7.md` (Opus): Revisión 1 sin Críticos ni Altos (2 Medios, 5 Bajos); Revisión 2 acotada al diff de las correcciones.
Cerrados: M-1 (parcial), M-2 (parcial), L-1, L-2, L-3, L-5, N-2, N-4, N-5. Abiertos: N-1 (Media) y N-3 (Baja), documentados en `pendientes-T7.md`. L-4 es riesgo aceptado.

## Pendiente

Ver `pendientes-T7.md`: los dos tests con Chrome verificado, el `check` real, T13 (escribe la bandeja), mezcla de la música en la composición.
