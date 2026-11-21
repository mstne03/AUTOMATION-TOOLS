# Handoff: módulo Vídeo, del cierre de los spikes al arranque de la fase 1 (2026-10-29)

Pega este documento entero como primer mensaje de una sesión nueva abierta en
`C:\Users\Marc\Documents\PROJECTS\AUTOMATION TOOLS`, sobre la rama **`feat/video-fase1`**, que sale de
`origin/ds/v1`. Si la sesión arranca en otra rama, cambia a esa o crea a partir de ella las ramas de cada
paquete.

El objetivo es **sacar adelante, en paralelo y con subagentes, todo lo que queda antes de construir la
fase 1, y dejar la fase 1 planificada**. La prioridad no negociable es **la seguridad del usuario**: ningún
paquete se integra si su spec o su código abren un agujero, aunque funcione.

---

## 0. Cómo trabajar en esta sesión (léelo antes de lanzar nada)

1. **Método: Subagent-Driven Development.** Carga `superpowers:subagent-driven-development` y, para el
   plan detallado de cada paquete, `superpowers:writing-plans`.
   - Tú orquestas: escribes los briefs, lanzas los subagentes, integras y revisas.
   - Los subagentes implementan, cada uno en **su propio worktree** (`isolation: "worktree"`) y en **su
     rama**.
2. **Nunca dos subagentes escriben el mismo archivo** en la misma oleada. La columna «Escribe» de la
   sección 4 es el reparto de propiedad. Si un subagente necesita tocar un archivo de otro, se para, lo
   informa, y tú lo serializas.
3. **Revisión de seguridad obligatoria y bloqueante en dos puntos** de cada paquete (sección 3):
   - Sobre el **plan**, antes de escribir código.
   - Sobre el **diff**, antes de integrar.

   La hace el agente `cyber-security-auditor` con el modelo más capaz, y se le pasa **el diff y las
   invariantes, no las conclusiones del implementador**, para que su lectura no salga sesgada. Además de
   la revisión de spec y de calidad que ya hace SDD.
4. **Integración:** cada rama de paquete se mergea en `feat/video-fase1` solo con todo en verde:
   - tests;
   - revisión de seguridad sin Critical ni High abiertos;
   - revisión de calidad.

   Al cerrar cada oleada, una **revisión de seguridad transversal** sobre la rama integrada, porque los
   agujeros también salen de la combinación de cambios.
5. **Plane es la fuente de verdad** (proyecto `SEO`).
   - Cada paquete tiene su tarea.
   - Al empezar uno: estado *In Progress*. Con la rama empujada o la PR abierta: *In Review*.
   - Los comentarios de Plane van sin atribución.
6. **Normas del repo** (`CLAUDE.md`, obligatorias):
   - Ramas `<tipo>/<nº>-<slug>` (por ejemplo `feat/111-motor-tiempo`), nunca `claude/…`.
   - Commits a nombre de Marc (`git config user.email` = `mserraitorne@gmail.com`), en español, en
     imperativo, ≤ 72 caracteres y con `(SEO-xx)` al final.
   - **Sin ninguna atribución:** ni `Co-Authored-By`, ni enlaces de sesión.
   - Hooks: `git config core.hooksPath .githooks`.
7. **Acciones que necesitan el «sí» explícito de Marc en el chat:**
   - push y PR;
   - publicar issues en repos ajenos (HyperFrames);
   - cualquier descarga, indicando nombre, origen y tamaño;
   - comprar o dar de alta cuentas.

   El instalador **no** se ejecuta desde la sesión: las pruebas con la app instalada las hace Marc.
8. **Cómo comunicarse con Marc:**
   - En español, con «ejecución» y nunca «corrida».
   - Recomendación clara con sus trade-offs, en vez de un menú de opciones.
   - Modo didáctico en backend, seguridad y DevOps.
   - Prioridades: **robustez > mantenibilidad > escalabilidad > simplicidad**. Si un atajo sacrifica
     alguna, dilo explícitamente.

---

## 1. De dónde partimos (no reabrir)

Documentos base (léelos antes de planificar):
- `SPEC-video.md`
- `HANDOFF-video-fase0.md`
- `video-mcp-server/LICENCIAS.md`
- `video-mcp-server/spikes/INFORME-codificacion.md`
- `video-mcp-server/spikes/INFORME-preview.md`
- `video-mcp-server/spikes/INFORME-waapi.md`
- `video-mcp-server/spikes/INFORME-chromium.md`

