# Prueba de carga de `/video/*` — PR #27 (SEO-107)

Rama `feat/21-aceptacion`, punta `281c510`. k6 v2.4.0, Windows 11, Node 24, ffmpeg 8.1 (el del PATH, no el LGPL del bundle).
Perfil: **un solo usuario de una app de escritorio**, no el límite de un servidor público.

## Veredicto

**No se recomienda fusionar sin mirar antes los hallazgos 1 y 2.** Con el perfil de un solo usuario la API de vídeo es rápida y
no corrompe datos, pero hay dos comportamientos reproducibles que un piloto local puede encontrarse.

| Criterio | Resultado |
|---|---|
| Respuestas 5xx | **0** |
| Proyectos corruptos (GET incoherente, `proyecto.json` ilegible, restos `.tmp`) | **0** (10 proyectos válidos en disco y por API) |
| Conflictos de revisión | 410 × 409 frente a 409 guardados correctos; ningún 5xx ni pérdida |
| Umbrales p95 por endpoint | **6 de 11 se incumplen** (ver tabla) |
| Peticiones sin respuesta (timeout de 60 s) | 2: `recursos` tras la ráfaga y una `voz` |

## Entorno y contención

- Sidecar real (`uv run app-backend`, `not config.FROZEN`) en `127.0.0.1`; el orquestador comprueba que los sockets de todo el árbol
  de procesos (uv, python, node) están en `127.0.0.1` y aborta si no (47810–47813 de la preview incluidos).
- ElevenLabs solo contra un mock local (`VIDEO_PRUEBAS_TTS_URL` + `VIDEO_E2E=1`); clave falsa, `ANTHROPIC_BASE_URL` a un puerto cerrado.
  Facturación simulada: 122 caracteres en 5 síntesis, todos en el mock.
- Estado en `%TEMP%\seo-studio-carga-*`, fuera de `node_modules`, borrado al terminar. Disco C: libre antes y después: 157,8 GB → 157,9 GB.
  Al acabar: 0 procesos, 0 directorios y 0 puertos 47810–47813 en escucha.
- Variables heredadas por lista blanca (la misma de `e2e/entorno.ts`).

### Hallazgo de contención durante la preparación

En la primera sonda el sidecar **sí salió a internet**: el arranque pidió a `huggingface.co` el modelo de embeddings de la KB (y el
actualizador de la KB apunta por defecto a `https://kb.mstne.dev/kb/`). Se bloqueó con `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` y
`KB_UPDATE_URL=http://127.0.0.1:9/kb/`; las ejecuciones medidas no tocan la red. No afecta a la facturación de voz, pero conviene saberlo
para cualquier prueba futura con el sidecar en dev.

## Cómo se ha medido

`app-ui/e2e/carga/orquestador.mjs` arranca todo, siembra (1 guion, 10 proyectos, 14 PNG de 540×960 en la bandeja que el comando
nativo escribiría en el uso real), lanza `carga.k6.js` y valida el disco. La preview se prepara con la voz ya generada.
Ejecución: `node e2e/carga/orquestador.mjs` desde `app-ui/` (Git Bash o PowerShell). `--sonda` imprime una respuesta de cada endpoint;
`--solo=a,b` ejecuta solo esos escenarios (con `RECURSOS_VUS=n` cambia la concurrencia de `recursos`). Sin integración en `npm test` ni pytest.

Escenarios, escalonados para poder atribuir cada medida: `capacidades` (1 cada 10 s, aislada), `listados` (5/s, 30 s), `coste` (0,5/s, 20 s),
`voz` (3 VUs, una iteración), `recursos` (12 importaciones, 3 VUs), `preview_mientras_guarda` (4 VUs: dos abren la preview y piden su
`index.html`, dos guardan el mismo proyecto), `pico` (rampa a 80 req/s, 30 s), `guardar_concurrente` (4 VUs sobre un proyecto; las iteraciones
impares envían una revisión vieja a propósito) y `recursos_tras_guardar` (sonda del hallazgo 1).

## Resultados (ejecución final, 4 098 peticiones, 6 min 25 s)

| Endpoint | p50 | p95 | p99 | Umbral p95 | |
|---|---|---|---|---|---|
| GET `/video/guiones` | 9 ms | 11 ms | 23 ms | 300 ms | OK |
| GET `/video/proyectos` | 1,53 s | 2,14 s | 2,23 s | 300 ms | **No** (lo dicta el pico, ver abajo) |
| GET `/video/proyectos/{id}` | 11 ms | 1,95 s | 2,12 s | 300 ms | **No** (idem) |
| GET `/video/capacidades` | 4,58 s | 6,34 s | 6,68 s | 5 s | **No** (~4,6 s por llamada; sondea ffmpeg) |
| PUT `/video/proyectos/{id}` | 12 ms | 155 ms | 174 ms | 800 ms | OK |
| POST `…/recursos` (3 VUs) | 7,4 s | 7,5 s | 7,5 s | 10 s | OK (cola por el cerrojo; ~2,5 s cada una sola) |
| POST `…/recursos` tras la ráfaga | 60 s | 60 s | 60 s | 10 s | **No** (hallazgo 1) |
| POST `…/voz/coste` | 17,7 s | 22,9 s | 23,5 s | 3 s | **No** (hallazgo 2) |
| POST `…/voz` | 3,9 ms | 54 s | 58,8 s | 5 s | **No** (hallazgo 2) |
| POST `…/preview` | 161 ms | 203 ms | 295 ms | 1,5 s | OK |
| GET `preview/index.html` | 7 ms | 10 ms | 14 ms | 300 ms | OK |

