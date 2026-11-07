# Revisión de seguridad · T11 (voz, recursos, perfiles y render por REST)

Rama `feat/t11-voz-recursos-render` (worktree `wt-b`), diff `git diff feat/t10-preview HEAD -- app-backend docs`,
solo el backend (`video_rest.py`, `jobs.py`, `main.py`, `video.py`, `agent.py`, tests y `contrato-voz.md`).
Referencias: PLAN Task 11 (R0-3, R0-6), Review Focus 2 y 4, Global Constraints, `contrato-voz.md`,
SPEC I6, I7, I8, I10, I11, I14 y HANDOFF §2.

Tests: `uv run --no-sync pytest -q tests/test_video_rest.py tests/test_video.py tests/test_video_t11.py`
da 187 passed y 3 skipped. `-p no:randomly tests/test_video_t11.py tests/test_video.py tests/test_api.py` da
132 passed y 2 skipped. No he dejado ficheros temporales.

## Veredicto

**Apto con cambios.** No hay hallazgos Critical ni High. Hay dos Medium: una voz en curso que muere por
acciones ajenas, y R0-6 cerrado solo en el simulador. El resto son Low o Info. Se cumple el contrato de
facturación: el plan no se fabrica, el `true` es literal y los errores llevan mensajes fijos.

---

## Hallazgos

### 1 · Medium · Una generación de voz en curso muere por cualquier timeout ajeno del motor principal o por cambiar la clave

**Dónde:**
- `app-backend/app_backend/video.py:225-233` (`_esperar`: con cualquier `TimeoutError`, `_descartar(s)` mata el proceso entero).
- `app-backend/app_backend/video_rest.py:756` (`coste_voz` llama a `video_voces`, que va a ElevenLabs, con el timeout por defecto de 120 s).
- `app-backend/app_backend/main.py:626` (`PUT /settings` con `elevenlabs_api_key` hace `motor.cerrar()` sin mirar `estado.cerrojos`).

**Escenario:**
1. El proyecto A genera un lote largo de voz con `timeout_voz(n)`, de hasta horas.
2. En el mismo proceso del motor llega otra llamada que pasa de 120 s y salta su timeout. Puede ser `video_voces` desde `/voz/coste` del proyecto B con ElevenLabs lento, `video_montar_preview` o `proyecto_leer`.
3. Ese timeout, o un `PUT /settings` con la clave, descarta el proceso y corta el lote de A a media frase.

ElevenLabs ya ha cobrado la frase en vuelo y no se usa. El motor la deja marcada (`.vuelo`, `voz.ts:140-150`), así que
reintentar exige `reintentar_facturadas: true`. No hay cobro doble sin confirmar, pero sí cobro perdido y un lote cortado sin
que la persona haya hecho nada en A. Esto anula el propósito explícito del timeout de T11 («para no matar el motor a media
ejecución») y Review Focus 2. A la UI de A le llega un 503 `no_disponible` y no el `fallo` parcial del contrato.

**Corrección:**
- `PUT /settings` con cambio de clave: si hay algún cerrojo `voz`, 409 `voz_en_curso` (o aplazar el reinicio hasta que se suelte).
- En `MotorVideo`, contar las llamadas largas en vuelo (`video_voz_generar`, `video_voz_muestra`). Si salta el timeout de otra
  llamada mientras hay una en vuelo, devolver `MotorTimeout` sin descartar el proceso, o dar a la voz su propio proceso (como
  el render).
- En `coste_voz`, pasar a `video_voces` un timeout corto y propio (p. ej. 15 s). El nombre es cosmético.
- Tests: `timeout_ajeno_no_mata_la_voz` y `cambiar_clave_con_voz_en_curso_409`.

### 2 · Medium · R0-6 (barrido al arrancar) no está en el motor real: el test pasa contra el simulador, y el deadline deja huérfanos

**Dónde:**
- `video-mcp-server/src/proceso.ts:482`: solo barre con `r.timeout || (cli && r.code !== 0)`. `index.ts:190-205` no llama a `barrerProcesos` al arrancar.
- `app-backend/tests/test_video_t11.py:656-692`: `test_motor_muere_en_render`, donde el docstring reconoce que «el barrido al arrancar lo hace el SIMULADOR».
- `app-backend/tests/test_video_t11.py:694`: el test real va con `skip`.
- `app-backend/app_backend/video_rest.py:526-531`: el deadline hace `motor_render.cerrar()`.

