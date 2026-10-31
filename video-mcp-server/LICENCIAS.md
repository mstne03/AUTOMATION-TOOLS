# Licencias del motor de vídeo (puerta de la fase 0, D10)

Revisión del 2026-10-28 sobre lo que viaja en `<instalación>/video-engine` (lo que monta
`app-ui/scripts/prepare-video-engine.sh`) y en `video-mcp-server/`. Pregunta que responde cada fila:
**¿se puede redistribuir dentro del instalador de una app de pago y de código cerrado?**
Textos leídos en el propio paquete o descarga salvo donde se indica la URL. No es asesoría
jurídica: donde hay duda se marca y se lleva a Marc.

## Veredicto

**Una pieza BLOQUEANTE (Chrome for Testing). GSAP quedó resuelto: ya no viaja en el producto.**

| Pieza | Veredicto | Alternativa recomendada |
|---|---|---|
| GSAP | **Resuelto (SEO-112, SEO-113).** Fuera de `plantilla/`, `catalogo/`, `src/` y de las dependencias; las piezas usan WAAPI con `hf-tiempo.js`. | — |
| **chrome-headless-shell 152 (Chrome for Testing, Google)** | **BLOQUEANTE (dudosa / redistribución no concedida)** — binario de Google con marca «Google Chrome», «All rights reserved» y sujeto a los términos de Google, que prohíben distribuir su software; ninguna fuente concede redistribución. | Spike con un **snapshot de Chromium** (código abierto, BSD, precompilado; versión y SHA-256 fijados) vía `HYPERFRAMES_BROWSER_PATH`; si pasa, va en el instalador. Si no, **descarga del CfT en el primer uso** con el SHA-256 ya fijado. |
| ffmpeg LGPL 7.1 (BtbN) | Sí, **con condiciones pendientes** antes de publicar (código fuente correspondiente y avisos de las bibliotecas estáticas). Riesgo de patentes a decidir. | Build LGPL propia y mínima (también reduce tamaño). |
| Resto (HyperFrames, Node, three, d3, topojson, atlas, fuentes, shaders, dependencias de npm) | Sí, con aviso (ya incluido) o atribución. | — |

## Tabla por pieza

