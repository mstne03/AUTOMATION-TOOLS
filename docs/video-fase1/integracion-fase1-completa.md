# Integración completa de la fase 1 de vídeo (SEO-107)

Rama `feat/video-fase1-integrada`, creada desde `origin/feat/7-recursos` (27b4d91, CI en verde).
Fecha: 2026-11-11.

## Ramas fusionadas (en orden, `--no-ff`)

| Rama | Punta | Estado antes de fusionar | Resultado |
|---|---|---|---|
| `feat/t0-enmiendas-spec` | 624a4b6 | Solo dos documentos (`HANDOFF-local-fase1.md`, `RESUMEN-sesion-nube.md`); el código de T0 ya entró con T11 | Fusionada, sin conflictos |
| `chore/ci-trivy` | 12ffd1b | Job `trivy` con binario verificado; `.trivyignore` sin excepciones activas (zip 9.0.5 ya corrige los dos CVE) | Fusionada, sin conflictos |
| `fix/updater-zip` | 12ffd1b | Misma punta que `chore/ci-trivy` (updater 2.14.1 + zip 9.0.5) | *Already up to date*: no aporta nada aparte |
| `feat/12-csp-preview` | 49023ab | `seguridad-T12.md`: 0 Critical, 0 High. Abiertos: 1 Medium, 1 Low (abajo) | Fusionada, sin conflictos |
| `feat/t17-preview` | 1b62c5a | `seguridad-T17.md`/`pendientes-T17.md`: 0 Critical, 0 High; los 5 Low cerrados; Medium 1 = condición de integración con T12 | Fusionada, sin conflictos |
| `feat/13-importar-exportar` | 9ba9cc3 | `seguridad-T13.md`: 0 Critical, 0 High. Abiertos: 1 Medium, 2 Low (abajo). Ya traía T12 y T17 fusionadas | Fusionada, sin conflictos |

No hubo ningún conflicto. Ninguna rama tenía Critical/High abiertos ni estaba a medias.

**Condición T12 ↔ T17 (Medium 1 de T17), cumplida:** `csp` y `devCsp` de `tauri.conf.json` fijan
`frame-src` a `http://127.0.0.1:47810 … 47813`, y `app-backend/tests/test_preview.py`
(`test_frame_src_sin_comodin`, `test_puertos_coinciden_con_frame_src`) falla si aparece un comodín.

**`TODO(T17)` de T18:** ya resuelto en `feat/13-importar-exportar` (9ba9cc3): `PanelPerfil.tsx:114` llama a
`recargarPreview()` tras cada guardado correcto, con su test en `preview.test.tsx`. No queda ningún
`TODO(T17)` en el código.

## Resultados de los tests (rama integrada, máquina de Marc)

| Suite | Resultado |
|---|---|
| `video-mcp-server`: `npm test` | 56 ficheros / 1150 tests OK, 69 omitidos (los de render real, excluidos por diseño) |
| `app-backend`: `uv run --extra dev pytest -q` | 625 OK, 10 omitidos (20 min) |
| `app-ui`: `pnpm test` | 30 ficheros / 386 tests OK |
| `app-ui/src-tauri`: `cargo test --locked` | 14/14 OK (con los marcadores de `binaries/` y `dist/` que crea el job de CI; sin ellos `build.rs` falla por el sidecar ausente, como se espera) |
| `app-ui`: `pnpm e2e` | **151 OK, 53 fallan** (detalle abajo) |

Dependencias: `pnpm install --frozen-lockfile` (app-ui) y `npm ci` (video-mcp-server), ambos sin errores.
`npm ci` avisa de que no ejecutó el `postinstall` de `esbuild` (política de scripts de npm); no afectó a
los tests.

### Los 53 E2E que fallan: previos a esta integración

Ninguna rama fusionada toca `app-backend/app_backend`, `video-mcp-server/src`, los helpers de `app-ui/e2e`
ni pantallas fuera de `src/video` (comprobado con `git diff origin/feat/7-recursos HEAD`). CI no ejecuta
E2E, así que la base no tenía este dato.

