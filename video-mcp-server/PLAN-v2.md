# PLAN v2 — footy-mcp-server: efectos, escenas especiales, shaders y música

Amplía el servidor que ya existe (v0.1.0, 7 herramientas `footy_*`) para que cada short pueda llevar todos los recursos de HyperFrames que se han probado: gancho animado, efectos de cámara y luz, looks, escenas especiales (mapa, gráfico, cifra, título 3D, túnel, cartel), fondos con shaders WebGPU, estilos de subtítulos y música bien mezclada.

Implementa todo de una vez siguiendo este documento. Junto a él está la carpeta **`referencia-v2/`** con código que ya funcionó el 26-27/10/2026: úsalo como punto de partida y no lo reescribas de cero (ver §11). Si algo de aquí choca con la documentación real de HyperFrames (skills en `.claude/skills/` y `npx hyperframes docs`), manda la documentación: adáptalo y apúntalo en el README, en "Desviaciones del plan v2".

---

## 0. Principios

1. **Compatibilidad.** Un guion v1 (solo `titulo`, `gancho`, `musica` y 6 bloques) se sigue aceptando y sale igual que en v1, con una única diferencia buscada: el gancho nuevo (§4.1), que arregla el fallo actual de que el gancho y el primer subtítulo se pisan. Todo lo demás es opcional y se activa desde el guion.
2. **Todo se decide en el guion.** Ninguna opción visual va en el código ni en variables de entorno. Si algo no está en el guion, se usa un valor por defecto documentado.
3. **Una sola fuente de verdad del formato.** El formato del guion v2 está escrito una vez (en `src/formato.ts`). De ahí salen el validador, la descripción de `footy_guardar_guion` y la respuesta de `footy_ayuda` (§8), que es lo que Claude lee en cada chat.
4. **Cero recursos de red en tiempo de render.** Todo lo que hoy cargan los bloques del catálogo desde CDN (GSAP, Three.js, d3, topojson, fuentes de Google, datos de mapas) se instala con npm y se copia dentro de la composición (§9).
5. **Vertical nativo.** Los bloques del catálogo están pensados en 1920×1080. Cada uno que se use se adapta de verdad a 1080×1920. Nunca se escala ni se mete un 16:9 con bandas.
6. **El render lo valida.** Antes de renderizar, `hyperframes check --json`. Los errores paran el job y los avisos se devuelven, como en v1 con el lint.

---

## 1. Lo que ya existe y no cambia

- Estructura de carpetas, `FOOTY_ROOT`, ids `footyNNN`, cola de render de un job a la vez, `voz.mp3` + `alineacion.json` + `palabras.json`, render a `.renderizando.mp4` y renombrado al final, verificación con ffprobe y patrón job (`job_id` + `footy_estado_render`).
- `tts.ts` (ElevenLabs con timestamps) y `alineacion.ts`.
- La regla de no llamar a ElevenLabs si `voz.mp3` existe y no hay `forzar`.

---

## 2. Formato del guion v2

Todos los campos nuevos son opcionales. Ejemplo completo:

```markdown
---
titulo: Higuita's scorpion kick
gancho: He saved it with his heels.

# Contexto y efectos
etiqueta: Wembley · 6 Sep 1995        # chip de contexto que entra tras el gancho
golpe: kicks                          # palabra exacta de la narración; admite "kicks#2" para la 2.ª aparición
enfasis: [scorpion, kick]             # palabras que crecen al sonar (todas sus apariciones)
destellos: [1, 5]                     # bloques que empiezan con light leak; por defecto [1] y el bloque del golpe
look: normal                          # normal | videocamara | pelicula
fecha: 1995-09-06 20:15               # para look videocamara (formato AAAA-MM-DD HH:MM)
subtitulos: karaoke                   # karaoke | pildora | neon | impacto

# Fondo de las escenas sin foto
fondo: aurora                         # ninguno | aurora | plasma | nebula | gradiente | mesh  (WebGPU salvo ninguno y gradiente)

# Música
musica: _musica/tension-01.mp3
musica_desde: 12.5                    # segundo de la pista donde empieza (por defecto 0)
musica_volumen: 0.12                  # pisa FOOTY_MUSICA_VOLUMEN solo para este vídeo
cortes_al_ritmo: true                 # mueve los cambios de imagen al beat más cercano (±0,2 s)

# Escenas especiales: sustituyen la foto de ese bloque
escenas:
  3:
    tipo: mapa
    region: europa                    # espana | europa | mundo
    destacar: [England, Colombia]
    etiqueta: England vs Colombia
  4:
    tipo: barras
    titulo: Copas de Europa por club
    periodos: [1960, 1980, 2000, 2025]
    series:
      Real Madrid: [5, 6, 8, 15]
      AC Milan: [0, 2, 5, 7]
      Liverpool: [0, 2, 4, 6]
  6:
    tipo: cifra
    valor: 15
    sufijo: " Copas"
    etiqueta: Real Madrid, récord absoluto
---

[1] Wembley, 1995. England against Colombia.
[2] ...
[6] ...
```

