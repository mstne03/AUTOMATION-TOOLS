# Spec: módulo «Vídeo» — HyperFrames + ElevenLabs (2026-10-27)

Que cualquier creador, de cualquier temática, pase de un guion escrito en SEO Studio a un MP4
vertical listo para subir, con voz generada por ElevenLabs y escenas animadas por HyperFrames, y
que pueda retocar el resultado a mano en un editor de línea de tiempo sin depender al 100 % de
lo que se genera solo.

Punto de partida: el servidor MCP «footy» (`C:\Users\Marc\Downloads\footy-mcp-server\hyper-frames-mcp-server`,
TypeScript, 12 tools, probado) que hoy hace shorts de fútbol de 6 bloques fijos para un canal.
Este documento describe cómo se generaliza y se integra como módulo del producto. Rama base:
`ds/v1`.

## Resumen en seis líneas

1. **Motor:** footy se generaliza (sin fútbol ni marca «footy» en el núcleo) y pasa de 6 bloques
   fijos a una **línea de tiempo de escenas** de duración variable.
2. **Integración:** el motor corre como **proceso hijo MCP por stdio** del backend; un adaptador
   en `registry.py` lo trata como un servidor más.
3. **Guiones:** nuevo formato de salida «vídeo» que devuelve escenas (no bloques), se guarda en
   disco y abre el editor con «Crear vídeo».
4. **Editor:** pantalla nueva con preview real de la composición, panel lateral con pestañas y
   timeline de cinco pistas; render a MP4 como job.
5. **Perfil visual:** identidad del canal (paleta, fuentes, voz, música, subtítulos…) como datos;
   mínimo en la fase 1, importación desde YouTube y asistente IA en la fase 3.
6. **Empaquetado:** Node y ffmpeg (build LGPL) van dentro del instalador; Chrome for Testing se
   descarga en el primer uso con versión y SHA-256 fijados (decisión del 2026-10-29).

## Por qué

- El creador ya escribe el guion en SEO Studio informado por la KB y por su propio canal; hoy
  ese guion muere en el portapapeles. Producir el vídeo cierra el ciclo dentro del producto.
- Footy demostró que el pipeline guion → voz con alineación → composición HTML → render funciona,
  pero está atado a un canal (fútbol), a un formato (6 bloques, ≤ 650 caracteres) y a un
  operador técnico (carpetas `footyNNN`, `.env`). El producto lo necesita genérico y con UI.
- La retención en Shorts depende de cortes cada 2–4 s y de una estructura gancho → giro →
  remate → bucle; 6 bloques fijos no dan ese ritmo.

## Objetivos

- **G1 · 100 % adaptable a cualquier canal y tema (criterio de aceptación).** Nada específico
  de una temática en el motor, en los nombres ni en los prompts. Un mismo build produce un
  short de fútbol, de cocina o de divulgación cambiando solo guion, recursos y perfil visual.
- **G2.** Guion en modo vídeo desde la pantalla Guiones, usando la KB (pública y privada) y los
  datos del canal del usuario como conocimiento, editable antes de crear el vídeo.
- **G3.** Editor de línea de tiempo que permite ajustar a mano escenas, recursos propios, voz,
  música y subtítulos, con preview fiel e instantánea.
- **G4.** Render local a MP4 vertical 1080×1920 a 30 fps, como job con progreso.
- **G5.** Perfil visual por canal, primero manual y después importable/asistido por IA.

## No objetivos (v1)

- Editor tipo Premiere completo: keyframes libres, transiciones a mano, corrección de color,
  varias pistas del mismo tipo.
- Vídeo horizontal largo (16:9, 8–15 min). El modelo de escenas no debe impedirlo después
  (la relación de aspecto es un campo del proyecto, no una constante), pero no se construye.
- Editar el MP4 ya renderizado (ffmpeg sobre el resultado): las ediciones se perderían al
  re-renderizar y cada corte recomprime.
- Clonación de voz del usuario en ElevenLabs (riesgo legal de consentimiento).
- Render en la nube (HeyGen) o subida automática: publicar sigue siendo la pantalla Publicar.
- Que el modelo escriba HTML/JS de la composición.

## Anti-objetivos (sería un fracaso aunque funcione)

- Que algo del núcleo huela a fútbol o al canal de Marc (G1).
- Que un cambio de texto obligue a regenerar toda la voz y pagarla entera.
- Que un Chrome colgado o un render fallido tumbe el backend o deje la cola bloqueada.
- Que la clave de ElevenLabs pase por los argumentos de una tool (la vería el modelo) o
  aparezca en logs.
- Que la preview del editor y el MP4 final no coincidan.
- Fallos silenciosos: un render que «termina» con un vídeo de resolución, duración o audio
  incorrectos sin avisar.

## Restricciones

- Arquitectura existente (`ds/v1`): Tauri 2 + React 19 (`app-ui`), sidecar FastAPI congelado
  con PyInstaller (`app-backend`), cola de jobs en SQLite (`app_backend/jobs.py`), secretos en
  Credential Manager vía `youtube_mcp/secrets.py`, agente Claude con
  `beta.messages.tool_runner` y gate de aprobación por riesgo (`registry.py`, `agent.py`).
- El WebView solo tiene `core:default`: diálogos de fichero y rutas del sistema van por
  comandos Rust.
- La salida del modelo nunca se pinta como HTML en la app.
- `data-testid` de `app-ui/docs/pantallas.md` son contrato de los E2E.
- `test_registry.py` limita tools estrictas (≤ 20) y uniones (≤ 16) con margen 12: cada tool
  write nueva expuesta al modelo cuenta.
- Sin atribución a Claude en commits/PR; ramas `<tipo>/<slug>`, nunca `claude/…`.
- Licencias: HyperFrames es Apache-2.0 (redistribuible con su aviso); ffmpeg debe ser build
  **LGPL**, no GPL, para ir dentro de un .exe no libre. La licencia de GSAP **no permite** este
  producto, y la redistribución del Chrome for Testing de Google es **dudosa / no concedida**
  (puerta de licencias, D10 y `video-mcp-server/LICENCIAS.md`).
- Equipo de referencia del usuario final: portátil Windows con GPU modesta; el render debe
  funcionar sin WebGPU (footy ya tiene reserva CSS para los fondos de shader).

## Decisiones

### D1. El motor sigue en TypeScript y corre como proceso hijo MCP por stdio

El backend hoy importa los servidores MCP Python como librerías en su mismo proceso. Footy es
Node, y HyperFrames es Node + Chrome + ffmpeg en cualquier caso. Alternativas descartadas:

- *Reescribir en Python:* tira código probado (alineación, plantillas, validaciones) y el
  render seguiría siendo Node.
- *Híbrido (validación en Python, render en Node):* duplica las reglas del guion en dos
  lenguajes; deriva garantizada.

Decisión: el código de footy entra en el repo como paquete propio (`video-mcp-server/`,
TypeScript) y el backend lo lanza como **proceso hijo** con el cliente MCP de Python por
**stdio** (mensajes JSON por la entrada/salida estándar; no abre puertos, así que nada fuera
del backend puede hablarle). El backend lo usa a través de una clase cliente (`MotorVideo`,
`app_backend/video.py`) desde sus rutas REST. Como el modelo no llama a estas tools (D2), no
entran en `registry.build()`; si alguna se expone al chat más adelante, se adapta al mismo
`ToolSpec` (riesgo, `job_kind`, `strict`) que las Python.

