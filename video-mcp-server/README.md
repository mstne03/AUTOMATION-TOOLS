# footy-mcp-server

Servidor MCP local (Windows, stdio) que produce los shorts del canal de historias de fútbol:

1. Claude escribe el guion → `footy_guardar_guion` (formato completo en `footy_ayuda`).
2. Tú revisas el guion y dejas las fotos que pide (`img1…img6`, salvo los bloques con escena especial).
3. Claude → `footy_generar_voz` → `footy_vista_previa` (opcional) → `footy_renderizar` → `footy_estado_render` → `footy_fotograma`.
4. Con tu OK, Claude lo sube con `youtube_upload_video` desde `C:\Footy\footyNNN.mp4` (eso lo hace `youtube-mcp-server`, no este servidor).

La voz sale de ElevenLabs con timestamps por carácter (subtítulos palabra a palabra sin Whisper) y el vídeo se monta y renderiza con la CLI de HyperFrames 0.8.206, instalada como dependencia local. Desde la v0.2.0 cada short puede llevar gancho animado, efectos de cámara y luz, looks, escenas especiales (mapa, barras, cifra, título 3D, túnel, cartel), fondos con shaders WebGPU, cuatro estilos de subtítulos y música con ducking y cortes al ritmo. Todo se decide en el guion.

## Instalación

Requisitos: Node 22 o superior y FFmpeg.

```bash
winget install --id Gyan.FFmpeg -e
```

```bash
cd C:\Users\Pau\footy-mcp-server
```

```bash
npm install
```

```bash
npm run build
```

Desactiva la telemetría de HyperFrames una vez (el servidor además pone `HYPERFRAMES_NO_TELEMETRY=1` en cada llamada; `footy_capacidades` muestra el estado):

```bash
npx hyperframes telemetry disable
```

Copia `.env.example` a `.env` y rellénalo:

| Variable | Obligatoria | Uso |
|---|---|---|
| `ELEVENLABS_API_KEY` | para la voz | Clave de la API. Nunca se escribe en logs ni en errores. |
| `ELEVENLABS_VOICE_ID` | para la voz | Id de tu voz clonada. |
| `ELEVENLABS_MODEL_ID` | no | Por defecto `eleven_multilingual_v2`. |
| `FOOTY_ROOT` | no | Por defecto `C:\Footy`. Se crea al guardar el primer guion. |
| `HYPERFRAMES_BROWSER_PATH` | no | Solo si la CLI no encuentra Chrome. |
| `FOOTY_MUSICA_VOLUMEN` | no | 0-1, por defecto `0.12`. Cada guion puede pisarlo con `musica_volumen`. |
| `FFMPEG_DIR` | no | Carpeta `bin` de FFmpeg si Claude Desktop no la ve en el PATH. Si no se pone, el servidor también la busca en la instalación de winget. |
| `FOOTY_FORZAR_SIN_GPU` | no | `1` para no usar WebGPU aunque haya (fondos con el degradado de reserva). Para pruebas. |

El `.env` se lee desde la carpeta del servidor, no desde el cwd.

Comprobación del entorno de render:

```bash
npx hyperframes doctor
```

Si el doctor marca Chrome como ausente o roto:

```bash
npx hyperframes browser ensure
```

Si aun así falla (proxy, antivirus…), instala Chrome o Chromium a mano y pon su ruta en `.env`, por ejemplo `HYPERFRAMES_BROWSER_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`.

## Config de Claude Desktop

