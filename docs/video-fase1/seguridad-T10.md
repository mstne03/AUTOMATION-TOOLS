# Revisión de seguridad · T10 Preview por capacidad

- Rama: `feat/t10-preview` (worktree `wt-b`), diff `feat/t9-rest-guion..HEAD` (3 commits: d79bdfc, fa63c6e, 2563aa0).
- Ficheros: `app_backend/preview.py` (nuevo), `config.py`, `main.py`, `video_rest.py`, `tests/test_preview.py`, `tests/motor_falso.py`, `tests/test_navegador.py`, `ci.yml`.
- Referencias: PLAN-video-fase1.md Task 10 (+ R0-5, R0-7, R0-9, R0-10), SPEC-video.md I2 (a/b/c), I8 (M-D1), A4; HANDOFF-video-fase1.md §2.
- Ejecución: `uv run --no-sync pytest -q tests/test_preview.py tests/test_video_rest.py` → **159 passed, 4 skipped** (2 solo Windows, `test_el_hash_fijado_es_el_del_runtime_del_repo` sin `node_modules`, `test_puertos_coinciden_con_frame_src` hasta T12).
- Prueba adicional propia (script temporal en el scratchpad, fuera del repo, solo loopback): uvicorn real con `run(sockets=[api, *reserva])` y `despachar`. Confirmado con sockets reales (no solo `ASGITransport`, que fija `scope["server"]` desde la URL): `/ping` responde en el puerto de la API y da 404 con CSP en el de la preview; `/p/<clave>/…` da 404 JSON en el de la API; el puerto de reserva da 404 con CSP; peticiones HTTP malformadas → 400 de uvicorn («Invalid HTTP request received.», sin ruta); la clave no aparece en ningún log.

## Veredicto

**Apto con observaciones.** Ningún hallazgo Critical, High ni Medium. Lo pedido por la Task 10 y las enmiendas R0-5, R0-7, R0-9 y R0-10 está implementado y cubierto por tests; quedan Low de robustez y defensa en profundidad.

## Comprobaciones que pasan

| Punto | Estado | Dónde |
|---|---|---|
| Clave de 32 bytes (`token_urlsafe(32)`, 256 bits), solo en memoria, una por proyecto | OK | preview.py:166-169 |
| Comparación en tiempo constante, recorriendo todas sin cortar; no ASCII o vacía → None | OK | preview.py:174-186 |
| Rotación en cada `POST …/preview`, dentro del cerrojo de T9 | OK | video_rest.py:424-436 |
| Invalidación al cerrar (`DELETE …/preview`), al borrar (dentro del cerrojo y tras borrar con éxito) y al reiniciar (memoria) | OK | video_rest.py:410, 452-455 |
| Clave fuera de logs: `access_log=False` para todo el servidor; ningún `log.*` con clave o URL; 500 del API registra solo `request.url.path` de la API | OK (verificado en real) | preview.py:454-456 |
| Solo `_composicion/<r n>/`: id y carpeta por regex, `comprobar_ancestros`, `es_enlace` en VIDEO_ROOT, proyecto, `_composicion`, base y cada segmento, `resolve().is_relative_to(base)`, `is_file()` | OK | preview.py:288-316 |
| Segmentos: sin vacío, `.`/`..`, `\`, `:` (ADS), NUL/controles, `*?"<>|`, `~` (8.3), punto/espacio final, nombres reservados; `%2f`/`%5c` llegan decodificados y se rechazan | OK | preview.py:288-293 |
| Lista blanca de extensiones y `Content-Type` por extensión; `nosniff` | OK | preview.py:46-67, 346-358 |
| CSP de cabecera en toda respuesta (404, 405, 421, 503, 500) con `sandbox allow-scripts` y origen exacto; `nosniff`, `no-store`, `no-referrer` | OK | preview.py:220-254 |
| R0-9: `frame-ancestors` con `localhost:1420` solo si `not FROZEN`; test `frame_ancestors_produccion` | OK | preview.py:222-224 |
| R0-10: runtime leído una vez, SHA-256 comprobado y servido desde memoria (sin TOCTOU); si falla, 503 y nunca otro | OK | preview.py:197-214, 338-342 |
| R0-10: `<meta>` CSP exactamente una vez y con la constante del motor (test contra la plantilla); sustitución única; inyección justo tras el `<meta>` | OK | preview.py:269-282 |
| `Host` exacto o 421 (DNS rebinding); solo GET/HEAD (405); CORS `null` solo con `Origin: null` y clave válida, nunca `*` | OK | preview.py:325-337 |
| R0-7: los cuatro puertos en `127.0.0.1`, `SO_EXCLUSIVEADDRUSE` en Windows, nunca `SO_REUSEADDR`; ajenos en `ajenos` + log + aviso `puertos_preview_ajenos`; sin puertos → 503 legible; API efímera fuera de la lista | OK | preview.py:385-432, video_rest.py:419-444 |
| `despachar` por `scope["server"][1]`; lifespan a la API; API no alcanzable desde la preview ni al revés | OK (verificado en real) | preview.py:443-451 |
| Bind solo en 127.0.0.1 (preview y API); sockets de Python no heredables (no los heredan motor/Chrome/ffmpeg) | OK | preview.py:393, 416 |
| Respuesta REST sin rutas: `carpeta` validada, `creado` acotado, `duracion` acotada, avisos reducidos a `codigo` | OK | video_rest.py:424-450 |
| Hash fijado `cafd7cc9…607e` = el medido en `spikes/INFORME-shader.md` para 0.8.206; el parche de HyperFrames no toca el runtime | OK (no recalculado: falta `node_modules`) | config.py:123 |

