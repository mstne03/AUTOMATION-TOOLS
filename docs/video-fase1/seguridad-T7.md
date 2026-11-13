# T7 · Revisión de seguridad — Revisión 1

**Fecha:** 2026-11-11 · **Alcance:** diff de la Tarea 7 «Recursos normalizados y capas» (`recursos.ts` nuevo, `composicion.ts`,
`montaje.ts`, `paths.ts`, `proceso.ts`, `proyecto.ts`, `esquema.ts`, `herramientas-proyecto.ts`, `capa-foto.html`,
`capa-clip.html`, `app_backend/video_rest.py` y sus tests). Revisión solo de lectura; no se ha lanzado ningún navegador.

**Modelo de amenaza.** El archivo importado (foto, clip o música) y su nombre son entrada no confiable: llegan de cualquier
sitio (un correo, una descarga). La salida del modelo también lo es. El atacante «local del mismo usuario» (otro proceso que
puede escribir en `<estado>` o en `VIDEO_ROOT`) se considera, con menos peso, como en T6.

## Recuento

| Severidad | Nº | IDs |
|---|---|---|
| Crítica | 0 | — |
| Alta | 0 | — |
| Media | 2 | M-1, M-2 |
| Baja | 5 | L-1 … L-5 |

## Hallazgos

### M-1 · Media · Los límites de píxeles no acotan al decodificador (bombas de memoria que esquivan I15)

**Dónde.** `video-mcp-server/src/recursos.ts:83-111` (`dimensionesImagen`), `:215-223` (`normalizarFoto`), `:231-254`
(`normalizarClip`); `proceso.ts:1005-1011` (`argsEntrada`).

**Qué pasa.** El tope de lado y de megapíxeles se comprueba contra lo que *declara* el contenedor (cabecera de la foto o
`ffprobe` del clip), pero ffmpeg decodifica con lo que dice el *bitstream*, y no hay nada que se lo impida:

- **WebP VP8X.** Se leen el ancho y el alto del lienzo de `VP8X` (`:88`). El decodificador de ffmpeg usa los del trozo
  `VP8 `/`VP8L` interior, que puede ser mayor (VP8L admite hasta 16384×16384). Una foto de pocos KB con lienzo 100×100 y un
  `VP8L` de 16384×16384 pasa el filtro y pide al decodificador ~1 GB por fotograma (y más con el `scale` posterior).
- **JPEG con varios SOF.** El lector devuelve el **primer** SOF (`:105`). Un JPEG con `SOF0` de 100×100 seguido de otro SOF
  de 65535×65535 antes del SOS hace que el decodificador `mjpeg` (si el build lo trae) reconfigure al segundo tamaño.
- **Clip con códec de imagen o cambio de resolución.** El `mov`/`matroska` puede llevar cualquier códec que el build decodifique
  (PNG, MJPEG, ProRes, etc.). `ffprobe` informa del tamaño del `stsd`/primer SPS; cada fotograma PNG trae su propio IHDR, y un
  H.264 puede cambiar de SPS a mitad. El filtro de 4096 px (`:237`) no se aplica a esos fotogramas.

El único tope real es el tiempo (30 s de ffprobe, 5 min de ffmpeg); `pendientes-T7.md` reconoce que no hay límite de memoria del
hijo. En una máquina de 32 GB, un par de importaciones así pueden dejar el equipo sin memoria (paginación, cierre de otras
aplicaciones) antes de que salte el plazo.

**Escenario.** El usuario recibe «foto.webp» (40 KB) y la importa como foto: pasa `identificarMedio`, la cabecera dice 100×100,
se lanza ffmpeg y reserva más de 1 GB; con un clip MP4 de fotogramas PNG de 30000×30000, varios GB por fotograma.

**Arreglo propuesto.**
1. Añadir a las opciones de entrada de **ffmpeg y ffprobe** sobre ficheros del usuario el tope del decodificador
   `-max_pixels <n>` (opción de `AVCodecContext`; rechaza cualquier fotograma mayor, la declare o no el contenedor):
   40 000 000 para foto y 4096×4096 = 16 777 216 para clip. Lo natural es que `argsEntrada` acepte un `maxPixeles`.