**Decisiones tomadas el 2026-10-29:**

| Tema | Decisión | Evidencia |
|---|---|---|
| GSAP (bloqueante 1) | Se sustituye por **WAAPI + motor de tiempo propio** (`hf-tiempo.js`) | `INFORME-waapi.md`: render con SSIM ≥ 0,9945 por fotograma; preview con seek, play y seek tras play correctos; desfase ≤ 3,1 ms |
| Chrome for Testing (bloqueante 2) | **Descarga en el primer uso**, con **versión y SHA-256 fijados por nosotros**, nunca por HyperFrames. Snapshot de Chromium como plan B | `INFORME-chromium.md`: CfT 156 funciona con HyperFrames 0.8.206; el preflight de HyperFrames rechaza en Windows `chrome.exe` y `content_shell`; el snapshot no trae avisos de licencia |
| `--no-sandbox` de HyperFrames | **Sandbox del renderer activo y `--disable-gpu-sandbox`**, con parche local, test y petición a HyperFrames | Renderer en Untrusted (frente a Medium hoy); 6 de 6 renders correctos; sandbox completo = 1 de 6 (se cuelga) |
| Navegador desactualizado | Fijamos nosotros un CfT actual. HyperFrames 0.8.216 sigue en la 152 | En Windows HyperFrames no tiene techo de versión (`chromeMajorCeiling` solo afecta a macOS 12) |

**Hechos verificados que no hay que volver a investigar** (fuentes en los informes):
- El runtime de HyperFrames **desenvuelve la raíz** de cada subcomposición (el host `h-…` hace de raíz).
- `document.currentScript` es null en las subcomposiciones.
- El runtime **borra `data-duration`** del host. Los datos de la pieza llegan como marcadores
  generados, nunca leídos del DOM.
- Sin `window.__timelines`, `hyperframes check` da `missing_timeline_registry`, y el motor lo trata
  como error que bloquea. La salida oficial es `data-no-timeline` en `#root`.
- `hf-seek` se dispara en cada seek **y en cada fotograma del play**. Las animaciones WAAPI siguen en
  pausa y el runtime fija su `currentTime`.
- La `expo` de gsap 3.15 es una curva mezclada: `2^(10(p-1))·p + p⁶(1-p)`.
- En Windows, solo headless-shell contesta a `<navegador> --version`, que es lo que comprueba el
  preflight de `hyperframes render`. `hyperframes/api` no expone el render.
- HyperFrames extrae los fotogramas de los `<video>` con ffmpeg: un navegador sin H.264 no afecta a los
  clips.
- El adaptador `typegpu` del runtime pone su tiempo a `null` en `play()`, así que el shader corre con su
  propio reloj. **Es la pista principal del fallo de fase (punto 4), sin verificar.**
- HyperFrames codificó con `h264_amf` (la iGPU AMD) aunque `--gpu` viene desactivado por defecto.

**Tareas ya creadas en Plane** (subtareas de **SEO-107**, en Backlog):

| Tarea | Título |
|---|---|
| SEO-108 | Descarga de CfT en el primer uso |
| SEO-109 | Sandbox del renderer |
| SEO-110 | Codificador por hardware |
| SEO-111 | Motor de tiempo |
| SEO-112 | Migrar las 13 plantillas |
| SEO-113 | Quitar GSAP |