Requisitos del adaptador:
- Arranque perezoso al primer uso del módulo y reinicio automático si el hijo muere.
- El hijo muere con el backend (mismo Job Object de Windows que ya ata el sidecar a la app).
- Timeout por llamada y **timeout del render** (footy no lo tiene; un Chrome colgado
  bloqueaba la cola). Al vencer, se mata el árbol de procesos del render y el job falla con
  mensaje legible.
- `stdout` del hijo reservado al protocolo; logs a `stderr` → fichero de log del backend.

### D2. El modelo no dispara renders ni gasta ElevenLabs

Las tools del motor las llama **el backend** desde rutas REST de la pantalla (patrón ya usado
en `GET /guiones/retencion`), no el agente. El modelo solo produce el guion de escenas en JSON
(D5). Motivos: el coste de ElevenLabs y el render son acciones del usuario con botón propio,
no algo que el modelo deba decidir; y reduce la superficie de inyección y el consumo del cupo
de tools estrictas. Si más adelante se quiere exponer alguna al chat, entra por el registro con
su riesgo y la tarjeta de aprobación de siempre. *(Decisión mía.)*

### D3. Línea de tiempo de escenas, duración variable

- El proyecto es una lista ordenada de escenas. Cada escena se ata a una o varias frases de
  la narración y tiene una **base** generada por HyperFrames y, opcionalmente, una **capa** con
  un recurso del usuario (foto o clip) encima o detrás.
- La **duración es un parámetro del vídeo**. Formato «Short» por defecto: 40–55 s, ~600–750
  caracteres de narración. Se admite cualquier duración hasta el máximo de la plataforma
  destino (Shorts: 3 min).
- El nº de escenas se deriva de la duración (un corte cada 2–4 s). El límite de caracteres se
  deriva de la duración y la velocidad de la voz (~13–15 caracteres/s en español; se calibra
  con la alineación real). Desaparece el 650 fijo.
- Gancho abierto en los 3 primeros segundos, remate justo después del dato clave y frase final
  que enlace con el inicio (bucle): **recomendaciones** que el guion intenta cumplir y la app
  señala si faltan; nunca bloquean.
- Los cortes de escena se ajustan por defecto al límite de palabra más cercano (alineación de
  ElevenLabs).
- Relación de aspecto es campo del proyecto (`9:16` único valor admitido en v1).

### D4. Catálogo de escenas genérico

Base (fase 1, adaptadas de footy): `cifra`, `barras`, `mapa` (incluye globo), `cartel`,
`titulo3d`; opciones globales `fondo` (aurora/plasma/nebula/gradiente/mesh, con reserva CSS),
`golpe`, `destellos`, `look`, `subtitulos`.

Nuevas (fase 2), definidas en genérico; la versión futbolera de la propuesta original es un
ejemplo de uso, no el tipo:

| Tipo | Qué es | Ejemplo fútbol | Ejemplo otro tema |
|---|---|---|---|
| `diagrama` | Plano cenital con fichas y flechas animadas que dibujan un recorrido; fondo intercambiable (campo, mapa, lienzo) | Pizarra táctica de una jugada | Ruta de un viaje, pasos de un proceso |
| `marcador` | Dos lados, valor que cambia, reloj opcional | Resultado con el minuto corriendo | Votación, competición, antes/después |
| `comparativa` | Dos entidades frente a frente con métricas que suben a la vez | Dos jugadores | Dos móviles, dos ciudades |
| `linea_tiempo` | Fechas que pasan con hitos | Carrera de un jugador | Historia de una empresa |
| `portada` | Titular o cita con textura de papel | Portada deportiva | Cita de un científico |
| `foto_viva` | Foto del usuario con zoom/paneo lento, paralaje (sujeto recortado) o enmarcada sobre el fondo; nunca a pantalla completa y quieta | — | — |
| `clip` | Vídeo corto del usuario integrado con texto encima | — | — |

En fase 1, `foto_viva` (solo zoom/paneo y marco, sin paralaje) y `clip` existen como **capa
de recurso** en la pista de recursos del editor, porque el editor necesita admitir material
propio desde el principio. El paralaje (recorte del sujeto) llega en fase 2.

La escena `tunel` (exige tres fotos) queda **fuera del esquema del modelo en la fase 1**: el
modelo no puede pedirla. La pieza (`escena-tunel.html`) sigue probada por el adaptador de tests
y entra en la fase 2 sin coste.

### D5. Guion en modo vídeo (pantalla Guiones)

- Nuevo formato en el modo Escribir: «Vídeo». El agente consulta `buscar_kb`, la KB privada y,
  en este formato, también los vídeos con mejor rendimiento del canal y sus momentos de
  retención mediante las tools de YouTube **de lectura** existentes. Se avisa del coste de cuota
  antes de lanzar, como en Diagnosticar.
- Salida: JSON de escenas validado contra un **esquema estricto** (tipos de escena cerrados,
  longitudes máximas, colores con regex, números acotados). Cada escena: frase(s) de voz, tipo
  y datos de la escena, y si necesita recurso del usuario → `{tipo: foto|clip, que_debe_salir,
  resolucion_minima}`. La lista de recursos del vídeo sale de ahí (normalmente 3–6).
- El guion de escenas es editable en Guiones (texto de frases, tipo de escena, orden) y se
  **guarda en disco** como parte del proyecto de vídeo (antes fuera de alcance; ahora
  obligatorio).
- Botón «Crear vídeo» → crea el proyecto y abre el editor.
- El system prompt hereda las reglas de Guiones (citar KB, priorizar aprendizajes propios, no
  copiar guiones ajenos) y añade: no usar material con derechos de retransmisión como recurso
  sugerido; proponer escenas generadas cuando no hay recurso.

### D6. Editor (layout B)

- **Preview** grande a la izquierda: es la composición HyperFrames real ejecutándose en el
  WebView2 (Chromium), con seek instantáneo. Lo que se ve es lo que se renderiza.
- **Panel lateral** con pestañas: Escena (inspector de lo seleccionado), Recursos (fotos y
  clips del proyecto), Perfil (perfil visual aplicado).
- **Timeline** inferior a todo el ancho, que hace también de lista de escenas. Cinco pistas:
  1. Escenas: mover, reordenar, recortar, cambiar tipo, editar textos.
  2. Recursos: arrastrar fotos/clips propios encima o debajo de una escena, entrada/salida.
  3. Voz: forma de onda, quitar silencios, **regenerar solo una frase** con ElevenLabs.
  4. Música: pista aportada por el usuario (sin catálogo en v1, *decisión mía*: una biblioteca
     empaquetada exige licencia de redistribución y una API externa añade coste y otra clave),
     inicio, volumen, ducking automático. La biblioteca de música del usuario vive en la
     carpeta de estado de la app y se analiza como en footy (duración, BPM, LUFS).
  5. Subtítulos: corregir palabras y cortes de línea.