2. Restringir los decodificadores con `-codec_whitelist` por clase (foto: `png,mjpeg,webp`; clip: `h264,hevc,vp8,vp9,av1,mpeg4`;
   música: `aac,mp3,mp3float,flac,vorbis,opus,pcm_s16le,pcm_s24le,pcm_f32le`), igual que ya se hace con `-format_whitelist`.
3. En `dimensionesImagen`: para `VP8X`, recorrer los trozos hasta el `VP8 `/`VP8L` y exigir que sus medidas no superen el lienzo
   (y rechazar `ANIM`); para JPEG, seguir hasta el SOS y rechazar si hay más de un SOF o tomar el mayor.
4. Test negativo: WebP con lienzo pequeño y VP8L grande, y JPEG con dos SOF, rechazados sin lanzar ffmpeg o con ffmpeg fallando
   por `max_pixels`.

### M-2 · Media · Un clip lento consume hasta 4 × 5 min y el backend se rinde antes: el recurso aparece después del error

**Dónde.** `video-mcp-server/src/recursos.ts:209-213`, `:248-266` (el `catch` de `:261` trata `tiempo_excedido` como fallo del
codificador); `app-backend/app_backend/video_rest.py:19` (`TIMEOUT_RECURSO = 420.0`) y `:1038-1041`.

**Qué pasa.** Cada candidato de `ordenSegundaPasada` (hasta `h264_nvenc`, `h264_qsv`, `h264_amf`, `h264_mf`) tiene su propio
plazo de 5 min, y un `tiempo_excedido` hace probar el siguiente. Si lo lento es **decodificar** el clip (que es lo que controla
el atacante), cambiar de codificador no ayuda: son ~20 min de CPU y GPU por importación. El backend corta a los 420 s (503,
«trabajo en curso», el motor no se reinicia porque la llamada es `protegida`), suelta `cerrojo_de(id)` y la UI muestra el error;
el motor sigue y, si al final codifica, ejecuta `proyectoCambiarRecursos` y sube la revisión sin que nadie lo espere. La entrada
de la bandeja ya se consumió, así que el reintento del usuario da `no_encontrado`, y el siguiente `PUT` de la UI da `conflicto`.

**Escenario.** Un MKV de 60 s a 4096×4096 y 60 fps con un códec de decodificación costosa (dentro de los límites de I15):
cuatro intentos de 5 min, el equipo ocupado 20 min, la UI con un error y un recurso «fantasma» que aparece al rato.

**Arreglo propuesto.** Un plazo total para `importarA` inferior a `TIMEOUT_RECURSO` (p. ej. 360 s), repartido entre los pasos
(`timeoutMs` = lo que quede), y no reintentar con otro codificador cuando el fallo fue `tiempo_excedido` (solo con
`archivo_danado` del codificador). Opcional: si el plazo total vence, no publicar aunque ffmpeg acabe. Test con
`deps.candidatos` que simule el timeout del primero y compruebe que no se prueba el segundo.

### L-1 · Baja · La entrada de la bandeja no se consume en todos los fallos

**Dónde.** `video-mcp-server/src/recursos.ts:388` (`proyectoLeer` antes de reclamar), `:333` (clase inválida antes de reclamar),
`:159-164` (un `rename` que falla con `EBUSY`/`EPERM` deja el `.bin`); `test/recursos.test.ts:390-396` no lo comprueba.

**Qué pasa.** `pendientes-T7.md` afirma que el motor consume la entrada «una sola vez (también si falla)», pero un proyecto
inexistente o inválido y una clase fuera de lista fallan **antes** de `reclamarBandeja`, y un `rename` bloqueado (antivirus,
indexador) relanza sin quitar el fichero. La entrada sigue ahí, reutilizable con otro `id` de proyecto, y ocupa hasta 500 MB.

**Escenario.** La UI manda el `bandejaId` contra un proyecto recién borrado: error, y el clip del usuario queda en la bandeja hasta
que T13 limpie; una llamada posterior con otro proyecto lo importa sin que el usuario lo haya vuelto a elegir.

**Arreglo propuesto.** Validar solo el `bandejaId` y reclamar la entrada lo primero (o envolver `proyectoLeer` y la comprobación de
clase en un `try` que la quite); en el `catch` del `rename`, `quitar(origen)` también si no es `ENOENT`. En el test de `:390`,
`expect(enBandeja(b)).toBe(false)` tras cada fallo.

