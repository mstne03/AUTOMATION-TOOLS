# Licencias del motor de vídeo (puerta de la fase 0, D10)

Revisión del 2026-10-28 sobre lo que viaja en `<instalación>/video-engine` (lo que monta
`app-ui/scripts/prepare-video-engine.sh`) y en `video-mcp-server/`. Pregunta que responde cada fila:
**¿se puede redistribuir dentro del instalador de una app de pago y de código cerrado?**
Textos leídos en el propio paquete o descarga salvo donde se indica la URL. No es asesoría
jurídica: donde hay duda se marca y se lleva a Marc.

## Veredicto

**Dos piezas BLOQUEANTES. No se avanza a la fase 1 hasta que Marc decida su sustitución.**

| Pieza | Veredicto | Alternativa recomendada |
|---|---|---|
| **GSAP 3.15.0** | **BLOQUEANTE** — la licencia prohíbe su uso en herramientas que permiten crear animaciones visuales sin código, que es lo que es el producto (no solo el editor). | Reescribir las plantillas con **Web Animations API** (nativa, sin licencia de terceros) a través del adaptador `waapi` que ya trae el runtime de HyperFrames; anime.js como plan B. |
| **chrome-headless-shell 152 (Chrome for Testing, Google)** | **BLOQUEANTE (dudosa)** — es un binario de Google con marca «Google Chrome», «All rights reserved» y sujeto a los términos de Google, que prohíben distribuir su software. No hay ninguna concesión de redistribución. | **Descargarlo en el primer uso** desde el almacén oficial de Google con el SHA-256 ya fijado (lo hace Google, no nosotros). Alternativas: Chromium `headless_shell` compilado por nosotros (BSD) o el Edge del sistema. |
| ffmpeg LGPL 7.1 (BtbN) | Sí, **con condiciones pendientes** antes de publicar (código fuente correspondiente y avisos de las bibliotecas estáticas). Riesgo de patentes a decidir. | Build LGPL propia y mínima (también reduce tamaño). |
| Resto (HyperFrames, Node, three, d3, topojson, atlas, fuentes, shaders, dependencias de npm) | Sí, con aviso (ya incluido) o atribución. | — |

## Tabla por pieza