**Escenario:**
1. El render supera el deadline (o `node` muere en pleno render).
2. El backend cierra `motor_render`, pero los Chrome y ffmpeg del motor muerto cuelgan del Job Object del sidecar y siguen vivos.
3. El motor relanzado no los barre hasta el siguiente timeout o error de la CLI.

Mientras tanto quedan Chrome huérfanos, lo que la sección de negativas de I7 prohíbe expresamente. Con varios renders colgados,
se agotan la CPU y la RAM en silencio, y tampoco se cumple I11 («el fallo se ve»). La negativa de T11 está en verde, pero
contra el simulador: da una falsa sensación de cierre.

**Corrección:** que el motor llame a `barrerProcesos(carpetasDelBundle(...))` en el arranque, antes de `server.connect`
(test `barrido_al_arrancar` en T6). Mientras no esté, marcar R0-6 como **abierto** en `pendientes` y en el handoff, y que
`test_motor_muere_en_render` lo diga en su nombre o en el `skip`, no como cubierto.

### 3 · Low · `sin_clave` frente a `sin_voz` se distingue por la subcadena «Elige la voz» del texto del motor

**Dónde:** `app-backend/app_backend/video_rest.py:350`. La fija `test_video_t11.py:499-504` contra `voz.ts:50` y `voz.ts:291`.

**Escenario:** el motor da `sin_configurar` en los dos casos, y la decisión depende de texto libre en español. Si alguien
reescribe el mensaje («Selecciona la voz…»), lo traduce, o se añade otro `sin_configurar` (p. ej. del perfil), cae en
`sin_clave` y la UI dice «Falta la clave» a quien sí la tiene. El fallo es benigno: no gasta ni filtra nada, y el test contra
`voz.ts` lo detecta en el monorepo. Pero la UI acaba decidiendo, de forma indirecta, por el texto, contra la regla del
contrato. Además, en el producto instalado `ELEVENLABS_VOICE_ID` no se reenvía nunca (`video.py:428-432`): hoy toda persona
verá `sin_voz` (pendiente ya anotado en el contrato).

**Corrección:** que el motor emita un dato estructurado, `problemas: [{ruta: "voiceId", codigo: "sin_voz"}]` (o
`[{ruta: "clave", codigo: "sin_clave"}]`), o un código propio, y que `_http` decida por `e.problemas`. Mantener la
subcadena solo como respaldo, con log de aviso.

### 4 · Low · Las rutas de recursos llaman a tools que el motor integrado no tiene, así que el 409 `recurso_en_uso` solo está probado contra el simulador

**Dónde:**
- `app-backend/app_backend/video_rest.py:892-913`.
- `video-mcp-server/src/*`: no se registra `video_recurso_importar` ni `video_recurso_borrar`.
- `proyecto.ts:32`: `CodigoAlmacen` no incluye `en_uso`.

**Escenario:** con el motor real, las dos rutas responden 502 `error_motor`. Es un fallo cerrado: no hay exposición. El 409 de
Review Focus 4 y la ausencia de rutas en `recurso` solo se han comprobado contra `motor_falso.py`, y cuando T7/T18 lo
implementen nada garantiza que la forma coincida. `recurso_seguro` (`video_rest.py:460-465`) trunca `nombreOriginal` a 120,
pero no rechaza separadores. Hoy eso lo hace el esquema del motor (`esquema.ts:227`); falta la defensa en profundidad en el
borde REST.

Comprobado y correcto:
- La entrada es solo `bandeja_id` (32 hex) y `clase` en `Literal`, con `extra="forbid"`: ninguna ruta llega desde la UI (I6).
- Borrar un recurso con un render en curso no necesita cerrojo: el render copia los recursos a `_render/` al componer (`composicion.ts:699`).

**Corrección:** añadir un `test_real_recurso_*` (con `skip` hasta T7) y el código `en_uso` al motor. En `recurso_seguro`,
vaciar `nombreOriginal` si casa con `[\\/:]|\.\.` o con caracteres de control.

### 5 · Low · El cerrojo de render se suelta en fallos que no paran el render del motor

**Dónde:** `app-backend/app_backend/video_rest.py:518-520` y `:542-546`.

**Escenario:** `video_renderizar` ya ha lanzado el job en `motor_render`, y luego pasa una de estas cosas:
- devuelve un `job_id` con forma inesperada;
- un sondeo responde sin datos;
- un sondeo da un `MotorError` tipado (no un timeout, que sí reinicia el proceso).

