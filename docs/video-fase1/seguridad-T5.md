# Auditoría de seguridad · T5 (voz por frases con ElevenLabs)

Rama `feat/t5-voz-frases`, diff `git diff feat/t4-almacen HEAD` (8 ficheros, +1169/−29). Revisión de solo lectura.
Contrastado con PLAN-video-fase1.md (Task 5), Review Focus 2, SPEC-video.md (I5, I10, I14, D7, M-D3) y
HANDOFF-video-fase1.md §2.

## Veredicto

**Aprobable con cambios menores.** No hay hallazgos Critical ni High. Hay 1 Medium (facturación que no se
cuenta y se repite cuando la validación falla después de cobrar) y varios Low/Info. Las invariantes I5, I10 (en
el producto integrado) e I14 se cumplen. La parte de facturación de la Review Focus 2 está bien resuelta en el
camino feliz y con 429, pero **no está verificada en Linux**: los tests que la cubren se saltan (ver "Pruebas").

## Pruebas ejecutadas

- `npx vitest run test/voz.test.ts test/tts.test.ts`: 25 pasan y **18 se saltan** (no 17). Se saltan porque `hfHome()`
  rechaza rutas POSIX (`pasaPorEnlace` exige letra de unidad), así que `requiere = it.skipIf(!ffmpeg)` desactiva toda
  la batería con ffmpeg aunque `/usr/bin/ffmpeg` exista. Entre las que se saltan están las cuatro de CA3
  (`una_frase_factura_una`, `reintento_no_refactura`, `misma_frase_reutiliza`, `reordenar_no_regenera`), las
  negativas de respuesta hostil (`alineacion_nan_no_guarda`, `retrocede_no_guarda`, `diez_a_la_seis_caracteres`,
  `audio_grande_rechazado`, `no_mp3_rechazado`), `clave_fuera_de_error` y el ensamblado. **Hay que ejecutarlas en
  Windows antes de fusionar.** Sí corren en Linux `coste_cambiado_no_llama`, las de `baseElevenLabs`, las de topes del
  cuerpo, `redirect: "error"` y `video_voces`.
- PoC temporal con el ffmpeg 6.1.1 del sistema, en el scratchpad y ya borrada (hallazgo 3).

## Comprobado y correcto

- **Las 6 tools nuevas no entran en `registry.build()`**: `build()` solo recorre `yt_mcp` y `kb_mcp`
  (`app-backend/app_backend/registry.py:180-203`). El backend no tiene todavía ninguna ruta REST que llame a las tools
  de voz: `main.py` solo llama a `video_capacidades`. El modelo no puede alcanzarlas en el producto (D2, I10).
- **Expectativa de `test_video.py:537-549`**: es el conjunto exacto de las tools que lista el motor integrado (15 + 6 =
  21). Es la lista del motor, no la del modelo, y se compara el conjunto exacto y la cuenta. Correcto.
- **I5**: `lanzarUno` pisa siempre `env` con `entornoHijo()` (lista blanca, no copia `process.env`). ffmpeg y ffprobe
  no reciben la clave. En argumentos solo hay rutas hash y números, nunca la clave ni el texto del guion. `log` redacta
  la clave de `process.env`. `errorHttp` y los errores de `fetch` pasan por `ocultarClave`, y `vozGenerar` y `vozMuestra`
  redactan el mensaje de `fallo` y el error. En el JSON por frase (`crudo`) solo se guardan las alineaciones. El canal de
  render no recibe la clave (`entorno_motor(con_clave=False)`), y las tools de voz van por `estado.motor`.
- **I14 / `baseElevenLabs`**: sin la variable, siempre `https://api.elevenlabs.io`. Integrado sin `VIDEO_E2E=1`, error
  (falla cerrado, no cae a la API real). La regex `^http://127\.0\.0\.1:(\d{1,5})/?$` está anclada: sin usuario, ruta,
  consulta, IPv6 ni nombre DNS (sin rebinding), y el puerto va de 1 a 65535. El backend construye el entorno del hijo
  desde cero (`get_default_environment()` + `entorno_motor()`), que no incluye `VIDEO_E2E` ni `VIDEO_PRUEBAS_TTS_URL`.
  `redirect: "error"` en TTS y en `/v1/voices`.