### L-2 · Baja · Los `.uso-*` huérfanos de la bandeja no los limpia nadie

**Dónde.** `video-mcp-server/src/recursos.ts:158-165` y `:363`.

**Qué pasa.** Si el motor muere entre el `rename` a `<id>.uso-<hex>` y el `finally` (cierre de la app, reinicio del motor por otro
timeout, apagado), el fichero queda con un nombre que ni el motor ni la limpieza prevista en T13 (que busca `.bin`) reconocen.
Hasta 500 MB por importación, indefinidamente; solo disco, sin lectura posible.

**Arreglo propuesto.** Al empezar `reclamarBandeja`, borrar los `*.uso-*` con más de una hora (como `limpiarRestos` con `.imp-*`),
sin seguir enlaces; o dejar documentado en T13 que su limpieza incluya ese patrón.

### L-3 · Baja · La capa se comprueba con `comprobarRecurso` y se copia con `copyFileSync` (TOCTOU)

**Dónde.** `video-mcp-server/src/montaje.ts:98-106` (`resolverCapa`) y `src/composicion.ts:841-846` (`escribirPlan`).

**Qué pasa.** Entre el `lstat` de `resolverCapa` y el `fs.copyFileSync` del plan (que sigue enlaces) hay una ventana en la que
otro proceso del mismo usuario puede cambiar `recursos/r-….mp4` por un enlace o un hardlink a otro fichero, que entraría en
`assets/` de la composición y lo servirían la preview y el render. Mismo patrón que ya tienen las imágenes de escena.

**Arreglo propuesto.** Para las copias de capas (y fondo), `copiarRecurso(origen, destino, LIMITES_MEDIO[clase].bytes)`, que abre
una sola vez y compara `dev`/`ino`/`nlink` contra el descriptor.

### L-4 · Baja · El render decodifica el clip con el ffmpeg de HyperFrames, fuera de `ejecutar`

**Dónde.** `node_modules/hyperframes/dist/chunk-L5MFWGGU.js:14418` (`extractVideoFramesRange`), alcanzado por el `<video>` de
`capa-clip.html`; ruta fijada por `HYPERFRAMES_FFMPEG_PATH` (`src/proceso.ts:159-160`).

**Qué pasa.** Es nuevo en T7 (antes no había `<video>` en la composición): el binario es el del bundle, pero el proceso no lleva
el plazo ni el `-protocol_whitelist` de `ejecutar`. El riesgo es residual porque la entrada es el MP4 que produjo nuestro ffmpeg y
`verificarClip` lo comprueba (H.264, sin audio, ≤ 60 s), no los bytes del usuario.

**Arreglo propuesto.** Ninguno de código ahora; dejarlo escrito en el informe de la fase como superficie aceptada, y que el barrido
de huérfanos de T6 (`video_barrer_procesos`) cubra también ese ffmpeg (por ruta de imagen ya debería).

### L-5 · Baja · `borrarRecurso` borra sin comprobar que `recursos/` no es un enlace

**Dónde.** `video-mcp-server/src/recursos.ts:412-415`.

**Qué pasa.** `carpetaVideo` valida la carpeta del proyecto, pero no la subcarpeta `recursos/`. Si un proceso local la cambia por
una junction, el borrado actúa sobre `r-<16hex>.<ext>` y `r-<16hex>.fondo.png` en el destino. El impacto es mínimo (nombres
aleatorios que tendrían que existir allí), pero la importación sí lo comprueba (`carpetaDeSalida`) y aquí no.

**Arreglo propuesto.** `if (!sinEnlace(dir)) throw …` antes del bucle, como en `musicaListar`.

## Verificado sin hallazgos

1. **Identificación por bytes.** `identificarMedio` usa solo firmas (PNG, JPEG, RIFF/WEBP/WAVE, `ftyp`, EBML, `OggS`, `fLaC`,
   ID3/sincronía MP3); la extensión no interviene: el fichero de trabajo se llama siempre `entrada.bin`. HLS, `ffconcat`, scripts y
   texto no casan con ninguna firma y no se lanza ffmpeg (`mp4_que_es_hls_o_concat`).