El job del backend falla y el `finally` suelta el cerrojo, pero el render del motor sigue escribiendo en la carpeta del
proyecto. Ya se puede borrar el proyecto (en Windows, `ProyectoEnUso`; en otros casos, un borrado parcial), generar la voz
encima o lanzar otro render. El caso es poco probable, porque solo lo provoca una respuesta mala del motor, pero rompe
«cerrojo = actividad real».

**Corrección:** en cualquier fallo posterior a un `video_renderizar` correcto (salvo `terminado` o `error` del motor),
hacer `motor_render.cerrar()` antes de soltar, como ya hace el deadline.

### 6 · Low · No todo error de `/video/**` lleva `detail {mensaje, codigo}`

**Dónde:**
- `app-backend/app_backend/main.py:199-200`: un id de ruta con forma mala da `{"detail": "No encontrado."}`.
- `main.py:201-204`: el 422 de FastAPI da una lista.
- `app-backend/app_backend/video_rest.py:111`: el 413 lleva texto.
- El 401 de `require_token` y el 500 de `error_inesperado` también llevan texto.

**Escenario:** el contrato dice «desde T11 **todo** error de `/video/**` lleva `detail: {mensaje, codigo}`». Ninguno de
estos textos es del motor (no hay fuga), pero la UI recibe una cadena donde espera un objeto: `detail.codigo` es `undefined`,
lo trata como error genérico y no distingue un `no_encontrado` por patrón de uno real.

**Corrección:** en esos manejadores, si `path.startswith("/video/")`, devolver `{"mensaje": …, "codigo": "no_encontrado" | "esquema" | "demasiado_grande" | "no_autorizado" | "interno"}`.
Test: recorrer un 404 de patrón, un 413 y un 401 bajo `/video/`.

### 7 · Low · Excepciones del runner fuera de la tupla capturada llegan a `GET /jobs` como `Tipo: mensaje`

**Dónde:** `app-backend/app_backend/video_rest.py:542` (solo `MotorError`, `TimeoutError`, `OSError` y `RuntimeError`) y `app-backend/app_backend/jobs.py:161-162`.

**Escenario:** `concurrent.futures.CancelledError` (al cerrar con un sondeo en vuelo), `KeyError`, `TypeError` y similares
caen en el `except Exception` genérico de `Jobs`, que guarda `f"{type(e).__name__}: {e}"`. Con el código actual no veo cómo
meter ahí una ruta, pero es texto no fijo hacia la UI.

**Corrección:** en `render_job`, `except Exception` con log y `ErrorPublico(MENSAJE_RENDER_FALLIDO)`.

### 8 · Info · La fuga entre tests (`test_api.py` tras `test_video*.py`) es solo de los tests, no del almacén de claves del producto

**Dónde:**
- `app-backend/tests/test_video.py:427` (`test_cambiar_la_clave_para_motor_y_no_el_render`): hace `PUT /settings {"elevenlabs_api_key": "xi-otra"}` y no la borra.
- `app-backend/tests/conftest.py:9-11`: `APP_BACKEND_SECRETS=file` en un `mkdtemp` de la sesión de pytest.
- `app-backend/tests/test_video_t11.py:707-710`: `sin_clave_guardada` lo tapa.

**Análisis:**
- La clave queda en el almacén de fichero del directorio temporal de esa ejecución de pytest y la ven los tests posteriores del mismo proceso.
- En el producto el almacén es el keyring del usuario. No hay estado compartido entre instancias más allá del propio usuario, ni camino por el que un test escriba en el keyring real (el modo `file` se fija antes de importar).
- No he reproducido el fallo: `t11 → video → api` pasa 132/134 y `test_video.py::test_cambiar_la_clave… → test_api.py` pasa 13/13.

El riesgo real está en los tests: sin `sin_clave_guardada`, `test_real_coste_plan_y_errores_del_motor` (último POST con plan
y coste buenos) llevaría al motor real a llamar a `api.elevenlabs.io` con `xi-otra`. Sería red real desde la suite, contra
I14 y la regla «nunca red real».

**Corrección:**
- `try/finally` que borre la clave en `test_video.py:427`.
- Una fixture `autouse` en `conftest.py` que, tras cada test, borre `ELEVENLABS_KEY` y `ANTHROPIC_KEY` del store.
- Una guarda `autouse` que haga fallar cualquier conexión a `api.elevenlabs.io` desde los `test_real_*`.
- Con eso, `sin_clave_guardada` sobra.