| Pieza | Versión | Licencia | ¿Redistribuible en .exe cerrado? | Condiciones | Fuente del texto |
|---|---|---|---|---|---|
| hyperframes | 0.8.206 | Apache-2.0 | Sí | Incluir la licencia (hecho: `LICENSES/hyperframes-LICENSE.txt`); conservar avisos. El repo no tiene `NOTICE` en la raíz (sí `CREDITS.md`, que no es un NOTICE de Apache §4d). | `app-ui/scripts/licencias/hyperframes-0.8.206-LICENSE.txt` (repo, etiqueta v0.8.206; el paquete npm no lo trae) |
| **gsap** | 3.15.0 | «Standard 'no charge' license» de GreenSock/Webflow | **No para este producto → BLOQUEANTE** | Ver sección GSAP. | `node_modules/gsap/package.json` (`license`), cabecera de `gsap-core.js` y `README.md` remiten a https://gsap.com/standard-license (leída el 2026-10-28; versión con fecha efectiva 30-04-2025, actualizada 30-05-2025). El paquete no incluye el texto. |
| three | 0.184.0 | MIT | Sí | Aviso (hecho: `three-LICENSE.txt`) | `node_modules/three/LICENSE` |
| three147 (`three@0.147.0`) | 0.147.0 | MIT | Sí | Aviso (hecho: `three-0.147-LICENSE.txt`) | `node_modules/three147/LICENSE` |
| d3-geo / d3-array | 3.1.1 / 3.2.4 | ISC | Sí | Aviso (viaja en `app/node_modules/<paquete>/LICENSE`) | `node_modules/d3-geo/LICENSE` |
| topojson-client | 3.1.0 | ISC | Sí | Aviso (en `node_modules`) | `node_modules/topojson-client/LICENSE` |
| world-atlas | 2.0.2 | ISC (código); datos de Natural Earth 4.1.0, dominio público | Sí | Aviso (en `node_modules`) | `node_modules/world-atlas/LICENSE` y `README.md` |
| es-atlas | 0.6.0 | MIT (código); **datos del IGN bajo CC BY 4.0** | Sí | **Atribución al IGN**: añadida a `LICENSES/LEEME.txt` en esta tarea. Los vídeos con el mapa de España son obra derivada que el usuario publica: la fase 1 debe sugerir «Mapa: © Instituto Geográfico Nacional» en la descripción cuando se use. | `node_modules/es-atlas/LICENSE` y `README.md` («Data license») |
| Fuentes Anton, Inter Tight, JetBrains Mono (@fontsource) | 5.3.0 | OFL-1.1 | Sí | La licencia acompaña a la fuente (hecho); no vender la fuente sola; no usar el nombre reservado en versiones modificadas. | `node_modules/@fontsource/*/LICENSE` |
| Geist (catálogo) | — | OFL-1.1 | Sí | Igual (hecho: `fuente-geist-OFL.txt`) | `catalogo/compositions/assets/fonts/Geist-OFL.txt` |
| Recursive (catálogo) | — | OFL-1.1 | Sí | Igual. Viajaba junto a la fuente pero no en `LICENSES/`: **añadida en esta tarea** (`fuente-recursive-OFL.txt`). | `catalogo/compositions/assets/fonts/OFL.txt` |
| Shaders vendorizados (`shaders` 4.0.0, typegpu 0.12.3, tinyest 0.3.4, typed-binary 4.3.3, tsover-runtime 0.0.7) | ver col. | MIT (los cuatro primeros), Apache-2.0 (tsover-runtime) | Sí | Avisos (hecho: `shaders-THIRD-PARTY-LICENSES.txt`; la copia del catálogo lleva el suyo al lado) | `plantilla/vendor/shaders.THIRD-PARTY-LICENSES.txt` y cabecera de `shaders.iife.js` |
| Node.js | v22.23.4 win-x64 | MIT + licencias de sus dependencias (OpenSSL Apache-2.0, ICU, etc.) | Sí | Aviso (hecho: `node-LICENSE.txt`, 148 KB, incluye las de terceros) | `LICENSE` del zip oficial |
| **ffmpeg / ffprobe** | `ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-7.1` (BtbN, autobuild-2026-07-31-14-10) | **LGPL-3.0** (`--enable-version3`, sin `--enable-gpl` ni `--enable-nonfree`, `--disable-libx264/x265`) | Sí, invocado como proceso aparte (nuestro código no enlaza con él) | Ver sección ffmpeg: **pendiente** el código fuente correspondiente y los avisos de las bibliotecas enlazadas estáticamente. | `LICENSE.txt` del zip; `configuration:` en `LICENSES/ffmpeg-version.txt` |
| **chrome-headless-shell** | 152.0.7977.30 win64 (Chrome for Testing) | Binario de Google bajo los términos de Google; contiene código Chromium (BSD-3) y terceros | **Dudoso → BLOQUEANTE** | Ver sección Chrome. | `ABOUT` y `LICENSE.headless_shell` del zip; https://policies.google.com/terms; https://www.google.com/chrome/terms/ |
| Dependencias de producción de npm (`npm ci --omit=dev`, 178 paquetes) | lockfile | 138 MIT, 19 ISC, 8 Apache-2.0, 4 BSD-3, 2 BSD-2, 3 OFL, 1 CC0, 1 0BSD, 1 Apache-2.0 AND LGPL-3.0-or-later (`@img/sharp-win32-x64`, libvips en DLL), gsap | Sí (salvo gsap) | Cada paquete lleva su licencia en `app/node_modules/<paquete>/`. `puppeteer-core` (Apache-2.0) no trae fichero `LICENSE` en el paquete: añadir el texto Apache a `LICENSES/` (menor). libvips (LGPL, enlazada dinámicamente): misma condición de código fuente que ffmpeg. Ninguna GPL. | `package.json` de cada paquete del árbol de producción del bundle local |

## GSAP: por qué es bloqueante