2. **Límites de bytes y de cabecera antes de decodificar.** Tamaño en `reclamarBandeja` (`lstat`) y otra vez en `copiarRecurso`,
   con el tope aplicado también a lo leído (si el fichero crece). Foto: lado y megapíxeles de la cabecera antes de lanzar nada
   (`png_20000`, 8000×6000). Clip: lado, fps (máximo de `r_frame_rate` y `avg_frame_rate`) y duración de `ffprobe`; la salida se
   acota con `-t 61`, `-r ≤ 60` y CFR. Música: duración ≤ 15 min y `-t 901`. (El hueco de los decodificadores es M-1.)
3. **ffmpeg y ffprobe.** Todas las llamadas sobre `entrada.bin` llevan `-protocol_whitelist file`, `-format_whitelist <demuxer>` y
   `-f <demuxer>` del tipo detectado; van por `ejecutar` con plazo (30 s ffprobe, 5 min ffmpeg) y matan el árbol. `mov` no sigue
   referencias externas (`enable_drefs` vale 0 por defecto); `argsEntrada` rechaza UNC y esquemas. Las salidas propias se reabren
   con el demuxer de su extensión, que fija el motor.
4. **Bandeja.** `bandejaId` con `^[0-9a-f]{32}$` (y en el backend); la carpeta, sin enlaces en ningún tramo (`pasaPorEnlace`);
   enlace simbólico, hardlink (`nlink > 1`) y junction rechazados y solo se quita el nombre, nunca el destino; el `rename` a un
   nombre privado decide entre dos peticiones simultáneas (test de dos importaciones a la vez); `copiarRecurso` lee del descriptor
   y compara `dev`/`ino` y `nlink` (sin TOCTOU por cambio de nombre); el destino se crea con `wx`.
5. **Publicación atómica.** Todo el trabajo ocurre en `.imp-<hex>` dentro del destino y entra con `rename`; el `.json` de la pista
   con `escribirAtomico` (tmp + fsync + rename); `proyecto.json` con `escribirJson`. Si `proyectoCambiarRecursos` falla (tope de
   30, validación), se borran los ficheros publicados.
6. **Nombres.** Los ficheros se llaman por `r-<16hex>` / `m-<16hex>` generados con `randomBytes`; en la composición, `capa<n>.<ext>`.
   `nombreOriginal` pasa por `nombreRecursoSeguro` (último tramo, sin `:` ni `..`, `textoSeguro`, ≤ 120) y no aparece en ningún
   fichero de la composición (`nombre_original_con_html`); el backend lo vuelve a filtrar (`_NOMBRE_PELIGROSO`). Ninguna tool
   `video_*` entra en `registry.build()` (PLAN, línea 18), así que el nombre no llega al modelo como texto de una tool.
7. **Piezas y composición.** `capa-foto.html` y `capa-clip.html` sin `innerHTML`; `{{DATOS}}` con `jsonParaScript` (escapa `<`, `>`,
   `&`, U+2028/9 y rechaza no finitos); `{{MEDIO}}` escapado y derivado del índice; `{{FONDO_HTML}}` construido por el motor;
   `capaDe` valida clase, modo, encuadre, extensión por clase, `detras` solo sobre escena con fondo y números finitos. `escribirPlan`
   no escribe fuera del destino. Los campos de la capa que controla el modelo (vía `proyectoGuardar`) son enums y números.
8. **Borrar en uso y rollback.** `en_uso` se decide dentro del callback síncrono de `proyectoCambiarRecursos`, sin carreras con
   `proyectoGuardar` en el mismo proceso; el backend serializa por proyecto con `cerrojo_de(id)` (importar, borrar y PUT).
   `resolverCapa` falla visible si el recurso ya no está, no es foto/clip o su `ext` no es la normalizada.
9. **`?hf-proxy`.** `montarProyecto` escribe `hyperframes.json` con `media.autoProxy: false`. En HyperFrames 0.8.206,
   `resolveAutoProxy` (`chunk-WHD5IAHI.js:95-100`) lee ese valor cuando no hay bandera; `serveProxyRequest`
   (`chunk-2S263R6D.js:163-169`) responde 404 **antes** de `probeAssetCodec` si `autoProxy` es falso;
   `preResolveHostileMediaProxies` (`chunk-AJSU6KGS.js:482-484`) no hace nada; `check` además lleva `--no-proxy`
   (`render.ts:505`, `autoProxy: args.proxy`). La preview del backend (`preview.py`, `FileResponse`) ignora la query y no transcodifica.