Claude Desktop en este PC es la versión MSIX (Microsoft Store), así que el config que lee está en
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
(no en `%APPDATA%\Claude\`, aunque ese archivo también exista). Dentro de `"mcpServers"`:

```json
"footy": {
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\Users\\Pau\\footy-mcp-server\\dist\\index.js"]
}
```

La carpeta tiene que llamarse exactamente `footy-mcp-server`, igual que en la ruta del config.

Después de cada `npm run build` **cierra Claude Desktop del todo**: Administrador de tareas → finaliza todos los procesos `Claude`, y vuelve a abrirlo. Cerrar la ventana no basta. Las 12 herramientas `footy_*` tienen que aparecer en el chat.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `footy_listar()` | Carpetas `footyNNN` con guion / imágenes requeridas / voz / mp4, y el siguiente id libre. |
| `footy_guardar_guion(id?, contenido, sobrescribir=false)` | Valida el formato v2 y guarda `guion.md`. Sin `id`, usa el siguiente libre. No pisa nada sin `sobrescribir=true`. Avisa si la voz queda desactualizada y devuelve qué fotos hacen falta. |
| `footy_estado(id)` | Opciones v2 activas, imágenes requeridas con resolución (aviso si el lado corto < 1080 px), si el fondo irá con GPU o con reserva, música (pista, desde, volumen, BPM), voz y mp4. |
| `footy_generar_voz(id, forzar=false)` | Llama a ElevenLabs solo si no hay `voz.mp3` o con `forzar=true`. Guarda `voz.mp3`, `alineacion.json` y `palabras.json`. |
| `footy_renderizar(id, musica=true)` | Comprueba todo, genera `_composicion\`, pasa `hyperframes check` y renderiza a `FOOTY_ROOT\footyNNN.mp4` (con `--browser-gpu` si hay fondo WebGPU). Devuelve `job_id` al momento. Un render a la vez; el resto se encola. |
| `footy_estado_render(job_id)` | `en_cola` / `renderizando` / `terminado` / `error`, con fase, progreso, ruta, duración, avisos o las últimas 30 líneas útiles de la CLI. |
| `footy_fotograma(id, segundo)` | PNG de 540×960 del mp4 como imagen MCP. |
| `footy_ayuda()` | Formato completo del guion v2 (sale de `src/formato.ts`): campos, un ejemplo por escena, listas válidas y un guion de ejemplo. |
| `footy_capacidades(reprobar=false)` | WebGPU sí/no con la fecha de la prueba, versiones de HyperFrames, FFmpeg y Chrome, fondos disponibles y telemetría. |
| `footy_vista_previa(id, segundos[])` | Monta la composición y devuelve una hoja de contacto (máx. 8 fotogramas de 270×480) con `hyperframes snapshot`, sin renderizar el vídeo. |
| `footy_musica()` | Lista `FOOTY_ROOT\_musica` con duración, BPM y sonoridad (LUFS). Cacheado por archivo y fecha en `logs\musica-cache.json`. |
| `footy_catalogo(consulta)` | Busca en el catálogo de HyperFrames (solo lectura) y marca las piezas ya adaptadas en `plantilla/piezas/`. |

## Formato del guion v2

La referencia completa la devuelve `footy_ayuda` y vive en `src/formato.ts` (de ahí salen también el validador y la descripción de `footy_guardar_guion`). Todo es opcional salvo `titulo`, `gancho` y los 6 bloques; un guion v1 sigue valiendo y sale igual que en v1 salvo el gancho nuevo.

```markdown
---
titulo: Higuita's scorpion kick
gancho: He saved it with his heels.
etiqueta: Wembley · 6 Sep 1995        # chip que entra al salir el gancho
golpe: kicks                          # palabra exacta; "kicks#2" = 2.ª aparición
enfasis: [scorpion, kick]             # crecen en los subtítulos al sonar
destellos: [1, 5]                     # por defecto [1] y el bloque del golpe
look: normal                          # normal | videocamara | pelicula
fecha: 1995-09-06 20:15               # obligatoria con videocamara
subtitulos: karaoke                   # karaoke | pildora | neon | impacto (<30 s)
fondo: aurora                         # ninguno | aurora | plasma | nebula | gradiente | mesh
musica: _musica/tension-01.mp3
musica_desde: 12.5
musica_volumen: 0.12
cortes_al_ritmo: true
escenas:
  3:
    tipo: mapa
    region: mundo                     # espana | europa | mundo
    destacar: [England, Colombia]
    etiqueta: England vs Colombia
  6:
    tipo: cifra
    valor: 15
    sufijo: " Copas"
    etiqueta: Real Madrid, récord absoluto
---

[1] Wembley, 1995. England against Colombia.
…
[6] The scorpion kick was born.
```

| Escena | Campos | Qué se ve |
|---|---|---|
| `mapa` | `region`, `destacar`, `etiqueta`, `titulo` | Mapa vertical; las zonas se encienden en el acento una a una (0,25 s) y entra la etiqueta. |
| `barras` | `titulo`, `periodos` (2-8), `series` (2-6), `prefijo`, `sufijo`, `fuente` | Carrera de barras vertical; cada periodo dura el bloque ÷ periodos. |
| `cifra` | `valor`, `prefijo`, `sufijo`, `etiqueta`, `decimales` | Número enorme que cuenta desde 0 en el 60 % del bloque y aterriza con golpe y destello. |
| `titulo3d` | `texto` (≤ 12, sin acentos) | Letras 3D doradas que se levantan una a una. |
| `tunel` | ninguno (≥ 3 fotos) | Túnel 3D con las fotos del vídeo. |
| `cartel` | `texto` (≤ 40), `subtexto` | Frase clave en grande sobre el fondo, palabra a palabra. |

Los bloques con escena no necesitan foto: **imágenes requeridas = bloques sin escena** (`footy_listar` y `footy_estado` lo muestran así).

### Datos

```
C:\Footy\
├─ _musica\                 pistas de la Biblioteca de audio de YouTube (opcional)
├─ footy001\
│  ├─ guion.md
│  ├─ img1.jpg … img6.jpg   jpg, png o webp; vale cualquier nombre que empiece por img1…img6
│  ├─ voz.mp3
│  ├─ alineacion.json       respuesta cruda de la alineación de ElevenLabs
│  ├─ palabras.json         palabras, segmentos, frases y hash del texto narrado
│  └─ _composicion\         proyecto HyperFrames generado (se puede abrir con `npx hyperframes preview`)
└─ footy001.mp4
```

### Composición generada

```
_composicion\
├─ index.html                     raíz 1080×1920: hosts, audio y variables del tema
├─ compositions\
│  ├─ bloque1.html … bloque6.html foto con Ken Burns o la escena especial del bloque
│  ├─ bucle.html                  reencuadre final de la imagen 1 (si el bloque 1 es foto)
│  ├─ fondo.html                  shader WebGPU o degradado (solo si alguna escena lo usa)
│  ├─ capas.html                  degradado, viñeta, destellos y look
│  ├─ gancho.html, etiqueta.html
│  ├─ subtitulos.html             todos los grupos en un host data-track-kind="captions"
│  └─ flash.html                  destellos blancos de los cortes y del golpe
└─ assets\                        fotos, voz.mp3, musica.mp3, gsap, fonts\ y vendor\ (solo lo que se usa)
```

Orden de pintado: fondo (10) → bloques (11-16) y bucle (17) → capas (40) → gancho (50) y etiqueta (51) → subtítulos (60) → flash (70).

### Marca

Todo lo de marca está en `plantilla/tema.json` (colores, fuentes, tamaños, paleta del túnel). Las fuentes son `.woff2` locales en `plantilla/fuentes/` (Anton, Inter Tight y JetBrains Mono de `@fontsource`, y Geist Bold en `fuentes/3d/` para el título 3D; todas OFL).

## Piezas del catálogo adaptadas (`plantilla/piezas/`)

Las piezas originales se instalaron con `npx hyperframes add` en `catalogo/` (referencia, no se usa en el render).

| Pieza | Del catálogo | Qué se cambió |
|---|---|---|
| `gancho.html` | `headline-slam` | Vertical (host 1080×620 en top 200), Anton con `@font-face` local, tamaño en px calculado por el servidor, contorno de 4 px, acento en la última palabra, entrada 1.12 → 1 y temblor con `fromTo` explícitos. |
| `capas.html` | `vignette`, `organic-light-leak-overlay`, `camcorder-hud`, `grain-overlay` | Viñeta del short-pro; destellos con 3 capas y máximo 0,62; HUD vertical (REC/batería a 196 px, fecha/contador a 930 px, por encima de los subtítulos) en JetBrains Mono local, con scanlines y tinte; grano con saltos finitos en vez de `animation: infinite`. |
| `subtitulos.html` | `caption-pill-karaoke`, `caption-neon-glow`, `caption-kinetic-slam` | Fuentes del tema en vez de Poppins/Outfit de Google Fonts, grupos de §6.4 generados en el servidor, franja 1056-1328 px y 140 px libres a la derecha, énfasis. |
| `escena-cifra.html` | `mk-progress-stat` | Sin barra ni textos de ejemplo; número en Anton de hasta 380 px que cuenta en el 60 % del bloque y aterriza con golpe y destello. |
| `escena-cartel.html` | `weight-wave` | Anton no es una fuente variable, así que se usa la alternativa del plan: palabra a palabra con blur 6 → 0 px cada 0,067 s. |
| `escena-barras.html` | `bar-chart-race` | Mismo modelo de rangos; maqueta vertical (nombre encima de la barra), colores del tema, año a la derecha del título, fuente solo si la da el guion. |
| `escena-mapa.html` | `spain-map`, `world-map` | Trazados SVG calculados en el servidor (`src/mapas.ts`); sin fetch, d3 ni topojson en el navegador. Canarias en recuadro; el mundo es un globo centrado en las zonas destacadas. |
| `escena-titulo3d.html` | `extruded-logo` | 1080×1920, cámara de 26° al doble de distancia, palabra centrada a ~700 px, hasta 12 letras a ~1000 px, acabado oro con luz de acento, render por setter, Three.js 0.184 local con import map `./`. |
| `escena-tunel.html` | `gallery-tunnel` | 1080×1920 y pasillo más alto que ancho, ids por bloque, fotos del vídeo con `imageMix 0.85` y paleta del tema. Three.js r147 UMD local. |
| `fondo-shader.html` | `aurora`, `plasma`, `mesh-gradient` (y `FractalNoise` para `nebula`) | 1080×1920, `shaders.iife.js` en `assets/vendor/`, colores del tema por `data-shader-props`. |
| `fondo-css.html` | propio | Degradado animado de reserva (dos `radial-gradient` con GSAP). |

## Scripts

| Script | Qué hace |
|---|---|
| `npm run build` | Compila a `dist/`. |
| `npm test` | Compila y pasa las pruebas: guion v1 y v2 (una por regla de validación), alineación, rutas, herramientas con fetch simulado, validaciones con archivos y la prueba stdio (12 herramientas, stdout limpio). |
| `npm run render:mock` | Render v1 rápido sin ElevenLabs en una carpeta temporal con espacios en la ruta. |
| `npm run render:matriz` | Renderiza footy990-996 (y una copia de `C:\Footy\footy001` si existe) con fotos, voz y música generadas con ffmpeg; comprueba `check` sin errores, 1080×1920 H.264 con audio, duración ±0,5 s y que no queda ningún `https://`, y deja una hoja de contacto por vídeo en `test/salidas/`. `FOOTY_MATRIZ=footy993,footy994` renderiza solo esos; `FOOTY_MOCK_CONSERVAR=1` conserva la carpeta temporal. |
| `npm run dev` | Arranca el servidor con `tsx` desde `src/`. |

## Problemas típicos

- **Las herramientas no aparecen en el chat.** Comprueba que editaste el config de la ruta MSIX de arriba, que `dist\index.js` existe (`npm run build`) y que cerraste todos los procesos de Claude desde el Administrador de tareas. El log está en `logs\footy.log`.
- **"No encuentro ffmpeg ni ffprobe".** Instala con winget y reinicia Claude Desktop (el PATH se lee al arrancar), o pon `FFMPEG_DIR` en `.env`.
- **El render falla al lanzar Chrome.** `npx hyperframes doctor`, luego `npx hyperframes browser ensure`, o `HYPERFRAMES_BROWSER_PATH`.
- **El fondo sale como degradado y no como shader.** `footy_capacidades` dice si hay WebGPU; con `reprobar=true` repite la prueba (por ejemplo, tras actualizar el driver de la gráfica).
- **"El guion ha cambiado desde que se generó la voz".** El hash del texto narrado de `palabras.json` no coincide con el guion actual: `footy_generar_voz(id, forzar=true)`. Cambiar solo el frontmatter (efectos, escenas, música) no obliga a regenerar la voz.
- **"No existe el job".** Los jobs viven en memoria; si Claude Desktop se reinició, vuelve a lanzar `footy_renderizar`.
- **Nunca uses `console.log` en el servidor.** En stdio corrompe el protocolo; usa `log` (`src/log.ts`), que escribe en stderr y en `logs\footy.log`.

## Desviaciones del plan v2

- **Mapas calculados en el servidor.** En vez de copiar d3, topojson y el atlas a la composición y proyectar en el navegador, `src/mapas.ts` lee `es-atlas@0.6.0` y `world-atlas@2.0.2` de npm con `d3-geo` y escribe los trazados SVG ya proyectados. No hay `fetch` en el render y la validación de `destacar` usa exactamente el mismo atlas. Por eso no se instala `d3@7` completo sino `d3-geo`.
- **Europa es un recorte del atlas.** `region: europa` solo acepta países de Europa (de Islandia a los Urales, más Rusia y Turquía). El ejemplo del plan (`europa` con Colombia) no es válido; en la ayuda está con `region: mundo`.
- **Mundo como globo.** En vertical un planisferio queda como una franja estrecha, así que `mundo` es un globo ortográfico centrado en las zonas destacadas.
- **Mapa y barras acaban en ~1010 px, no en 1250 px.** La franja de subtítulos es 1056-1328 px y los subtítulos van encima de las escenas: a 1250 px las barras y el mapa quedaban debajo del texto.
- **Franja de subtítulos 1056-1328 px** (en v1 llegaba a 1344) para cumplir "ningún texto fuera de 168-1330".
- **Un solo host de fondo.** El fondo (shader o degradado) es un host para todo el vídeo por debajo de los bloques, en vez de uno por bloque: así `shaders.iife.js` se carga una vez. La foto anterior a una escena sobre fondo termina justo en el corte (que lleva destello) para que el cambio no se note.
- **Ducking con los tiempos de las palabras.** Los huecos de voz (≥ 0,6 s) salen de `palabras.json`, que es exacto, en vez de `silencedetect` o `hyperframes audio`. Se aplica con `data-automation` (carril de volumen, ×1,8 en los huecos con rampas de 0,25 s), que sí existe en 0.8.206. Fade in 0,5 s y fade out 1 s con `data-fade-in`/`data-fade-out`.
- **Sonoridad.** Voz y música se normalizan a −14 LUFS con `loudnorm` de ffmpeg al preparar los assets (el `normalize-audio` de la CLI trabaja sobre dos clips de la composición y escribe `data-volume`, que aquí ya fija `musica_volumen`).
- **Beats y BPM** con `hyperframes audio --only beats,bpm,loudness --json` sobre la pista ya recortada (una sola llamada, medio segundo), en vez de `hyperframes beats`, que escribe archivos en el proyecto.
- **`check` con `--no-contrast` y `CI=1`.** El contraste WCAG sobre fotos da falsos positivos (todo el texto lleva contorno). `CI=1` evita que `check` deje un proceso "caliente" 5 minutos con `_composicion\` abierta, que en Windows impide regenerarla en el siguiente render. Los avisos de organización del Studio (`timeline_track_too_dense`) no se devuelven.
- **Textos de las escenas con `data-layout-allow-occlusion`.** `check` toma la viñeta (transparente en el centro) como un elemento opaco encima de los títulos, cifras y etiquetas y paraba el render con `text_occluded`; la marca va en esos textos, que es donde la CLI la respeta.
- **Fuente 3D corregida.** En `Geist-Bold.typeface.json` las letras H, L y F tenían contornos que se cruzan consigo mismos y Three.js las triangulaba mal (la H salía como una "И"). Nuestra copia en `plantilla/fuentes/3d/` lleva esos tres contornos rehechos; el resto del alfabeto y las cifras se han revisado a ojo.
- **Título 3D** con el campo de 26° del original y la cámara al doble de distancia en vez de 40°: con gran angular las letras de los extremos se veían de lado.
- **Three.js en dos versiones.** `extruded-logo` usa Three 0.184 (módulos ES) y `gallery-tunnel` el build UMD de r147, que en 0.184 ya no existe; se instala como alias `three147@npm:three@0.147.0`.
- **Fuentes.** Las piezas usan las fuentes del tema (Anton, Inter Tight) en lugar de Poppins, Outfit o Inter de Google Fonts; el HUD usa JetBrains Mono local. No hace falta `@fontsource-variable/inter`.
- **`impacto` en vídeos de 30 s o más** no falla: se usa karaoke y el job lo avisa.
- **Gancho y etiqueta ceden ante las escenas.** El gancho dura 2,3 s y la etiqueta entra justo después (1,35 s), como en el short-pro, salvo que una escena empiece antes: entonces el gancho acaba en el corte de esa escena (mínimo 0,9 s) y la etiqueta pasa a verse debajo del gancho (top 860 px) mientras dura, o no se muestra y el job lo avisa. Las escenas tienen su texto en la mitad superior y se pisaban.
- **`fondo: nebula` usa el shader `FractalNoise`.** El `Nebula` del catálogo es un efecto de forma (una esfera de gas dentro de un cristal), no un fondo: pintaba una bola en el centro con el resto negro.
- **Cifra con golpe.** Si el `golpe` cae en un bloque `cifra`, la cuenta aterriza en esa palabra (o 0,55 s tras la entrada si la palabra abre el bloque) y el temblor y el destello se mueven con el aterrizaje, para que el número llegue cuando la voz lo dice.
- **Año de las barras** redondeado al periodo más cercano: el original mostraba el año del que se sale mientras los valores ya iban hacia el siguiente.
- **Etiqueta del mapa** entra con la primera zona encendida, no al final: en bloques de 1-2 s no daba tiempo a leerla.
- **Subtítulos neón** con las palabras apagadas al 55 % en vez del 22 %, contorno de 6 px y sombra: el original no se leía sobre fotos claras ni sobre fondos rosas.
- **Prueba de GPU** en el primer render que la necesite (o con `footy_capacidades`), no al arrancar el servidor: tarda ~10 s y arrancar tiene que ser instantáneo para Claude Desktop.

### Desviaciones del plan v1 que siguen vigentes

- **Telemetría.** El servidor pone `HYPERFRAMES_NO_TELEMETRY=1` y `DO_NOT_TRACK=1` en el entorno de la CLI salvo que ya vengan definidas, además del `telemetry disable` de la instalación.
- **Frases.** Además de 3 palabras o 18 caracteres sin cruzar segmentos, una frase se corta al final de una oración.
- **Transiciones.** Cada bloque entra con un fundido de 0,3 s centrado en el corte; el bloque 1 no tiene fundido para que el fotograma 0 lo muestre entero.
- **Último subtítulo.** Se retira al acabar el audio para que los últimos 0,4 s sean solo la imagen 1 y el short haga bucle.
- **Render a temporal.** El mp4 se escribe como `footyNNN.renderizando.mp4` y se renombra al terminar.
- **Calidad.** `--quality delivery`.
- **Caracteres facturados.** Se leen de `x-character-count` (o `character-cost`) si la API los manda; si no, se estima con la longitud del texto.

## Lo que no se ha podido verificar

- **Caracteres facturados.** En la primera prueba real la cabecera de ElevenLabs dio 56-59 créditos para textos de 139-148 caracteres. El servidor ahora registra en `logs\footy.log` todas las cabeceras de coste tal como llegan; compáralas con el historial de uso del panel de ElevenLabs.
- **Fotos reales con escenas especiales.** La matriz usa degradados con números; `footy001` (fotos y voz reales, guion v1) sí se renderiza en la matriz.
- **Render sin red.** Ninguna composición tiene URLs externas (la matriz lo comprueba), pero no se ha medido el tráfico de la CLI durante el render.
