# Prueba de carga de `/video/*` — PR #27 (SEO-107)

Rama `feat/21-aceptacion`, punta `281c510`. k6 v2.4.0, Windows 11, Node 24, ffmpeg 8.1 (el del PATH, no el LGPL del bundle).
Perfil: **un solo usuario de una app de escritorio**, no el límite de un servidor público.

## Veredicto

**La API de vídeo aguanta el perfil de un piloto local: 0 respuestas 5xx, 0 proyectos corruptos y todos los umbrales cumplidos.**
No hay hallazgos bloqueantes. Quedan dos observaciones de rendimiento (capacidades e importación de recursos) y los límites de lo no cubierto.

| Criterio | Resultado |
|---|---|
| Respuestas 5xx | **0** (de 5 852 peticiones) |
| Peticiones sin respuesta / estados inesperados | **0 / 0** |
| Proyectos corruptos (GET incoherente, `proyecto.json` ilegible, restos `.tmp`) | **0** (10 proyectos válidos en disco y por API) |
| Conflictos de revisión (409 esperados) | 735 conflictos frente a 734 guardados correctos; revisión final 734 coherente |
| Umbrales | **Todos cumplidos** (16 con criterio), k6 con código de salida 0 |

## Entorno y contención

- Sidecar real (`uv run app-backend`, `not config.FROZEN`) en `127.0.0.1`; el orquestador comprueba que los sockets de todo el árbol de
  procesos (uv, python, node) están en loopback y aborta si no (los 47810–47813 de la preview incluidos).
- ElevenLabs solo contra un mock local (`VIDEO_PRUEBAS_TTS_URL` + `VIDEO_E2E=1`); clave falsa, `ANTHROPIC_BASE_URL` a un puerto cerrado.
  Facturación simulada: 188 caracteres en 8 síntesis, todos en el mock.
- Estado en `%TEMP%\seo-studio-carga-*`, fuera de `node_modules`, borrado al terminar (con reintentos). Al acabar: 0 procesos, 0 directorios
  temporales y 0 puertos 47810–47813 en escucha. Disco C: libre 157,8 GB al empezar y 155,4 GB al acabar; la diferencia (~2,4 GB) no es del
  estado de la prueba (borrado): son el entorno de Python (`uv sync`), el `node_modules` del motor (275 MB) y cachés instalados para poder ejecutarla.
- Variables heredadas por lista blanca (la misma de `e2e/entorno.ts`).

### Hallazgo de contención: el sidecar sale a internet en dev

En la primera sonda el sidecar **sí salió a internet**: el arranque pidió a `huggingface.co` el modelo de embeddings de la KB (y el actualizador
de la KB apunta por defecto a `https://kb.mstne.dev/kb/`). Se bloqueó con `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` y
`KB_UPDATE_URL=http://127.0.0.1:9/kb/`; las ejecuciones medidas no tocan la red. No afecta a la facturación de voz, pero conviene saberlo
para cualquier prueba futura con el sidecar en dev.

## Cómo se ha medido

`app-ui/e2e/carga/orquestador.mjs` arranca todo, siembra (1 guion, 10 proyectos, 14 PNG de 540×960 en la bandeja que el comando nativo escribiría
en el uso real), lanza `carga.k6.js` y valida el disco. La preview se prepara con la voz ya generada.
Ejecución: `node e2e/carga/orquestador.mjs` desde `app-ui/` (Git Bash o PowerShell). `--sonda` imprime una respuesta de cada endpoint;
`--solo=a,b` ejecuta solo esos escenarios, en ese orden (`RECURSOS_VUS`, `GUARDAR_VUS`, `PAUSA` ajustan concurrencia y separación).
`--diag` y `--conexion` y `INSPECT=<s>` son diagnósticos puntuales. Sin integración en `npm test` ni pytest.

Escenarios, escalonados para atribuir cada medida: `capacidades` (1 cada 10 s, aislada), `listados` (5/s, 30 s), `coste` (0,5/s, 20 s),
`voz` (3 VUs, una iteración), `recursos` (12 importaciones, 3 VUs), `preview_mientras_guarda` (4 VUs: dos abren la preview y piden su
`index.html`, dos guardan el mismo proyecto), `pico` (rampa a 80 req/s, 30 s), `guardar_concurrente` (4 VUs sobre un proyecto; las iteraciones
impares envían una revisión vieja a propósito) y `recursos_tras_guardar` (importar justo después de la ráfaga de guardados).

## Resultados (ejecución final, 5 852 peticiones, 6 min 25 s)

| Endpoint | p50 | p95 | p99 | Umbral p95 | |
|---|---|---|---|---|---|
| GET `/video/guiones` | 8 ms | 10 ms | 12 ms | 300 ms | OK |
| GET `/video/proyectos` (listados, 5/s) | 65 ms | 77 ms | 97 ms | 300 ms | OK |
| GET `/video/proyectos/{id}` (con guardados) | 10 ms | 20 ms | 27 ms | 300 ms | OK |
| GET `/video/capacidades` | 4,61 s | 4,70 s | 4,72 s | 5 s | OK, pero ver observación 1 |
| PUT `/video/proyectos/{id}` (4 VUs) | 14 ms | 108 ms | 119 ms | 800 ms | OK |
| POST `…/recursos` (3 VUs a la vez) | 7,3 s | 7,4 s | 7,5 s | 10 s | OK (cola por el cerrojo; ~2,5 s cada una) |
| POST `…/recursos` justo tras la ráfaga | 2,50 s | 2,52 s | 2,52 s | 10 s | OK |
| POST `…/voz/coste` (0,5/s) | 20 ms | 46 ms | 47 ms | 3 s | OK |
| POST `…/voz` (3 VUs a la vez) | 4,7 ms | 635 ms | 691 ms | 5 s | OK (la ganadora genera; el resto recibe 409/422) |
| POST `…/preview` | 135 ms | 166 ms | 180 ms | 1,5 s | OK (la primera tarda ~5 s) |
| GET `preview/index.html` | 9 ms | 11 ms | 12 ms | 300 ms | OK |
| **Pico**, 80 req/s (todas sus peticiones) | 1,77 s | 2,09 s | 2,17 s | 3 s | OK (saturado) |

