# Auditoría de seguridad · T14 (contrato de pantallas, cliente y modelo de la UI de Vídeo)

- Rama: `feat/t14-contrato-ui`, diff `bf37c9f..ddb4418` (un commit, 21 ficheros, +1007/−10).
- Referencias: `PLAN-video-fase1.md` (Task 14, Global Constraints, tabla REST de la Task 9), `SPEC-video.md` I6 e I8, `CLAUDE.md`.
- Pruebas: `pnpm test` → 20 ficheros, 157 tests, todo en verde. Dos pruebas temporales de carrera en el store (`src/test/zz-tmp-sec.test.ts`), borradas después; `git status` limpio.

## Veredicto

**Aprobado con cambios.** No hay Critical ni High. Hay dos Medium que conviene cerrar antes de que U2 (T16) y U5 monten sus E2E y el editor encima de esto.

## Lo que se comprobó y está bien

| Punto | Resultado |
|---|---|
| `innerHTML` / `dangerouslySetInnerHTML` | Ninguno en el diff ni en `app-ui/src/video/`. `aGuionVideo` solo devuelve cadenas y números; el test con `<img onerror>` lo comprueba en el modelo (el render real lo prueba T15). |
| Ids en URL | Todos los segmentos dinámicos de `client.ts:187-222` pasan por `encodeURIComponent` (`gid`, `id`, `rid`, `pid`). Los cuerpos van por `JSON.stringify`. |
| Rutas en el cliente (I6) | Ningún tipo ni método de vídeo recibe rutas; los recursos y la música van por `bandeja_id`. El test `sin_rutas_en_cliente` está bien orientado (mira las firmas de la interfaz y la sección de tipos). |
| Validación de la URL de preview (I8) | `PREVIEW_RE` en `modelo.ts:104` rechaza `localhost`, `127.1`, `[::1]`, `0x7f…`, `u@host`, `127.0.0.1:47810@evil`, `HTTP://` en mayúsculas, `https`, puertos 47809/47814/478100, `javascript:`, URLs relativas al protocolo (`//`), `\`, `#`, saltos de línea y `..` literal. El sentido es fail-closed. Ver el hallazgo 3 para el `..` codificado. |
| Clave de capacidad | No se guarda en `localStorage`/`sessionStorage` ni sale en `console.*`. `PreviewVideo.url` solo es un tipo; todavía nadie lo guarda. |
| Bearer | Sigue solo en memoria (`createClient`); no hay logs nuevos. |
| `core:default` | El diff no toca `src-tauri/`, ni las capabilities, ni la CSP. |
| Contrato de `data-testid` | Los ids de `pantallas.md` coinciden con la lista de la Task 14. `nav-video` tiene su E2E en `marco.spec.ts` en el mismo commit. |
| Mock de ElevenLabs | Escucha solo en `127.0.0.1:0`, corta los cuerpos de más de 100 kB, exige `xi-api-key` y hace `unref()`. `/__llamadas` va sin autenticación, pero solo en loopback y con dos contadores (aceptable). |
| `global-setup` | `npm run build` = `tsc -p tsconfig.json` en `video-mcp-server` (sin descargas ni scripts `pre`/`post`). La ruta del motor va en una variable de entorno (JSON), no se interpola en la shell. Nada peligroso. |
| `__proto__` | `plano()` filtra `__proto__`/`constructor`/`prototype` y limita la profundidad a 8 y los arrays a 500. Un test lo cubre. |

## Hallazgos

### 1. [Medium] Los E2E con el motor real pueden llamar a la API real de ElevenLabs con la clave de desarrollo de Marc