- Guardado automático y deshacer/rehacer *(decisión mía)*.
- Render final = job de la cola existente con progreso; al terminar, verificación con ffprobe
  (resolución, fps, duración ± tolerancia, pista de audio presente) antes de dar el vídeo por
  bueno.
- La pantalla usa solo componentes del catálogo `ds/*` y tokens; sus `data-testid` se añaden a
  `pantallas.md` en el mismo cambio.

**Mecanismo de preview elegido (spike de fase 0, `video-mcp-server/spikes/INFORME-preview.md`):**

- El backend sirve la carpeta de la composición como **URL de capacidad**
  (`/…/{clave}/{ruta}` en `127.0.0.1`, clave aleatoria de 32 bytes que solo se entrega con el
  Bearer; rutas resueltas y acotadas a la carpeta; respuesta con `CSP: sandbox allow-scripts`).
  Al `index.html` se le inyecta el runtime de HyperFrames y un script de control.
- La pantalla la carga en un `<iframe sandbox="allow-scripts">` **sin `allow-same-origin`**
  (origen opaco: sin acceso al token, a `window.__TAURI__` ni al almacenamiento; comprobado).
  WebGPU funciona dentro de ese iframe.
- Control solo por `postMessage` con lista cerrada de órdenes (`seek`, `play`, `pause`), que el
  script traduce a **`window.__player`** del runtime (no a `__timelines["main"]`: el player
  mueve también timelines anidados, `<audio>`/`<video>` y el tiempo del shader). En la fase 1 se
  validan forma e id de las respuestas.
- Cifras: seek mediana 14 ms en WebView2, 59–135 fps según la GPU que elija Windows, deriva
  audio/vídeo de pocos ms en 50 s (desfase instantáneo hasta ~50 ms, a escuchar con voz real).
- **Criterio de salida NO cumplido:** tras reproducir el vídeo entero, un seek atrás deja el
  fondo WebGPU `aurora` en otra fase (SSIM 0,60–0,86 frente al MP4). Pendiente de Marc antes de
  la fase 1: diagnosticar la causa con un seek de calentamiento como red (recomendado), o fondo
  CSS en la preview. Falta además la medición en WebView2 con la RTX (Windows eligió la iGPU).

### D6b. Ciclo de vida del proyecto *(decisión mía)*

- Entrada nueva en la barra lateral: **Vídeo** (`/video`), con la lista de proyectos (título,
  perfil, duración, estado: borrador / renderizando / listo / error, fecha) y el editor en
  `/video/:id`.
- El guion de escenas generado en Guiones se puede **guardar como borrador** sin crear proyecto
  (lista de guiones guardados en Guiones). «Crear vídeo» crea el proyecto con una **copia** del
  guion: desde ese momento el editor es la fuente de verdad.
- Copia de una sola vía: editar después el guion en Guiones no toca el proyecto. Si el
  usuario quiere llevar los cambios, «Crear vídeo» de nuevo crea otro proyecto. Sin
  sincronización bidireccional (evita conflictos con ediciones a mano en la timeline).
- Borrar un proyecto pide confirmación y borra su carpeta (recursos copiados incluidos).
- El borrado lo hace un solo componente (el backend), a partir del id validado por regex: la
  ruta debe ser hija directa de `<estado>/video/proyectos/`, la carpeta no puede ser un punto de
  reanálisis, y el borrado recursivo **no sigue** enlaces, junctions ni puntos de reanálisis (los
  desenlaza). No es una acción del modelo (I10).

### D7. Voz con ElevenLabs

- BYOK: cada usuario usa su propia clave, guardada en el almacén de secretos como la de
  Anthropic (`elevenlabs_api_key`), con `has_elevenlabs_key` en ajustes y validación de la
  clave. Se entrega al proceso hijo por variable de entorno al arrancarlo; nunca por argumento
  de tool ni en logs. *(Decisión mía, coherente con el BYOK de Claude.)*
- Voz elegida del catálogo de voces de la cuenta del usuario, con botón de escuchar. El botón
  genera una muestra de 60 caracteres con coste visible y caché por voz; nunca se descarga
  `preview_url` (I14).
- La narración se trocea por frases/segmentos: regenerar una frase solo factura esa frase y
  reajusta la alineación del resto. Para vídeos largos, la voz se genera por partes y se une.
- Antes de generar, la app muestra el nº de caracteres que se van a facturar.
- La respuesta de ElevenLabs se valida por esquema antes de usarla: cuerpo ≤ 20 MB;
  `characters`, `character_start_times_seconds` y `character_end_times_seconds` con la misma
  longitud, ≤ 2 × los caracteres enviados, números finitos, ≥ 0, no decrecientes, `fin ≥ inicio`
  y ≤ duración del audio + 1 s. El audio (≤ 10 MB por frase) se trata como fichero no confiable
  (I15: se sondea con el ffmpeg del bundle, con lista blanca `mp3`). Si algo falla, error visible
  y no se guarda nada.

### D8. Perfil visual

Un único formato de perfil y un único panel; la importación y el asistente solo rellenan un
borrador.

- **Contenido:** paleta, tipografías (de las empaquetadas), voz, idioma, música por defecto,
  estilo de subtítulos, fondo animado, look, tono del texto.
- **Fase 1 (mínimo):** lista simple de perfiles, cada uno en `perfiles/<id>.json`, editables a
  mano (voz, paleta y fuente) y con «Duplicar»; hay un perfil por defecto y el proyecto
  referencia uno por `perfilId`. Sin importar de canal ni IA.
- **Fase 3:**
  - *Importar de un canal:* paleta calculada en local a partir del banner y ~8 miniaturas
    (cuantización de color, sin IA); tono deducido por Claude de títulos y descripciones;
    estilo tipográfico clasificado por Claude viendo las miniaturas y mapeado a la fuente
    empaquetada más parecida. La voz no se importa.
  - *Definir con IA:* el usuario describe el canal y Claude propone un perfil completo.
  - Varios perfiles por usuario con su proyecto referenciándolos *(decisión mía)* ya existen
    desde la fase 1; aquí solo se suman el borrador importado y el generado por IA.

### D9. Recursos del usuario y derechos

- Fotos: vertical, mínimo 1080×1920 (ideal ≥ 1440×2560 por el zoom). La app avisa si un
  recurso queda por debajo de la resolución mínima de su escena.
- Clips: MP4 H.264, preferible 1080×1920 a 30 fps, 2–6 s; el audio del clip se descarta por
  defecto. Los horizontales se reencuadran sobre fondo desenfocado: el fondo es un fotograma fijo del clip
  con CSS `filter: blur()` (`boxblur` es GPL y el build LGPL propio, `ffmpeg-build/componentes.conf`, no incluye `gblur`), así que
  no se mueve.
- Aviso visible al añadir recursos: no usar retransmisiones ni material sin licencia (Content
  ID). La app no puede verificar el origen; solo informa.
- Los recursos se copian a la carpeta del proyecto (no se referencian en su ruta original).

### D10. Empaquetado

- Node, `node_modules` del motor, Chrome headless y ffmpeg/ffprobe (build LGPL) van **dentro
  del instalador** como recursos de Tauri, con su aviso de licencia. Coste estimado: ~300 MB más
  de instalador. Motivo: robustez (funciona sin red, sin descargas que puedan fallar o ser
  manipuladas). *(Decisión mía.)*