## Hallazgos

### 1 · Low · La terna `(id, carpeta, creado)` no se vuelve a comprobar al servir (R0-5 parcial)
- **Dónde:** preview.py:296-316 (`_resolver` solo usa `id` y `carpeta`); preview.py:158-164 (`abrir`, única función que usa la terna, no se llama en producción: `POST` siempre usa `rotar`, video_rest.py:436).
- **Escenario:** la clave sigue viva mientras nadie llame a `cerrar`. Si el proyecto desaparece por una vía que no es `DELETE /video/proyectos/{id}` (motor, explorador de archivos, restauración de copia) y `siguienteId` vuelve a dar `video001` con una `_composicion/r1/`, la clave antigua sirve la composición del proyecto nuevo. Hoy el único portador de la clave es la propia UI, así que el impacto es bajo; pero la garantía de R0-5 depende de que todo borrado pase por REST, no de la terna.
- **Corrección:** al servir `index.html` (o cada petición, con caché por mtime de `proyecto.json`), comprobar que el `creado` en disco coincide con `entrada.creado` y si no, `claves.cerrar(id)` y 404. Alternativa barata: que `video_montar_preview` escriba un testigo aleatorio en `_composicion/r<n>/` y la entrada guarde ese testigo. Retirar `abrir` si no se va a usar, o documentar que es para T17.

### 2 · Low · `DELETE …/preview` no toma el cerrojo: carrera con un `POST` en vuelo
- **Dónde:** video_rest.py:452-455 frente a video_rest.py:424-436.
- **Escenario:** el usuario abre y cierra el editor enseguida. `DELETE` se ejecuta mientras `POST` espera a `video_montar_preview`; `cerrar` no encuentra nada y luego `POST` hace `rotar`. Queda una clave válida con el editor cerrado hasta el siguiente cierre, borrado o reinicio (contradice «invalidada al cerrar el editor», I8).
- **Corrección:** `async with cerrojo_de(id): estado.claves.cerrar(id)`, o un contador de generación por id que `DELETE` incremente y `POST` compruebe antes de `rotar`. Test: `cerrar_durante_montaje_no_deja_clave`.

### 3 · Low · Reserva exclusiva en Windows y conexiones en TIME_WAIT al reabrir la app (a medir)
- **Dónde:** preview.py:385-411; main.py:707.
- **Escenario:** según la documentación de Winsock sobre `SO_EXCLUSIVEADDRUSE`, un puerto escuchado con esa opción no se puede volver a vincular con ella mientras sigan activas conexiones aceptadas por el socket anterior (incluido el cierre ordenado). Al cerrar y reabrir la app enseguida con la preview abierta (conexiones keep-alive del WebView2), los cuatro puertos pueden salir como «ajenos» durante el TIME_WAIT (≈ 2 min): la preview da 503 con «ocupados por otro programa» o sirve en otro puerto con un aviso falso de A4. La reserva solo se intenta al arrancar, así que no se recupera hasta reiniciar el backend. Es de disponibilidad, no de confidencialidad, y un aviso falso habitúa a ignorar el real.
- **Corrección:** medirlo en Windows (`test_segundo_bind_exclusivo…` no cubre este caso). Si se confirma: reintentar los puertos ajenos con espera acotada al arrancar y de nuevo, en diferido, en `POST …/preview`; distinguir en el log `WSAEADDRINUSE` con el puerto en TIME_WAIT (propio) de un listener ajeno.

### 4 · Low · `NavegadorError` de `comprobar_ancestros` no se captura en `_resolver`
- **Dónde:** preview.py:300-315 (captura `OSError, ValueError`); navegador.py:86 (`NavegadorError(Exception)`).
- **Escenario:** si `<estado>` o `<estado>/video` es un enlace, cada petición a la preview acaba en 500 con traza en el log (con la ruta, sin la clave). Falla cerrado, pero ensucia el log y no da 404 uniforme.
- **Corrección:** capturar también `NavegadorError` y devolver None (404). Test con el ancestro enlazado.

