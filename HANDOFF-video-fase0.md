# Handoff: módulo Vídeo, cierre de la fase 0 (2026-10-28)

Pega este documento entero como primer mensaje de la sesión que planifique la fase 1, abierta en
`C:\Users\Marc\Documents\PROJECTS\AUTOMATION TOOLS` sobre la rama `feat/video-hyperframes`
(rebasada sobre `origin/ds/v1`). Lee antes `SPEC-video.md` (D6, D10 y D11 ya llevan los resultados),
`video-mcp-server/LICENCIAS.md` y los dos informes de `video-mcp-server/spikes/`.

---

## Contexto en tres líneas

La fase 0 (integración técnica) está construida y revisada: el motor footy vive en el repo como
`video-mcp-server/`, sin temática ni marca; el backend lo lanza como proceso hijo MCP por stdio; la
clave de ElevenLabs va al almacén de secretos; y el instalador lleva Node, navegador y ffmpeg LGPL.
**La fase 1 no puede empezar todavía:** la puerta de licencias tiene **dos bloqueantes** (GSAP y
Chrome for Testing) y el spike de preview no cumplió su criterio de salida. Todo eso lo decide Marc.

## Qué se construyó (por tarea)

| Tarea | Commits | Qué quedó |
|---|---|---|
| Spec y plan | `05346af`, `3a92a23` | `SPEC-video.md`, `PLAN-video-fase0.md` |
| 1 · Traer footy | `3a92a23..07a2086` | `video-mcp-server/` (TypeScript, 12 tools) importado del repo de footy |
| 2 · Spike de codificación (D11) | `07a2086..f680c2f` | `spikes/codificacion.mjs`, `spikes/medidas.mjs`, `INFORME-codificacion.md`; ffmpeg LGPL elegido y fijado |
| 3 · Spike de preview (D6) | `f680c2f..f9384e8` | router `app_backend/spike_preview.py`, página `app-ui/src/spikes/PreviewSpike.tsx`, `frame-src` en `devCsp`, conductor Playwright, `INFORME-preview.md` |
| 4 · Generalizar el motor (G1) | `f9384e8..c873d41` | sin fútbol ni «footy»; tools `video_*`; variables `VIDEO_*`; modo integrado (`VIDEO_ENGINE_EMBEDDED=1`) |
| 5 · Huecos de seguridad del motor | `c873d41..bb4edad` | timeout de render que mata el árbol de procesos; `--` en `catalog`; realpath ante symlinks |
| 6 · Clave de ElevenLabs (D7) | `bb4edad..7901ff5` | `elevenlabs_api_key` en el almacén de secretos, `has_elevenlabs_key`, validación de la clave |
| 7a · Ajustes del motor | `7901ff5..9a95e6c` | minors aplazados de 4 y 5: timeouts acotados, catálogo, respaldo de `taskkill`, mensajes en modo integrado |
| 7 · `MotorVideo` (D1) | `9a95e6c..7a621d5` | cliente MCP por stdio en `app_backend/video.py`: arranque perezoso, un solo hijo con llamadas concurrentes, relanzado si muere, timeout; `GET /video/capacidades` |
| 8 · Empaquetado (D10) | `7a621d5..0b0a4ac` | `app-ui/scripts/prepare-video-engine.sh` (versiones y SHA-256 fijados), recursos en `tauri.conf.json`, smoke test del motor desde el bundle, clave oculta también en `datos`, `mcp==2.3.*` |
| 9 · Licencias y cierre | `0b0a4ac..ef14731` (+ ronda de correcciones) | `video-mcp-server/LICENCIAS.md`, SPEC (D6, D10, D11), este handoff; aviso OFL de Recursive y atribución del IGN en `LICENSES/` |

Ninguna tool nueva entra en `registry.build()` (D2): `test_registry.py` no cambia.

## Cifras de los spikes

**Codificación (D11), composición de 50,4 s, RTX 4060:**

| | Tiempo | Notas |
|---|---|---|
| Rápido (HyperFrames → H.264 con NVENC) | 517 s | captura 6 m 29 s |
| Compatible mov + `h264_mf` | 785,7 s | intermedio 785 MB |
| Compatible mov + `h264_nvenc` | 781,8 s | |
| Compatible webm + mf / nvenc | 835,8 / 833,8 s | intermedio 6,3 MB |