Por escenario: `listados` p95 73 ms, `guardar_concurrente` p95 20 ms, `preview_mientras_guarda` p95 148 ms (máximo 5,1 s en la primera preview).

Verificación tras la carga: 10 proyectos válidos en disco y por API; `recursos` con 15 ficheros (12+2 importaciones y `proyecto.json`);
la API responde igual de rápido 25 s después (`GET /proyectos` 68 ms, `coste` 31 ms, `preview` 90 ms).

## Observaciones (no bloqueantes)

1. **`GET /video/capacidades` cuesta ~4,6 s por llamada.** Sondea ffmpeg y GPU en cada llamada (`reprobar:false` no evita el sondeo del ffmpeg). Si la UI la pide al
   abrir la pantalla, el usuario espera ~5 s. Como el motor es un solo proceso, una ráfaga de capacidades retrasa al resto de llamadas. Conviene cachearla: la huella del
   ffmpeg y de la GPU no cambia dentro de una sesión.
2. **Importar un PNG de 540×960 cuesta ~2,5 s** y se serializa por el cerrojo del proyecto: 12 seguidos son ~30 s. Aceptable para una importación suelta; si se espera
   importar muchas fotos de golpe, la UI debe mostrar progreso.
3. **Saturación a 80 req/s**: p95 de 2,1 s en lecturas. Es ~16 veces lo que genera un usuario, y se recupera al bajar la carga (la API vuelve a 54–68 ms), pero fija el techo.
4. **Registro de los 409**: cada conflicto de revisión escribe una línea `[error]` en el stderr del motor y otra en el del sidecar. Son 735 líneas en 30 s a este ritmo;
   conviene registrarlos como `info` (ver «Lección del arnés»).
5. El ffmpeg del PATH (gyan, con libx264) provoca el aviso «no es el LGPL del bundle»; esperado en desarrollo.

## Lección del arnés (se descartaron dos falsos hallazgos)

Las primeras ejecuciones parecían mostrar que `recursos`, `coste` y `voz` dejaban de responder (60 s) tras una ráfaga de guardados. **Era un artefacto del orquestador:**
lanzaba k6 con `spawnSync`, que bloquea el bucle de eventos de Node y deja de leer el stderr del sidecar; al llenarse la tubería (64 KB, unos 400 conflictos 409
registrados) el sidecar y el motor se bloqueaban al escribir su siguiente línea de log. Se demostró con un A/B idéntico en todo salvo el modo de lanzar k6:
bloqueante → `recursos` 1/12 y 60 s; asíncrono → 12/12 en 2,5 s (y los guardados pasan de 5 a 12,6/s). Se corrigió el arnés (k6 asíncrono; `K6_BLOQUEANTE=1`
reproduce el artefacto) y todos los números de este informe son de después.

Esto **no ocurre en la app instalada**: `lib.rs` consume los eventos `Stderr` y `Stdout` del sidecar en un bucle continuo (`rx.recv()`). Aun así, es un riesgo latente para
cualquier otro host que lance el sidecar (otro arnés, un script, `uv run` con la salida sin leer): si nadie drena el stderr, ~64 KB de logs bastan para bloquear el motor.
Registrar menos en `[error]` (observación 4) lo aleja.

## Qué no se ha cubierto

Render (`/render`: Chrome for Testing no está instalado en este entorno, «Falta el navegador del motor de vídeo»), música (`/musica`), perfiles y `GET /video/voces`
(requiere el catálogo real de ElevenLabs; el mock solo atiende `/v1/voices` con una voz). El límite de los 4 puertos de preview y `webgpu`. Pruebas largas (soak) y memoria del motor.
Solo se probó un proceso de motor en un Windows 11 con 32 GB de RAM; el hardware de los pilotos puede ser inferior.

## Recomendaciones

1. Cachear `GET /video/capacidades` por sesión (observación 1).
2. Registrar los 409 de revisión como `info`, no `[error]` (observación 4).
3. Umbrales para CI si se quiere vigilar: GET fuera del pico p95 ≤ 100 ms, PUT p95 ≤ 200 ms, 0 respuestas 5xx y 0 sin respuesta. El resto, tal como están en `carga.k6.js`.
4. Repetir con el render habilitado (Chrome for Testing instalado) antes de un piloto con exportación.

## Ficheros

- `app-ui/e2e/carga/orquestador.mjs`, `app-ui/e2e/carga/carga.k6.js`
- `docs/video-fase1/carga-PR27.resumen.json` (`--summary-export` de k6) y `carga-PR27.verificacion.json` (comprobación del disco)