- **Dónde:** `app-ui/e2e/global-setup.ts:62-74` (`env: { ...process.env, … }`), junto con `app-backend/app_backend/config.py:121-122` (respaldo `os.environ["ELEVENLABS_API_KEY"]`), `app-backend/app_backend/video.py:397` (pasa la clave al motor) y `video-mcp-server/src/tts.ts:6` (`URL_BASE_ELEVENLABS = "https://api.elevenlabs.io"`, fija).
- **Escenario:** el comentario dice que «ElevenLabs va a un servidor local para no gastar créditos ni salir a la red», pero hoy ni el backend ni el motor leen `VIDEO_PRUEBAS_TTS_URL` (no aparece en `app_backend/` ni en `video-mcp-server/src/`; lo añaden T5/T11). El almacén `file` del E2E empieza vacío, así que `config.elevenlabs_key()` recurre a `ELEVENLABS_API_KEY` del entorno. Ese entorno se hereda entero en el sidecar, y `.env`/la shell de desarrollo de Marc la tienen como «respaldo de desarrollo». En cuanto un E2E de U2–U5 pulse `voz-generar` o `perfil-voz-escuchar`, la síntesis irá a `api.elevenlabs.io` con la clave real: gasta créditos y sale a la red desde los tests (contra I14 y la Global Constraint de salidas de red). Además, `reintento_no_refactura` daría falsos verdes, porque el mock contaría 0 llamadas. Pasa lo mismo con `ajustes-eleven-guardar`, que valida contra `https://api.elevenlabs.io/v1/user` (`main.py:623`).
- **Corrección:** en el `env` del sidecar, fijar `ELEVENLABS_API_KEY: "e2e-eleven-falsa"` (o `""`) y `ELEVENLABS_VOICE_ID: "voz-e2e"`, para no heredar las reales. Y que sea fail-closed: en `global-setup`, tras arrancar, comprobar que el motor usa el mock (una síntesis de humo o `GET /__llamadas` > 0 tras una llamada mínima), o abortar si `VIDEO_PRUEBAS_TTS_URL` no está implementada. En T5/T11, que el motor rechace la URL real cuando `VIDEO_PRUEBAS_TTS_URL` esté puesta y sea de loopback, y que `entorno_motor` no reenvíe nunca `ELEVENLABS_API_KEY` del entorno cuando `not FROZEN` y haya URL de pruebas. Mientras tanto, corregir el comentario.

### 2. [Medium] Carrera al cambiar de proyecto: la respuesta de un PUT o un 409 en vuelo se aplica al proyecto nuevo

- **Dónde:** `app-ui/src/state/editor.ts:604-608` (`cargar` no invalida el guardado en vuelo), `:696-698` (aplica `r.revision` a `useEditor.getState().proyecto` sin comprobar el id) y `:714-719` (`alConflicto` toma como borrador el proyecto actual y lo sustituye por el remoto de *otro* id).
- **Escenario (reproducido con una prueba temporal):**
  - *Éxito:* edición en `video001` (rev 3), PUT en vuelo, el usuario abre `video002` (rev 10) y el PUT vuelve con rev 4. Resultado: `proyecto.id = video002`, `revision = 4`. El siguiente guardado de `video002` manda la revisión 4 y recibe un 409 falso. Si la revisión coincidiera por casualidad con la de `video002`, la comprobación de concurrencia se saltaría y se pisaría una versión ajena.
  - *409:* lo mismo, pero el PUT de `video001` falla con 409. Resultado: en la ruta `/video/video002` el editor muestra `video001` («A-servidor»), y el borrador es `video002`. Con «usar borrador», `editar()` reemplaza el proyecto por el de `video002` con la revisión de `video001`: estado mezclado entre proyectos y riesgo de sobrescritura con la revisión equivocada. Además, `cargar` dentro de los 800 ms descarta en silencio la edición pendiente del proyecto anterior (`cancelarTimer()` sin vaciar), contra lo que promete la cabecera («cambiar de pantalla no pierde ediciones pendientes»).
- **Corrección:** guardar un contador de época o el `id` cargado. En `guardar`/`alConflicto`, tras cada `await`, descartar la respuesta si `useEditor.getState().proyecto?.id !== proyecto.id` o si la época cambió. En `cargar`, si `guardado === "pendiente"`, vaciar antes (`await guardar()`) o rechazar la carga, y poner `guardando = false` solo si se descarta el vuelo de forma controlada. Añadir tests `cambiar_de_proyecto_con_put_en_vuelo` y `cambiar_de_proyecto_con_409`.

### 3. [Low] `aPreviewUrl` acepta `..` codificado (`%2e%2e`, `.%2E`)

- **Dónde:** `app-ui/src/video/modelo.ts:104-107`.
- **Escenario:** `http://127.0.0.1:47810/p/%2e%2e/%2e%2e/x` pasa la regex y el `includes("..")`, y el parser WHATWG lo normaliza a `pathname = /x`: el `src` sale de `/p/`. El origen sigue siendo de loopback y de un puerto de la lista, y el servidor de preview solo tiene `/p/{clave}/…`, así que el impacto real es bajo (la URL la da el backend, no el modelo). Pero el test `url_preview_solo_loopback` da a entender que el recorrido está cerrado y no lo está. También pasan `/p//x` y `/p/` sin clave.
- **Corrección:** validar con el parser y no solo con la regex: `const u = new URL(url); u.href === url && u.protocol === "http:" && u.hostname === "127.0.0.1" && PUERTOS.has(u.port) && /^\/p\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9._~\-/]*$/.test(u.pathname) && !/%2e|%2f|%5c/i.test(url) && !u.username && !u.password`. Añadir `%2e%2e`, `.%2E`, `/p//x` y `/p/` a los casos negativos.