### Tipos de escena

| tipo | Campos | Base del catálogo | Qué se ve |
|---|---|---|---|
| `mapa` | `region` (espana, europa, mundo), `destacar` (lista de nombres del atlas), `etiqueta` | `spain-map`, `world-map` | Mapa en vertical; las zonas destacadas se encienden en el color de acento una a una y aparece la etiqueta |
| `barras` | `titulo`, `periodos` (2-8), `series` (2-6 series, una cifra por periodo), `prefijo`, `sufijo` | `bar-chart-race` | Carrera de barras en vertical; la duración de cada periodo = duración del bloque ÷ periodos |
| `cifra` | `valor`, `prefijo`, `sufijo`, `etiqueta`, `decimales` | `mk-progress-stat` | Número enorme que cuenta desde 0 y aterriza con un golpe |
| `titulo3d` | `texto` (máx. 12 caracteres) | `extruded-logo` | Letras 3D metálicas que se levantan una a una |
| `tunel` | ninguno: usa las imágenes del vídeo | `gallery-tunnel` | Túnel 3D con las fotos en las paredes |
| `cartel` | `texto` (máx. 40 caracteres), `subtexto` | propio + `weight-wave` | Texto grande sobre el `fondo` (shader), para frases clave |

### Reglas de validación

Todas tienen que dar un mensaje en español que diga qué falta y cómo arreglarlo.

- `golpe` y `enfasis`: cada palabra tiene que existir en la narración (comparando sin mayúsculas ni puntuación). Si no existe, el error lista las palabras del bloque más parecido. `kicks#2` exige al menos 2 apariciones.
- `escenas`: claves 1-6, un `tipo` válido y los campos de ese tipo. `barras`: cada serie con tantas cifras como periodos. `mapa`: cada nombre de `destacar` tiene que existir en el atlas de esa región; si no, el error devuelve los 10 nombres más parecidos. Si el `look` es videocamara, no puede haber escena 3D en el bloque 1 (avisa en vez de fallar).
- **Imágenes requeridas = bloques sin escena.** Un vídeo con escena en el bloque 3 no necesita `img3`. `footy_estado` y `footy_listar` lo tienen que reflejar. `tunel` usa las fotos que haya; exige al menos 3.
- `fondo` con shader WebGPU: si `footy_capacidades` dice que no hay WebGPU, no es error. El render usa el fallback (§5) y lo avisa.
- `musica`: la ruta tiene que existir dentro de `FOOTY_ROOT`. `musica_desde` < duración de la pista.
- Límite de narración: sigue en 650 caracteres.
- Un campo desconocido en el frontmatter da un aviso, no un error, con la lista de campos válidos.

---

## 3. Arquitectura de la composición

Hoy `composicion.ts` genera un único `index.html` grande. En v2 pasa a **una raíz + subcomposiciones**, que es lo que pide HyperFrames y lo que hace que `check` no se queje de pistas demasiado densas:

```
_composicion/
├─ index.html                 # raíz 1080×1920: solo hosts, audio y overlays globales
├─ compositions/
│  ├─ bloque1.html … bloque6.html   # foto con Ken Burns, o la escena especial de ese bloque
│  ├─ gancho.html              # hook-slam vertical
│  ├─ subtitulos.html          # todos los grupos en un solo host data-track-kind="captions"
│  ├─ capas.html               # viñeta, destellos, flash, look (videocámara/película)
│  └─ fondo.html               # shader WebGPU o fallback, si alguna escena lo usa
└─ assets/
   ├─ vendor/                  # gsap, three (con addons), d3, topojson…  (solo lo que se use)
   ├─ data/                    # atlas de mapas (solo el de la región usada)
   ├─ fonts/                   # Anton, Inter Tight y las que pidan los bloques usados
   ├─ img1.jpg …, voz.mp3, musica.mp3
```

- Las plantillas de cada pieza viven en `plantilla/piezas/*.html`. `composicion.ts` las copia y les pasa los datos por `data-variable-values` en el host, o por un `<script type="application/json">`, nunca concatenando texto del guion en el HTML sin escapar (como ya hace v1).
- Orden de pintado (`z-index`): bloques 1-6 (10-16) → fondo (dentro de su bloque) → capas (40) → gancho y etiqueta (50) → subtítulos (60) → flash (70).
- Las transiciones entre bloques siguen siendo de 0,3 s con solape (`SOLAPE` actual).

---

## 4. Funcionalidades: qué hace cada una, con números

Valores medidos en el render bueno del 27/10 (`referencia-v2/short-pro/`).

### 4.1 Gancho (siempre)
- Componente `headline-slam` del catálogo, adaptado: copia vertical en `referencia-v2/short-pro/compositions/hook-slam.html`.
- Host: `top: 200px; height: 620px; width: 1080px`, duración 2,3 s, fuente Anton a 150 px (que `tamanoGancho` siga ajustándola si no cabe), mayúsculas, contorno de 4 px negro, palabra de acento = la última del gancho (`accent_word_index`), color de acento del tema.
- Entrada: `scale 1.12 → 1` con `expo.out` y temblor de 3 fotogramas al aterrizar (lo trae el componente). Salida hacia arriba.
- **Convive con los subtítulos**, que siguen en su franja de 1056-1344 px. Ese es el arreglo del fallo de v1.

### 4.2 Etiqueta (`etiqueta`)
- Chip con fondo de acento y texto oscuro (Anton 64 px, `letter-spacing 0.06em`, padding 10/34), centrado, `top: 300px`.
- Entra justo cuando sale el gancho (2,35 s) con `yPercent 120 → 0` y `back.out(2)` en 0,3 s. Dura 1,35 s y sale con `yPercent -60` en 0,2 s.

### 4.3 Flash y punch-in en cada cambio de imagen (siempre)
- En el inicio de cada bloque salvo el 1: flash blanco a 0,55 de opacidad en 0,05 s, que se apaga en 0,2 s con `power2.out`, y el bloque entra con `scale 1.07 → 1` en 0,45 s con `expo.out`.

### 4.4 Golpe de cámara (`golpe`)
- En el instante en que empieza esa palabra según `palabras.json`, el contenedor del bloque activo hace 4 pasos de un fotograma: `(22,-14) → (-16,10) → (8,-4) → (0,0)` px, más un flash de 0,35 en 0,03 s que se apaga en 0,15 s.
- Cada paso con `fromTo` explícito e `immediateRender:false`. Nada de `.to()` encadenados desde 0, porque eso da avisos de tweens solapados (§9).

### 4.5 Destellos (`destellos`)
- Light leak cálido adaptado de `organic-light-leak-overlay`: tres capas (ámbar, rojo y oro) con `mix-blend-mode: screen` y blur de 20-40 px.
- Opacidad máxima 0,62 (con más satura las caras), duración 1,7-1,8 s desde el inicio del bloque, curva: sube en el 24 %, baja a 0,4 a mitad y desaparece en el 28 % final. Código en `referencia-v2/short-pro/build_pro.py` (función `leak`).

### 4.6 Viñeta (siempre)
- `radial-gradient(ellipse at 50% 45%, transparent 48%, rgba(0,0,0,0.62) 100%)` durante todo el vídeo, por debajo de textos.

### 4.7 Énfasis (`enfasis`)
- En los subtítulos, la palabra crece a 1,12 con `back.out(3)` en 0,12 s al sonar y se queda en 1,05. Necesita `margin: 0 0.14em` para no pisar a sus vecinas.