| Pieza | Versión | Licencia | ¿Redistribuible en .exe cerrado? | Condiciones | Fuente del texto |
|---|---|---|---|---|---|
| hyperframes | 0.8.206 | Apache-2.0 | Sí | Incluir la licencia (hecho: `LICENSES/hyperframes-LICENSE.txt`); conservar avisos. El repo no tiene `NOTICE` en la raíz (sí `CREDITS.md`, que no es un NOTICE de Apache §4d). | `app-ui/scripts/licencias/hyperframes-0.8.206-LICENSE.txt` (repo, etiqueta v0.8.206; el paquete npm no lo trae) |
| three | 0.184.0 | MIT | Sí | Aviso (hecho: `three-LICENSE.txt`) | `node_modules/three/LICENSE` |
| three147 (`three@0.147.0`) | 0.147.0 | MIT | Sí | Aviso (hecho: `three-0.147-LICENSE.txt`) | `node_modules/three147/LICENSE` |
| d3-geo / d3-array | 3.1.1 / 3.2.4 | ISC | Sí | Aviso (viaja en `app/node_modules/<paquete>/LICENSE`) | `node_modules/d3-geo/LICENSE` |
| topojson-client | 3.1.0 | ISC | Sí | Aviso (en `node_modules`) | `node_modules/topojson-client/LICENSE` |
| world-atlas | 2.0.2 | ISC (código); datos de Natural Earth 4.1.0, dominio público | Sí | Aviso (en `node_modules`) | `node_modules/world-atlas/LICENSE` y `README.md` |
| es-atlas | 0.6.0 | MIT (código); **datos del IGN bajo CC BY 4.0** | Sí | **Atribución al IGN**: añadida a `LICENSES/LEEME.txt` en esta tarea. Los vídeos con el mapa de España son obra derivada que el usuario publica: la fase 1 debe sugerir «Mapa: © Instituto Geográfico Nacional» en la descripción cuando se use. | `node_modules/es-atlas/LICENSE` y `README.md` («Data license») |
| Fuentes Anton, Inter Tight, JetBrains Mono (@fontsource) | 5.3.0 | OFL-1.1 | Sí | La licencia acompaña a la fuente (hecho); no vender la fuente sola; no usar el nombre reservado en versiones modificadas. | `node_modules/@fontsource/*/LICENSE` |
| Geist (`plantilla/fuentes/3d`) | — | OFL-1.1 | Sí | Igual (hecho: `fuente-geist-OFL.txt`) | `catalogo/compositions/assets/fonts/Geist-OFL.txt` |
| Recursive | — | OFL-1.1 | Sí | Igual. El catálogo que la usaba ya no viaja (SEO-113); su licencia sigue en `LICENSES/` (`fuente-recursive-OFL.txt`). | `catalogo/compositions/assets/fonts/OFL.txt` |
| Shaders vendorizados (`shaders` 4.0.0, typegpu 0.12.3, tinyest 0.3.4, typed-binary 4.3.3, tsover-runtime 0.0.7) | ver col. | MIT (los cuatro primeros), Apache-2.0 (tsover-runtime) | Sí | Avisos (hecho: `shaders-THIRD-PARTY-LICENSES.txt`). **Modificado respecto al upstream** (SEO-114): se sustituye una sentencia del glue de `renderSyntheticFrame` por una variante «el último gana»; el diff está en `plantilla/vendor/shaders.iife.patch` y el hash upstream sigue en `catalogo/hyperframes.lock.json`. Las licencias MIT/Apache permiten modificar; se conservan los avisos. | `plantilla/vendor/shaders.THIRD-PARTY-LICENSES.txt` y cabecera de `shaders.iife.js` |
| Node.js | v22.23.4 win-x64 | MIT + licencias de sus dependencias (OpenSSL Apache-2.0, ICU, etc.) | Sí | Aviso (hecho: `node-LICENSE.txt`, 148 KB, incluye las de terceros) | `LICENSE` del zip oficial |
| **ffmpeg / ffprobe** | `ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-7.1` (BtbN, autobuild-2026-07-31-14-10) | **LGPL-3.0** (`--enable-version3`, sin `--enable-gpl` ni `--enable-nonfree`, `--disable-libx264/x265`) | Sí, invocado como proceso aparte (nuestro código no enlaza con él) | Ver sección ffmpeg: **pendiente** el código fuente correspondiente y los avisos de las bibliotecas enlazadas estáticamente. | `LICENSE.txt` del zip; `configuration:` en `LICENSES/ffmpeg-version.txt` |
| **chrome-headless-shell** | 152.0.7977.30 win64 (Chrome for Testing) | Binario de Google bajo los términos de Google; contiene código Chromium (BSD-3) y terceros | **Dudoso → BLOQUEANTE** | Ver sección Chrome. | `ABOUT` y `LICENSE.headless_shell` del zip; https://policies.google.com/terms; https://www.google.com/chrome/terms/ |
| Dependencias de producción de npm (`npm ci --omit=dev`, 178 paquetes) | lockfile | 138 MIT, 19 ISC, 8 Apache-2.0, 4 BSD-3, 2 BSD-2, 3 OFL, 1 CC0, 1 0BSD, 1 Apache-2.0 AND LGPL-3.0-or-later (`@img/sharp-win32-x64`, libvips en DLL) | Sí | Cada paquete lleva su licencia en `app/node_modules/<paquete>/`. `puppeteer-core` (Apache-2.0) no trae fichero `LICENSE` en el paquete: añadir el texto Apache a `LICENSES/` (menor). libvips (LGPL, enlazada dinámicamente): misma condición de código fuente que ffmpeg. Ninguna GPL. | `package.json` de cada paquete del árbol de producción del bundle local |

## GSAP: resuelto (SEO-112, SEO-113)

La licencia estándar de GSAP prohíbe usarlo en herramientas que crean animaciones visuales sin código, y eso es este
producto. Se sustituyó por WAAPI y un motor de tiempo propio (`plantilla/vendor/hf-tiempo.js`), y se retiró el catálogo
que lo cargaba de jsDelivr. Las copias de `hyperframes/dist/vendor/npm/gsap@3.15.0` y `dist/studio` quedan excluidas
del bundle por W2.8.

