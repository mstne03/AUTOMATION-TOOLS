# T21 · smoke del binario, capturas y E2E de la preview (SEO-107)

## Qué se ha tocado

- `app-backend/scripts/smoke_test.py`: comprobaciones nuevas (ver abajo).
- `app-ui/e2e/video-preview.spec.ts`: `cambio_se_ve_sin_render` ya no es `test.fixme`.
- `app-ui/e2e/visual.spec.ts`: pantallas `video` y `video-editor` (claro/oscuro, 1200×800 y 900×600).
- `app-ui/e2e/__capturas__/`: 8 PNG nuevas (`video-*` y `video-editor-*`). Las demás no se han regenerado.
- `app-ui/docs/pantallas.md` («Regresión visual»): las dos pantallas y qué se simula en cada una.

## Smoke (`smoke_test.py`)

Se ejecuta contra el binario congelado; **no hay build congelado en esta máquina**, así que no se ha podido
ejecutar de punta a punta. Verificado por partes:

- `py_compile` y `ruff check` limpios.
- `entorno_de(pid)` (lectura del PEB) contra el propio proceso: idéntico a `os.environ` (114 variables), y contra un
  hijo con `VIDEO_E2E`/`VIDEO_PRUEBAS_TTS_URL` los ve. `descendientes()` encuentra al hijo.
- `csp_esperada(puerto)` es idéntica a `preview.cabecera_csp(puerto)` con `config.FROZEN = True` en los 4 puertos.
- Contra el backend en modo desarrollo (`uv run app-backend`): `comprobar_docs_ausentes` pasa; `comprobar_preview`
  encuentra los 4 puertos, 404 con CSP, y solo falla en lo esperado: en desarrollo la CSP lleva
  `http://localhost:1420` en `frame-ancestors` y el binario congelado no.

Qué comprueba, por requisito del plan:

| Requisito | Cómo |
|---|---|
| `VIDEO_PRUEBAS_TTS_URL` ausente del motor congelado | El sidecar arranca con `VIDEO_PRUEBAS_TTS_URL`, `VIDEO_E2E` y `ELEVENLABS_VOICE_ID` centinela (`VARIABLES_DE_PRUEBA`). Con motor, `comprobar_motor_sin_pruebas` lee el entorno real de cada `node.exe` hijo (PEB) y exige `VIDEO_ENGINE_EMBEDDED=1` y ninguna de las tres. |
| Preview responde en su puerto con su CSP | Sondea `config.PUERTOS_PREVIEW`: al menos uno responde, 404 en `/docs` y con clave inexistente, y la CSP es exactamente la de producción (sin `localhost:1420`). Corre también sin motor. |
| Runtime con el hash correcto | SHA-256 del `hyperframe.runtime.iife.js` del bundle frente a `config.RUNTIME_SHA256`; además `POST /video/proyectos/{id}/preview` (proyecto sin voz) no debe dar 503: ese 503 solo sale si no hay puerto reservado o el runtime no verifica. |
| `/docs` da 404 | `/docs`, `/redoc` y `/openapi.json` con token válido en la API, y `/docs` en cada puerto de la preview. |

Limitación conocida: no se obtiene una clave de preview real porque montar exige voz (ElevenLabs, sin red en el
smoke), así que no se hace un GET de `__preview/runtime.js` servido; el hash se comprueba en el fichero y vía el 503.
Si se quiere el GET servido, hace falta un smoke con el ElevenLabs falso (`VIDEO_E2E`), que el binario congelado
no admite por diseño.

## E2E `cambio_se_ve_sin_render`

Quitado el `fixme`. Cambios para que pase: genera la voz antes (helper `generarVoz`, extraído del test de seek, porque
el motor no monta la preview sin voz), selecciona la primera escena (`clip-escena-*`), escribe en el `textbox` dentro de
`escena-campo-texto` (el `data-testid` es del contenedor, no del input) y busca el texto con regex insensible a
mayúsculas y espacios: el cartel parte el texto en una pieza por palabra y la plantilla lo pone en mayúsculas por CSS.

## Capturas

`video`: `GET /video/proyectos` simulado con los cuatro estados (listo, renderizando, borrador, error).
`video-editor`: proyecto real del sidecar (guion de cocina) y preview simulada (composición fija de 10 s) para no
depender del motor ni de la voz. Importante: la ruta del iframe se registra **después** de `simularRutas` (el último
`page.route` registrado es el primero que se consulta; al revés, el iframe iba a la red y `listo` nunca llegaba).

Revisadas las PNG (oscuro 1200×800, claro 900×600, `video` claro 1200×800 y oscuro 900×600): sin errores, sin
solapes, nada cortado salvo lo propio del diseño: la timeline mide 240 px y desplaza en vertical (la fila «Música»
queda por debajo), y a 900×600 las píldoras «Pendiente» de la pista de voz se recortan con puntos suspensivos.

## Ejecución

Resultado final: `pnpm exec playwright test e2e/video-preview.spec.ts e2e/visual.spec.ts` -> 51 passed (2,4 min), 0 fallos, 0 saltados, con FFMPEG_DIR del bundle LGPL. Puerto 1420 libre antes de lanzar.
Ruido conocido en el log del motor: `video_voces: ElevenLabs respondió 404: No existe` aparece en ejecuciones de este
árbol (voz `voz-e2e` del ElevenLabs falso en alguna llamada de la UI); no hace fallar ningún test.