### 4.8 Looks (`look`)
- `videocamara`: componente `camcorder-hud` adaptado a vertical, con el REC y la batería dentro de la zona segura (top ≥ 180 px) y la fecha y el contador por encima de 1330 px. Además, scanlines (líneas de 2 px al 22 %) y un tinte cálido/frío con `mix-blend-mode: overlay`. La fecha sale de `fecha` en formato `SEP 06 1995` / `08:15 PM`. Sin `fecha`, la del día del render no vale: error de validación.
- `pelicula`: componente `grain-overlay` del catálogo + viñeta más fuerte (0,75) + destello en todos los bloques.
- `normal`: nada extra.

### 4.9 Estilos de subtítulos (`subtitulos`)
- `karaoke` (por defecto): el de v1.
- `pildora`: adaptado de `caption-pill-karaoke`.
- `neon`: de `caption-neon-glow`.
- `impacto`: de `caption-kinetic-slam`, una palabra a pantalla completa con alternancia de entradas, solo para vídeos de menos de 30 s.
- Todos usan los mismos grupos de §6.4 del plan v1, la misma franja vertical y las fuentes locales. Hay que quitarles los `<link>` de Google Fonts.

### 4.10 Escenas especiales (`escenas`)
- Cada escena es una subcomposición `bloqueN.html` con la duración exacta del bloque. Los bloques del catálogo que tienen duración fija se reescalan pasando su duración como variable, o calculando su ritmo interno (por ejemplo `periodDuration`). Nunca con `timeScale`.
- Adaptaciones verticales (1080×1920), con todo el texto entre 168 y 1330 px:
  - `mapa`: el mapa ocupa de 300 a 1250 px; título arriba (Anton 72 px); las zonas destacadas se encienden con 0,25 s de separación; etiqueta abajo dentro de la franja. **Datos**: `es-atlas@0.6.0/es/autonomous_regions.json` para España y `world-atlas@2` (countries-50m o 110m) para Europa y el mundo, instalados con npm. Europa = proyección recortada al continente. Los nombres para `destacar` salen de las propiedades del atlas, con una tabla de alias en español → inglés (por ejemplo `Inglaterra` → `United Kingdom` + aviso).
  - `barras`: máximo 6 barras en vertical (ocupan de 420 a 1250 px), título arriba, año grande a la derecha de la cabecera, la primera barra en color de acento y fuente pequeña abajo ("Fuente: …" si el guion añade `fuente:`; si no, nada; **nunca** "Placeholder data").
  - `cifra`: número de 300+ px que cuenta desde 0 en el 60 % del bloque con `power2.out`, golpe de cámara al llegar y etiqueta debajo.
  - `titulo3d`: `extruded-logo` con `texto` como variable y cámara reencuadrada para vertical (letras a 1000 px de ancho máximo).
  - `tunel`: `gallery-tunnel` con `images` = las fotos del vídeo, `imageMix 0.85`, paleta del tema y cámara en vertical.
  - `cartel`: texto en Anton tan grande como quepa (como `tamanoGancho`) sobre el `fondo`, con la ola de grosor de `weight-wave` si la fuente lo permite. Si no, entrada palabra a palabra con blur 6 → 0 px, separadas 0,067 s.
- Los subtítulos siguen visibles encima de cualquier escena.

---

## 5. Fondos con shaders WebGPU (`fondo`)

- Bloques del catálogo `aurora`, `plasma`, `nebula`, `mesh-gradient`, `flowing-gradient`… Llevan `data-requires-webgpu` y la librería `compositions/lib/shaders.iife.js`. Cópiala a `assets/vendor/` y ajusta la ruta.
- **El servidor corre en Windows, con la tarjeta gráfica de la máquina.** El render tiene que pasar `--browser-gpu` cuando la composición incluya un shader WebGPU. Sin shaders, se mantiene el modo por defecto (determinista con SwiftShader).
- **Comprobación de capacidad** al arrancar (y cacheada en `logs/capacidades.json` con fecha): renderiza en una carpeta temporal una composición mínima de 1 s con `aurora` y `--browser-gpu`, y comprueba que el fotograma del medio no sea negro (luminancia media > 8). El resultado se expone en `footy_capacidades`.
- **Fallback:** sin WebGPU, `fondo` se sustituye por un gradiente animado en CSS con los colores del tema (dos `radial-gradient` que se desplazan con GSAP), y el job devuelve un aviso que lo dice. Nunca falla el render por esto.
- La salida sigue siendo 1080×1920 a 30 fps. Compara con ffprobe como hoy.