**Origen de las curvas de `hf-tiempo.js` (duda para Marc; esto no es asesoría jurídica):** `expo`, `sine`, `power` y
`back.out`, y la derivación de `out` e `inOut` desde `in`, se escribieron a partir de las fórmulas de `gsap-core.js`
3.15, y `test/curvas.test.ts` conserva una tabla de valores generada con esa versión. Salvo `expo`, son fórmulas de uso
común; `expo` tiene una forma particular de GSAP. Hay que decidir si basta con esta nota o si se reescribe `expo` con
otra fórmula, aceptando una comparación SSIM nueva.

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

Dato técnico que amplía las alternativas: en Windows HyperFrames captura **siempre por pantallazo**
(`beginframe`, que exige headless-shell, solo se activa en Linux: `requestedCaptureMode` en
`dist/chunk-RDDVQSNQ.js`) y acepta cualquier binario por `HYPERFRAMES_BROWSER_PATH` («system Chrome
instead of the pinned chrome-headless-shell», según su propio mensaje de ayuda). En cambio, solo
**lanza** el navegador (`puppeteer.launch`); no sabe conectarse a uno ya abierto.

**Alternativas (recomendación primero):**

1. **Snapshot de Chromium precompilado** (`storage.googleapis.com/chromium-browser-snapshots/Win_x64/<rev>/chrome-win.zip`):
   builds de Chromium de código abierto, sin marca de Google, bajo BSD-3 + licencias de terceros; no
   hay que compilarlo. Se redistribuye con sus avisos y lo usa el motor por `HYPERFRAMES_BROWSER_PATH`
   en headless normal. *A verificar al descargarlo (con permiso de Marc):* que el `ABOUT`/`LICENSE` del
   zip no traiga términos de Google. Mantiene la robustez sin red de D10. Sacrifica: son builds de
   tronco no cualificados como versión estable (sin parches de rama); solo hay navegador completo, sin
   headless-shell (el zip pesa ~370 MB en la rev 1728808, frente a 114 MB del CfT: empeora el tamaño);
   sin códecs propietarios (verificar si los clips H.264 del usuario se decodifican por el adaptador
   `frame-source`/ffmpeg o en el navegador); hay que elegir la revisión del punto de rama de la 152.
   **Primer paso: spike** que renderice la composición de prueba con el snapshot y compare (SSIM) con
   el render del CfT, con fondo WebGPU y con un clip.
2. **Descarga en el primer uso** (si el spike 1 no pasa) desde `storage.googleapis.com/chrome-for-testing-public` con el SHA-256
   ya fijado en `prepare-video-engine.sh`, a una carpeta del estado de la app, verificada antes de
   extraer (mismo patrón que Puppeteer y la CLI de HyperFrames: quien distribuye es Google). Mismo binario
   ya probado; quita ~270 MB del instalador. **Sacrifica robustez offline** (D10): el primer render
   necesita red y ~114 MB de descarga; si la descarga falla hay que mostrarlo, nunca silenciarlo.
   Seguridad: SHA-256 fijado (TOFU, Google no publica SHA-256), extracción en carpeta vacía, carpeta no
   escribible por otras apps si es posible.
3. **WebView2 Fixed Version Runtime** (Microsoft): Microsoft lo documenta para empaquetarlo con la app
   con versión fija (condiciones exactas de su licencia a leer al adoptarlo). Pero `msedgewebview2.exe`
   no es un navegador lanzable en headless: lo aloja una app a través del loader de WebView2.
   HyperFrames solo lanza y no sabe conectarse, así que haría falta parchear su productor para
   conectarse por CDP a un WebView2 oculto de nuestra app (el spike de preview ya usó CDP sobre
   WebView2). Mucho trabajo y fuera de lo que HyperFrames soporta: no recomendado salvo que 1 y 2
   fallen.
4. **Chromium `headless_shell` compilado por nosotros** (BSD-3, redistribuible con avisos). Máxima
   robustez offline y claridad legal; sacrifica mantenibilidad (compilar Chromium en CI: horas y ~100 GB,
   parches de seguridad a nuestro cargo) y quizá códecs propietarios (H.264 de los clips del usuario:
   a verificar si HyperFrames los decodifica con ffmpeg o en el navegador).
5. **Edge del sistema** (`msedge.exe`) por `HYPERFRAMES_BROWSER_PATH`, en el mismo modo de captura
   por pantallazo que HyperFrames ya usa en Windows. Cero bytes y nada que
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