### 9 · Info · Otros puntos

- `timeout_voz` sin `frases` llega a 60 + 200 × 540 = 108 060 s (unas 30 h) con el cerrojo `voz` tomado si el motor se cuelga en una frase (`video_rest.py:790`). Va según el plan, pero conviene un tope duro (p. ej. 4 h) o que se acote por frases pendientes reales.
- El reenvío de `VIDEO_PRUEBAS_TTS_URL` en desarrollo (`video.py:428-432`) no tiene efecto: el motor va con `VIDEO_ENGINE_EMBEDDED=1` y `VIDEO_E2E` no se reenvía, así que `tts.ts:17` lo rechaza. Además solo admite `127.0.0.1`, con lo que la clave no puede salir a terceros. Si se quiere para los E2E, hay que reenviar también `VIDEO_E2E` (solo con `not FROZEN`).
- `GET /video/proyectos` deriva `error` de `jobs.list(200)`: un fallo más antiguo que los últimos 200 jobs se ve como `borrador`.
- `guardar_perfil` devuelve `d` tal cual si no es un dict (`video_rest.py:888`). Hoy sería `null`; mejor `_inesperada()`.

---

## Comprobado y correcto

- **`plan_no_se_fabrica`:** `generar_voz` y `muestra_voz` reenvían `plan_confirmado` y `caracteres_confirmados` tal cual (`video_rest.py:781-786` y `:846-855`) y no llaman a `video_voz_coste`. `VozIn` y `MuestraIn` exigen los dos (422 si faltan).
- **`reintentar_facturadas` y `reintentar_facturada`:** `is True` sobre `Any`. `"true"`, `1` y la ausencia valen `false`.
- **Doble cobro:** el cerrojo `voz` por proyecto, el `enCurso` y `muestrasEnCurso` del motor (`voz.ts:394` y `:676`) y las marcas `.vuelo` impiden dos lotes simultáneos y que se refacture sin confirmar. El `plan` funciona además como testigo de idempotencia: tras un lote, el plan cambia y da `coste_cambiado`.
- **Texto libre del motor:**
  - Errores: todos por `MENSAJES_POR_CODIGO` con mensaje fijo. Los 503 se limitan a `MENSAJES_503_FIJOS`.
  - `fallo.mensaje`: es fijo.
  - Render: `_resultado_render` filtra campo a campo, sin ruta del MP4. `avisos` lleva solo códigos.
  - `GET /jobs`: los errores del render son `ErrorPublico` fijos.
- **Clave de ElevenLabs:**
  - Solo en el entorno del proceso principal (`con_clave=False` en el de render).
  - Se oculta en stderr, en los errores MCP y en los datos JSON (`video.py:132-143`, `:232`, `:262`).
  - No va en `args` del job.
  - Los `log.warning` de `video_rest` reciben texto ya oculto.
- **Perfiles (R0-3):**
  - `pid` con patrón en la ruta (404 si no casa).
  - En `PUT`, el `id` del cuerpo debe coincidir (422 antes del motor) y el motor lo vuelve a comprobar (`perfil.ts:134`).
  - `duplicar` no admite `id` (`extra="forbid"`) y el id nuevo, que genera el motor, se valida con `PERFIL`.
- **Tools del modelo:** `registry.build()` solo recorre `yt_mcp` y `kb_mcp` (`registry.py:182`). Ninguna `video_*` llega al agente (lo cubre `test_agent`, como muestra el aviso de `video_proyecto_crear` no encontrado).
- **Jobs:**
  - `video_render` es interno: `POST /jobs` da 400.
  - Va en su propio carril, y una subida no espera a un render colgado (`test_render_colgado_falla_y_cola_sigue`).
  - Al reiniciar, los jobs a medias quedan `failed`.
- **Borrar con render o voz en curso:** 409 `render_en_curso` o `voz_en_curso` bajo `cerrojo_de(id)`. Un render encolado ya tiene el cerrojo desde el `POST`. La clave de la preview se invalida al borrar.
- **Cerrojos:** `tomar` es atómico (`threading.Lock`) y está bajo el `asyncio.Lock` del proyecto. Se sueltan en `finally`, y en el render también con `CancelledError` (`except BaseException`). El cierre de la app corta el sondeo (`cierre.set()`).