---

## 6. Música

- Sigue entrando como en v1 (`ffmpeg -stream_loop`), con estos cambios:
  - `musica_desde`: `-ss` antes de `-i`.
  - Fade in de 0,5 s y fade out de 1 s.
  - **Ducking:** con `npx hyperframes audio --json` (o `silencedetect` de ffmpeg sobre `voz.mp3`) se sacan los huecos de voz de más de 0,6 s. La música va al `musica_volumen` bajo la voz y sube a ×1,8 en los huecos, con rampas de 0,25 s. Se implementa con la automatización de volumen de HyperFrames (`data-automation`, carril de volumen) si existe en 0.8.206. Si no, aplica la curva con ffmpeg (`volume` con expresión por tiempo) al preparar `musica.mp3`.
  - `normalize-audio`: la voz a −14 LUFS integrados, la música relativa a ella.
- **`cortes_al_ritmo`:** `npx hyperframes beats --json` sobre la pista ya recortada. Cada cambio de bloque se mueve al beat más cercano si está a ±0,2 s, sin salirse del hueco entre la última palabra de un bloque y la primera del siguiente. Los subtítulos no se mueven.
- Nueva herramienta `footy_musica` (§8).

---

## 7. Catálogo: qué instalar y dónde

Instálalos con `npx hyperframes add <nombre>` en una carpeta de trabajo y deja la versión adaptada (vertical, local y con variables) en `plantilla/piezas/`. Apunta en el README qué se cambió de cada uno.

| Pieza | Del catálogo |
|---|---|
| Gancho | `headline-slam` |
| Destellos | `organic-light-leak-overlay` |
| Viñeta | `vignette` |
| Videocámara | `camcorder-hud` |
| Película | `grain-overlay` |
| Subtítulos | `caption-pill-karaoke`, `caption-neon-glow`, `caption-kinetic-slam` |
| Mapas | `spain-map`, `world-map` |
| Barras | `bar-chart-race` |
| Cifra | `mk-progress-stat` |
| Título 3D | `extruded-logo` |
| Túnel | `gallery-tunnel` |
| Cartel | `weight-wave` |
| Fondos | `aurora`, `plasma`, `nebula`, `mesh-gradient` |

Dependencias npm (fijadas en `package.json`): `gsap@3.15.0` (ya está), `three@0.184.0`, `d3@7`, `topojson-client@3.1.0`, `es-atlas@0.6.0`, `world-atlas@2`, `@fontsource-variable/inter`, y las fuentes `@fontsource/*` que pidan las piezas (Bebas Neue, Space Mono, JetBrains Mono, Outfit, Geist si aplica).

Para los recursos de cada vídeo, copia a `_composicion/assets/` **solo lo que se use** (Three.js pesa ~25 MB entre build y addons: cópialo solo si hay escena 3D).

---

## 8. Herramientas MCP

Las 7 de v1 siguen, con estos cambios, y se añaden 5 nuevas. Las descripciones tienen que ser cortas y completas, porque son lo único que Claude ve al empezar cada chat.