10. **Backend.** `RecursoIn`/`MusicaIn` con `extra="forbid"`, patrón de `bandeja_id` y `max_length` del nombre; `TIMEOUT_RECURSO`
    con llamada `protegida`; errores traducidos a mensajes fijos por código (`en_uso` → 409, `demasiado_grande` → 413, `esquema`
    → 422 con `{ruta, codigo}` saneados), el detalle solo al log; `recurso_seguro` y `_pista_segura` descartan cualquier campo
    fuera del contrato (la `ruta` del simulador no llega a la UI).
11. **Tests.** `npx vitest run test/recursos.test.ts test/piezas-capas.test.ts`: 46 pasan y 2 `skip` (los de Chrome). Ojo: en esta
    máquina se ejecutaron con el ffmpeg *full build* de WinGet (el log lo avisa), no con el LGPL del bundle.

## Revisión 2 (re-revisión del diff de correcciones)

**Fecha:** 2026-11-11 · **Alcance:** solo el diff de las correcciones de la Revisión 1 (`composicion.ts`, `recursos.ts`,
`test/recursos.test.ts`, 162 líneas). Solo lectura; sin navegador. `npx vitest run test/recursos.test.ts`: 36 pasan (109 s, con
el ffmpeg 8.1 *full build* de WinGet, no el LGPL del bundle).

### Estado de los hallazgos

| ID | Estado | Comentario |
|---|---|---|
| M-1 | **Parcial** | Cerrado en el ffmpeg de foto y de clip (`-max_pixels` antes de `-i`, bien colocado: es opción de entrada y llega también a `avformat_find_stream_info`). Sigue abierto en `sondear` (ffprobe sobre el `entrada.bin` del clip y de la música) y en el ffmpeg de la música: ver N-1. No se hicieron `-codec_whitelist` ni el recorrido de `VP8X`/SOF en `dimensionesImagen` (defensa en profundidad; con `-max_pixels` dejan de ser imprescindibles en foto). |
| M-2 | **Parcial** | Ya no se reintenta tras `tiempo_excedido` y el plazo baja a 4 min, pero `archivo_danado` sigue reintentando con cada codificador sin distinguir un fallo del codificador de uno del decodificador: ver N-3. Falta el test pedido (timeout del primer candidato ⇒ no se prueba el segundo). |
| L-1 | Cerrado | `quitar(origen)` si el `rename` falla con algo distinto de `ENOENT`. Residuo aceptable: si el bloqueo (antivirus) impide también el `unlink`, la entrada sigue y el error se traga. La validación previa (proyecto, clase) no abre la entrada y `pendientes-T7.md` lo documenta así. Sin test del `rename` fallido. |
| L-2 | Cerrado | Los `.uso-*` de más de 1 h se limpian, solo ficheros normales (`Dirent.isFile()` no sigue enlaces) y con `unlink`. Matices en N-4. |
| L-3 | Cerrado | `escribirPlan` copia con `copiarRecurso` (lstat + un solo `open` + `dev`/`ino`/`nlink` contra el descriptor, destino `wx` tras `borrarArbol`). Efecto colateral en N-5. Sin test de la capa cambiada por un enlace. |
| L-4 | Riesgo aceptado | Sin cambios, como se decidió. |
| L-5 | Cerrado | `sinEnlace(recursos/)` antes del borrado; el test con junction comprueba que el destino queda intacto. Matiz de orden en N-6. |

### Hallazgos nuevos

**N-1 · Media · ffprobe y la música siguen sin `-max_pixels` (resto de M-1).** `sondear(h.ffprobe, entrada, …)` en
`normalizarClip` y `normalizarMusica`, y el ffmpeg de `normalizarMusica` (`recursos.ts:246`, `:303`, `:311`), abren el fichero del
usuario sin el tope. `avformat_find_stream_info` (en ffprobe y en ffmpeg) decodifica un fotograma de cada pista de vídeo para
conocer su `pix_fmt`: un MKV con varias pistas PNG/MJPEG enormes, o una música MP3/FLAC/M4A con carátula (pista *attached pic*)
gigante, reserva hasta el tope por defecto de `av_image_check_size2` (~2 GB por plano y fotograma) por cada pista, con el `-vn`
de la música o sin él. Es el escenario de M-1 trasladado al sondeo. **Arreglo:** que `argsEntrada` (o `sondear`) acepte
`maxPixeles` y lo emita como `-max_pixels` (ffprobe lo admite como opción de códec); para la música basta un tope pequeño
(p. ej. 4096²), porque solo se usa el audio. Test: el mismo de M-1 sobre los argumentos de ffprobe y de la música.

