# T7 · Pendientes (2026-11-10)

Lo que T7 deja sin hacer, con el motivo y quién lo cierra. Nada de esto se ha falseado: los tests que lo cubrirían están
escritos y marcados `skip` con el motivo, o no se pueden escribir todavía.

## Necesitan un Chrome verificado (no se ejecuta ninguno desde esta rama)

Marc aún no ha decidido si descarga el Chrome for Testing 156 y no hay un binario con SHA-256 verificado contra un valor fijado.
No se ha lanzado ningún Chrome, Chromium ni Edge, ni la caché de HyperFrames o de puppeteer, ni el zip local de la 152.

- **`capa_foto_seek_y_render`** y **`capa_clip_seek_y_render`** (`test/piezas-capas.test.ts`, `it.skip` con el motivo
  «falta Chrome verificado»). Cuando haya navegador: seek de la preview contra render con `scripts/comparar-fotogramas.mjs`
  (SSIM ≥ 0,99, por mínimo de fotogramas) para los tres encuadres de foto y para un clip vertical y uno horizontal. Se
  ejecutan con `VIDEO_ENGINE_DIR` y `W2_REFS`; las referencias SSIM congeladas (`w2refs`) no se tocan.
- **`hyperframes check` de `capa-foto.html` y `capa-clip.html`.** Ejecutado solo en el `ejecutarPieza` de los tests (DOM
  falso, sin navegador): confirma que cada pieza usa `HF.contexto`, solo anima con `tween`, no lleva `innerHTML` ni lee
  tiempos del DOM. El `check` real (reglas de HyperFrames sobre `<video>`, pistas y capas) necesita el navegador.
- **Pista del modo «detrás».** El host va en `z-index: 10` (el del fondo, que está antes en el DOM) con `data-track-index="9"`
  para no solapar pista con el fondo. Si `check` o el render dan problemas con ese orden, la alternativa es subir el fondo a
  z 8 (cambia `anadirPieza` del fondo, sin efecto en píxeles). Hay que mirarlo con el primer render real.
- **El `<video>` de la capa dentro de una subcomposición.** HyperFrames gobierna el `<video>` por `data-start` y
  `data-duration`. La preview del backend (T10) sirve la composición por HTTP: confirmar con un clip real que el seek del
  WebView2 cae en el fotograma (el clip se normaliza a CFR para que así sea, pero no se ha visto en un navegador).

## Depende de otras tareas

- **T13 (comando nativo).** Es quien escribe `<estado>/video/bandeja/<32hex>.bin` y quien pasa el nombre del archivo por
  `nombre_original` (el motor lo recorta, lo pasa por `textoSeguro` y lo guarda solo como texto de UI). El motor consume la
  entrada **una sola vez** en cuanto empieza a abrirla (también si falla después); si el error es de validación previa (proyecto o clase
  inválidos) no la abre y sigue en la bandeja. Quita cualquier enlace que encuentre en ella y limpia los `.uso-*` huérfanos de más de una hora; la limpieza de entradas
  que nadie consume nunca (la app murió entre el diálogo y la importación) es de T13.
- **Música en la composición.** T7 solo importa y lista (`video_musica_importar`, `video_musica_listar`, biblioteca
  `<estado>/video/musica/m-<16hex>.m4a` + `.json`). El montaje de T6 no mezcla todavía `proyecto.musica` (la pista, su
  volumen y el ducking): falta convertir el M4A a `assets/musica.wav` (`prepararMusica` ya lo hace por extensión) y
  resolver `pistaId` contra la biblioteca. No estaba en el alcance de T7.
- **Mensaje de `sin_codificador` y de límites en la UI.** El motor los da como `esquema` con el código del problema
  (`limite_excedido`, `formato_no_admitido`, `clase_distinta`, `sin_codificador`, `archivo_danado`, `sin_video`,
  `sin_audio`, `bandeja_id_invalido`, `enlace_no_permitido`); T11 los lleva a 422 con `{ ruta, codigo }`, y falta que la UI
  (T15) les ponga texto. `demasiado_grande` ya es 413.

## Límites conocidos (documentados, sin arreglo en T7)

- **N-1 (Media): cerrado** en la Revisión 3 de `seguridad-T7.md` (`-max_pixels` también en ffprobe y en el ffmpeg de la música).
  Quedan dos informativas: N-7 (un clip por encima del tope puede dar «no tiene vídeo» en lugar del error de límite) y N-8
  (`musica.ts` sondea la biblioteca sin tope; es anterior a T7, se arregla con una línea).
- **N-3 (Baja, abierto).** Un clip que falle en el decodificador (`archivo_danado`) prueba los cuatro codificadores: hasta 4 × 240 s,
  más que los 420 s del backend. Falta un plazo total en `importarA`.

- **ffprobe decodifica a veces.** El tamaño de las fotos se lee de la cabecera (PNG, JPEG, WebP) antes de lanzar nada; en los
  clips, ffprobe sondea el contenedor y puede decodificar algún fotograma para fijar parámetros. No hay un tope de memoria del
  proceso hijo: solo el tiempo (30 s) y los límites de tamaño de fichero. Acotarlo de verdad pediría un job object de Windows
  (`CreateJobObject` con límite de memoria); no está asignado a ninguna tarea todavía.
- **JPEG real no se genera en los tests.** El ffmpeg LGPL del bundle no trae `mjpeg`; el lector de cabecera JPEG se prueba con
  cabeceras escritas a mano (SOF de 20000×20000) y la importación real, con PNG. Un JPEG de verdad lo comprobará Marc a mano.
- **Disco.** Importar un clip de 500 MB copia el fichero a una carpeta de trabajo `.imp-*` y escribe el MP4; si el disco no
  cabe, ffmpeg falla (`archivo_danado`) y la carpeta se borra. Las carpetas `.imp-*` de más de una hora se limpian al empezar
  otra importación.
- **Formato de salida de la foto.** Siempre PNG (con transparencia si la tenía): una foto de 12 Mpx pesa varios MB. Si pesa
  demasiado para el proyecto, la decisión es de producto (sin verificar si el ffmpeg del bundle trae un codificador WebP: en `componentes.conf` solo se vio como demuxer, decodificador y parser).
