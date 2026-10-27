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
6. **Empaquetado:** Node, Chrome headless y ffmpeg (build LGPL) van dentro del instalador.

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
  **LGPL**, no GPL, para ir dentro de un .exe no libre.
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
del backend puede hablarle). Un adaptador en `registry.py` convierte sus tools al mismo
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

### D7. Voz con ElevenLabs

- BYOK: cada usuario usa su propia clave, guardada en el almacén de secretos como la de
  Anthropic (`elevenlabs_api_key`), con `has_elevenlabs_key` en ajustes y validación de la
  clave. Se entrega al proceso hijo por variable de entorno al arrancarlo; nunca por argumento
  de tool ni en logs. *(Decisión mía, coherente con el BYOK de Claude.)*
- Voz elegida del catálogo de voces de la cuenta del usuario, con botón de escuchar.
- La narración se trocea por frases/segmentos: regenerar una frase solo factura esa frase y
  reajusta la alineación del resto. Para vídeos largos, la voz se genera por partes y se une.
- Antes de generar, la app muestra el nº de caracteres que se van a facturar.

### D8. Perfil visual

Un único formato de perfil y un único panel; la importación y el asistente solo rellenan un
borrador.

- **Contenido:** paleta, tipografías (de las empaquetadas), voz, idioma, música por defecto,
  estilo de subtítulos, fondo animado, look, tono del texto.
- **Fase 1 (mínimo):** perfil editable a mano con voz, paleta y fuente; un perfil por defecto.
- **Fase 3:**
  - *Importar de un canal:* paleta calculada en local a partir del banner y ~8 miniaturas
    (cuantización de color, sin IA); tono deducido por Claude de títulos y descripciones;
    estilo tipográfico clasificado por Claude viendo las miniaturas y mapeado a la fuente
    empaquetada más parecida. La voz no se importa.
  - *Definir con IA:* el usuario describe el canal y Claude propone un perfil completo.
  - Varios perfiles por usuario; cada proyecto referencia uno *(decisión mía)*.

### D9. Recursos del usuario y derechos

- Fotos: vertical, mínimo 1080×1920 (ideal ≥ 1440×2560 por el zoom). La app avisa si un
  recurso queda por debajo de la resolución mínima de su escena.
- Clips: MP4 H.264, preferible 1080×1920 a 30 fps, 2–6 s; el audio del clip se descarta por
  defecto. Los horizontales se reencuadran sobre fondo desenfocado.
- Aviso visible al añadir recursos: no usar retransmisiones ni material sin licencia (Content
  ID). La app no puede verificar el origen; solo informa.
- Los recursos se copian a la carpeta del proyecto (no se referencian en su ruta original).

### D10. Empaquetado

- Node, `node_modules` del motor, Chrome headless y ffmpeg/ffprobe (build LGPL) van **dentro
  del instalador** como recursos de Tauri, con su aviso de licencia. Coste: ~300 MB más de
  instalador. Motivo: robustez (funciona sin red, sin descargas que puedan fallar o ser
  manipuladas). *(Decisión mía.)*
- Telemetría de HyperFrames desactivada (footy ya fija `HYPERFRAMES_NO_TELEMETRY`,
  `DO_NOT_TRACK`); la composición no puede referenciar URLs externas (footy ya lo comprueba).
- El smoke test del release comprueba que el motor arranca y responde desde el bundle.
- **Puerta de licencias (cierre de fase 0):** confirmar que se puede redistribuir cada pieza del
  instalador: binario de Chrome headless (o alternativa Chromium/Edge), licencia gratuita de
  GSAP (posible restricción a herramientas que compitan con Webflow; sin comprobar), aviso de
  HyperFrames (Apache-2.0) y build LGPL de ffmpeg. Si alguna no se puede, se sustituye esa
  pieza antes de construir la fase 1. El código de footy es de Marc y no tiene restricciones.

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
  defecto: Rápido si hay GPU, si no Compatible), *Rápido* (deshabilitado con explicación si no
  hay GPU) y *Compatible*. El job registra qué modo y codificador usó. Si Rápido falla por el
  codificador, el job reintenta en Compatible una vez y lo indica. *(Selector a petición de
  Marc; valores y reintento, decisión mía.)*
- Ambos modos pasan la misma verificación final con ffprobe (D6).
- El spike de fase 0 valida: que HyperFrames renderiza al intermedio sin `libx264`, tiempos de
  ambos modos para 50 s, y calidad visual de `h264_mf` frente a GPU con el bitrate elegido.

## Seguridad

- **Entrada no confiable:** KB, transcripciones, datos del canal, guion pegado y la propia
  salida del modelo. El modelo solo rellena datos validados por esquema; todo texto se escapa
  antes de entrar al HTML (`escaparHtml`, `jsonParaScript` de footy); colores y fuentes
  validados; plantillas sustituidas en una pasada.
- **Ejecución de procesos:** solo `spawn` sin shell y argumentos en array (como footy).
  Corregir el hueco conocido: argumentos que empiecen por `--` en `catalog` (usar `--` como
  separador o validar).
- **Rutas:** id de proyecto validado por regex; todo resuelto con realpath dentro de la carpeta
  del proyecto; corregir el hueco de footy (imágenes encontradas sin realpath → un symlink
  podía apuntar fuera). Los ficheros que elige el usuario entran por diálogo Rust y se copian.
- **Secretos:** ver D7. La clave se oculta en errores.
- **Proceso hijo:** stdio, sin puertos. Muere con la app. Timeout de render.
- **Preview en el WebView:** la composición se carga aislada del resto de la app (iframe
  sandbox con origen propio, sin acceso a `window.__TAURI__` ni al token del backend), porque
  contiene texto derivado del modelo aunque esté escapado.
- **Coste:** confirmación con caracteres a facturar antes de llamar a ElevenLabs; aviso de
  cuota de YouTube antes del guion en modo vídeo.

## Fases

- **Fase 0 · Integración técnica.** Generalizar footy (fuera fútbol y «footy»), meterlo en el
  repo, proceso hijo + adaptador, clave ElevenLabs BYOK, empaquetado, y dos **spikes**: preview
  en WebView2 con fondos WebGPU (fluidez y fidelidad frente al MP4) y codificación en dos
  pasadas (D11). Cierra con la puerta de licencias (D10). Si un spike falla, esa parte se
  replantea antes de la fase 1.
- **Fase 1 · Guion en modo vídeo + editor + base del motor.** D3, escenas base de D4 y capa de
  recursos, D5, D6, D7 y perfil mínimo de D8.
- **Fase 2 · Escenas nuevas.** Resto de D4, incluido paralaje.
- **Fase 3 · Perfil visual completo.** Importación, asistente IA, varios perfiles.

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