### 5 · Low · El hash fijado del runtime no se comprueba en ningún job de CI
- **Dónde:** tests/test_preview.py:780-784 (se salta sin `video-mcp-server/node_modules`); ci.yml:208 (backend-windows no instala el motor).
- **Escenario:** si `RUNTIME_SHA256` y el runtime empaquetado divergen (subida de HyperFrames, `npm ci` distinto), la preview da 503 en el producto (falla cerrado, I11) y nadie lo ve hasta la prueba manual. Aquí tampoco se pudo recalcular: solo coincide con el prefijo y sufijo medidos en `spikes/INFORME-shader.md`.
- **Corrección:** comprobarlo en el job `video` (que ya hace `npm ci`), por ejemplo un test de vitest que lea `app-backend/app_backend/config.py` o un JSON compartido; o instalar el motor en backend-windows. Mismo patrón que el manifiesto del parche.

### 6 · Info · CORP/COOP ausentes: correcto, pero documentarlo
- **Dónde:** preview.py:245-251.
- `Cross-Origin-Resource-Policy: same-origin`/`same-site` **rompería** la preview: el documento está en un sandbox sin `allow-same-origin` (origen opaco), y CORP bloquea las cargas no-cors (`<script>`, `<img>`, `<audio>`, `<video>`) desde un origen opaco. COOP no se aplica a iframes. La protección frente a otras webs (A4) es la clave. Recomendación: un comentario en `CabecerasPreview` y un test que fije la ausencia, para que nadie lo «arregle».

### 7 · Info · Cabeceras de defensa en profundidad baratas
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), …` (ya negado por ser iframe cruzado sin `allow`, pero no cuesta nada) y `X-DNS-Prefetch-Control: off` (una página HTTP puede filtrar por prefetch DNS fuera de la CSP). Relacionado con R0-11 (borrar `RTCPeerConnection`/`WebSocket` en `control.js`), aún pendiente.

### 8 · Info · Respuestas sin CSP fuera de la app
- Las 400 de uvicorn por HTTP malformado (verificado) no pasan por `CabecerasPreview`. Son `text/plain` sin contenido controlable; aceptable.

### 9 · Info · `INDEX.HTML` en Windows se sirve sin reescribir
- **Dónde:** preview.py:352 (`segmentos == ["index.html"]` distingue mayúsculas; NTFS no).
- `/p/<k>/INDEX.HTML` se sirve en crudo: sin runtime ni `control.js` y con el `<meta>` original. Queda **más** restringido (CSP de cabecera + `'self'` opaco), no menos. Si se quiere uniformidad: comparar en minúsculas o rechazar todo `.html` que no sea exactamente `index.html` en la raíz.

### 10 · Info · Nombres de dispositivo no cubiertos por la regex
- **Dónde:** preview.py:68. `COM¹–³`, `LPT¹–³`, `CONIN$`, `CONOUT$` pasan `_segmento_valido`; los para `is_file()` (un dispositivo no es fichero regular), así que no hay impacto. Añadirlos por coherencia con I6.

### 11 · Info · Enlaces duros no se detectan
- **Dónde:** preview.py:308-313. `es_enlace` cubre symlinks, junctions y reparse points, no `st_nlink > 1`. Solo el propio usuario o el motor pueden crear uno dentro de `_composicion/` (fuera de alcance por el modelo de amenazas); I6 los rechaza en la importación. Opcional: rechazar `st_nlink > 1` en el fichero final.

### 12 · Info · Socket de la API sin `SO_EXCLUSIVEADDRUSE`
- **Dónde:** preview.py:414-417 (código movido de main.py, preexistente). En Windows, la seguridad mejorada de sockets impide que otra cuenta lo secuestre con `SO_REUSEADDR`, pero por coherencia con R0-7 y A4 se puede poner la misma opción.

### 13 · Info · Puertos fijos: huella y carga compartida con la API
- Una web en el navegador del usuario (A4) puede detectar que SEO Studio está abierto sondeando 47810–47813 (conexión rechazada frente a respuesta), y la preview comparte proceso y bucle con la API, así que una avalancha de conexiones al puerto fijo afecta a la API. Es inherente a M-D1; Local Network Access de Chromium lo mitiga. Opcional: `limit_concurrency` en `config_servidor`.

### 14 · Info · Dependencias abiertas con T12
- La `csp` de producción de `tauri.conf.json` aún no tiene `frame-src` (el iframe no cargaría) y `devCsp` sigue con `frame-src http://127.0.0.1:*`; `test_puertos_coinciden_con_frame_src` se salta hasta entonces. Lo cierra T12 (M-D1); conviene que el skip pase a fallo cuando T12 se integre.
- `Vary: Origin` solo se envía con `Origin: null`; con `no-store` no importa, pero lo correcto es enviarlo siempre en la ruta de la preview.