- **M-D3**: `voces()` solo extrae `voice_id` (con la regex), `name` y `labels.language`, saneados con `limpiar`.
  `preview_url` no se lee ni se sigue. La muestra se genera con `MUESTRA_TEXTO` (60 unidades UTF-16 y 60 code points,
  comprobado).
- **Respuesta no confiable**: el cuerpo se lee por trozos con tope de 20 MB (1 MB si es un error), y content-length
  declarado de más se rechaza sin leer. `audio_base64` se acota antes de decodificar y el audio a ≤ 10 MB. La alineación
  se valida (`problemaAlineacion`, `procesarAlineacion`, `validarPalabras`) y se compara su fin con la duración que
  devuelve ffprobe. El mp3 pasa por ffprobe con `-f mp3 -format_whitelist mp3`. La lista de voces se corta a 200. Los
  ids de voz se validan con `^[A-Za-z0-9]{10,40}$` y `encodeURIComponent`.
- **Coste**: `exigirCoste` exige un entero idéntico al cálculo del servidor antes de la clave, de ffmpeg y de cualquier
  `fetch`. Un subconjunto (`frases`) se recalcula, y los textos repetidos se facturan una vez. El candado `enCurso` se
  comprueba y se pone sin ningún `await` de por medio, así que no hay carrera dentro del proceso. Reintentar después de un
  éxito da `coste_cambiado`, porque el plan ya es 0.
- **Lote cortado**: se escribe primero el mp3, después el json (`escribirAtomico` del almacén de T4: `wx` con nombre
  aleatorio, fsync y rename), y la frase solo existe si el json valida (versión, hash, duración). Si se corta entre el
  mp3 y el json, en el peor caso se vuelve a facturar una frase.
- **concat**: la lista solo contiene `file '<sha256hex>.mp3'` relativos e `inpoint`/`outpoint` formateados con
  `toFixed(3)`. `Math.max`/`Math.min` convierten a número cualquier valor de `recorte`, así que no se puede inyectar
  texto aunque el esquema fallara. Además el esquema valida `recorte` (`esquema.ts:239`). La lista y el wav viven en
  `voz/`, comprobada con `comprobarCarpeta`. El demuxer exterior usa `safe=1` por defecto.
- **`salidaBinaria`**: tiene tope, sigue drenando la tubería para no bloquear al hijo, una salida truncada se convierte en
  `code` ≠ 0 y no se entrega a medias. `picosDeWav` comprueba RIFF/WAVE, recorre los chunks con límites y trata
  `0xFFFFFFFF`.

## Hallazgos

### 1. Medium · La facturación que se cobra y no se valida no se cuenta, y el reintento la vuelve a pagar

- **Dónde**: `video-mcp-server/src/voz.ts:176-193` (`sintetizarValidado`) y `voz.ts:236-239` (el `catch` de `vozGenerar`).
  También `vozMuestra`, `voz.ts:470`.