### 4. [Low] El 409 y los errores pueden perder ediciones intermedias, y no se reintenta tras un error

- **Dónde:** `app-ui/src/state/editor.ts:706-710` y `:715-718`.
- **Escenario:**
  - (a) `alConflicto` toma `actualLocal` *antes* del `await videoProyecto()`. Lo que se edite mientras dura ese GET acaba en `proyecto` y luego lo pisa `remoto`, sin pasar al borrador (y `historial: []` impide deshacerlo).
  - (b) Si el PUT falla con un estado que no es 409, las ediciones hechas durante el vuelo (`version !== enviado`) no se reprograman. Quedan en memoria con «Error al guardar» hasta la siguiente edición, y si el usuario cierra la ventana se pierden.
  - (c) Con `conflicto`, `editar()` sigue aceptando cambios sobre la versión del servidor, que no se guardan; luego `usarBorrador` los sustituye (se pueden recuperar con deshacer, pero no es evidente).
  
  No duplica ediciones: la revisión del servidor manda y el borrador no se reenvía solo.
- **Corrección:** en `alConflicto`, tomar `useEditor.getState().proyecto` *después* del GET, o bloquear `editar` mientras `guardado === "guardando"` tras un 409. En el error que no es 409, reprogramar con backoff (o exponer «Reintentar» en `editor-guardado`). Mientras haya `conflicto`, que `editar` no actúe o avise. Añadir un test `edicion_durante_get_de_conflicto_va_al_borrador`.

### 5. [Low] `reiniciarEditor()` desvincula el cliente global y deja el autoguardado mudo

- **Dónde:** `app-ui/src/state/editor.ts:610-616` (`cliente = null`) y `:690` (`if (!cliente …) return;` sin marcar error).
- **Escenario:** `vincularCliente` solo se llama una vez, en `App.tsx`. Si U2 usa `reiniciarEditor()` al desmontar el editor (el nombre lo invita), el siguiente proyecto se edita con «pendiente» para siempre y nunca se guarda, sin ningún aviso. El resultado es pérdida de datos en silencio.
- **Corrección:** que `reiniciarEditor` no toque `cliente` (separar un `desvincularCliente()` solo para los tests), y que `guardar` sin cliente ponga `guardado: "error"`.

### 6. [Low] `aGuionVideo` ata cada recurso pedido a la escena por índice

- **Dónde:** `app-ui/src/video/modelo.ts:157` y `:170`.
- **Escenario:** si U1 reordena (`guion-video-subir`/`bajar`), borra o añade escenas, `aCuerpo()` sigue tomando `extra.recursos[i]` por la posición original. El `que_debe_salir` y la resolución acaban en otra escena, y la UI muestra un `recurso` que no coincide con el que se envía. No es una vía de inyección, porque el motor valida, pero lo que el usuario ve y lo que se manda divergen.
- **Corrección:** guardar el recurso plano dentro de `EscenaGuionUi` (p. ej. `recursoCrudo`) y serializarlo desde la propia escena.

### 7. [Info] Alcance del test `sin_rutas_en_cliente`

- **Dónde:** `app-ui/src/test/client.test.ts:779-791`.
- Solo busca nombres de parámetro de una lista (`ruta`, `path`, `uri`…). Un parámetro `destino: string` o `carpeta: string` pasaría. Vale como red de seguridad, pero no como garantía. Sugerencia: añadir `destino|carpeta|dir|directorio|fichero|archivo` a la lista, y que el test falle si alguna firma de `video*` recibe un `string` cuyo nombre no esté en una lista blanca (`id`, `gid`, `pid`, `rid`, `bandejaId`, `voiceId`, `modo`).

### 8. [Info] Los `ruta?` de `AvisoVideo`/`Aviso`

- **Dónde:** `app-ui/src/api/types.ts:474` y `app-ui/src/video/modelo.ts:98`.
- Es la ruta dentro del documento. Si U2 la pinta, debe ser como texto. Si el backend no pasara un aviso del motor por `sinRutas` (T9, `error_sin_ruta`), podría aparecer una ruta del sistema de ficheros en la UI. No es de esta tarea; se anota para la R1 de T9/T16.