**N-2 · Baja · `-max_pixels` igual al límite rechaza fotos legítimas cerca de 40 Mpx.** `ff_get_buffer` comprueba
`FFALIGN(ancho, STRIDE_ALIGN) × alto ≤ max_pixels` (STRIDE_ALIGN = 64 en builds con AVX-512), no `ancho × alto`. Una foto de
7745×5164 (39,99 Mpx) pasa `dimensionesImagen`, pero 7808×5164 = 40,32 M supera `-max_pixels 40000000` y sale como
`archivo_danado` («no se pudo leer o convertir»), un mensaje engañoso. El margen es ≤ 63 × alto (~0,5 Mpx). El clip no se ve
afectado: 4096 es múltiplo de 64, así que `FFALIGN(w, 64) ≤ 4096` para todo `w ≤ 4096`. No verificado de forma empírica (haría
falta lanzar ffmpeg fuera del comando permitido). **Arreglo:** `-max_pixels` = `L.pixeles + 64 * L.lado` (sigue acotando a
~40,5 Mpx) y un test con un PNG de 7745×5164 generado con `lavfi`.

**N-3 · Baja · Los reintentos por `archivo_danado` reabren el hueco de M-2.** El `catch` de `normalizarClip` reintenta con el
siguiente codificador ante cualquier salida no nula de ffmpeg, que también da un fallo de **decodificación**. Un clip que decodifica
despacio casi 4 min y luego hace fallar ffmpeg (más de 2/3 de fotogramas erróneos, el `-max_error_rate` por defecto; y
`-max_pixels` da ahora un disparador fiable: un cambio de SPS/IHDR a un tamaño mayor en muchos fotogramas pequeños al final)
consume hasta 4 × 240 s = 16 min, por encima de los 420 s del backend: el mismo recurso «fantasma» de M-2. El comentario de
`TIMEOUT_CODIFICAR_MS` («el peor caso queda por debajo de 420 s») solo es cierto sin reintentos. **Arreglo:** plazo total en
`importarA` (el propuesto en M-2: ~360 s, con `timeoutMs` = lo que quede) o reintentar solo si el fallo fue rápido (p. ej. < 10 s,
lo típico de un codificador de hardware que no abre); y el test con `deps.candidatos` que falta.

**N-4 · Informativa · Matices de `limpiarUsosHuerfanos`.** (a) `rename` conserva el `mtime`, y si T13 escribe el `.bin` con
`CopyFile` también se conserva el del original del usuario: la «edad» que se mide es la del fichero, no la del `.uso`, así que un
`.uso` recién creado puede parecer de más de una hora. Dentro de un mismo motor no hay carrera, porque de `reclamarBandeja` a
`copiarRecurso` todo es síncrono (sin `await`) y, ya copiado, borrar el `.uso` no afecta (Windows permite el `unlink` con el
descriptor abierto). Entre dos motores sobre el mismo `<estado>` (un reinicio con el viejo aún vivo), uno puede borrar el `.uso`
del otro entre el `rename` y el `open`, y esa importación falla con `ENOENT`; sin impacto de seguridad. **Arreglo:**
`fs.utimesSync(uso, ahora, ahora)` tras el `rename`. (b) El `.` del regex no está escapado (`\.uso-`); solo estético. (c) El
`try` envuelve todo el bucle: un `statSync` que falla corta la limpieza del resto.

**N-5 · Informativa · `copiarRecurso` se aplica ahora a todas las copias del plan.** Además de las capas pasan por él las fuentes,
`hf-tiempo.js`, `shaders.iife.js`, el vendor de `three` desde `node_modules` y las imágenes de escena. Un `nlink ≠ 1` rompe el
montaje: hoy no ocurre (`video-mcp-server` usa npm, que copia), pero instalarlo con pnpm (enlaces duros al almacén) haría fallar
todo vídeo 3D. Las imágenes de escena que sean enlaces duros pasan a rechazarse, lo que es coherente con la política de recursos.
Conviene dejarlo escrito junto a `TOPE_COPIA_BYTES`, que además aplica 500 MB a todo en lugar del límite de cada clase
(aceptable: son salidas normalizadas o ficheros propios).