Texto leído: https://gsap.com/standard-license (Webflow, fecha efectiva 30-04-2025). El paquete
npm no incluye el texto completo, así que no se copia al bundle: `LICENSES/gsap-LICENSE.txt` sigue
apuntando a la URL, y la cabecera de `gsap.min.js` («Subject to the terms at …») se conserva, como
exige la restricción III.3 (no quitar avisos).

Cláusulas en las que me apoyo:

- **Definición «Prohibited Uses»** (sección I): el uso de GSAP «in tools that allow users to build
  visual animations without code», además de los usos que ayudan a crear una solución que compita con
  las herramientas de animación de Webflow.
- **Definición «Competitive Products»** (sección I): software que permite a los usuarios crear, editar
  o gestionar animaciones mediante una interfaz visual.
- **Restricción III.1**: no usar GSAP para un Prohibited Use sin consentimiento previo por escrito.
  La licencia (II) se concede *solo* para «Permitted Uses» (uso en webs, apps web o interfaces).
- **V (terminación)**: si se incumple, Webflow puede terminar la licencia y obliga a dejar de usar y
  destruir las copias. **VI.2 (modificaciones)**: tras una revisión, no se pueden usar versiones
  publicadas después de la nueva fecha efectiva — riesgo de quedarse congelado en una versión.

Aplicación a SEO Studio: el creador **construye un vídeo animado sin escribir código**: elige escenas
del catálogo, rellena datos desde el guion y, en la fase 1, mueve, recorta y reordena escenas en una
línea de tiempo visual (G3, D6). Eso encaja en la letra de las dos definiciones, y ya desde la fase 0
(el guion → vídeo animado sin código) aunque no hubiera editor. Argumentos en contra (que no bastan):
no exponemos keyframes ni curvas (no objetivo de la v1), la salida es un MP4 y no una animación web,
y el FAQ dice que el código generado por IA no es Prohibited Use — pero aquí el modelo no escribe
código (D5), y el FAQ invita a preguntar en los casos dudosos, lo que confirma que no hay permiso
implícito. Con un producto de pago construido encima, el riesgo (terminación + destruir copias) es
inaceptable sin consentimiento escrito.

**Alternativas (recomendación primero):**

1. **Web Animations API (WAAPI)** en las plantillas. HyperFrames 0.8.206 trae adaptadores de runtime
   para `waapi`, `css`, `animejs` y `lottie` además de `gsap` (`runtime.adapters.*` en `dist/`), y no
   depende de gsap (no está en sus `dependencies`). Es estándar del navegador, sin licencia de
   terceros, y el mismo motor (Chromium) la ejecuta en la preview (WebView2) y en el render. Alcance
   medido: ~110 llamadas (`fromTo` 48, `add` 45, `set` 7, `to` 6, `from` 3, `call` 1) sobre 14
   `gsap.timeline` en `plantilla/` más la composición de la sonda de `src/capacidades.ts`. Sacrifica:
   reescritura de las piezas y no poder reutilizar tal cual los bloques del registro de HyperFrames,
   que suelen usar GSAP. Antes de reescribir: un spike corto que pruebe que el seek de HyperFrames es
   determinista con WAAPI en preview y en render (fotograma a fotograma contra el MP4).
2. **anime.js** si WAAPI se queda corta (stagger, texto). Licencia a verificar al adoptarla (se
   publica como MIT; no está instalada y no la he leído).
3. **Pedir consentimiento escrito a Webflow.** Da seguridad jurídica si lo conceden, pero deja el
   producto a merced de un tercero que puede revisar la licencia (VI.2) y no resuelve las versiones
   futuras. No recomendado como base.

## Chrome for Testing: por qué es dudoso

- `ABOUT` del zip: el binario se identifica como «Google Chrome», «Copyright 2026 Google LLC. All rights
  reserved», y remite a los términos de servicio (`chrome://terms`).