**Binarios disponibles en local** (git los ignora; están en el worktree
`C:\Users\Marc\Documents\PROJECTS\AUTOMATION TOOLS\.claude\worktrees\hyperframes-elevenlabs-integration-ccba9b`):
- `app-ui\src-tauri\binaries\video-engine\`: Node 22.23.4, CfT 152 y ffmpeg 7.1.5 LGPL; 783 MB.
- `video-mcp-server\spikes\salidas\chromium\descargas\cft-156-headless-shell-win64.zip`, con SHA-256
  `e6d26810df71efd0a3dfd0f7246d75d279ebdf8a8ec153d1ac44069657298628`.

**Antes de usarlos, copia y verifica el SHA-256** contra los fijados en `app-ui/scripts/prepare-video-engine.sh`
y en esta tabla. Si no cuadran, no se usan. Regenerarlos (`bash app-ui/scripts/prepare-video-engine.sh`)
descarga cientos de MB: pide permiso a Marc antes.

**Comandos de tests:**
- Backend: `cd app-backend && uv run --extra dev pytest -q`.
- Motor: `cd video-mcp-server && npm test`.
- UI: `cd app-ui && pnpm test`; los E2E con `pnpm e2e`, **solo desde Git Bash** y con el puerto 1420
  libre.
- El CI (`ci.yml`) tiene el job `video` y `ci-ok` como único check obligatorio.

---

## 2. Modelo de amenazas del módulo de vídeo

Esta sección es la referencia de todos los revisores de seguridad.

**Qué protegemos:**
- La cuenta de Windows del usuario: sus archivos, su registro y su sesión.
- Las claves BYOK: Anthropic y ElevenLabs.
- Los tokens OAuth de YouTube.
- Los vídeos y recursos del usuario.
- La integridad de los binarios que ejecutamos.

**Entradas no confiables:**
- La **salida del modelo**: guion YAML, datos de escena y textos.
- Los **ficheros del usuario**: imágenes, audio y clips. Los decodifican ffmpeg y Chrome.
- Las **respuestas de ElevenLabs**: audio y JSON de alineación.
- El **binario de CfT descargado**.
- Las **dependencias npm y los parches**.
- Los **mensajes `postMessage`** del iframe de la preview.
- En el futuro, los **vídeos importados de YouTube** (fase 3).

**Fronteras de confianza:**

```
UI (WebView2) ──HTTP loopback + bearer──▶ sidecar (FastAPI)
sidecar ──stdio MCP, entorno por lista blanca──▶ motor (Node) ──args en array──▶ CLI de HyperFrames
HyperFrames ──puppeteer──▶ Chrome: renderer (debe ir en Untrusted) ─▶ proceso de GPU (sin sandbox, residual)
HyperFrames ──pipe──▶ ffmpeg ;  composición ──✗ red (D10) ;  preview = iframe sandbox sin allow-same-origin
estado en %LOCALAPPDATA% (escribible por cualquier proceso del usuario: ojo a TOCTOU)
```

**Invariantes de seguridad.** Son criterio de aceptación de todo paquete, y cada una debe estar
cubierta por un test o por una comprobación del smoke test:

| ID | Invariante |
|---|---|
| **I1** | La salida del modelo es **dato validado por esquema**. Nunca llega como HTML, JS, CSS, ruta o argumento de CLI sin escapar. Las plantillas solo reciben valores escapados (`escaparHtml`, `jsonParaScript`). El modelo nunca escribe HTML de composición. |
| **I2** | La composición **no referencia la red** (`urlsDeRed`): si hay una URL externa, el render se rechaza. Incluye fuentes y librerías. |
| **I3** | El renderer de Chromium corre con **integridad Untrusted** durante el render real. Un test lo mide y falla si no se cumple (tras SEO-109). |
| **I4** | Node, ffmpeg y Chrome se ejecutan **solo desde rutas fijas y con SHA-256 fijado**, sin rutas alternativas por entorno o argumento en el binario congelado (Ruling 6). El CfT descargado se verifica **antes de extraerlo y antes de cada lanzamiento** (TOCTOU). |
| **I5** | **Secretos:** la clave de ElevenLabs solo va al entorno del motor, y nunca a Chrome, ffmpeg o HyperFrames, ni a logs (con redacción), ni a ficheros de la composición, URLs o mensajes de error. Lo mismo vale para cualquier clave futura. |
| **I6** | **Rutas:** los recursos del usuario solo entran desde directorios permitidos, con `realpath`, y se rechazan symlinks, hardlinks, junctions y reparse points. Las salidas solo van dentro del estado de la app. Nada de `..`. |
| **I7** | **Procesos:** argumentos en array (sin shell), `--` o `--opción=` delante de valores del usuario, y timeouts que matan **el árbol** de procesos. No quedan Chrome huérfanos. |
| **I8** | **Escucha y preview:** todo solo en loopback y con token. La URL de capacidad es imposible de adivinar y se rota. El iframe no lleva `allow-same-origin`. Los mensajes `postMessage` se validan por `source`, forma, lista cerrada de tipos y rangos. CSP estricta, sin `frame-src` abierto en producción. |
| **I9** | **Cadena de suministro:** versiones exactas y lockfiles. Los parches (`patch-package`) se revisan línea a línea. Ninguna dependencia nueva sin justificar. Descargas por HTTPS y con hash. Nada de `@latest` ni `npx` sin versión. Telemetría desactivada. |
| **I10** | El modelo **no dispara renders ni gasta ElevenLabs** (D2). Lo que escribe o borra pasa por el gate de aprobación. |
| **I11** | **Si algo falla, el fallo se ve.** Nunca se cae en silencio a un componente menos seguro: Chrome del sistema, ffmpeg GPL, render sin sandbox o caché de HyperFrames. |
| **I12** | **Licencias:** nada de GSAP. No se redistribuye CfT. Se cumplen las obligaciones LGPL de ffmpeg antes de publicar. |

---

## 3. Protocolo de revisión de seguridad (bloqueante)

Se aplica a todos los paquetes, sin excepción.

**R0 · Revisión de la spec y del plan** (antes de escribir código). El `cyber-security-auditor` recibe
el plan del paquete, la sección 2 y los archivos que va a tocar, y responde:
- Para cada entrada no confiable que toca el paquete: **«¿qué consigue un atacante que la controla?»**
- ¿Qué invariantes afecta, y cómo las verifica el plan con un test?
- ¿El plan introduce una frontera nueva, un binario, una red, una ruta o un proceso? ¿Está modelado?
- ¿Hay alguna salida «cómoda» que viole I11?

**Un plan con un hueco no se implementa:** se corrige el plan o se escala a Marc.

**R1 · Revisión del diff** (antes de integrar). El revisor recibe el diff completo, la sección 2 y la
lista de tests añadidos. Busca:
- Inyección (HTML, argumentos, rutas).
- Secretos en entornos, logs y errores.
- TOCTOU.
- Comprobaciones que se saltan en algún camino de error.
- Fallbacks silenciosos.
- Timeouts sin matar el árbol de procesos.
- Dependencias o parches sin revisar.
- Tests que no fallarían si se rompe la invariante.

**Gravedades:**
- **Critical / High:** bloquean el merge.
- **Medium:** se corrigen, o Marc los acepta explícitamente y se registran en Plane con la etiqueta
  `seguridad`.
- **Low:** van a Plane.

**R2 · Revisión transversal al cerrar cada oleada.** Sobre la rama integrada: un recorrido de punta a
punta por las fronteras de la sección 2, más las pruebas negativas de la tabla siguiente.

**Pruebas negativas mínimas** (cada paquete añade las suyas):

| Prueba | Resultado esperado |
|---|---|
| Composición con una URL externa | Rechazada |
| Guion con `<script>` o con `{{…}}` en un texto | Aparece escapado en el HTML |
| Recurso del usuario que es un symlink, hardlink o junction | Rechazado |
| Zip de CfT con un byte cambiado | Error visible y no se extrae |
| Binario de CfT cambiado tras verificarlo | Detectado antes del lanzamiento |
| Clave de ElevenLabs | No aparece en `video.log`, ni en los entornos de los hijos de HyperFrames, ni en la composición |
| Render con timeout | No quedan procesos de Chrome ni de ffmpeg |
| Renderer durante el render | Integridad Untrusted |

---

## 4. Paquetes de trabajo y oleadas

Formato de cada fila:
- **Escribe:** los archivos de los que es propietario (nadie más los toca en esa oleada).
- **Depende de:** lo que tiene que estar integrado antes.

### Oleada 0 · Preparación (la hace el orquestador, en serie y rápido)

| Paquete | Qué hacer |
|---|---|
| **W0.1** Entorno | Configurar hooks y autoría git y confirmar la rama. Preparar los binarios (sección 1) con el hash verificado. |
| **W0.2** Plane | Crear las tareas que faltan, como subtareas de SEO-107 y con el formato de SEO-108 a SEO-113 (contexto, pasos, seguridad, criterios de aceptación): **W1.1**, **W1.5**, **W2.8**, **W3.3**, **W3.4**, **W3.5** y las tareas manuales de Marc (sección 5) con la etiqueta `acción-Marc`. Añadir a SEO-110 (W1.6) los puntos 6, 7 y 8 del handoff de la fase 0. |
| **W0.3** Spec de seguridad | Llevar las invariantes de la sección 2 a la sección «Seguridad» de `SPEC-video.md`, con el modelo de amenazas resumido. Revisión R0 de **la propia spec** por el `cyber-security-auditor`: ¿qué permite hoy la spec que no debería? Cerrar los huecos en la spec y **que Marc la apruebe antes de la oleada 1**. Escribe: `SPEC-video.md`. |

### Oleada 1 · En paralelo (archivos disjuntos)

| Paquete | Plane | Escribe | Depende de | Notas de seguridad clave |
|---|---|---|---|---|
| **W1.1** Diagnóstico del fallo de fase del shader (punto 4). Investigación acotada a 1 día, con informe y propuesta de arreglo | por crear | `video-mcp-server/spikes/shader/**`, `spikes/INFORME-shader.md` | — | Si el arreglo es un parche a HyperFrames, **no se aplica aquí**: lo integra W2.6 en el mismo fichero de parche que W1.3, después de él. Validar la pista de `typegpu`. Reproducible en Chrome; la medición con la RTX en WebView2 la hace Marc (M2). |
| **W1.2** Motor de tiempo (SEO-111) | SEO-111 | `video-mcp-server/plantilla/vendor/hf-tiempo.js`, `src/composicion.ts`, `plantilla/index.html`, el arnés de comparación (en `video-mcp-server/test/` o `scripts/`) y el test de curvas congelado | — | **Cablear `{{INICIO}}` para TODAS las piezas**, para que en la oleada 2 nadie más toque `composicion.ts`. I1: los valores nuevos (inicio, duración) salen de `composicion.ts` como números, nunca del modelo sin validar. |
| **W1.3** Sandbox del renderer (SEO-109) | SEO-109 | `video-mcp-server/patches/hyperframes+0.8.206.patch`, `video-mcp-server/package.json` (solo lo necesario para aplicar el parche en desarrollo) y un test del motor que mide la integridad del renderer durante un render real | — | I3 e I9. Parche mínimo, revisado línea a línea: quitar `--no-sandbox` y `--disable-setuid-sandbox` en win32 y añadir `--disable-gpu-sandbox` (también en `getHardwareGpuProbeArgs`). El test **falla** si el renderer no está en Untrusted. **Ojo:** el bundle instala con `npm ci --omit=dev --ignore-scripts` (`prepare-video-engine.sh`, línea ~109), así que un `postinstall` no llegaría a la app instalada; aplicarlo en el bundle es W2.8. Redactar la issue para HyperFrames, pero **publicarla solo con el sí de Marc**. |
| **W1.4** CfT en el primer uso, parte de backend (SEO-108) | SEO-108 | `app-backend/app_backend/video.py` (`_navegador_bundle` y `entorno_motor`), un módulo nuevo `app_backend/navegador.py`, `app_backend/config.py` (solo constantes del navegador), `tests/test_navegador.py`, `scripts/smoke_test.py`, `app-ui/scripts/prepare-video-engine.sh` (**solo quitar la sección del navegador**), `.github/workflows/release.yml` (solo el navegador) y `app-ui/README.md` (motor opt-in) | — | I4, I9 e I11. Ruta fija en el estado; SHA-256 **antes** de extraer; extracción en una carpeta nueva y vacía; **volver a comprobar el hash antes de cada arranque del motor**; sin override por entorno en el binario congelado; error visible y reintentable. Descarga como job con progreso. La UI va en W2.7. |
| **W1.5** ffmpeg LGPL propio y mínimo (punto 3) | por crear | Archivos **nuevos** solamente: `video-mcp-server/ffmpeg-build/**` (script reproducible) y un workflow nuevo `.github/workflows/ffmpeg-lgpl.yml` | — | I9 e I12. Fuentes con hash y firma GPG verificada; sin `libopenh264`, sin `--enable-gpl` ni `--enable-nonfree`; publicar el código fuente correspondiente y reunir los avisos. **No toca `prepare-video-engine.sh`**: la integración es W3.2. |
| **W1.6** Render: codificador, rendimiento y GPU (SEO-110 y puntos 6, 7 y 8) | SEO-110 | `video-mcp-server/src/render.ts`, `src/proceso.ts` (si hace falta) y sus tests | — | I7 e I11. Codificador predecible o registrado; reserva por software si el de hardware falla; timeouts con muerte del árbol; registrar en el job el adaptador y el codificador. Renders largos: diseñar un canal o sesión aparte para el render (minor de la fase 0: hoy un timeout tumba las demás llamadas). |

### Oleada 2 · Tras integrar W1.2, W1.3 y W1.4

| Paquete | Plane | Escribe | Depende de | Notas |
|---|---|---|---|---|
| **W2.1** Migrar `gancho` y `escena-cifra` desde el spike | SEO-112 | `plantilla/piezas/gancho.html`, `plantilla/piezas/escena-cifra.html` y sus tests | W1.2 | Comparación por fotograma contra GSAP, sondas de preview, I1. |
| **W2.2** CSS simples: `escena-cartel`, `etiqueta`, `flash`, `fondo-css`, `bloque-foto` | SEO-112 | Esas 5 piezas y sus tests | W1.2 | Igual que W2.1. |
| **W2.3** Con setters o d3: `capas`, `escena-barras`, `escena-mapa` | SEO-112 | Esas 3 piezas y sus tests | W1.2 | `hf.reloj`; ojo a los tweens de `x` e `y` por separado (`hf-tiempo` lanza un error). |
| **W2.4** three.js: `escena-titulo3d`, `escena-tunel` | SEO-112 | Esas 2 piezas y sus tests | W1.2 | Sin medir en el spike: validar `hf-seek` con three.js en render y preview. |
| **W2.5** `subtitulos` | SEO-112 | `plantilla/piezas/subtitulos.html` y sus tests | W1.2 | **Medir el coste en la preview** (cientos de animaciones). Si pesa, `hf.reloj`. I1: el texto del guion siempre escapado. |
| **W2.6** Arreglo del shader | por crear (de W1.1) | `patches/hyperframes+0.8.206.patch` o la pieza `fondo-shader` | W1.1 y W1.3 | Mismo fichero de parche que W1.3: se hace **después** de él y lo revisa R1 línea a línea. |
| **W2.8** Parche del sandbox en el bundle | por crear | `app-ui/scripts/prepare-video-engine.sh` (aplicar el parche explícitamente sobre `$DEST/app/node_modules` tras el `npm ci --ignore-scripts`, y abortar si no se aplica) y `app-backend/scripts/smoke_test.py` (comprobar que el renderer está en Untrusted durante un render del motor empaquetado) | W1.3 y W1.4 | I3, I9 e I11. **Sin esto, el sandbox solo existe en desarrollo** y la app instalada sigue con `--no-sandbox`. El script aborta si el parche falla o si cambia la versión de HyperFrames. Si W2.6 añade cambios al mismo parche, este paso los recoge sin más. |
| **W2.7** UI de la descarga de CfT | SEO-108 | Pantalla y componente de Ajustes del motor de vídeo en `app-ui/src/**` (definir los archivos en el plan), sus tests y su E2E | W1.4 | `data-testid` según `app-ui/docs/pantallas.md`, con contrato y E2E en el mismo commit. Mensaje de error claro; sin botón de «usar otro navegador» (I11). |

**Reglas de la oleada 2:**
- Cada plantilla se compara contra **su render con GSAP**, antes de quitar GSAP (SSIM ≥ 0,99 por
  fotograma; seek, play y seek tras play correctos).
- Si una pieza necesita cambiar `composicion.ts`, el subagente **se para y lo informa**, y el orquestador
  lo serializa.

### Oleada 3 · Cierre

| Paquete | Plane | Escribe | Depende de | Notas |
|---|---|---|---|---|
| **W3.1** Quitar GSAP del producto | SEO-113 | `video-mcp-server/package.json` y su lock, `composicion.ts` (`GSAP_JS`), `plantilla/index.html`, el catálogo, `LICENCIAS.md`, `LICENSES/` y el test que detecta GSAP | Toda la oleada 2 | I2 (el catálogo carga de jsDelivr) e I12. |
| **W3.2** Integrar el ffmpeg propio en el bundle | — | `app-ui/scripts/prepare-video-engine.sh` (sección ffmpeg) y `LICENSES/` | W1.4 y W1.5 | Hash fijado, sin `libx264` ni `libopenh264` (comprobación en el script), código fuente publicado. |
| **W3.3** Tamaño del instalador (punto 5) | por crear | Medición e informe; ajustes de NSIS (LZMA) en `tauri.conf.json` | W3.1 y W3.2 | Revisar si `three147` sigue haciendo falta. Medir el instalador comprimido. |
| **W3.4** Minors de seguridad de la fase 0 | por crear | Según el plan, sin chocar con archivos de otros | W1.2 y W1.6 | TOCTOU y hardlinks al copiar recursos (I6); firma GPG de `SHASUMS256.txt` de Node (I9); el test de clave guardada que borra fuera de `finally`; `estado()` llama a `imagenesValidadas` sin protegerla; el hack `globalThis.__fake`; el árbol de Chrome en POSIX (antes de usar el motor en el VPS); copiar la Apache-2.0 de `puppeteer-core` a `LICENSES/`. |
| **W3.5** Borrar el spike de preview | por crear | `app_backend/spike_preview.py` y su test, `app-ui/src/spikes/`, `frame-src` de `devCsp` y `app-ui/scripts/spike-preview-medir.mjs` | **M2 hecha** | I8: tras borrarlo no debe quedar `frame-src http://127.0.0.1:*`. La preview real (fase 1) llevará su propio diseño: validación de `postMessage`, URL de capacidad rotada y `frame-src` acotado en el `csp` real. |
| **W3.6** Revisión final y PR | — | — | Todo | R2 de toda la rama, todos los tests y el CI. **Push y PR contra `ds/v1` solo con el sí de Marc.** Descripción con *Qué cambia*, *Por qué*, *Cómo se ha probado* y *Pasos manuales pendientes*. |

### Oleada 4 · Planificar la fase 1 (sin implementar)

Con todo lo anterior integrado, escribir `PLAN-video-fase1.md` con `superpowers:writing-plans`: guion en
modo vídeo (D5), editor con layout B (D6), escenas base (D4) y criterios de aceptación de la fase 1
(`SPEC-video.md`). Pasa por la revisión R0 de seguridad del plan y por la aprobación de Marc antes de
construir nada.

---

## 5. Tareas manuales de Marc (en paralelo con las oleadas)

| ID | Qué | Desbloquea |
|---|---|---|
| **M1** | Instalar la app y lanzar el smoke test contra la instalación (procedimiento en `HANDOFF-video-fase0.md`, «Pasos manuales pendientes de Marc», paso 1) | Valida el empaquetado. Repetirlo tras W1.4 y W3.2 |
| **M2** | Medir la preview en WebView2 con la RTX (procedimiento en `INFORME-preview.md`), incluido el fallo de fase a ojo | W1.1 (datos) y W3.5 (borrado del spike) |
| **M3** | Aprobar la publicación de las issues para HyperFrames: sandbox en Windows, preflight `--version` en Windows y, si sale de W1.1, `typegpu` | W1.3 y W2.6, a largo plazo |
| **M4** | Aprobar el push y la PR de `feat/video-fase1` | W3.6 |
| **M5** | Revisar y aprobar los cambios de seguridad de `SPEC-video.md` | Oleada 1 |

---

## 6. Plantilla de brief para cada subagente implementador

```
Paquete: <ID y título> (Plane SEO-xx). Rama: <tipo>/<nº>-<slug> desde feat/video-fase1. Worktree propio.
Objetivo: <1-2 frases>. Criterios de aceptación: <de Plane>.
Escribes SOLO estos archivos: <lista>. Lectura libre del resto. Si necesitas otro archivo: PARA e infórmalo.
Invariantes de seguridad que te aplican: <I…> (texto completo en HANDOFF-video-fase1.md §2). Cada una
con un test que falle si se rompe; incluye las pruebas negativas de §3 que te tocan.
Plan aprobado (R0): <ruta o texto>. TDD: test que falla primero.
Prohibido: añadir dependencias sin justificarlo en el informe, descargar sin permiso, rutas alternativas
por entorno, caídas silenciosas a componentes menos seguros, `--no-verify`, atribución en commits.
Commits: español, imperativo, ≤72 caracteres, «(SEO-xx)» al final, autor Marc, sin Co-Authored-By.
Entrega: resumen de cambios, tests añadidos y su salida, invariantes cubiertas y cómo, riesgos abiertos,
y la lista exacta de archivos tocados.
```

Brief del revisor de seguridad (R1): diff completo + §2 + §3 + lista de tests. «Encuentra cómo un
atacante que controla cada entrada no confiable rompe alguna invariante. Clasifica por gravedad, con un
escenario concreto y la línea exacta. No supongas que un test protege algo sin leerlo.»

---

## 7. Cosas que no hay que hacer

- Reabrir GSAP frente a WAAPI, CfT frente a Chromium, o el sandbox completo, sin datos nuevos.
- Usar Chrome del sistema, Edge o la caché de HyperFrames como reserva (I11).
- Subir HyperFrames sin repetir las comparaciones de fotogramas y el test de integridad del renderer.
- Leer del DOM, dentro de las piezas, el id, el inicio o la duración.
- Ejecutar el instalador desde la sesión.
- Publicar nada, hacer push o abrir issues en repos ajenos sin el sí de Marc.