- Intermedio decidido: **mov (ProRes 4444)**; webm como reserva si falta disco.
- `h264_mf` ignora el bitrate (~3,2 Mb/s, Constrained Baseline); NVENC lo respeta con `-rc`.
- SSIM/PSNR frente a ProRes: Rápido 0,9958 / 52,1 dB; mov→mf 0,9961 / 52,6; mov→nvenc 0,9979 / 56,5
  (indicativas: fondos lisos, cadena de medición con una anomalía sin explicar en webm).
- La captura de Chrome es el cuello: 8–14 min por 50 s.

**Preview (D6):** seek mediana 14 ms en WebView2 (máx. 21); 135 fps en WebView2 con la Radeon 780M,
59–60 fps en Chrome con la RTX (limitado a 60); deriva audio/vídeo −6…+8 ms en 50 s, desfase instantáneo
hasta ~50 ms. Fotogramas iguales al MP4 con la página recién cargada (SSIM 0,93–0,98), **distintos tras
reproducir 50 s** (SSIM 0,60–0,86 en 10 s y 25 s): fase del shader `aurora`.

**Bundle:** `video-engine/` 783 MB sin comprimir (navegador 270, `app/` 220, ffmpeg 209, Node 84).

## Decisiones pendientes de Marc (con mi recomendación)