- Términos de Google (https://policies.google.com/terms): el permiso de uso del software es personal y
  «You may not copy, modify, distribute, sell, or lease any part of our services or software», con la
  salvedad de las licencias de código abierto que lo digan expresamente.
- `LICENSE.headless_shell` (2,1 MB) recoge las licencias abiertas de Chromium y sus terceros; cubren el
  código, no conceden la redistribución del binario compilado y con marca de Google.
- La documentación de Chrome for Testing lo presenta como sabor para automatización y pruebas y no dice
  nada de empaquetarlo en otros productos (blog «Chrome for Testing» y repo GoogleChromeLabs, leídos
  el 2026-10-28).

Ninguna fuente concede redistribución → dudosa → bloqueante según la regla de la puerta.

**Alternativas (recomendación primero):**

1. **Descarga en el primer uso** desde `storage.googleapis.com/chrome-for-testing-public` con el SHA-256
   ya fijado en `prepare-video-engine.sh`, a una carpeta del estado de la app, verificada antes de
   extraer (mismo patrón que Puppeteer y la CLI de HyperFrames: quien distribuye es Google). Mismo binario
   ya probado; quita ~270 MB del instalador. **Sacrifica robustez offline** (D10): el primer render
   necesita red y ~114 MB de descarga; si la descarga falla hay que mostrarlo, nunca silenciarlo.
   Seguridad: SHA-256 fijado (TOFU, Google no publica SHA-256), extracción en carpeta vacía, carpeta no
   escribible por otras apps si es posible.
2. **Chromium `headless_shell` compilado por nosotros** (BSD-3, redistribuible con avisos). Máxima
   robustez offline y claridad legal; sacrifica mantenibilidad (compilar Chromium en CI: horas y ~100 GB,
   parches de seguridad a nuestro cargo) y quizá códecs propietarios (H.264 de los clips del usuario:
   a verificar si HyperFrames los decodifica con ffmpeg o en el navegador).
3. **Edge del sistema** (`msedge.exe`) vía `puppeteer-core` en modo captura por pantallazo
   (`forceScreenshot`, que HyperFrames ya usa en este equipo según el spike D11). Cero bytes y nada que
   redistribuir; sacrifica determinismo (versión no fijada, se actualiza sola) y robustez (Edge se puede
   desinstalar en el EEE; políticas de empresa). Solo como reserva.

## ffmpeg LGPL: condiciones pendientes

- **Licencia:** LGPL v3 (por `--enable-version3`). Lo invocamos como ejecutable aparte, así que SEO Studio
  no es «Combined Work» y puede seguir cerrado. Al distribuir el binario hay que cumplir la GPLv3 §6
  incorporada: acompañar el **código fuente correspondiente** (ffmpeg n7.1.5-12 y cada biblioteca LGPL
  enlazada estáticamente: gmp, libssh, libbluray, lame, twolame, soxr, openal, libaribb24…) o una oferta
  / punto de descarga que **mantengamos** nosotros. Hoy **no se hace**. Recomendación: espejo propio del
  tarball de ffmpeg y del commit de BtbN/FFmpeg-Builds usado (sus scripts fijan las versiones de cada
  biblioteca) y un enlace en `LICENSES/LEEME.txt`.
- **Avisos de bibliotecas BSD/MIT estáticas** (libvpx, libwebp, dav1d, libass, harfbuzz, zimg…): sus
  licencias exigen reproducir el aviso en la distribución binaria; el zip de BtbN solo trae el texto de
  la LGPL. **Pendiente** reunirlos.
- **Patentes (no es copyright, no bloquea esta puerta, decide Marc):** el build incluye `libopenh264`
  compilado desde fuente (la cobertura de patentes de Cisco solo vale para los binarios que Cisco
  distribuye) y codificadores que no usamos (VVC, AV1…); el codificador AAC nativo sí se usa. D11 asume H.264 con
  `h264_mf` (patentes cubiertas por la licencia de Windows) o con la GPU. Recomendación: **build LGPL
  propia y mínima** (solo `prores`/`vp9` de lectura, `h264_mf`/`h264_nvenc`/`qsv`/`amf`, `aac`, filtros
  necesarios), que además recorta buena parte de los 209 MB y facilita las dos condiciones anteriores.