1. **29 specs de vídeo** (`video-editor`, `video-guion`, `video-render` y los 9 nuevos de
   `video-preview`, de T17): todos caen en el `beforeEach`, en `limpiarVideo()` (`e2e/video-comun.ts:45`),
   con `TypeError: … is not iterable`. **Causa raíz, error de contrato real:** el motor devuelve
   `datos: { proyectos }` y `datos: { guiones }` (`herramientas-proyecto.ts:35` y `:55`), y
   `video_rest.py` reenvía ese objeto tal cual (`listar_proyectos` hace `return datos` en vez de la lista
   que ya extrae; `listar_guiones` no desenvuelve). La UI (`client.videoProyectos(): ProyectoVideoResumen[]`)
   y `test_video_rest.py` esperan una lista, pero los tests del backend usan un motor falso que ya
   devuelve lista, por eso pytest pasa. **Con `VIDEO_ENGINE=1` y el motor real, la lista de proyectos de
   la UI también se rompería.** Se ha dejado sin corregir aquí (fuera del encargo de integración); es el
   primer arreglo antes de T21.
2. **23 capturas de `visual.spec.ts`** (chat, publicar, guiones, canal, kb, ajustes, ajustes-video,
   catalogo; claro y oscuro; ~1 % de píxeles distintos). **Diagnosticadas: son cambios reales y deliberados
   de la fase de vídeo, no entorno; NO se han regenerado.** Prueba: en un worktree de `origin/ds/v1`
   (675b3af), en esta misma máquina y con el mismo Chromium, `visual.spec.ts` pasa entero (30/30). Los
   diff PNG muestran bloques desplazados, no antialiasing: (a) la barra lateral tiene una entrada nueva
   «Vídeo» entre Guiones y Canal, que baja Canal, Conocimiento y Conversaciones (afecta a todas las
   pantallas); (b) en Guiones, el selector Formato tiene una tercera opción «Vídeo» y el campo Duración se
   desplaza; (c) en Ajustes, el índice tiene una sección nueva «Motor de vídeo». Regenerarlas es decisión de
   Marc (`pnpm e2e e2e/visual.spec.ts --update-snapshots`), en un commit que diga que recogen la navegación
   y el formato de vídeo.
3. ~~**`ajustes.spec.ts:80`**~~ (resuelto, commit a9d332f). El backend sí borraba: `FileSecretStore.delete`
   hace `unlink` del fichero (`<estado>/anthropic_api_key.json`), comprobado ahora por un test del backend
   que lee el disco y por el propio E2E. La causa: `config.anthropic_api_key` usa `ANTHROPIC_API_KEY` del
   entorno como respaldo, y el arnés E2E (desde 3792a85) forzaba ahí una clave falsa, así que tras borrar la
   del almacén `has_anthropic_key` seguía a true. Arreglo: el sidecar E2E fija `ANTHROPIC_API_KEY` vacía
   (sigue anulando cualquier clave heredada). Pendiente de producto, no de seguridad: con una clave en el
   entorno, Ajustes muestra «Guardada en FileSecretStore» aunque venga del entorno, y «Borrar» parece no
   hacer nada; convendría que `/settings` dijera el origen de la clave.

Consecuencia: **los E2E de T17 (`video-preview.spec.ts`) no se han podido verificar de punta a punta**;
solo los tests unitarios de la preview pasan.

## Corrección del contrato REST ↔ motor ↔ UI (segundo commit de la rama)

Causa común: `app-backend/tests/motor_falso.py` no imitaba la forma real del motor, y el cliente de la UI
(`client.ts`) se escribió contra otro contrato. Los tests de la UI simulan el cliente, así que nadie lo veía.
Cada endpoint se ha corregido en el lado que contradecía su contrato documentado:

| Endpoint | Antes (motor real) | Ahora | Dónde |
|---|---|---|---|
| `GET /video/proyectos` | `{proyectos: [...]}` | lista (validada: si no es lista, 502 `error_motor`) | backend, `_lista` |
| `GET /video/guiones` | `{guiones: [...]}` | lista (ídem) | backend, `_lista` |
| `GET /video/proyectos/{id}` | `{proyecto, avisos}` → el editor caía (`p.frases` indefinido) | el proyecto (validado: objeto con `id`) | backend, `_proyecto` (también en `abrir_preview`, que toleraba ambas formas) |
| `GET /video/perfiles`, `/voces`, `/musica` | la UI esperaba lista y recibía el sobre documentado (`contrato-voz.md:102`); `PanelPerfil` hacía `.find` sobre un objeto | el cliente desenvuelve y rechaza (`ApiError` 502) lo que no sea lista | `client.ts`, `lista()` |
| `PUT /video/perfiles/{pid}` | la UI mandaba el perfil a pelo (el backend exige `{perfil}`) y esperaba el perfil de vuelta (el backend da `{id}`): el cambio se perdía en la caché | manda `{perfil}` y devuelve el enviado | `client.ts` |

Tests: `motor_falso.py` devuelve ya la forma real (sin el arreglo, `test_ciclo_de_guiones` y
`test_crear_listar_leer_y_guardar_proyecto` fallan); `test_real_url_en_texto_inerte`,
`test_real_proyecto_manipulado_422`, `test_real_recurso_en_uso_409` y `_estado` de T11 asertan la lista o
el proyecto plano en vez de tolerar el sobre. Tres tests nuevos en `client.test.ts` (`contrato_backend`, y
guardar perfil). `video-guion.spec.ts`: el selector `radio "Vídeo"` pasa a `exact: true` (chocaba con
«Vídeo largo»).

Resultados tras el arreglo: pytest de vídeo 361 OK (el único fallo era un test real que leía
`["proyecto"]`, ya corregido y verificado); `pnpm test` 389/389; **E2E de vídeo: 20 OK, 8 fallan, 1
omitido** (antes, 0 de 29). Los 8 que quedan no son de contrato:

- ~~`video-preview` `iframe_sin_token`, `sandbox_solo_atributo`, `sonda_red_cero`~~: **resueltos, el
  aislamiento es efectivo y las sondas medían mal** (tercer commit). Prueba empírica con el Chromium de
  Playwright, padre en `localhost:1420` e iframe `sandbox="allow-scripts"` en `127.0.0.1:47810`, con la
  CSP de fixture y sin ella: `self.origin` y `window.origin` = `"null"`; `location.origin` = la URL
  (conserva la URL aunque el origen sea opaco: era lo que medía la sonda); `document.cookie`,
  `localStorage`, `parent.document` y `top.location.href` lanzan `SecurityError`; `fetch` externo lanza
  `TypeError`. Contraprueba con `allow-scripts allow-same-origin`: `self.origin` pasa a ser la URL y
  `cookie`/`localStorage` quedan accesibles. `parent.document` sigue bloqueado por ser de otro origen, así
  que solo no prueba el aislamiento. La cabecera real (`preview.py:235`) lleva `sandbox allow-scripts` e
  `img-src` limitado a su origen, `data:` y `blob:`.
  Red: Chromium emite el evento `request` también para la imagen que corta la CSP (`requestfailed` con
  `errorText: "csp"`, sin salir a la red); sin CSP sí sale y muere por DNS (`ERR_NAME_NOT_RESOLVED`). El test
  contaba el evento `request` como salida.
  Cambios en `video-preview.spec.ts`: las sondas leen `self.origin` y exigen que `document.cookie` lance;
  `sonda_red_cero` cuenta como salida cualquier respuesta o fallo que no sea de la CSP, y exige que la
  imagen la corte la CSP; `leerMarco` devuelve `undefined` mientras el iframe no ha cargado (en
  `sandbox_solo_atributo` había una carrera que antes ganaba por suerte). 9/9 en tres repeticiones.