1. **GSAP — BLOQUEANTE.** La licencia de Webflow prohíbe usar GSAP en herramientas que permiten crear
   animaciones visuales sin código («Prohibited Uses», restricción III.1 de
   https://gsap.com/standard-license). SEO Studio es eso, con o sin editor.
   **Recomiendo** reescribir las plantillas con **Web Animations API** (adaptador `waapi` del runtime
   de HyperFrames) **más un motor de tiempo propio**: WAAPI solo anima propiedades CSS, y cinco piezas
   animan objetos JS con setters de GSAP (contador del HUD de `capas`, reloj de `escena-barras`, cuenta
   de `escena-cifra`, three.js de `escena-titulo3d` y `escena-tunel`). Candidato sin verificar: el
   evento `hf-seek` del runtime, o un adaptador propio. Es una tarea propia de la fase 1 (14 piezas +
   motor de tiempo + comparación de fotogramas por pieza), no un retoque, y **empieza por un spike**
   con una pieza CSS y una JS en preview y render. Al adoptarla, excluir del bundle las copias de gsap
   que trae el propio paquete `hyperframes`. Plan B: anime.js. No recomiendo pedir consentimiento a
   Webflow como base: puede terminar la licencia a su discreción (V) y endurecer las versiones futuras.
2. **Chrome for Testing — BLOQUEANTE (dudosa / no concedida).** Binario de Google («All rights
   reserved», términos de Google: «You may not copy, modify, distribute…»), sin concesión de
   redistribución. En Windows HyperFrames captura siempre por pantallazo y acepta cualquier navegador
   por `HYPERFRAMES_BROWSER_PATH`, así que no necesita headless-shell.
   **Recomiendo un spike con un snapshot de Chromium precompilado** (`chromium-browser-snapshots`,
   BSD, sin marca de Google, sin compilar nada; revisión y SHA-256 fijados) comparado por SSIM con el
   render del CfT. Si pasa, va en el instalador y se mantiene la robustez sin red de D10; sacrifica
   tamaño (~370 MB de zip, navegador completo), builds de tronco no estables y códecs propietarios
   (verificar clips H.264). **Si no pasa, descarga del CfT en el primer uso** con el SHA-256 ya fijado
   (sacrifica el primer render sin red; quita 270 MB). Descartados como base: WebView2 Fixed Version
   (redistribuible por Microsoft, pero no se lanza en headless y HyperFrames no sabe conectarse a un
   navegador abierto), Chromium compilado por nosotros (muy caro de mantener) y Edge del sistema (sin
   versión fija; solo de reserva).
3. **ffmpeg — condiciones antes de la primera versión pública.** Publicar el código fuente
   correspondiente (ffmpeg y bibliotecas LGPL estáticas) y reunir los avisos BSD/MIT de las estáticas.
   **Recomiendo** una **build LGPL propia y mínima**: cumple ambas cosas, quita `libopenh264` (riesgo de
   patentes: compilado desde fuente no lo cubre Cisco) y recorta tamaño.
4. **Fallo de fase del shader en la preview.** **Recomiendo** diagnosticar la causa raíz acotado en
   tiempo, con el seek de calentamiento como red; fondo CSS solo en la preview si no sale. Si se adopta
   WAAPI (punto 1), repetir la comparación de fotogramas con las plantillas nuevas.
5. **Tamaño del instalador (783 MB vs ≈300 MB de la spec).** Depende del punto 2: el snapshot de
   Chromium lo empeora y la descarga en el primer uso lo reduce. **Recomiendo** decidir el 2 primero,
   build mínima de ffmpeg (punto 3), revisar si `three147` (con `three`, 73 MB) sigue siendo necesario
   y probar LZMA en NSIS; medir el instalador comprimido después, no antes.
6. **Bitrate (abierto).** **Recomiendo** medir en la fase 1 con fotos reales y 60 s (`h264_mf` y NVENC
   vbr/cbr/cq, SSIM/PSNR frente al intermedio) y, en NVENC, pasar a calidad constante (`-rc vbr -cq N`)
   si los números lo permiten; `h264_mf` no se puede controlar, así que el bitrate solo rige en GPU.
7. **Render de 8–14 min por 50 s.** **Recomiendo** una tarea de rendimiento al inicio de la fase 1
   (`--workers`, ruta de captura, `forceScreenshot`) y que la UI lo trate como job largo con progreso
   y estimación; el timeout del render debe dimensionarse con estas cifras.
8. **Windows elige la GPU.** WebView2 usó la Radeon 780M; `powerPreference` se ignora en Windows. **Recomiendo**
   no suponer GPU en la fase 1, documentar al usuario cómo fijar «Alto rendimiento» para `app-ui.exe` y
   `msedgewebview2.exe`, y registrar en el job qué adaptador se usó.

## Lo aparcado y los minors que la fase 1 debe recoger

**Aparcado:**
- Chrome huérfano en POSIX (Puppeteer lo lanza en su propio grupo): solo se distribuye para Windows,
  donde `taskkill /T` cubre el árbol. Antes de usar el motor en Linux/VPS hay que recorrer el árbol.
- Ruling 1: la medición de la preview dentro de la app con la RTX quedó como paso manual (abajo).
- **Ruling 6 (mantener en la fase 1):** el binario congelado **no acepta ninguna ruta alternativa
  para el motor**: siempre usa `exe.parent/video-engine`. El smoke test monta una junction temporal en
  vez de un override. Un override por entorno o argumento reabriría la vía de exfiltración (un
  `node.exe` ajeno recibiría la clave de ElevenLabs en su entorno). Si se descarga el navegador en el
  primer uso, la misma regla aplica a su ruta: fija, dentro del estado de la app y verificada por hash.

**Minors aplazados:**
- **Borrar el spike de preview** (`app_backend/spike_preview.py` y su test, `app-ui/src/spikes/`,
  `frame-src` de `devCsp`, `scripts/spike-preview-medir.mjs`) **como primer paso del plan de la fase 1**,
  después de la medición manual de Marc. No se ha borrado en la fase 0 a propósito (Ruling 7): Marc lo
  necesita para medir. Hasta entonces el módulo viaja en el sidecar (solo se monta con
  `APP_BACKEND_SPIKES=1`). Su regex de `<head>` es engañable por un comentario HTML previo (irrelevante
  si se borra).
- Preview real: validar forma e id de las respuestas `postMessage`; rotar la clave de la URL de capacidad
  por proyecto/sesión; añadir `frame-src http://127.0.0.1:*` al `csp` real; fijar de dónde sale el runtime.
- El timeout de una llamada al motor tumba las demás llamadas en curso de la sesión: documentarlo y
  diseñarlo para renders largos (canal o sesión aparte para el render).
- La ruta de render futura también lanza la prueba de GPU (`hayWebgpu`): necesitará timeout largo.
- Firma GPG de `SHASUMS256.txt` de Node sin verificar (ancla de confianza documentada en el script).
- TOCTOU entre validación y copia de recursos, y hardlinks (riesgo bajo, requiere escritura local); el
  test de symlink nunca se ejecutó en esta máquina (Windows sin modo desarrollador).
- Test de clave guardada que borra fuera de `finally`; `_cliente` async sin `await`; timeout fijo de 15 s
  en la validación de ElevenLabs.
- Hack `globalThis.__fake` en `ajustes7a.test.ts`; `estado()` llama a `imagenesValidadas` sin proteger.
- Informe D11: el dato 3 965 kb/s solo está en ffprobe (no en `medidas.json`); medir el tiempo del
  comando NVENC `-rc vbr` recomendado.
- Licencias (menores): copiar el texto Apache-2.0 de `puppeteer-core` a `LICENSES/` (el paquete no lo trae);
  sugerir la atribución «© Instituto Geográfico Nacional» en la descripción del vídeo cuando se use el
  mapa de España (CC BY 4.0).
- Observado en la tarea 9, sin revisar: varias composiciones de `catalogo/compositions/` cargan GSAP, three,
  d3 y fuentes desde `cdn.jsdelivr.net`. Si alguna se usa en un render, choca con «la composición no puede
  referenciar URLs externas» (D10); y cargan GSAP, que cae en el punto 1.

## Pasos manuales pendientes de Marc

1. **Instalar la app y comprobar el motor desde la instalación.** Construir el instalador
   (`bash scripts/prepare-video-engine.sh` y `pnpm tauri build` desde `app-ui/` en Git Bash), instalarlo y,
   desde `app-backend/` en PowerShell, lanzar el smoke test contra el binario instalado (encuentra solo
   `video-engine` junto al exe):

   ```powershell
   uv run python scripts/smoke_test.py "$env:LOCALAPPDATA\SEO Studio\app-backend.exe"
   ```

   Debe imprimir `GET /video/capacidades OK` (HyperFrames 0.8.206, telemetría desactivada, ffmpeg LGPL y
   Chrome del bundle). Si la carpeta de instalación es otra, usa esa ruta. Tarda hasta ~5 min la primera
   vez (prueba de GPU). *Nota:* este paso valida el empaquetado actual, que todavía lleva Chrome y GSAP;
   no es una aprobación de licencias.
2. **Medición de la preview en WebView2 con la RTX.** Procedimiento completo en
   `video-mcp-server/spikes/INFORME-preview.md`, sección «Procedimiento manual para Marc». Resumen: montar
   la composición (`node spikes/preview-montar.mjs "<bin del ffmpeg LGPL>"`), `pnpm tauri dev` con
   `APP_BACKEND_SPIKES=1`, `APP_BACKEND_SPIKE_COMPOSICION`, `APP_BACKEND_SPIKE_RUNTIME`,
   `APP_BACKEND_SECRETS=file` y un `APP_BACKEND_DIR` temporal; en la consola de la app
   `location.hash = "#/spike-preview"`, pulsar **Medir** y copiar el JSON. Repetir tras fijar
   `app-ui.exe` y `msedgewebview2.exe` en «Alto rendimiento» (Configuración → Sistema → Pantalla →
   Gráficos). Mirar también a ojo el fallo de fase (play entero → seek a 10 s) y escuchar la sincronía
   con voz real.

## Seguridad (lo que cambia con las decisiones)

- Si se elige la descarga de Chrome en el primer uso: es un binario ejecutable bajado en tiempo de ejecución. Defensa:
  HTTPS, SHA-256 fijado comprobado **antes** de abrir el zip, extracción en carpeta nueva y vacía,
  nunca reutilizar una carpeta escribible sin volver a verificar; si el hash no cuadra, error visible.
- WAAPI no añade código de terceros a la composición (menos superficie que GSAP).
- La preview sigue aislada (iframe sin `allow-same-origin`); la salida del modelo sigue siendo solo datos
  validados por esquema.

## Hechos verificados que conviene no volver a investigar

- HyperFrames 0.8.206 no depende de gsap (no está en sus `dependencies`) y su runtime trae adaptadores
  `waapi`, `css`, `animejs`, `lottie` y `gsap`.
- El paquete npm de gsap no incluye el texto de la licencia; solo remite a la URL.
- En Windows HyperFrames captura siempre por pantallazo (`beginframe` solo en Linux), acepta cualquier
  navegador por `HYPERFRAMES_BROWSER_PATH` y solo lanza (`puppeteer.launch`), nunca se conecta.
- El paquete `hyperframes` trae su propia copia de gsap 3.15.0 (`dist/vendor/npm/`, `dist/studio/`).
- `LICENSE.headless_shell` de Chrome for Testing son las licencias abiertas de Chromium (2,1 MB); el `ABOUT`
  es el que lo identifica como Google Chrome bajo los términos de Google.
- En `app-backend`, los tests se lanzan con `uv run --extra dev pytest`.