| Herramienta | Cambio |
|---|---|
| `footy_guardar_guion` | Valida el formato v2. Descripción: los campos en una línea cada uno y "detalle completo en footy_ayuda". |
| `footy_estado` | Muestra las opciones v2 activas, las imágenes requeridas según las escenas, si el fondo irá con GPU o con fallback y la música (pista, desde, volumen, BPM si se calculó). |
| `footy_listar` | "6 imágenes" pasa a ser "imágenes requeridas N/M". |
| `footy_renderizar` | Sin cambios de interfaz. Añade `check` antes del render y `--browser-gpu` cuando toque. |
| **`footy_ayuda()`** | Devuelve el formato completo del guion v2 desde `src/formato.ts`, con un ejemplo por tipo de escena y las listas válidas (regiones, fondos, looks, estilos de subtítulos). |
| **`footy_capacidades()`** | GPU/WebGPU (sí/no y fecha de la prueba), versiones de HyperFrames, FFmpeg y Chrome, fondos disponibles y si la telemetría está desactivada. Con `reprobar=true`, repite la prueba de GPU. |
| **`footy_vista_previa(id, segundos[])`** | Monta la composición y saca fotogramas con `hyperframes snapshot --at` sin renderizar el vídeo. Devuelve una hoja de contacto como imagen MCP (máx. 8 fotogramas, 270×480 cada uno). Necesita voz y guion válidos. |
| **`footy_musica()`** | Lista `FOOTY_ROOT\_musica` con duración, BPM (`hyperframes beats`) y sonoridad. Cachea el resultado por archivo y fecha de modificación. |
| **`footy_catalogo(consulta)`** | `hyperframes catalog --query "<consulta>" --json`: nombre, tipo, descripción y si ya está adaptado en `plantilla/piezas/`. Solo lectura. |

---

## 9. Trampas conocidas (pasaron de verdad el 26-27/10)

1. **CDN en los bloques.** Casi todos traen `<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/...">`, Three.js, d3, topojson, clipper, `<link>` a Google Fonts y `fetch()` de datos. Sin red, el render falla o sale en blanco. Reescribe todo a `assets/vendor/…` (el patrón está en `referencia-v2/localize.py`) y haz que `check` falle si queda algún `https://` en la composición.
2. **Import maps.** `{"three": "assets/vendor/three184/three.module.js"}` se ignora ("Bare specifier"): **la ruta tiene que empezar por `./`**. Ese fue el motivo de que `extruded-logo` y `cuboid-carousel` salieran vacíos. Con `./` funcionan.
3. **Fuentes.** HyperFrames solo trae algunas familias (Inter, Montserrat, Outfit, Oswald, League Gothic, Space Mono, JetBrains Mono, Lato, Poppins…). Cualquier otra (Anton, Inter Tight, Bebas Neue, Geist) necesita `@font-face` en **cada** subcomposición que la use. Si no, da el error de lint `font_family_without_font_face`.
4. **`letterSpacing` animado** da un error de lint (`gsap_non_transform_motion`). Anima `scaleX` u opacidad.
5. **Temblores con `.to()` encadenados** dan `overlapping_gsap_tweens`. Usa `fromTo` con posición explícita por paso.
6. **Medir el DOM en callbacks** (`getTotalLength`, `getBoundingClientRect` dentro de `onUpdate`) da un aviso y ralentiza. Precalcula al montar.
7. **`tl.set` a 0 para ocultar** no se pinta en el fotograma 0. Usa `fromTo`.
8. **`split-flap-board`:** el alfabeto marca el recorrido de cada pestaña; para cifras, pon los números primero en `flapAlphabet`.
9. **Datos de ejemplo** en los bloques ("Placeholder data", "NOVA", "Streaming Subscribers"). Revisa que no quede ninguno.
10. **Dos `index.html` raíz** en la misma carpeta dan `multiple_root_compositions`. No dejes copias de trabajo dentro de `_composicion/`.
11. **Telemetría:** `npx hyperframes telemetry disable` una vez en la instalación. Documéntalo y compruébalo en `footy_capacidades`.

---

## 10. Pruebas y criterios de aceptación

**Sin gastar créditos de ElevenLabs.** Extiende `render:mock` a `npm run render:matriz`, que genera estos vídeos con voz sintética (tono de ffmpeg) y un `palabras.json` sintético con palabras reales para que `golpe` y `enfasis` tengan dónde engancharse:

| id | Contenido |
|---|---|
| `footy990` | Guion v1 puro: tiene que salir igual que v1 salvo el gancho |
| `footy991` | `etiqueta` + `golpe` + `enfasis` + `destellos` + subtítulos `pildora` |
| `footy992` | `look: videocamara` + `fecha` + subtítulos `neon` |
| `footy993` | Escenas `mapa` (españa) en el 2 y `barras` en el 4 |
| `footy994` | Escenas `cifra` en el 3, `titulo3d` en el 5 y `cartel` con `fondo: aurora` en el 6 |
| `footy995` | Escena `tunel` en el 1 + `look: pelicula` + música con `musica_desde`, ducking y `cortes_al_ritmo` |
| `footy996` | Igual que 994 pero forzando el fallback sin GPU (`FOOTY_FORZAR_SIN_GPU=1`) |