Por escenario (latencia de todas sus peticiones): `listados` p95 71 ms; `guardar_concurrente` p95 18 ms; `preview_mientras_guarda` p95 189 ms
(máximo 5,3 s en la primera preview); **`pico` p95 2,13 s**. Los GET de la tabla superan 300 ms solo porque incluyen el pico: fuera de él
(`listados`) responden en ≤ 71 ms. A 80 req/s el sidecar se satura; un usuario no genera esa tasa.

## Hallazgos (no corregidos; decisión de Marc)

### 1. `POST /video/proyectos/{id}/recursos` deja de responder tras una ráfaga de guardados (reproducible, grave para el piloto)

Tras `guardar_concurrente` (≈ 400 PUT + 400 × 409 sobre un proyecto, durante 30 s), la **siguiente importación de recursos de otro proyecto no
vuelve en 60 s**, aunque con 1 VU. Sola tarda 2,5 s (12/12 correctas con 1 o 3 VUs). Se reprodujo 4 veces (`--solo=guardar_concurrente,recursos`,
con 1 y 3 VUs, y en la ejecución completa). Los GET, PUT y la preview siguen respondiendo durante el cuelgue, así que no es el bucle de eventos del sidecar.
El motor no registra ningún error de `video_recurso_importar`. No se ha identificado la causa raíz.
Hipótesis no verificadas: cola o bloqueo en el cliente MCP/stdio tras cientos de errores de `video_proyecto_guardar` (cada 409 se registra como
`[error]` en el stderr del motor), o un estado del cerrojo de actividad. **Siguiente paso propuesto:** reproducir con `--solo=guardar_concurrente,recursos`
y volcar la pila del proceso `node` mientras la petición está colgada.
Matiz de uso real: una ráfaga de 400 guardados no es normal en la UI; el riesgo real depende de cuántos guardados seguidos (autoguardado) bastan para disparar el fallo, que no se ha acotado.

### 2. `voz/coste` y `voz` tardan 17–54 s bajo concurrencia, pero 20–50 ms en reposo

Al ritmo de 0,5 coste/s, el p95 es de 23 s; con 3 VUs a la vez en `voz`, p95 de 54 s y una petición agota los 60 s. Justo después de la carga las mismas
llamadas responden en 20–50 ms y `GET /proyectos/{voz}` tardó 2,3 s una vez. Es decir: no hay un bloqueo permanente, sino una degradación grave con peticiones
concurrentes al motor. En la sonda inicial (una llamada cada vez) `coste` y `voz` fueron inmediatos. Posible relación con el hallazgo 1 (misma vía hacia el motor).
La confirmación de voz concurrente del mismo proyecto devuelve 409 («ocupado») como se espera. Con un usuario real (un coste y una voz a la vez) no se ha observado.

### 3. `GET /video/capacidades` cuesta ~4,6 s por llamada

Sondea ffmpeg y GPU en cada llamada (`reprobar:false` no evita el sondeo del ffmpeg). Si la UI la pide al abrir pantalla, son 5 s de espera.
En la primera ejecución, mezclada en el listado a 1,7/s, encoló al resto del motor hasta 50 s: el motor es un solo proceso. No es ruta caliente, pero conviene cachear.

### 4. Importar un PNG de 540×960 cuesta ~2,5 s

Serializado por el cerrojo del proyecto. Aceptable para uno; 12 seguidos son ~30 s.

### Notas menores

- El ffmpeg del PATH (gyan, con libx264) provoca el aviso «no es el LGPL del bundle»; esperado en desarrollo.
- `GET /video/voces` no se midió (requiere el catálogo real de ElevenLabs); el mock solo atiende `/v1/voices` con una voz.
- En el stderr del sidecar aparece un error de fastembed por no encontrar el modelo con `HF_HUB_OFFLINE=1`; es esperado y no afecta a `/video/*`.

## Qué no se ha cubierto

Render (`/render`, Chrome for Testing no instalado: «Falta el navegador del motor de vídeo»), música (`/musica`), perfiles y `GET /voces`. El
límite de los 4 puertos de preview y `webgpu`. Pruebas largas (soak) y memoria del motor.

## Recomendaciones

1. Investigar el hallazgo 1 antes del piloto (bloqueante si el autoguardado puede encadenar muchos guardados).
2. Limitar la concurrencia hacia el motor desde el backend (cola o semáforo por proceso) y registrar los 409 de revisión como `info`, no `[error]`.
3. Cachear `capacidades` (la huella del ffmpeg y la GPU no cambian dentro de una sesión).
4. Si se quiere un umbral de CI: p95 ≤ 100 ms para los GET fuera del pico, ≤ 200 ms para PUT, 0 respuestas 5xx y 0 sin respuesta.
5. Repetir esta prueba tras corregir los hallazgos 1 y 2: el script ya los vigila (`recursos_tras_guardar`, `coste`, `voz`).

## Ficheros

- `app-ui/e2e/carga/orquestador.mjs`, `app-ui/e2e/carga/carga.k6.js`
- `docs/video-fase1/carga-PR27.resumen.json` (`--summary-export` de k6) y `carga-PR27.verificacion.json` (comprobación del disco)
