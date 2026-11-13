# Auditoría de seguridad · PR #27 (`feat/21-aceptacion` → `ds/v1`, punta `281c510`)

Fecha: 2026-11-13. Modo interno y **solo de lectura**: código fuente y sistema de ficheros, sin ninguna prueba contra
hosts externos, sin ejecutar renders, E2E ni la suite. Este informe es el único cambio de la rama.

Referencias: `SPEC-video.md` §Seguridad (A1–A4, I1–I15), `docs/video-fase1/R2-fase1.md` (R2 de T21, 2026-11-11) y
`seguridad-T*.md`. Lo que ya está abierto o cerrado en esos documentos no se repite; solo se comprueba lo que ha cambiado
desde la R2. Desde `637ce31` («informe de T21 con los arreglos tras la R2») la rama trae: el ffmpeg LGPL propio (PR #28),
la validación de la clave con `/v1/voices`, R2-1 (bandeja) y R2-2 (avisos) arreglados, importar un recurso sin conflicto
falso, abrir guiones guardados y regenerar la voz sin salir del editor.

Nivel de cada hallazgo: todos están **inspeccionados en código**; ninguno se ha reproducido en ejecución.

## Resumen

| ID | Severidad | Dónde | Título |
|---|---|---|---|
| A27-1 | Low | `video-mcp-server/src/herramientas.ts:171`, `render.ts:322`, `musica.ts:63-68,163`, `voz.ts:350` | Flujo heredado: ffprobe y ffmpeg sobre ficheros copiados a mano, sin `-max_pixels` |
| A27-2 | Low | `video-mcp-server/src/proceso.ts:145-165,486,975` | Rechazar la carpeta de ffmpeg no impide el `spawn` |
| A27-3 | Low | `video-mcp-server/src/recursos.ts:144-182,405`, `app-ui/src-tauri/src/lib.rs:~438` | La bandeja no tiene cuota y los `.bin` que nadie reclama no se limpian |
| A27-4 | Low | `app-backend/app_backend/video_rest.py:756-768` | Las papeleras `.borrando-*` nunca se barren |
| A27-5 | Low | `app-backend/app_backend/video_rest.py:410-423,785-835,1047` | Varias rutas reenvían la salida del motor a la UI sin filtrarla |
| A27-6 | Info | `video-mcp-server/src/voz.ts:229-300` | La confirmación de la voz es de coherencia, no de presencia del usuario |
| A27-7 | Info | `app-backend/app_backend/preview.py:483-486` | El socket de la API no lleva `SO_EXCLUSIVEADDRUSE` |
| A27-8 | Info | varios | Defensa en profundidad y documentación (bandeja, ACL, `FFMPEG_DIR`, cwd, LEEME) |

**Correcciones (rama `fix/21-auditoria-pr27`, 2026-11-13).** A27-1 a A27-5 corregidos y A27-8 en lo que tenía arreglo
en código; A27-6 y A27-7 siguen como propuestas. Detalle en «Estado de las correcciones», al final.

No hay hallazgos Critical, High ni Medium. Las superficies del encargo están cerradas en el código revisado, salvo lo
que se lista arriba y los heredados que siguen abiertos (ver «Heredados»).

## Hallazgos

### A27-1 · Low · Flujo heredado: ffprobe y ffmpeg sobre ficheros copiados a mano, sin `-max_pixels`

- **Dónde:** `herramientas.ts:171`, `render.ts:322`, `musica.ts:163` y `:63-68` (`prepararMusica`), `voz.ts:350`.
- **Escenario (A2):** el flujo anterior al módulo integrado, en el que la persona copia `imgN` o `_musica` a mano dentro de
  `VIDEO_ROOT`, no pasa por la normalización de I15. Sobre esos ficheros, `sondear` y ffmpeg corren sin `maxPixeles` y
  `hyperframes audio` abre la pista sin `-protocol_whitelist`. Un PNG o un MP4 con dimensiones enormes en la cabecera
  agota la memoria del motor.
- **Razonamiento:** en el flujo de la app (bandeja → `importarA`), todas las invocaciones llevan `argsEntrada`
  (`-protocol_whitelist file`, `-format_whitelist`, `-f`) y `-max_pixels` antes de `-i`, también en ffprobe, y hay test.
  Las llamadas citadas no pasan por ahí.
- **Impacto:** DoS local del motor (lo reinicia el backend). No se ejecuta código: los protocolos del build propio son
  solo `file pipe fd`. En la app integrada este camino solo se alcanza si un fichero entra en `VIDEO_ROOT` por fuera de la
  bandeja.
- **Arreglo:** pasar `maxPixeles` en esos `sondear`, y `-max_pixels` y `argsEntrada` en `prepararMusica` y en la invocación
  de `hyperframes audio`. Otra opción: que en el modo integrado esas rutas solo acepten recursos normalizados (`<id>.<ext>`
  registrados en `proyecto.json`).

### A27-2 · Low · Rechazar la carpeta de ffmpeg no impide el `spawn`

- **Dónde:** `proceso.ts:975` (`herramientasFfmpeg` revisa la carpeta en cada uso y devuelve `null` si sobra un fichero),
  `proceso.ts:145-165` (`entornoHijo`) y `proceso.ts:486` (`lanzarUno`).
- **Escenario:** un llamador obtiene `Herramientas` antes y lanza después. Si entre medias aparece una `.dll` en la
  carpeta del ffmpeg, `entornoHijo` recibe `null` y solo quita la carpeta del `PATH`, pero `lanzarUno` lanza igualmente
  la ruta absoluta del `ffmpeg.exe`. Windows busca las DLL primero junto al exe, así que la DLL plantada se cargaría.
- **Impacto:** quien planta la DLL ya ejecuta código como el usuario (fuera de alcance según «Atacantes»). Aun así,
  incumple el requisito de W3.2 («el motor rechaza una `.dll` extra») y la regla I11 de que el fallo se vea.
- **Arreglo:** si `comando` es el ffmpeg o el ffprobe del bundle, llamar a `revisarCarpetaFfmpeg` dentro de `lanzarUno`,
  justo antes del `spawn`, y fallar con un error legible. Añadir un test: planta la DLL después de `requerirFfmpeg` y
  antes de `ejecutar`.

### A27-3 · Low · La bandeja no tiene cuota y los `.bin` que nadie reclama no se limpian

- **Dónde:** `recursos.ts:144-182` (`reclamarBandeja`, `limpiarUsosHuerfanos`), `recursos.ts:405` (`importarRecurso`) y
  la copia de Rust (`lib.rs`, `importar_recurso`).
- **Escenario:** `limpiarUsosHuerfanos` solo barre los `.uso-*` de más de una hora; los `<32hex>.bin` sin reclamar se
  quedan para siempre. Se acumulan cuando la UI no llama al backend tras el diálogo, cuando `proyectoLeer` (`:405`) falla
  antes de `reclamarBandeja` o cuando el proceso muere a media copia en Rust. Cada uno pesa hasta 500 MB y es una copia
  privada del usuario (foto o clip) que nadie ve.
- **Impacto:** el disco se llena por acumulación (exige diálogos manuales, no es remoto) y quedan datos del usuario
  retenidos fuera de la vista. Mismo efecto que R2-1, por otra vía.
- **Arreglo:** en `importarRecurso`, reclamar primero la entrada o borrar el `.bin` si falla la validación previa. En
  `limpiarUsosHuerfanos`, barrer también los `.bin` de más de una hora. En Rust, escribir a `<id>.parcial` y renombrar a
  `.bin` al terminar.

### A27-4 · Low · Las papeleras `.borrando-*` nunca se barren

- **Dónde:** `video_rest.py:756-768` (`borrar_proyecto`).
- **Escenario:** si `_borrar(papelera)` falla a medias (antivirus, fichero abierto), el comentario dice «la papelera se
  barre luego», pero ningún código barre las `.borrando-*` (búsqueda en `app_backend/`: una sola aparición). La persona
  ve el proyecto borrado, y la voz, las fotos y el MP4 siguen en `%LOCALAPPDATA%`.
- **Impacto:** retención de datos que el usuario cree borrados. No hay acceso cruzado: la carpeta hereda la ACL del estado.
- **Arreglo:** al arrancar el backend (o antes de cada borrado), barrer con `_borrar` las hijas de `VIDEO_ROOT` que
  casen exactamente con `^\.borrando-video[0-9]{3}-[0-9a-f]{8}$` y no sean enlaces. Añadir un test con una papelera
  sembrada.

### A27-5 · Low · Varias rutas reenvían la salida del motor a la UI sin filtrarla

- **Dónde:** `_lista` y `_proyecto` (`video_rest.py:410-423`) solo comprueban el envoltorio (`{clave: list}`, un `dict` con
  `id` de tipo `str`). `GET /guiones` y `GET /proyectos` devuelven los elementos tal cual (`listar_proyectos` además
  muta `p["estado"]` sobre cada `dict`). `GET /proyectos/{id}` devuelve el documento entero. `POST /guiones`,
  `GET /guiones/{gid}`, `POST /proyectos`, `PUT /proyectos/{id}` y `GET /perfiles` reenvían la respuesta del motor sin
  mirarla.
- **Escenario:** la R2 dice «resultados del motor filtrados campo a campo». Es cierto para recursos, pistas, render, voz
  y voces (`recurso_seguro`, `_pista_segura`, `_resultado_render`, `_entero`), pero no para estas rutas. Si un fallo del
  motor, o un campo nuevo, metiese una ruta absoluta, un mensaje interno o un valor con otra forma, llegaría a la UI sin
  que el backend lo viese. Los textos de guion y proyecto son salida del modelo (A1).
- **Impacto:** bajo. La UI pinta como texto (React, sin `dangerouslySetInnerHTML` en el módulo), el motor valida con
  esquema al cargar (I1) y el WebView es de confianza. Es una frontera de defensa en profundidad que se da por cerrada y
  no lo está; como mucho, un documento con forma inesperada rompe el editor.
- **Arreglo:** en `_lista`, exigir que cada elemento sea un `dict` con `id` que case con su patrón (`GUION`, `PROYECTO`)
  y quedarse con los campos del contrato (`ResumenProyecto`: `id`, `titulo`, `revision`, `actualizado`, `escenas`). En
  `crear_guion`, `crear_proyecto` y `guardar_proyecto`, devolver solo los campos que usa `client.ts` (`id`, `revision`,
  `avisos` por `_avisos_seguros`). Corregir la frase de la R2.

### A27-6 · Info · La confirmación de la voz es de coherencia, no de presencia del usuario

- **Dónde:** `voz.ts:229-300` (`planear`, `exigirCoste`, `exigirPlan`), `voz.ts:388-394`, `voz.ts:664-693` (muestra) y
  `video_rest.py:900-1018`.
- **Verificado:** no se puede gastar en ElevenLabs sin enviar el `plan` y los `caracteres` exactos del cálculo actual. El
  `plan` es el SHA-256 de `[voiceId, modelo, hashes de los textos pendientes, marcas de fallo]`. `exigirCoste` exige un
  entero idéntico (sin tolerancia) y `exigirPlan`, la huella idéntica. Lo que se sintetiza es la instantánea de `planear`,
  así que un `PUT` concurrente no cambia lo que se cobra. Las frases ya cobradas que fallaron necesitan además
  `reintentarFacturadas: true` literal (en el backend, `is True`). Lo ya generado está en caché por hash y no se cobra
  dos veces. El cerrojo `voz` del backend y `enCurso` del motor impiden dos generaciones a la vez. La muestra exige
  60 caracteres y `planMuestra` de esa voz. El modelo no tiene tools `video_*` (D2, I10).
- **Límite del control:** el `plan` es determinista y se calcula a partir de datos que el propio llamador puede pedir
  (`/voz/coste`). Lo que frena el gasto es el bearer, no la confirmación. Quien tenga el token (por ejemplo, un XSS en el
  WebView) puede encadenar `PUT` con textos nuevos, `/voz/coste` y `/voz` sin tope agregado: cada vuelta cuesta como mucho
  la narración permitida (3000 caracteres según `esquema.ts:13`). Lo mismo vale para muestras con voces distintas.
- **Propuesta (opcional, fase 2):** un tope de gasto por sesión o por día en el backend, y que el `plan` lleve un nonce
  de un solo uso emitido por `/voz/coste` y guardado en memoria, para que la confirmación pruebe que hubo un coste
  mostrado y no solo calculable.

### A27-7 · Info · El socket de la API no lleva `SO_EXCLUSIVEADDRUSE`

- **Dónde:** `preview.py:483-486` (`_crear_socket_api`): `bind(("127.0.0.1", 0))` sin la opción exclusiva que sí llevan
  los puertos de preview (`_vincular`, `:418-432`).
- **Escenario (A4):** otro proceso que vincule el mismo puerto con reutilización recibiría peticiones con el bearer.
- **Razonamiento:** desde Windows Server 2003, la seguridad de sockets mejorada impide que un socket de **otra cuenta** se
  vincule encima, con o sin `SO_REUSEADDR`. El mismo usuario queda fuera de alcance. Por tanto, es defensa en
  profundidad, no una vía abierta (no se ha medido).
- **Arreglo:** aplicar la misma `SO_EXCLUSIVEADDRUSE` en `_crear_socket_api`, con el mismo `getattr` que en `_vincular`.
  Es una línea y deja las dos escuchas del sidecar con la misma regla.

### A27-8 · Info · Defensa en profundidad y documentación

- **Bandeja:** Rust no comprueba que la carpeta `bandeja` no sea una junction antes de escribir (`lib.rs:~440`); el motor
  la rechaza al leer (`sinEnlace(dir)`), así que el fichero no se consume. Hay una ventana entre `sinEnlace(dir)` y el
  `rename` por ruta (`recursos.ts:149-165`), pero `copiarRecurso` revalida sobre el descriptor (`nlink`, `dev/ino`,
  tope), así que no tiene impacto práctico. Las dos cosas exigen ser el mismo usuario.
- **ACL del estado:** no hay ACL explícita y todo depende de la herencia de `%LOCALAPPDATA%`. Un `APP_BACKEND_DIR`
  apuntado a una carpeta compartida rompería el supuesto. `dir_estado_desde` cae a una ruta relativa si faltan
  `LOCALAPPDATA` y el home. Propuesta: rechazar un estado relativo y documentar que `APP_BACKEND_DIR` es solo para desarrollo.
- **`FFMPEG_DIR` en el motor integrado:** el motor acepta cualquier `FFMPEG_DIR` y solo avisa. En la práctica no importa,
  porque el backend congelado fija siempre el del bundle (`video.py:542-550`).
- **cwd de los hijos:** los hijos del motor que no son la CLI de HyperFrames heredan el cwd del motor. Propuesta: fijar
  `cwd` a una carpeta del estado.
- **SHA-256 de ffmpeg:** se verifica al empaquetar y no en ejecución; es una decisión documentada y coherente con I4
  (atacante local fuera de alcance).
- **`video-mcp-server/ffmpeg-build/LEEME.md`:** la línea 37 dice «solo file y pipe», pero el build habilita `file pipe fd`
  (`fd` es necesario y está justificado en `9290b8a`); además, el LEEME aún habla de marcadores `PENDIENTE-TAREA-10`, y ya
  no queda ninguno. Corregir el texto.
- **Detección del ffmpeg ajeno por texto:** `video_rest.py` reconoce el error del ffmpeg ajeno buscando la frase «no es el
  LGPL del bundle» en el mensaje del motor. Si cambia el texto, la UI pasa a decir «Falta ffmpeg» (falla visible, no
  insegura). Propuesta: un `codigo` propio desde el motor.

## Superficies verificadas sin hallazgo nuevo

- **Autenticación del sidecar.** Bearer de 32 bytes que genera Tauri (`lib.rs:120`, `APP_BACKEND_TOKEN`) o
  `secrets.token_urlsafe(32)`; `secrets.compare_digest` en `require_token` (`main.py:240`); todo `/video/*` con
  `dependencies=protegido`. La API escucha solo en `127.0.0.1`, con un puerto efímero que nunca cae en 47810–47813
  (`vincular_api`). El spike de preview solo se monta con `not config.FROZEN`.
- **IDOR y recorrido de rutas entre proyectos.** Todos los ids de ruta tienen patrón ASCII estricto (`video[0-9]{3}`,
  `g-`/`p-`/`r-`/`m-` + 16 hex, `bandeja` de 32 hex); un id con forma mala da 404. `PUT` exige que el id del cuerpo sea el
  de la ruta. El motor vuelve a fijar `id`, `creado` y `revision`, y rechaza `recursos` distintos de los del disco
  (`proyecto.ts:335-351`), así que un `PUT` no puede referenciar un fichero que no pasó por la importación. La clave de
  preview está atada a `(id, carpeta, creado)`. Hay un solo usuario por estado, así que no existe IDOR entre cuentas.
- **`revision` y 409.** Se compara con el disco dentro del motor (síncrono) y bajo `cerrojo_de(id)` en el backend, y
  también en `quitar_silencios` e `importar_recurso`, que suben la revisión. `cambioEnServidor` (UI, `editor.ts`) pausa el
  autoguardado mientras el servidor cambia el proyecto, así que no hay conflicto falso ni pérdida silenciosa. El sobre y
  el documento deben coincidir en `revision` (`revision_distinta`).
- **Voz y gasto (ElevenLabs).** Ver A27-6: no hay gasto sin `plan` y `caracteres` exactos. `POST /settings/validate-elevenlabs-key`
  (cambio de `/v1/user` a `/v1/voices`) solo lee `detail.status` y no reenvía texto de ElevenLabs. La URL es fija y va
  por `elevenlabs_transport`.
- **Servidor de preview.** Cuatro puertos vinculados en `127.0.0.1` con `SO_EXCLUSIVEADDRUSE` y nunca reutilización
  (`_vincular`). Los ajenos quedan en `Reserva.ajenos` y se avisan (R2-2 arreglado en `661a259`). Hay comprobación de
  `Host` exacta contra DNS rebinding (421) y no hay log de acceso. La CSP de cabecera lleva `sandbox allow-scripts` y
  `default-src 'none'`; `connect-src`, `script-src`, `img-src` y `media-src` solo admiten el origen propio, y además
  `worker-src 'none'`, `base-uri 'none'`, `form-action 'none'` y `frame-ancestors` sin `localhost:1420` en el binario
  congelado. `Access-Control-Allow-Origin: null` solo para `Origin: null`, nunca `*`.
- **`frame-src` y `postMessage`.** `tauri.conf.json:24-25` lista exactamente `http://127.0.0.1:47810–47813`, en `csp` y
  en `devCsp`. `Preview.tsx` y `previewProtocolo.ts` no cambian desde la R2 (comprobado con `git diff 637ce31..HEAD`): el
  iframe sigue con `sandbox="allow-scripts"` exacto y la validación de `e.source`/`e.origin === "null"` por esquema sigue
  igual.
- **Bandeja.** El arreglo de R2-1 (`9d37e29`) es correcto: `<estado>/video/bandeja` es la misma carpeta en Rust, Python y
  Node, con la misma precedencia de `APP_BACKEND_DIR`. El id cumple `^[0-9a-f]{32}$` en las tres capas y se genera con
  128 bits de un CSPRNG. Es de un solo uso: `rename` atómico a `.uso-<hex>` y borrado en el `finally`. Rust hace sus
  comprobaciones sobre el handle (reparse point, directorio, `nlink`, tamaño, `create_new`) y Node, sobre el `fd`. El
  tipo se detecta por los primeros bytes y los límites se aplican antes de decodificar. El nombre original es solo texto
  (`nombreRecursoSeguro`, y `recurso_seguro` lo vuelve a filtrar), nunca ruta ni argumento. `borrarArbol` y `_borrar` no
  atraviesan junctions.
- **Entorno de los hijos (I5).** El backend congelado solo pasa `VIDEO_E2E`, `VIDEO_PRUEBAS_TTS_URL` y un `FFMPEG_DIR`
  ajeno con `not config.FROZEN` (`video.py:542-550`); congelado, `FFMPEG_DIR` es siempre el del bundle. No hay otra vía:
  el binario congelado no carga `.env` ni el motor integrado tampoco (`config.ts:12`), `APP_BACKEND_VIDEO_CMD` es solo de
  desarrollo y `tts.ts:14-27` sigue limitando la URL de pruebas a `http://127.0.0.1:<puerto>` con `VIDEO_E2E=1`.
  `entornoHijo` construye el entorno desde cero: el `PATH` es solo el ffmpeg del bundle, `System32` y PowerShell, nunca
  el `PATH` del usuario, y la clave de ElevenLabs no llega. Solo hay dos `spawn` (`proceso.ts:346`, `taskkill` por ruta
  absoluta, y `:490`). Pendiente de comprobar en ejecución: `mcp.client.stdio.get_default_environment()`, porque el venv
  no estaba en este worktree.
- **ffmpeg LGPL propio.** Build sin red, solo con los protocolos `file pipe fd`; SHA-256 fijado y verificado al empaquetar.
  `revisarCarpetaFfmpeg` rechaza ficheros extra, enlaces simbólicos y enlaces duros (con la salvedad de A27-2). En el
  flujo de la app, `-max_pixels` va antes de `-i`: foto, 40 Mpx con un 1,3 % de holgura justificada; clip y música,
  4096², también en ffprobe, con test.

## Heredados que siguen abiertos (sin cambios en esta rama)

De `R2-fase1.md` → «Estado de los heredados» y «Condiciones para `VIDEO_ENGINE=1`»: R2-3 (prueba manual de IPC desde el
iframe), R2-4 / T12 Medium (WebRTC en la preview; sigue sin decisión escrita en la spec), R2-5 (CORS `localhost:1420` en
producción), T12 Low (mutex con el relanzamiento del updater), T13 M1 / L2 / L3, R0-2 (servidor de ficheros de
HyperFrames, residual aceptado) y el punto 7 de la R2 (respaldo `ELEVENLABS_API_KEY` del entorno en `config.py`).

## Veredicto para el piloto local con `VIDEO_ENGINE=1`

**Sin bloqueos nuevos de seguridad.** Los cinco Low son de robustez y de retención de datos, no abren una vía a A1–A4
dentro del alcance. Recomendado antes del piloto: A27-3 y A27-4, porque retienen copias privadas del usuario, y A27-2,
porque es requisito de W3.2. A27-1, A27-5 y A27-7 pueden ir después. El piloto sigue condicionado por los puntos 3–9 de
la R2 que no dependen de R2-1 y R2-2 (estos dos están arreglados en código; falta la prueba con Rust real del punto 1 en
la app instalada).

## Estado de las correcciones

| ID | Estado | Qué se ha hecho | Test |
|---|---|---|---|
| A27-1 | Corregido | `sondear` lleva siempre `-max_pixels` (por defecto `MAX_PIXELES` = 8192², `proceso.ts`), así que lo llevan las llamadas del flujo heredado de `herramientas.ts`, `render.ts`, `musica.ts` y `voz.ts`. `normalizarVoz` y `prepararMusica` pasan `-max_pixels` a ffmpeg. `hyperframes audio` no admite opciones de entrada: sigue protegido por el `sondear` previo, que con `argsEntrada` rechaza la ruta, el protocolo o el formato ajenos. | suites del motor |
| A27-2 | Corregido | `exigirCarpetaFfmpeg` (`proceso.ts`) revisa la carpeta del ffmpeg o el ffprobe dentro de `lanzarUno`, justo antes del `spawn`, en el modo integrado; si sobra un fichero, la llamada falla con el mensaje de «falta ffmpeg» y el motivo. | `carpeta-ffmpeg.test.ts` |
| A27-3 | Corregido | El motor barre, además de los `.uso-*`, los `.bin` y `.parcial` de más de una hora (nunca la entrada que se está importando). Si la importación falla antes de reclamar la entrada (proyecto inexistente, clase inválida), la entrada se retira. Rust copia a `<id>.parcial` y la renombra a `.bin` al terminar. | `recursos.test.ts`, `lib.rs` (`la_bandeja_no_deja_parciales…`) |
| A27-4 | Corregido | `barrer_papeleras` (`video_rest.py`) vacía las `.borrando-video###-<8hex>` al arrancar el backend (lifespan) y antes de cada borrado. Solo toca hijas directas con el nombre exacto, y sin seguir enlaces. | `test_borrar_barre_papeleras…` |
| A27-5 | Corregido | `_lista` filtra cada resumen por id con su patrón y deja solo los campos de `types.ts`, con escalares acotados. Crear guion, crear proyecto y guardar proyecto devuelven solo `id` o `revision` y los avisos filtrados (`_avisos_documento`). Leer guion devuelve `{guion, avisos}` y perfiles, solo los que tienen id válido. El motor falso de los tests devuelve ya la forma real de `video_guion_leer`, y la frase de la R2 está corregida. | `test_salida_del_motor_filtrada…` |
| A27-6 | Abierto (propuesta) | Tope de gasto y nonce de un solo uso: queda para la fase 2. | — |
| A27-7 | Abierto (propuesta) | No se ha tocado. | — |
| A27-8 | Corregido en parte | **Bandeja:** Rust rechaza la bandeja o su carpeta `video` si es un enlace o una junction. **Estado:** `APP_BACKEND_DIR` y `LOCALAPPDATA` relativos se ignoran, con la misma regla en `config.py` y `lib.rs`; el estado nunca es relativo, y queda documentado que `APP_BACKEND_DIR` es solo para desarrollo y que no lleva ACL propia. **cwd:** los hijos sin cwd propio arrancan en `hf-home`. **LEEME:** protocolos `file pipe fd` y ningún `PENDIENTE-TAREA-10`, comprobado con `comprobar-pendientes.sh`. **Frase del ffmpeg ajeno:** un test del backend vigila que siga en `render.ts`; un `codigo` propio exigiría tipar los errores de render, y no compensa para una falla que ya es visible. **Sin cambios:** `FFMPEG_DIR` en el motor integrado, porque el backend congelado fija siempre el del bundle y los E2E necesitan otro; y el SHA de ffmpeg en ejecución, por la decisión de I4. | `dir_estado_sigue_a_config_py`, `test_frase_del_ffmpeg_ajeno…` |