**N-6 · Informativa · En `borrarRecurso`, la comprobación va después de cambiar `proyecto.json`.** Si `recursos/` es un enlace
(o no existe: `pasaPorEnlace` lanza `ENOENT` y `sinEnlace` devuelve `false`), el recurso ya salió de `recursos` y la revisión subió,
pero la tool responde `enlace_no_permitido` y los ficheros quedan huérfanos. Falla cerrado, así que no es un hueco de seguridad,
pero el error contradice el estado. **Arreglo:** comprobar antes de `proyectoCambiarRecursos` y tratar la ausencia de la carpeta
como «nada que borrar». La ventana entre la comprobación y `borrarArbol` (atacante local del mismo usuario) se acepta como en T6.

### Tests nuevos

- *M-1 (argumentos)*: comprueba de verdad el valor y que va antes de `-i`, en foto y en clip. *M-1 (ffmpeg)*: prueba que el
  binario respeta `-max_pixels`, no un fichero con cabecera y *bitstream* distintos; vale como garantía de la opción.
- *L-2*: prueba el borrado por edad y que respeta uno reciente; no cubre N-4 (a).
- *L-5*: correcto (junction, destino intacto, quita solo la junction).
- Faltan los de M-2 (sin reintento tras un timeout), L-1 (`rename` fallido) y L-3 (capa cambiada por un enlace).

### Veredicto

Ningún hallazgo crítico ni alto. **M-1 y M-2 quedan parciales**: N-1 (Media) es el resto de M-1 y conviene cerrarlo antes de dar
T7 por buena; N-3 (Baja) es el resto de M-2. N-2 es una regresión menor con un arreglo trivial. L-1, L-2, L-3 y L-5, cerrados.

## Revisión 3 (re-revisión del diff de N-1)

**Fecha:** 2026-11-11 · **Alcance:** solo el diff que cierra N-1 (`proceso.ts` `sondear`, `recursos.ts` clip y música,
`test/recursos.test.ts`, 106 líneas). Sin navegador ni binarios nuevos; el comportamiento de ffmpeg/ffprobe se razona sobre su
código (`ff_get_buffer`, `ff_set_dimensions`, `avformat_find_stream_info`) y la observación de `-max_pixels` en ffprobe que aporta
quien corrige. `npx vitest run test/recursos.test.ts`: **37 pasan** (105 s, ffmpeg 8.1 *full build* de WinGet).

### Estado de N-1: **Cerrado**

- **ffprobe** del `entrada.bin` del clip y de la música: `-max_pixels 16777216` (4096²) antes de `argsEntrada` y del fichero. En
  ffprobe es opción genérica de códec: va a `codec_opts`, que se aplica en `avformat_find_stream_info` (el único punto donde
  ffprobe decodifica con `-show_format -show_streams`; sin `-show_frames`/`-count_frames` no decodifica más). Toda pista de vídeo,
  carátulas *attached pic* incluidas, queda acotada.
- **ffmpeg de la música**: `-max_pixels` antes de `-i`, igual que en foto y clip (opción de entrada que también llega a
  `avformat_find_stream_info`). Con `-vn -map 0:a:0` la carátula no tiene decodificador después del sondeo, así que el único
  decodificado es ese y queda acotado.
- **M-1 pasa a Cerrado** en todo el camino de importación (foto, clip, música; ffprobe y ffmpeg). El segundo `sondear` de cada
  rama (sobre la salida propia) sigue sin tope, y es correcto: es un PNG/MP4/M4A que generó el motor con las dimensiones ya acotadas.

### `-max_pixels` en ffprobe: sale con 0 aunque rechace

Que ffprobe imprima el error y salga con 0 es lo esperado: el fallo de decodificación dentro de `avformat_find_stream_info` no es
fatal, solo deja la pista sin parámetros. Como `sondear` sin `soloMp4` ignora `stderr`, el efecto se reduce a lo que acabe en el
JSON:

- **¿Un hostil pasa como válido?** No. (a) Si la cabecera declara un tamaño > 4096 de lado, `ancho`/`alto` lo reflejan y el límite
  de lado lo rechaza. (b) Si ffprobe no llega a conocer el tamaño (`width` ausente o 0), `normalizarClip` responde `sin_video`. (c) Si
  la cabecera miente (pequeña) y el *bitstream* es grande, pasa el sondeo, pero el ffmpeg de normalización lleva el mismo tope y el
  decodificador rechaza cada fotograma (`archivo_danado`, o fotogramas descartados con salida acotada). En todos los casos el
  resultado se valida después con `verificarClip` / el `sondear` de la salida, que es fichero propio. La memoria queda acotada en
  todos.
- **¿Cambia la duración?** No: sale de `format.duration` y de la pista (contenedor), no de decodificar.
- **¿Cambia el tamaño de un clip legítimo?** No: el clip ya exige ≤ 4096 por lado, luego `ancho × alto ≤ 4096²`; y como 4096 es
  múltiplo de 64, `FFALIGN(ancho, 64) × alto ≤ 4096²` también (el matiz de N-2 no aplica al clip). Una pista secundaria de vídeo
  mayor que el tope solo pierde sus parámetros; `sondear` toma la primera y ffmpeg mapea `0:v:0`.
- **Música:** sin carátula no hay pista de vídeo y el tope no actúa. Con carátula ≤ 4096² decodifica igual que antes. Con carátula
  mayor (rara, pero existen de 5000² o más), ffprobe sale con 0 y `normalizarMusica` solo mira `pistasAudio` y la duración, y el
  ffmpeg falla el decodificado de la carátula dentro del sondeo sin abortar (aviso de parámetros no encontrados, código 0): la pista
  se importa igual, sin su carátula, que se descartaba de todos modos. No verificado de forma empírica con una carátula > 4096²
  (haría falta lanzar ffmpeg fuera del comando permitido).

### Test

El test nuevo observa `spawn` (el `ejecutar` interno de `sondear` no pasa por el espía del módulo) y exige `-max_pixels` con el
valor exacto y antes del primer `-f` (el de `argsEntrada`, es decir, antes de la entrada) en el ffprobe del clip, el de la música y
el ffmpeg de la música. Sin la corrección la búsqueda de `-max_pixels` da −1 y falla; si el `spawn` real no se interceptara, los
`expect(...).toBeDefined()` fallarían en lugar de dar un falso verde. Correcto.

### Hallazgos nuevos

**N-7 · Informativa · Un clip mayor que el tope puede salir como «El archivo no tiene vídeo.»** Antes del diff, un clip de 8K
llegaba con `width`/`height` y se rechazaba con `límite` («más de 4096 píxeles de lado»). Ahora, si el decodificador rechaza el
tamaño en `ff_set_dimensions` antes de que ffprobe lo exporte (según demuxer y códec), la pista sale sin dimensiones y el error es
`sin_video`, que no describe el problema. Falla cerrado; solo es el mensaje. No verificado empíricamente. **Arreglo:** en
`normalizarClip`, si `pistasVideo > 0` y falta `ancho`/`alto`, responder un límite («más de 4096 píxeles de lado o archivo dañado»)
en vez de `sin_video`; test con un MKV/MP4 de 4097×16 generado con `lavfi`.

**N-8 · Informativa · `sondear` de la biblioteca de música sigue sin tope (fuera del alcance de T7).** `musica.ts:163` sondea cada
pista de la carpeta de música sin `maxPixeles`. Es anterior a T7, la carpeta la elige el usuario y no es el camino de importación
de I15, así que no reabre N-1; pero ahora el arreglo es una línea (`{ maxPixeles: LIMITES_MEDIO.clip.lado ** 2 }`) y cierra la misma
clase de bomba de carátula también ahí.

### Sin regresiones

- La firma de `sondear` es compatible (parámetro opcional); el resto de llamadas no cambia de comportamiento.
- `-max_pixels` va antes de `argsEntrada`: no altera `-protocol_whitelist`, `-format_whitelist` ni `-f`.
- `maxPixeles: 0` o ausente no emite la opción (comprobación por valor *falsy*); ningún sitio pasa 0.

### Veredicto

**N-1 cerrado, y con él M-1.** Sin hallazgos críticos, altos, medios ni bajos nuevos; N-7 y N-8 son informativos. Siguen abiertos,
ya conocidos, N-3 (plazo total en los reintentos) y L-4 (riesgo aceptado).