- **Real (fase 0):** `video-engine/` ocupa **783 MB sin comprimir** (navegador 270, ffmpeg +
  ffprobe 209, `app/` con `node_modules` 220, Node 84). Piezas fijadas con versión y SHA-256 en
  `app-ui/scripts/prepare-video-engine.sh`: Node v22.23.4 win-x64, chrome-headless-shell
  152.0.7977.30 (la que fija hyperframes 0.8.206; SHA-256 calculado sobre la descarga, Google no
  lo publica), ffmpeg `n7.1.5-12-g1fdbca85aa-win64-lgpl-7.1` (BtbN), hyperframes 0.8.206 y el
  resto por lockfile. Recortes posibles a decidir: Chrome fuera del instalador (ver puerta),
  build mínima de ffmpeg, `three` + `three147` (73 MB), compresión LZMA en NSIS.
- Telemetría de HyperFrames desactivada (footy ya fija `HYPERFRAMES_NO_TELEMETRY`,
  `DO_NOT_TRACK`); la composición no puede referenciar URLs externas (footy ya lo comprueba).
- El smoke test del release comprueba que el motor arranca y responde desde el bundle.
- **Puerta de licencias (cierre de fase 0):** confirmar que se puede redistribuir cada pieza del
  instalador. Si alguna no se puede, se sustituye esa pieza antes de construir la fase 1. El
  código de footy es de Marc y no tiene restricciones.