Para cada uno: `check` sin errores, mp4 de 1080×1920 con audio, duración ±0,5 s y una hoja de contacto en `test/salidas/footy99N.jpg` con un fotograma por bloque, más uno en el golpe y otro en el segundo 0,5.

**Criterios:**
1. `npm run build`, `npm test` y `npm run render:matriz` pasan.
2. Ningún `https://` dentro de ninguna `_composicion/` generada.
3. En las hojas de contacto: el gancho no se pisa con el primer subtítulo; ningún texto sale de la franja 168-1330 px ni queda bajo los 140 px de la derecha; los mapas y las barras muestran los datos del guion; no aparece ningún texto de ejemplo del catálogo.
4. `footy996` sale con el fallback y su job trae el aviso; `footy994` sale con el shader de verdad si `footy_capacidades` dice WebGPU = sí.
5. Validación: cada regla de §2 tiene su test con el mensaje esperado.
6. Las 12 herramientas aparecen en el chat después de cerrar Claude Desktop del todo desde el Administrador de tareas. `footy_ayuda` devuelve el formato completo.
7. Un guion v1 ya existente (`C:\Footy\footy001`) se puede volver a renderizar sin tocarlo.

---

## 11. Material de referencia (`referencia-v2/`)

Es código que ya renderizó bien en el entorno de Claude. Úsalo para copiar valores, estructura y adaptaciones; no lo pegues tal cual, porque está pensado para 16:9 salvo `short-pro`.

- `short-pro/`: **el short vertical bueno** (footy001-pro): `index.html` completo con gancho, etiqueta, viñeta, destellos, flash, punch-in, golpe y énfasis, más `compositions/hook-slam.html` (headline-slam ya adaptado) y `build_pro.py`, que muestra cómo se inyectó cada capa. Base de §4.1-4.7.
- `localize.py`: reescritura de CDN a local (§9.1).
- `reel/`: el showcase de 60 s. `index.html` raíz con hosts y `data-variable-values`, `compositions/scenes/*.html` (escenas propias), versiones ya localizadas de `bar-chart-race`, `gallery-tunnel`, `rack-focus`, `camcorder-hud`, `split-flap-board` y `weight-wave`, y `build_index.py`.
- `bloques-arreglados/`: `extruded-logo`, `cuboid-carousel` y `spain-map` funcionando tras los arreglos de §9.2 y los datos de npm, con `harness.py`, que monta un bloque suelto y saca fotogramas para probarlo.

---

## 12. Orden de implementación

1. `src/formato.ts` + validador v2 + tests (§2). `footy_ayuda`.
2. Refactor de `composicion.ts` a raíz + subcomposiciones (§3), con un guion v1 saliendo igual. Gancho nuevo (§4.1).
3. Capas: flash y punch-in, viñeta, etiqueta, golpe, destellos y énfasis (§4.2-4.7).
4. Instalación y adaptación de piezas del catálogo + vendor local + `check` sin `https://` (§7, §9).
5. Looks y estilos de subtítulos (§4.8-4.9).
6. Escenas: cifra → cartel → barras → mapa → titulo3d → tunel (§4.10).
7. Fondos WebGPU, prueba de capacidad y fallback (§5). `footy_capacidades`.
8. Música v2 y `footy_musica` (§6).
9. `footy_vista_previa` y `footy_catalogo`.
10. `render:matriz` y criterios de aceptación (§10). README: instalación, campos nuevos, telemetría y desviaciones del plan v2.

## 13. Fuera de alcance

- Subir a YouTube (lo hace `youtube-mcp-server`).
- Buscar o descargar fotos o música: las pone el usuario.
- Cambiar `youtube-mcp-server` o `kb-seo`.
- Formatos horizontales: el canal es solo de shorts verticales.