- **Escenario**: ElevenLabs cobra la frase al responder 200. Después la descarta el motor: el audio no pasa ffprobe, la
  alineación acaba más de 1 s después del audio, `procesarAlineacion` o `validarPalabras` fallan, el cuerpo pasa de
  20 MB o el `AbortSignal` de 180 s salta después de que el servidor haya generado. En todos esos casos se devuelve
  `fallo` con `caracteresFacturados` sin esos caracteres, y la frase sigue pendiente. Si el fallo es determinista para
  ese texto (una alineación que siempre queda descuadrada con un texto concreto), cada reintento confirmado vuelve a
  pagar la misma frase, sin límite y sin que la persona lo vea. Contradice en parte la Review Focus 2 ("reintentar
  factura solo lo que falta") y el "coste visible" de I10.
- **Corrección**:
  - Separar "llamada facturada" de "frase guardada". Si la respuesta HTTP fue 2xx, sumar los caracteres a
    `caracteresFacturados` aunque luego falle la validación, y marcar `fallo.facturada: true` para que la UI diga
    "se cobró y no se pudo usar".
  - Para los fallos de validación posteriores al cobro, contar los intentos por hash en `voz/<hash>.fallos`, por
    ejemplo, y a partir del segundo exigir una confirmación explícita distinta (`reintentarFallidas: true`) o
    bloquear con `codigo: "respuesta_invalida_repetida"`.
  - Opcional: guardar en cuarentena (fuera de la ruta que lee `leerFrase`) el JSON crudo de alineación, para
    reprocesarlo sin volver a llamar cuando el fallo sea solo de alineación.

### 2. Low · La confirmación del coste solo comprueba un número: no ata el plan ni sirve de autorización

- **Dónde**: `voz.ts:147-153` (`exigirCoste`), `voz.ts:134` y `voz.ts:455` (`exigirCoste(MUESTRA_CARACTERES, …)`).
  También `src/index.ts:42`: `registrarHerramientasProyecto` registra las tools siempre, también fuera del modo integrado.
- **Escenarios**:
  - **(a) Un cambio de la misma longitud se factura.** Entre mostrar y confirmar cambia el texto de las frases sin
    que cambie el total de caracteres (otra pestaña, o la UI guarda una edición): se factura el plan nuevo con la
    confirmación vieja. El importe es el confirmado, pero no el contenido.
  - **(b) La muestra no protege nada.** Su confirmación es la constante 60, así que no frena a ningún llamador.
  - **(c) En modo desarrollo el modelo puede gastar.** Si el servidor corre suelto en Claude Desktop, el modelo ve
    `video_voz_coste`, `video_voz_generar` y `video_voz_muestra` y puede confirmar él mismo (leer el coste y
    reenviarlo). En el producto no pasa (D2: el backend no las expone), y el formato anterior ya permitía gastar en
    desarrollo con `video_generar_voz`. Aun así, la garantía de I10 depende por completo de que T13/T14 no expongan
    estas tools al modelo.
- **Corrección**:
  - Que `vozCoste` devuelva también `plan: sha256(voiceId|modelo|hashes únicos ordenados)` y que `vozGenerar` exija
    `planConfirmado` igual, además de los caracteres.
  - Registrar las tools que gastan solo en modo integrado, o marcarlas en su descripción como "solo para la UI".
  - En T13, que la ruta REST sea la única vía y que un test de `registry` falle si aparece alguna `video_voz_*`.

### 3. Low · concat anidado: un "mp3" políglota se abre como ffconcat dentro de la lista

- **Dónde**: `src/proceso.ts:983-989` (`argsEntrada(…, internos)` → `-format_whitelist concat,mp3`) y `voz.ts:311`.
- **Escenario (PoC verificada con ffmpeg 6.1.1)**:
  - Un fichero que empieza por `ffconcat version 1.0\nfile 'x.mp3'\n#` y sigue con tramas mp3 de silencio (que no
    contienen `\n`) **pasa** `ffprobe -f mp3 -format_whitelist mp3`: `format_name=mp3`, pista de audio y 1,04 s.
  - Al ensamblar, el demuxer `concat` abre cada entrada sin formato forzado y copia la lista blanca
    (`concat,mp3`). El sondeo da a la cabecera `ffconcat` la puntuación máxima, así que el fichero **se interpreta
    como lista de concatenación** (ffmpeg llegó a parsear sus líneas).
  - Una ruta absoluta en la lista anidada se rechaza con "Unsafe file name" (`safe=1` por defecto también en la
    anidada).
  - Impacto: con `safe=1`, como mucho se leen otros ficheros con nombre seguro de la misma carpeta `voz/` (audio del
    propio usuario), o hay una recursión que acaba en el timeout de 120 s. No hay lectura de ficheros arbitrarios. Hace
    falta controlar la respuesta de ElevenLabs (servicio comprometido o el mock en desarrollo), o escribir en
    `%LOCALAPPDATA%`.
- **Corrección**:
  - Antes de guardar, exigir que el audio empiece por `ID3` o por una cabecera de trama MPEG (`0xFF`, y `0xE0` con
    máscara en el segundo byte), y rechazar cualquier búfer que contenga `ffconcat` en los primeros 64 KiB.
  - Mejor todavía (I15, normalizar al importar): remuxar cada frase con ffmpeg (`-f mp3 … -c copy` a un fichero nuevo)
    y guardar solo esa salida.
  - Pasar `-safe 1` de forma explícita en `ensamblarVoz`, para que no dependa del valor por defecto.

### 4. Low · `vozMuestra`: sin candado, temporal compartido y caché leída antes de comprobar la carpeta

- **Dónde**: `voz.ts:441-477`.
- **Escenarios**:
  - **(a) Doble cobro con muestras simultáneas.** Dos clics seguidos en "escuchar" la misma voz: las dos llamadas
    pasan la caché, se paga dos veces y usan el **mismo** temporal (`<hash>.tmp-<pid>.mp3`). El `finally` de una
    borra el fichero mientras la otra lo sondea, así que la segunda falla después de cobrar.
  - **(b) Caché leída antes de comprobar la carpeta.** `ficheroNormal(ruta)` y `readFileSync` (`voz.ts:459`) se
    ejecutan antes de `comprobarCarpeta(dir)`. Si `muestras/` es una junction, se lee y se devuelve en base64 un
    fichero de hasta 10 MB de otra carpeta. `ficheroNormal` hace `lstat` del fichero, no de la carpeta.
  - **(c) Ruta mal formada.** `carpetaMuestras` da `<estado>/video/video/muestras` en integrado y
    `~/Videos/video/muestras` en desarrollo, fuera de `VIDEO_ROOT`. La caché no tiene json ni validación: cualquier
    fichero normal de ≤ 10 MB vale como muestra.
- **Corrección**:
  - Un candado por hash (un `Set`, como `enCurso`).
  - `comprobarCarpeta` antes de leer la caché.
  - Temporal con nombre aleatorio y apertura `wx`.
  - Una ruta fija bajo el estado de la app, por ejemplo `path.join(path.dirname(cfg.videoRoot), "muestras")` o
    un `VIDEO_STATE_DIR` explícito.

### 5. Low · El temporal de validación se escribe siguiendo enlaces y con nombre predecible

- **Dónde**: `voz.ts:177-179` (`fs.writeFileSync(temporal, tts.audio)` con `temporal = <hash>.tmp-<pid>.mp3`).
- **Escenario**: un proceso del usuario (TOCTOU en `%LOCALAPPDATA%`, §2) planta `voz/<hash>.tmp-<pid>.mp3` como
  symlink o hardlink a otro fichero. El motor escribe el audio a través del enlace y lo borra en el `finally`, con
  lo que borra la entrada del enlace. Puede corromper un fichero del usuario. El hash y el pid son predecibles.
- **Corrección**: abrir con `fs.openSync(temporal, "wx")` y añadir un sufijo aleatorio, como ya hace `escribirAtomico`.

### 6. Low · Las cabeceras de coste y el `request-id` se aceptan sin validar

- **Dónde**: `src/tts.ts:205-206` y `tts.ts:215`. Se usan en `voz.ts:193` y se escriben en `voz.ts:597`
  (`caracteresFacturados`, `requestId`).
- **Escenario**: `x-character-count: -1e9` o `1.5` se acepta (solo se exige que sea finito). Así
  `caracteresFacturados` sale negativo o fraccionario en la respuesta a la UI y en el JSON de la frase. La UI enseñaría
  un coste falso (resta en el total), y `requestId` va sin acotar al JSON y a la UI.
- **Corrección**: aceptar solo enteros en `[0, 10 * texto.length]`, y si no, usar `undefined` (se caerá a
  `texto.length`) y registrar un aviso. Acotar `requestId` a `^[A-Za-z0-9_-]{1,100}$`.

### 7. Info · La puerta de `VIDEO_PRUEBAS_TTS_URL` en el binario congelado depende solo del entorno

- **Dónde**: `tts.ts:17`.
- **Situación**: hoy es inalcanzable, porque el backend no pasa ni `VIDEO_E2E` ni la URL. Pero el binario congelado
  obedece `VIDEO_E2E=1` si algún día llega por el entorno. El plan deja la comprobación a T21.
- **Corrección**: añadir ya en `app-backend/tests/test_video.py` un test que afirme que `entorno_motor()` (con
  `FROZEN=True`) no contiene `VIDEO_E2E`, `VIDEO_PRUEBAS_TTS_URL` ni nada que empiece por `VIDEO_PRUEBAS_`. Valorar que
  el motor no honre la variable cuando corre desde el bundle (por ejemplo, si `process.execPath` está bajo
  `VIDEO_ENGINE_DIR/node`).

### 8. Info · `fallo.mensaje` puede llevar rutas absolutas

- **Dónde**: `voz.ts:180-182`. El stderr de ffprobe se incluye recortado a 200 caracteres y suele empezar por la ruta
  completa del temporal (`C:\Users\<usuario>\AppData\…`).
- **Escenario**: llega a la UI como dato, no como error, así que `resultadoDeError` no lo depura. No va al modelo.
- **Corrección**: cambiar en el stderr la ruta del temporal por su nombre base antes de ponerla en el mensaje.

### 9. Info · `.ffconcat` entra en el mapa global `DEMUXERS`

- **Dónde**: `proceso.ts:967`.
- **Situación**: hoy ningún llamador con rutas del usuario llega a ese mapa con `.ffconcat`, porque todos filtran
  antes por `EXTENSIONES_AUDIO` o `EXTENSIONES_IMAGEN`. Pero un importador futuro que use `Object.keys(DEMUXERS)` como
  lista de extensiones permitidas abriría listas `concat` del usuario.
- **Corrección**: quitar la entrada del mapa y pasar `"concat"` de forma explícita en `ensamblarVoz`
  (`argsEntrada(lista, "concat", ["mp3"])`).

### 10. Info · El motor integrado todavía no recibe la voz ni el modelo

- **Dónde**: `app_backend/video.py:358-398`. `entorno_motor` no pasa `ELEVENLABS_VOICE_ID` ni `ELEVENLABS_MODEL_ID`.
- **Situación**: en el producto, todas las tools de voz salvo `video_voces` y `video_voz_muestra` responden
  `sin_configurar`. Es funcional, no de seguridad, y entiendo que es de T13.
- **Corrección**: cuando se pasen, validar `voiceId` en el backend con la misma regex, y el modelo contra una lista
  cerrada.

### 11. Info · Los caracteres se cuentan en unidades UTF-16

- **Dónde**: `voz.ts:134`.
- **Situación**: `texto.length` cuenta 2 por cada carácter fuera del BMP. Si `textoSeguro` admite emojis, el coste
  que ve la persona no coincide con lo que factura ElevenLabs. No hay forma de saltarse la confirmación con esto.
- **Corrección**: contar `[...texto].length`, o documentar que `textoSeguro` excluye ese rango.

### 12. Info · El candado `enCurso` vive en la memoria del proceso

- **Dónde**: `voz.ts:145`.
- **Situación**: con un timeout del backend, `_descartar` espera a cerrar el proceso antes de devolver el error, así
  que hoy no hay dos motores con clave a la vez. Si T13 cambia ese orden, o lanza un segundo proceso con clave, dos
  lotes del mismo proyecto podrían facturar las mismas frases.
- **Corrección**: un fichero de candado `voz/.generando` abierto con `wx` (con PID y fecha, para limpiar uno
  obsoleto). Además, que T13 dé a `video_voz_generar` un timeout acorde al lote (hasta 540 frases × 180 s): si no,
  cada timeout mata el motor y pierde una frase ya cobrada.