- ~~`video-preview` `seek_pinta_fotograma`~~ (resuelto, commit 003c3db). No era el entorno: el motor
  rechazaba montar la preview («Faltan las voces de 4 frase(s)… Genera la voz antes») porque el test
  creaba un proyecto sin voz. Y la voz de pruebas no podía funcionar: el backend reenviaba
  `VIDEO_PRUEBAS_TTS_URL` pero no `VIDEO_E2E`, y el motor integrado la ignora sin ella (`tts.ts:17`);
  además el motor integrado solo usa `FFMPEG_DIR` (no el PATH), y en desarrollo el backend solo lo ponía si
  existía la carpeta del bundle. Cambios: `entorno_motor` reenvía `VIDEO_E2E` y `FFMPEG_DIR` **solo fuera
  del bundle** (`not FROZEN`; en el producto, `FFMPEG_DIR` es siempre el del bundle y `VIDEO_E2E` no pasa,
  con test); `global-setup.ts` fija `VIDEO_E2E=1` y `FFMPEG_DIR` (de `FFMPEG_DIR` o del PATH, con ffmpeg y
  ffprobe) y expone `E2E_FFMPEG`; el test genera la voz por la API con el ElevenLabs falso, confirmando el
  coste, y se salta con motivo explícito si no hay ffmpeg (la misma condición que los tests reales de T11).
  El aviso `video_voces … 404` del log es del mock, que no tiene catálogo de voces; el backend lo tolera.
- ~~`video-render` (4)~~ (resuelto, commit 79c2e9b): `render-dialogo` pasa al elemento `role="dialog"`
  (`Dialog` admite `testid`); mismo nombre, `pantallas.md` precisa el elemento.

**Estado final de los E2E (suite completa, tras el arreglo de la clave):** 180 OK, 1 omitido, 23 fallan:
solo las 23 capturas de `visual.spec.ts`, pendientes de que Marc decida regenerarlas (ver arriba). Todos
los E2E de vídeo pasan. El omitido es `cambio_se_ve_sin_render` (CA4), con `test.fixme` «depende del panel
de escena de T18»: T18 ya está integrada, así que hay que activarlo en T21. `pnpm test` 389/389.

## Hallazgos abiertos heredados (ninguno bloquea la integración)

- T12 Medium: `disable_non_proxied_udp` no cierra WebRTC del todo (solo evita la fuga de IP local).
  Decidir el riesgo residual o cerrarlo con `--disable-features=WebRtc…`.
- T12 Low: posible carrera del mutex de instancia única con el relanzamiento del updater. Prueba manual.
- T13 Medium M1: se rechaza cualquier `REPARSE_POINT` (también ficheros de OneDrive). Falla cerrado;
  confirmarlo en la máquina de Marc con OneDrive.
- T13 Low L2: MP4 truncado con el nombre final si el proceso muere exportando (`.parcial` + renombrar).
- T13 Low L3: `blocking_*` en comandos `async` y sin cerrojo de un diálogo a la vez.
- T17 Info 7–9: tests de `postMessage` poco estrictos, falta de tiempo de espera para `listo`,
  `mensaje_hostil_ignorado` admite mensajes ajenos.
- Manual de Marc (T12): WebRTC en WebView2 y la sonda de red con la app real.

## Lo que queda para T21

1. ~~Arreglar el contrato de listados, las sondas de la preview y los 5 E2E de vídeo~~ (hecho, ver arriba).
   Queda activar `cambio_se_ve_sin_render` (quitar el `fixme` ahora que T18 está dentro).
2. Regenerar las 23 capturas si Marc da el visto bueno a los cambios de navegación y formato de vídeo (la
   clave, resuelta).
3. Las pruebas de aceptación del plan (Task 21): `fidelidad-preview`, `aceptacion`, `rendimiento-180s`,
   `render:aceptacion`, `render:mock`, `render:sandbox`, `smoke_test.py`, capturas `video` y
   `video-editor`, y repetir la tabla de pruebas negativas y la R2 de punta a punta.
4. W3.2 (ffmpeg LGPL en el bundle) y W3.5 (borrado del spike).
5. Pruebas manuales de Marc: M2 (WebGPU en WebView2), equipo sin GPU, WebRTC y OneDrive; después el
   piloto con `VIDEO_ENGINE=1`.
6. No se ha abierto PR ni fusionado a `ds/v1`/`main`: pendiente del sí de Marc.