- **Resultado (2026-10-28, detalle en `video-mcp-server/LICENCIAS.md`): dos bloqueantes.**
  - **GSAP:** su licencia excluye las herramientas que permiten crear animaciones visuales sin
    código (definición «Prohibited Uses» y restricción III.1 de https://gsap.com/standard-license),
    que es lo que hace el producto. Alternativa recomendada: plantillas con Web Animations API
    (adaptador `waapi` del runtime de HyperFrames) más un motor de tiempo propio para las piezas
    que animan objetos JS (contadores, three.js), empezando por un spike.
  - **chrome-headless-shell (Chrome for Testing):** redistribución **dudosa / no concedida**:
    binario con marca de Google sujeto a sus términos, que prohíben distribuir su software.
    Alternativa recomendada: spike con un snapshot de Chromium precompilado (BSD) vía
    `HYPERFRAMES_BROWSER_PATH` para seguir en el instalador; si no pasa, descarga del CfT en el
    primer uso con el SHA-256 fijado (sacrifica funcionar sin red en el primer render).
  - ffmpeg LGPL: redistribuible, pero falta publicar el código fuente correspondiente y los
    avisos de sus bibliotecas estáticas antes de la primera versión pública.
  - HyperFrames, Node, three, d3, topojson, atlas (atribución al IGN para el mapa de España),
    fuentes OFL y shaders vendorizados: redistribuibles con el aviso que ya se incluye.
- **Decisiones del 2026-10-29 (spikes `INFORME-waapi.md` e `INFORME-chromium.md`):**
  - **GSAP se sustituye** por WAAPI más un motor de tiempo propio (`hf-tiempo.js`).
  - **Chrome for Testing se descarga en el primer uso**, no va en el instalador. La versión y el
    SHA-256 los fijamos nosotros (CfT 156.0.8078.73), no HyperFrames. Se guarda en una ruta fija
    dentro del estado de la app, sin override por entorno, y se verifica antes de extraerlo y
    antes de cada lanzamiento (I4). Si falla, error visible y reintento; nunca otro navegador
    (I11). HyperFrames no puede elegir otro navegador por su cuenta (I13). Sacrifica el primer
    render sin conexión. El snapshot de Chromium queda como plan B.
  - **Descarga del CfT:** URL fijada en código
    (`https://storage.googleapis.com/chrome-for-testing-public/<versión>/win64/chrome-headless-shell-win64.zip`),
    solo HTTPS con verificación TLS, sin seguir redirecciones a otro host, con tamaño máximo
    fijado (el esperado + 10 %) y el SHA-256 calculado mientras llega. La inicia el usuario (botón
    con el tamaño), nunca la UI sola ni el modelo. La extracción rechaza entradas con `..`, rutas
    absolutas, letra de unidad, `:` (flujos alternativos de NTFS) o enlaces, y limita el tamaño
    total y el nº de ficheros. Ruta: `<estado>/video/navegador/<versión>/`, fuera de las carpetas
    de proyectos y de cualquier ruta que sirva la preview. Al fijar una versión nueva se borran las
    anteriores.
  - **Sandbox:** el renderer de Chrome corre en Untrusted (parche local a HyperFrames, que lanza
    con `--no-sandbox`), con el sandbox de la GPU desactivado (I3 y riesgo residual en «Seguridad»).

### D11. Codificación H.264: dos modos

HyperFrames 0.8.206 solo codifica H.264 con `libx264` (GPL, no puede ir en un ffmpeg LGPL) o
con un codificador de GPU (`h264_nvenc`, `h264_qsv`, `h264_amf`); sin ninguno lanza
`H264EncoderUnavailableError` (`dist/chunk-5QKJPCQ4.js`). Por eso hay dos modos de render:

- **Rápido:** HyperFrames codifica directamente a H.264 con el codificador de GPU. Una sola
  pasada. Solo disponible si la detección de capacidades encuentra un codificador de GPU que
  funcione.
- **Compatible:** dos pasadas. HyperFrames renderiza a un intermedio sin `libx264` (ProRes en
  `.mov`, o WebM/VP9; se elige en el spike) y el ffmpeg LGPL lo pasa a H.264 con la GPU si la
  hay y, si no, con Media Foundation (`h264_mf`, presente en todo Windows 10/11; patentes de
  H.264 cubiertas por la licencia de Windows). Funciona en cualquier equipo. Más lento, ocupa
  disco temporal (el intermedio se borra al terminar) y algo menos de calidad que `libx264` a
  igual bitrate; se compensa con bitrate alto.
- **Selección:** ajuste del usuario «Modo de render» con tres valores: *Automático* (por
  defecto; en la fase 1 equivale a Compatible hasta medir el bitrate con fotos reales, M-D6;
  después, Rápido si hay GPU y si no Compatible), *Rápido* (deshabilitado con explicación si no
  hay GPU) y *Compatible*. El job registra qué modo y codificador usó. Si Rápido falla por el
  codificador, el job reintenta en Compatible una vez y lo indica. *(Selector a petición de
  Marc; valores y reintento, decisión mía.)*
- Ambos modos pasan la misma verificación final con ffprobe (D6).
- El spike de fase 0 valida: que HyperFrames renderiza al intermedio sin `libx264`, tiempos de
  ambos modos para 50 s, y calidad visual de `h264_mf` frente a GPU con el bitrate elegido.

**Resultado del spike (fase 0, `video-mcp-server/spikes/INFORME-codificacion.md`):**

- **Intermedio decidido: `mov` (ProRes 4444)**, impuesto por HyperFrames con alfa
  (`yuva444p12le`, ~130 Mb/s): 785 MB de disco temporal por 50 s, que se borran al terminar.
  `webm` (VP9) queda como alternativa si falta disco (6,3 MB, ~50 s más lento en total, calidad
  sin medir de forma fiable); el motor comprueba el espacio libre antes de elegir.
- Tiempos para 50 s en la máquina de Marc: Rápido 517 s; Compatible 782–836 s. Casi todo es la
  captura de Chrome (8–14 min por 50 s, ~8–14× tiempo real), no la codificación (4–13 s).
- **Bitrate: ABIERTO.** `h264_mf` **ignora el bitrate** (sale ~3,2 Mb/s, perfil Constrained
  Baseline, con cualquier ajuste); NVENC lo respeta con `-rc`. Se fija en la fase 1 midiendo con
  fotos reales (o se pasa a calidad constante en NVENC).
- **Reintento obligatorio:** un render con `--gpu` falló a los 12 min por montar argumentos de
  `libx264` (`x264-params`). Hipótesis sin confirmar: la sonda de NVENC de HyperFrames (timeout
  de 2 s) no responde a tiempo bajo carga. Por eso el reintento en Compatible ante fallo del
  codificador **no es opcional**, y el motor **sondea él mismo** los codificadores con el ffmpeg
  del bundle (timeout generoso) antes de ofrecer Rápido, sin fiarse de la detección interna.

## Seguridad

*(Reescrita el 2026-10-29 para la fase 1. Las invariantes I1–I12 son criterio de aceptación de
todo cambio del módulo: cada una se cubre con un test o con una comprobación del smoke test.)*

### Atacantes considerados

- **A1 · Contenido remoto:** quien influye en la salida del modelo (KB, transcripciones, datos
  del canal, guion pegado; YouTube en la fase 3).
- **A2 · Ficheros maliciosos** que el usuario importa (fotos, clips, música).
- **A3 · Cadena de suministro:** npm, el CfT descargado, ElevenLabs comprometido o con un fallo.
- **A4 · Webs en el navegador del usuario y otros usuarios de Windows del mismo equipo:**
  loopback compartido, DNS rebinding.
- **Fuera de alcance:** malware que ya se ejecuta como el usuario. Puede modificar cualquier
  fichero de la instalación (`installMode: currentUser`) y del estado. Las comprobaciones de hash
  en tiempo de ejecución sirven para la **integridad y la robustez** (descarga corrupta,
  extracción a medias, antivirus, otra herramienta), no para frenar a ese atacante.

### Qué protegemos

- La cuenta de Windows del usuario: sus archivos, su registro y su sesión.
- Las claves BYOK (Anthropic, ElevenLabs) y los tokens OAuth de YouTube.
- Los vídeos y recursos del usuario.
- La integridad de los binarios que ejecutamos (Node, ffmpeg, Chrome).

### Entradas no confiables

- La **salida del modelo** (guion de escenas, datos de escena, textos) y lo que la alimenta:
  KB, transcripciones, datos del canal y guion pegado.
- Los **ficheros del usuario** (imágenes, audio, clips), que decodifican ffmpeg y Chrome.
- Las **respuestas de ElevenLabs** (audio y JSON de alineación).
- El **binario de Chrome for Testing descargado** en el primer uso.
- Las **dependencias npm y los parches** locales (`patch-package`).
- Los **mensajes `postMessage`** del iframe de la preview.
- En la fase 3, el **banner, las miniaturas, los títulos y las descripciones de YouTube**: las
  imágenes se decodifican con los límites de I15; los textos van a Claude y lo que proponga es
  salida del modelo (I1).

### Fronteras de confianza

```
UI (WebView2) ──HTTP loopback + bearer──▶ sidecar (FastAPI)
UI (WebView2) ──iframe sandbox, frame-src = puertos fijos 47810–47813──▶ servidor de preview (puerto propio, solo la composición, sin acceso a la API del sidecar)
sidecar ──HTTPS, URL y hash fijados──▶ storage.googleapis.com (CfT, solo a petición del usuario)
sidecar / motor ──HTTPS──▶ api.elevenlabs.io
sidecar ──stdio MCP, entorno por lista blanca──▶ motor (Node) ──args en array, entorno por lista blanca──▶ CLI de HyperFrames (modo cerrado, I13)
HyperFrames ──puppeteer──▶ Chrome: renderer (Untrusted, sin red) ─▶ proceso de GPU (sin sandbox, residual)
HyperFrames ──pipe──▶ ffmpeg ;  HyperFrames ──servidor de ficheros en 127.0.0.1──▶ Chrome
composición ──✗ red (CSP + proxy nulo) ;  preview = iframe sandbox sin allow-same-origin
composición ──✗ API del sidecar (otro puerto; ni siquiera sin bearer)
estado en %LOCALAPPDATA% (escribible por cualquier proceso del usuario: ver «Atacantes»)
```

**Riesgos residuales aceptados:**

- **Proceso de GPU de Chrome sin sandbox** (`--disable-gpu-sandbox`): con el sandbox completo,
  el render se cuelga en 5 de 6 ejecuciones (`video-mcp-server/spikes/INFORME-chromium.md`). El
  renderer, que es quien interpreta el HTML, sí va en Untrusted. Para acotarlo: el render usa
  `--disable-accelerated-video-decode` (ningún medio del usuario se decodifica en el proceso de
  GPU); los shaders WebGPU son solo los vendorizados, nunca datos del usuario o del modelo. Se
  revisa con cada subida de HyperFrames o del CfT fijado. El parche (Windows) no admite
  `--single-process` ni `--in-process-gpu`, que sacarían el renderer del sandbox.
- **Sandbox del renderer y cierre de red (W1.3):** (a) con WebRTC en la página, el servicio de red
  abre sockets UDP efímeros en `0.0.0.0` aunque ningún paquete salga (medido); el respondedor mDNS
  (5353) queda cerrado con `WebRtcHideLocalIpsWithMdns`. (b) Los accesos a red del código de
  HyperFrames que corre en Node (telemetría, instalación de opcionales, comprobación de versión,
  descarga del navegador) no se cortan con el parche, sino con las variables de entorno de I13:
  dependen de que el motor las fije siempre. (c) Un renderer visto un instante en integridad Low
  antes de pasar a Untrusted solo se admite si sale y vive menos de 2 s en el test de I3. Es el
  nivel inicial antes de `LowerToken()` (nivel de integridad diferido), previo a cargar
  contenido; el test de I3 además debe exigir (hoy no lo hace: pendiente, R0-12) que, en el instante de la primera captura de
  fotograma, todos los renderers vivos estén en Untrusted.
- **Integridad del motor y del render (W1.6):** la comprobación de los ficheros parcheados de
  HyperFrames contra sus SHA-256 es de integridad, no de autenticidad (el JSON vive junto al
  `dist` y lo puede escribir cualquier proceso del usuario); el resto de `dist/` y `node_modules`
  queda sin hash, y entre comprobar y lanzar hay una ventana aceptada, como en I4. El barrido de
  I7 depende de que el sistema dé la ruta de la imagen: un proceso con nombre del motor y sin ruta
  que no se pueda descartar como ajeno (por su línea de comandos o su padre) no se mata a ciegas:
  se trata como no verificable, falla cerrado y reinicia el motor.
- **ffmpeg sin sandbox:** la normalización y el render corren con los permisos del usuario; un
  fallo de memoria en un decodificador permitiría ejecutar código como el usuario. Se acota con la
  lista blanca de formatos y la normalización de I15. Se estudiará ejecutarlo con integridad Low o
  en un AppContainer.
- **Servidor de ficheros de HyperFrames (A4):** durante el render sirve `_render/` en
  `127.0.0.1:<efímero>` sin autenticación; otros procesos del equipo, incluido otro usuario de
  Windows (A4), y el DNS rebinding podrían leer la composición (fotos, voz y textos) mientras
  dura. Se acepta en la fase 1 porque solo sirve `_render/` (nunca la carpeta del proyecto ni
  `recursos/` originales) y vive lo que dura el render; se estudiará un prefijo de ruta
  aleatorio en el parche.

### Invariantes

| ID | Invariante |
|---|---|
| **I1** | **Todo dato que llega a una plantilla es dato validado por esquema al cargarlo**, no solo al escribirlo: salida del modelo, guion de escenas, perfil visual, JSON del proyecto en disco y alineación. Nunca llega como HTML, JS, CSS, ruta o argumento de CLI sin escapar; cada valor se escapa para **su contexto exacto** (texto HTML, atributo, JSON dentro de `<script>`, JSON dentro de un atributo), sustituido en una pasada; colores por regex y fuentes de una lista cerrada (también las que proponga la IA en la fase 3). El esquema del modelo **no tiene campos de ruta ni de URL**: los recursos y la música se referencian por un id que genera el backend. Los recursos copiados se renombran a `<id>.<ext>`; el nombre original solo se guarda como texto para la UI. Topes del esquema: ≤ 180 s, ≤ 90 escenas, ≤ 3000 caracteres de narración, ≤ 30 recursos. El modelo nunca escribe HTML de composición. Los tiempos los calcula el motor como números finitos. |
| **I2** | **La composición no usa la red, y lo impone el navegador, no un escáner.** (a) `index.html` lleva una CSP en `<meta>` con `default-src 'none'` y solo los orígenes locales imprescindibles (`'self'`, `data:`, `blob:`; `'unsafe-inline'`/`'unsafe-eval'` solo si el runtime lo exige, justificado en el código); la preview envía la misma política como cabecera, con el origen explícito `http://127.0.0.1:<puerto>` en lugar de `'self'`, junto a `sandbox allow-scripts`. (b) En Windows, el Chrome del render arranca con `--proxy-server=0.0.0.0:1` y `--host-resolver-rules="MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"` (parche local de HyperFrames), de modo que ninguna petición sale de loopback aunque la CSP falle. El `--proxy-bypass-list` se limita al **puerto exacto del servidor local** de esa invocación (`<-loopback>;<host>:<puerto>`, solo `localhost` o `127.0.0.1`), no a todo loopback: `<-loopback>` quita la excepción implícita de Chrome y, sin URL con puerto, no se exceptúa nada. El parche descarta los flags de proxy, resolución y WebRTC que pida HyperFrames y añade `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` y `--disable-quic`. El proxy es `0.0.0.0:1` y no `127.0.0.1:1` porque en Windows conectar a `0.0.0.0` falla siempre; con `127.0.0.1:1`, cualquier proceso que escuchase en el puerto 1, incluido el de otro usuario (A4), recibiría todo el tráfico como proxy. (c) `urlsDeRed` se mantiene como aviso temprano y legible: recorre todos los ficheros de texto (`.html .css .js .mjs .json .svg`), incluido `vendor/`, y detecta `//host`, `http(s):`, `ws(s):` y `file:`. |
| **I3** | El renderer de Chromium corre con **integridad Untrusted** durante el render real, también en la app instalada. Un test lo mide y falla si no se cumple. |
| **I4** | Node, ffmpeg y Chrome se ejecutan **solo desde rutas fijas** calculadas por el backend, sin alternativas por entorno o argumento en el binario congelado (Ruling 6 de la fase 0). Node y ffmpeg se verifican con SHA-256 al construir el bundle. El CfT descargado: (1) el zip se verifica antes de extraerlo; (2) se extrae en una carpeta nueva y vacía y se genera un **manifiesto con el SHA-256 de cada fichero**; (3) solo se publica en su ruta final por renombrado atómico, y nunca se usa una extracción a medias; (4) **antes de cada invocación de la CLI de HyperFrames**, el motor comprueba contra el manifiesto `chrome-headless-shell.exe` y todas las `.dll`, y rechaza ficheros que no estén en él. La única excepción es `chrome-headless-shell-win64/debug.log`: Chrome lo escribe junto a su exe en cada ejecución (ningún flag de log lo evita en el CfT fijado), y se tolera **solo en esa ruta exacta** y solo como fichero normal (sin enlaces ni hardlinks); el manifiesto no puede listarlo, y el backend y el motor aplican la misma regla. No es código: nadie lo carga. La ventana entre esa comprobación y el lanzamiento se acepta (atacante fuera de alcance). **El ffmpeg del bundle es sustituible sin tocar esta invariante:** hoy es un build LGPL de BtbN con el SHA-256 del **zip** fijado en `prepare-video-engine.sh` (el exe extraído no lleva hash propio); el build propio de `video-mcp-server/ffmpeg-build/` lo sustituirá en W3.2 al cumplir su puerta (fuentes con hash y firma verificada, descarga y compilación en contenedores separados, la compilación sin red, solo protocolos `file` y `pipe`), y su SHA-256, fijado en `prepare-video-engine.sh`, es el control final. Que el motor rechace una `.dll` extra en la carpeta del ffmpeg, como hace con el navegador, es requisito de W3.2 y todavía no está implementado. |
| **I5** | **Secretos:** la clave de ElevenLabs solo va al entorno del motor; nunca a Chrome, ffmpeg o HyperFrames, ni a logs (con redacción), ni a ficheros de la composición, URLs, argumentos de tools o mensajes de error. Los hijos del motor (HyperFrames, ffmpeg, Chrome) reciben un entorno por **lista blanca** (`PATH` con el ffmpeg del bundle delante, `SYSTEMROOT`, `TEMP`/`TMP`, `HOME`/`USERPROFILE` redirigidos de I13, las variables de I13 y `HYPERFRAMES_BROWSER_PATH`), nunca una copia del entorno del motor; así queda cubierta cualquier clave futura. |
| **I6** | **Rutas.** La UI nunca envía rutas de sistema al backend: los diálogos de abrir y guardar son comandos Rust que copian el fichero elegido a una bandeja de entrada dentro del estado (o el MP4 al destino elegido) y devuelven un id opaco de un solo uso. El backend y el motor solo trabajan dentro de `<estado>/video/`. Cada fichero se abre **una vez**: las comprobaciones (tipo, tamaño, que no sea symlink, hardlink, junction ni punto de reanálisis) se hacen sobre el handle abierto, y se copia desde ese handle, sin reabrir la ruta. Ids de proyecto y de recurso por regex; nada de `..`, rutas absolutas ni `:` en nombres. |
| **I7** | **Procesos:** `spawn` sin shell y argumentos en array, `--` o `--opción=` delante de valores del usuario, y timeouts que matan **el árbol** de procesos. El hijo muere con la app (Job Object). Tras un timeout, una cancelación, o si la CLI de HyperFrames termina con error, **y al arrancar el motor** (para recoger lo que dejó un motor muerto; la cancelación y el arranque, hoy no: pendientes de T6, test `barrido_al_arrancar`), el motor **barre por ruta de imagen** (no por árbol): lista los procesos y mata los que tengan por imagen el `ffmpeg`/`ffprobe` exactos del bundle o cualquier ejecutable bajo la carpeta del CfT con manifiesto (en desarrollo, solo el exe del navegador, y ffmpeg solo si `FFMPEG_DIR` está fijado; nunca el Chrome del usuario), y repite la comprobación. No toca lo que cuelga de un hijo en vuelo ni el trabajo de otro motor vivo. Si no puede listar, verificar o matar —incluido un proceso con nombre del motor y sin ruta legible que no se pueda descartar como ajeno—, falla cerrado y reinicia el motor. Ningún servidor que abran HyperFrames o Chrome escucha fuera de `127.0.0.1`. Chrome se controla solo por pipe (`pipe: true` en todas las vías de lanzamiento de HyperFrames 0.8.206); ningún proceso del motor abre un puerto CDP. El parche **debe** rechazar `--remote-debugging-port` y `--remote-debugging-address` con un error (hoy no lo hace: pendiente de T6, con el test `render_sin_puerto_cdp`). El único servidor sin autenticar que queda es el de ficheros de HyperFrames (ver «Riesgos residuales aceptados»). |
| **I8** | **Escucha y preview.** Todo solo en loopback. Rutas de la API con bearer; la de la preview, con una clave de capacidad de 32 bytes **atada a un proyecto** (sirve solo su `_composicion/`, nunca la carpeta del proyecto ni otra), que se crea al abrir el editor y se invalida al cerrarlo, al borrar el proyecto y al reiniciar el backend. La clave no aparece en ningún log (logs de acceso sin la ruta, o con la clave tapada). La preview se sirve desde un **puerto propio** de la lista fija `47810–47813`, distinto del de la API del sidecar: `frame-src` lista exactamente los puertos de preview fijados en `tauri.conf.json`; nunca `127.0.0.1:*`. Si los cuatro puertos están ocupados, no hay preview y la UI lo dice. El backend reserva los cuatro puertos con uso exclusivo mientras vive; un puerto de la lista ocupado por otro proceso se avisa, porque la composición podría navegar a él. La regla «nunca `127.0.0.1:*`» se aplica también a `devCsp`, que hoy aún lo tiene (`tauri.conf.json`): lo cierra T12 del plan. Ese servidor solo sirve la composición. La composición no alcanza la API del sidecar porque `frame-src` no incluye el puerto de la API (el marco no puede navegar a ella), el `connect-src` de la preview solo admite su propio origen y la API exige bearer. El iframe siempre lleva `sandbox="allow-scripts"`, sin `allow-same-origin`, `allow-popups` ni `allow-top-navigation`, y su `src` solo sale de la ruta que devuelve el backend. Mensajes del iframe al padre: se aceptan solo si `e.source === iframe.contentWindow` y `e.origin === "null"`; se validan por esquema (tipo de una lista cerrada, `id` correlacionado, números finitos y acotados); nunca se pintan como HTML ni se usan como URL o ruta; se descartan los tipos desconocidos. La respuesta de la preview lleva `X-Content-Type-Options: nosniff` y la CSP de I2. |
| **I9** | **Cadena de suministro:** versiones exactas y lockfiles. Los parches se revisan línea a línea. Ninguna dependencia nueva sin justificar. Descargas por HTTPS y con hash. Nada de `@latest` ni `npx` sin versión. Telemetría desactivada. |
| **I10** | El modelo **no dispara renders ni gasta ElevenLabs** (D2). Lo que escribe o borra pasa por el gate de aprobación. Coste visible antes de gastar (caracteres de ElevenLabs, cuota de YouTube). |
| **I11** | **Si algo falla, el fallo se ve.** Nunca se cae en silencio a un componente menos seguro: Chrome del sistema, Edge, ffmpeg GPL, render sin sandbox o caché de HyperFrames. Las reservas legítimas (modo Compatible, codificador por software) son explícitas y quedan registradas en el job. |
| **I12** | **Licencias:** nada de GSAP. No se redistribuye CfT. Se cumplen las obligaciones LGPL de ffmpeg antes de publicar. |
| **I13** | **HyperFrames en modo cerrado.** Toda invocación de la CLI de HyperFrames (`check`, `render`, `snapshot`, prueba de GPU, `catalog`) se hace con `CI=1`, `HYPERFRAMES_NO_UPDATE_CHECK=1`, `HYPERFRAMES_NO_AUTO_INSTALL=1`, `HYPERFRAMES_NO_OPTIONAL_INSTALL=1`, `HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1` y `HYPERFRAMES_SKIP_SKILLS=1`, y con `HOME`/`USERPROFILE` apuntando a `<estado>/video/hf-home` (vacía al crearse), de modo que no lee ni escribe en `~/.cache/hyperframes`, `~/.hyperframes` ni en la caché de puppeteer del usuario. El parche local de HyperFrames hace que `findBrowser()` **lance un error** si `HYPERFRAMES_BROWSER_PATH` está definida y no es un fichero, en vez de buscar en cachés o en el sistema, o descargar. Ninguna dependencia opcional se instala en tiempo de ejecución: si falta, el job falla con un mensaje legible. |
| **I14** | **Salidas de red permitidas del módulo**, y ninguna más: el backend → `storage.googleapis.com` (solo la descarga del CfT, iniciada por el usuario) y `api.elevenlabs.io` (validar la clave); el motor → `api.elevenlabs.io`. HyperFrames, Chrome y ffmpeg: ninguna. La tool `video_catalogo` (usa la red de HyperFrames) no se registra en el modo integrado. |
| **I15** | **Recursos del usuario normalizados y acotados.** Al importarlos (fotos, clips, música): (1) el tipo se identifica por sus primeros bytes y solo se aceptan JPEG, PNG y WebP (fotos); MP4, MOV o WebM con H.264, HEVC, VP9 o AV1 (clips); MP3, WAV, FLAC, OGG y M4A (música); (2) se rechaza lo que supere los límites: foto ≤ 50 MB, ≤ 8192 px por lado y ≤ 40 Mpx; clip ≤ 500 MB, ≤ 60 s, ≤ 4096 px por lado y ≤ 60 fps; música ≤ 100 MB y ≤ 15 min; (3) se **recodifica una vez** con el ffmpeg del bundle a un formato canónico, invocándolo con `-protocol_whitelist file`, `-format_whitelist` con la lista del punto 1, un demuxer explícito (`-f`) y timeout. HyperFrames, la preview y el análisis de música solo ven los ficheros normalizados, nunca el original. (4) Antes de renderizar, el motor comprueba que hay espacio libre para el intermedio (ProRes, ~16 MB/s) más un margen. |

### Pruebas negativas mínimas

| Prueba | Resultado esperado |
|---|---|
| Plantilla de prueba con `fetch("http://203.0.113.1/")`, `<img src="//ejemplo.test/x.png">` y `new WebSocket("ws://…")`, en el render y en la preview | Ninguna petición llega a un sumidero local que hace de proxy (el test lo levanta y comprueba cero conexiones); la CSP registra la violación |
| JS en `vendor/` con una URL externa | `urlsDeRed` lo detecta |
| `HYPERFRAMES_BROWSER_PATH` apunta a un fichero inexistente y hay un `chrome.exe` en Program Files | El render falla con un error legible; no se lanza ningún Chrome ni hay descarga |
| Render completo con `HOME` redirigido | `~/.cache/hyperframes`, `~/.hyperframes` y la caché de puppeteer del usuario real no se crean ni se modifican; ninguna conexión a `registry.npmjs.org` |
| Cada invocación de la CLI de HyperFrames (espía en el test) | Lleva todas las variables de I13 |
| El entorno de cada hijo del motor | Solo contiene las variables de la lista blanca de I5 (el test enumera las claves) |
| Una `.dll` extra en la carpeta del CfT | Detectada antes del render; error visible |
| Zip con hash correcto (fixture) y una entrada `..\..\x.dll` | Rechazado; nada escrito fuera de la carpeta temporal |
| Un `.mp4` que en realidad es una lista HLS o `concat` que referencia `file:///…` | Rechazado al importar; nada del fichero referenciado aparece en el MP4 |
| PNG de 20 000 × 20 000 px, o clip de 2 h | Rechazado al importar con un mensaje legible |
| Perfil o proyecto en disco con `"color": "red;background:url(//x)"` o una fuente fuera de la lista | Rechazado al cargar |
| Alineación de ElevenLabs (simulado) con `NaN`, tiempos que retroceden o 10⁶ caracteres | Error legible; el motor sigue vivo; no se guarda nada |
| Proyecto con una junction interna que apunta a una carpeta centinela con ficheros | Al borrar el proyecto, la carpeta centinela queda intacta |
| Sockets en escucha de los descendientes del motor durante el render | Todos en `127.0.0.1` |
| Guion con `<script>` o con `{{…}}` en un texto | Aparece escapado en el HTML |
| Recurso del usuario que es un symlink, hardlink o junction | Rechazado |
| Zip de CfT con un byte cambiado | Error visible y no se extrae |
| Binario de CfT cambiado tras verificarlo | Detectado antes del lanzamiento |
| Clave de ElevenLabs | No aparece en `video.log`, ni en los entornos de los hijos de HyperFrames, ni en la composición |
| Render con timeout | Ningún proceso con imagen bajo la carpeta del CfT o del ffmpeg del bundle (se comprueba por ruta de imagen, no por árbol) |
| Renderer durante el render | Integridad Untrusted |

### Enmiendas de la fase 1 (2026-11-07)

Aprobadas por Marc (M-D1, M-D2, M-D3, M-D5, M-D6, M-D7 y M-D8; M-D4 aplazada) para alinear esta spec con el código y con
las decisiones de la fase 1:

| ID | Sección tocada |
|---|---|
| M-1 | I2 (b): bypass de proxy limitado al puerto exacto del servidor local |
| M-2 | I4: `debug.log` de Chrome tolerado solo junto a su exe |
| M-3 | I7: barrido de procesos huérfanos por ruta de imagen (también tras una cancelación y al arrancar el motor, R0-6) |
| W1.3 | Riesgos residuales (sandbox del renderer y cierre de red); I2 (b) |
| W1.5 | I4: ffmpeg sustituible y frontera de construcción del build LGPL |
| W1.6 | Riesgos residuales (integridad del motor y del render) |
| M-D1 | I8 y diagrama de fronteras de confianza: preview en puertos fijos `47810–47813`. Estado objetivo: el `frame-src` exacto y el cierre de `devCsp` los cumple T12, no el código actual |
| M-D2 | D8 (fase 1), Fases (fase 1 y 3) |
| M-D3 | D7: botón de escuchar con muestra generada, nunca `preview_url` (I14) |
| M-D4 | Aplazada: sin enmienda; el respaldo de mutex va en T12 y M-4 sigue abierta hasta entonces |
| M-D6 | D11: Automático = Compatible en la fase 1 |
| M-D7 | D9: fondo desenfocado con CSS `filter: blur()` |
| M-D8 | D4: `tunel` fuera del esquema del modelo en la fase 1 |
| R0 | I2 (b), I7, I8, riesgos residuales y W1.3 (c): hallazgos R0-1, R0-2, R0-6, R0-7 y R0-13 |

### Revisión de seguridad

Cada paquete de trabajo pasa una revisión de seguridad bloqueante sobre su plan (antes de
escribir código) y sobre su diff (antes de integrar); Critical y High bloquean el merge. Al cerrar
cada oleada se repite una revisión transversal sobre la rama integrada. Protocolo completo en
`HANDOFF-video-fase1.md` §3.

## Fases

- **Fase 0 · Integración técnica.** Generalizar footy (fuera fútbol y «footy»), meterlo en el
  repo, proceso hijo + adaptador, clave ElevenLabs BYOK, empaquetado, y dos **spikes**: preview
  en WebView2 con fondos WebGPU (fluidez y fidelidad frente al MP4) y codificación en dos
  pasadas (D11). Cierra con la puerta de licencias (D10). Si un spike falla, esa parte se
  replantea antes de la fase 1.
- **Fase 1 · Guion en modo vídeo + editor + base del motor.** D3, escenas base de D4 y capa de
  recursos, D5, D6, D7 y lista simple de perfiles de D8.
- **Fase 2 · Escenas nuevas.** Resto de D4, incluido paralaje.
- **Fase 3 · Perfil visual completo.** Importación y asistente IA.

## Criterios de aceptación (fase 1)

1. Con dos perfiles y dos guiones de temas distintos (p. ej. fútbol y cocina), el mismo build
   produce dos vídeos coherentes con su perfil sin tocar código ni configuración oculta (G1).
2. Guiones → formato Vídeo → «Crear vídeo» abre el editor con escenas, voz y recursos
   pendientes señalados.
3. Cambiar el texto de una frase y regenerarla factura solo esa frase.
4. Un cambio en el editor se ve en la preview sin renderizar; el MP4 final coincide con la
   preview (comparación de fotogramas en segundos fijos).
5. El MP4 se verifica (1080×1920, 30 fps, duración, audio) antes de marcarse como terminado.
6. Un render colgado vence su timeout, el job falla con mensaje legible y la cola sigue.
7. La clave de ElevenLabs no aparece en logs, respuestas de la API ni argumentos de tools.
8. Funciona en un equipo sin WebGPU (reserva CSS de fondos) y en uno sin codificador H.264 de
   GPU (modo Compatible).
9. E2E de la pantalla nueva con el contrato de `pantallas.md`, ElevenLabs simulado.

## Lo que queda al constructor

- Estructura interna de `video-mcp-server/` y cómo se reparte el código de footy.
- Formato en disco del proyecto (JSON del proyecto, carpeta de recursos, voz por frases) y
  dónde vive dentro del directorio de estado de la app.
- Librería o implementación propia de la timeline en React, y cómo se comunica la preview con
  la composición (postMessage, seek).
- Mecanismo exacto de deshacer/rehacer.
- Cómo se calibra la velocidad de la voz por voz/idioma.
- Plan de tests concreto por fase, siguiendo los existentes (pytest backend, vitest UI,
  Playwright E2E con sidecar real y mocks).
