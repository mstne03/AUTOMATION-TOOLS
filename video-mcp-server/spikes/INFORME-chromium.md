# Spike Chromium en lugar de Chrome for Testing (punto 2 del handoff de la fase 0)

Fecha: 2026-10-29 · Máquina: Windows 11, RTX 4060 Laptop · HyperFrames 0.8.206 · referencia: chrome-headless-shell
152.0.7977.30 (Chrome for Testing, el del motor). Código del spike (desechable): `spikes/chromium/`. Salidas en
`spikes/salidas/chromium/` (ignorada por git).

## Veredicto

**Técnicamente, Chromium sirve: renderiza igual que Chrome for Testing (CfT). Pero no entra en el
instalador tal cual,** porque HyperFrames 0.8.206 lo rechaza en Windows antes de renderizar y porque el
snapshot no trae los avisos de licencia que exige redistribuirlo. Las dos cosas tienen arreglo, pero cada
arreglo es una pieza más que mantener.

**Decidido (Marc, 2026-10-29): descarga de CfT en el primer uso** (alternativa 2 de `LICENCIAS.md`). El
snapshot de Chromium queda como plan B, por si el primer render sin red llega a ser un requisito duro. La
decisión dependía de resolver por otras vías los dos problemas de seguridad que ya tenía el producto; los
dos se comprobaron (ver «Decisión de Marc» al final).

`content_shell` queda descartado: sin GPU no renderiza.

## Qué se probó

Revisión elegida: **r1668971**, el último snapshot `Win_x64` anterior al punto de rama de la 152
(posición 1669021, según ChromiumDash). Todo lo que contiene está también en la 152 de CfT. En el punto de rama exacto no hay
snapshot, y el siguiente, r1669035, ya es posterior. Commit `3309651b3528b24be3a8d476b43a7bb0940faf8b` (fichero `REVISIONS`
del bucket); `chrome://version` dice «Chromium 152.0.7977.0 (Build para desarrolladores)».

| Fichero (`storage.googleapis.com/chromium-browser-snapshots/Win_x64/1668971/`) | Tamaño | MD5 del bucket | SHA-256 (calculado tras verificar el MD5) |
|---|---|---|---|
| `chrome-win.zip` | 326,8 MB | `wqGC9YHdeMtox1YDBHFOWw==` ✓ | `1b730ddc85d862d64b08fcdaeed8e77c7e4b214d4b5912bcc5a833791624afeb` |
| `content-shell.zip` | 99,6 MB | `QNmf4ZsTxpnZJIb6n/MN6Q==` ✓ | `20a65e34d314b213492bfeff87c7621ccca3f9e759b5d177536ee0d41578b356` |

Para comprobar que se usaba de verdad el navegador pedido, pinté `navigator.userAgent` en el fotograma. Salen tres
distintos: `HeadlessChrome/152.0.7977.30` (CfT), `HeadlessChrome/152.0.0.0` (snapshot) y `Chrome/999.0.0.0`
(content_shell).

### Render real (`hyperframes render`), composición completa de 12,4 s, 372 fotogramas, SSIM frente al CfT

| Composición | Chromium (`chrome.exe`) | content_shell |
|---|---|---|
| Completa sin GPU (gancho, 6 escenas `cifra`, subtítulos, capas, voz) | 368/372 **idénticos**; mín. 0,99995 | **falla**: no trae SwiftShader |
| Igual, con un clip H.264 (`libopenh264`, 800×450, 4 s) | 367/372 idénticos; mín. 0,999995. El clip se ve | **falla** (igual) |
| Fondo WebGPU `aurora` con `--browser-gpu` (RTX 4060) | mín. **0,9968**, media 0,99893, ninguno idéntico; a la vista no se distingue | mín. 0,9968; casi igual que Chromium (0,99992) |
| Referencia: dos renders `aurora` con el mismo CfT | — | 372/372 idénticos (el render con GPU es determinista aquí) |

- **H.264:** Chromium no trae el códec H.264 y aun así el clip sale idéntico. HyperFrames extrae los
  fotogramas de los `<video>` con ffmpeg, no con el navegador, así que a los clips del usuario no les afecta.
  La preview (WebView2, que es Edge) sí reproduce H.264 por sí misma.
- **WebGPU:** entre el snapshot y el CfT hay una diferencia pequeña pero real en el camino del shader. Puede
  venir de los parches de rama o de las opciones de compilación oficiales. Con SSIM ≥ 0,9968 no se aprecia.
- **Tiempos** de una sola ejecución, con el equipo ocupado. Son orientativos: CfT 78 / 102 / 139 s; Chromium
  87 / 92 / 101 s.

## Los bloqueos

### 1. El preflight de `hyperframes render` rechaza en Windows cualquier navegador que no sea headless-shell

Antes de renderizar, la CLI ejecuta `<navegador> --version` (`checkChrome` en `dist/chunk-QVTCXN42.js`), y si
falla aborta. En Windows, `chrome.exe` y `content_shell.exe` **no implementan `--version`**: arrancan el
navegador entero. `chrome.exe` llega a abrir una ventana; `content_shell` entra en un bucle de errores de
sandbox. El preflight cae por timeout (ETIMEDOUT) o por exceso de salida (ENOBUFS).

- No hay opción para saltarlo. HyperFrames no expone el render como API: `hyperframes/api` solo trae
  `transcribe` y `removeBackground`. Además, el lanzamiento usa la misma variable `HYPERFRAMES_BROWSER_PATH`.
- `snapshot` y `check` no hacen ese preflight, y por eso con ellos funcionaba.
- **Inferencia sin probar:** Edge del sistema (`msedge.exe`), la alternativa 5 de `LICENCIAS.md`, chocará
  con lo mismo.
- Para medir el render en sí, el spike contesta esa única llamada con un preload de Node
  (`spikes/chromium/version-preload.cjs`). **Es un truco de medición, no una solución de producto.**

Salidas posibles si se elige Chromium:
- **(a) Reportarlo a HyperFrames y esperar:** robusto, pero sin plazo.
- **(b) Parchear la CLI** con `patch-package`: hay que revisar el parche en cada subida de HyperFrames, lo que
  resta mantenibilidad.
- **(c) Un ejecutable intermedio propio** (en Rust, que ya está en la toolchain de Tauri) que conteste
  `--version` y pase todo lo demás a `chrome.exe`. Supone una pieza nativa más en la cadena del navegador, y
  ha de reenviar bien la salida estándar y la terminación del árbol de procesos.

### 2. El snapshot no trae avisos de licencia

Ni `ABOUT` ni `LICENSE` en el zip. `chrome://credits` es una página de ejemplo («set `generate_about_credits=true`
in args.gn»). Redistribuir Chromium (BSD-3 y decenas de terceros) obliga a acompañar esos avisos.

- Para generarlos exactos hay que bajar el código fuente de Chromium en esa revisión y ejecutar
  `tools/licenses/licenses.py`. Son decenas de GB, y habría que repetirlo en cada cambio de revisión.
- El `LICENSE.headless_shell` del CfT 152 sirve de base, pero corresponde a otro binario: es una
  aproximación, no los avisos exactos.

**Lo bueno:** el binario es «Chromium», «Copyright 2026 Los creadores de Chromium», y `chrome://terms` está
vacío a propósito: «In official builds this space will show the terms of service». **No hay términos de
Google.** La duda legal del CfT no se traslada al snapshot.

### 3. Tamaño y mantenimiento

- **`chrome-win` ocupa 775 MB descomprimido.** Recortado (sin `interactive_ui_tests.exe` de 328 MB, sin
  `setup.exe`, sin servicios y solo con `en-US` de las 53 configuraciones regionales) quedan **~380 MB**,
  frente a 270 MB del CfT: unos 110 MB más en el instalador. La lista de recorte hay que validarla con un
  render.
- **Es un build de tronco: nunca recibe parches.** Solo se actualiza cambiando de revisión. Y la versión la
  sigue fijando HyperFrames.

### content_shell

Pesa 231 MB, menos que el CfT, y con GPU renderiza igual que Chromium. Pero sin GPU HyperFrames exige
SwiftShader («Distributed renders require pure-software GL»), y `content_shell` no trae
`vk_swiftshader.dll`. Hay que contar con equipos sin GPU válida y con que el modo determinista es el de por
defecto. **Descartado.**

## Recomendación

Con el orden robustez > mantenibilidad > escalabilidad > simplicidad:

- **CfT descargado en el primer uso** (SHA-256 ya fijado en `prepare-video-engine.sh`, carpeta fija del
  estado de la app y verificada por hash: Ruling 6).
  - **A favor:** usa el mismo binario que ya se ha probado de punta a punta. HyperFrames lo soporta tal
    cual, sin preflight que sortear ni parches. No hay avisos de licencia que generar, porque quien
    distribuye es Google, como hacen Puppeteer y la propia CLI de HyperFrames. Y quita ~270 MB del
    instalador.
  - **Lo que se sacrifica:** el **primer** render necesita red (~114 MB). Si falla, el error tiene que verse;
    nunca hay que caer en silencio a otro navegador.
- **El snapshot de Chromium en el instalador** mantiene el render sin red desde el primer día, pero suma
  tres frentes de mantenimiento permanentes: el rodeo del preflight, los avisos de licencia por revisión y
  la lista de recorte. Además pesa 110 MB más.
  - Lo dejaría como plan B, solo si «el primer render funciona sin red» se convierte en requisito.
  - En ese caso, la vía preferible es (a) más (c): reportar el preflight a HyperFrames y, mientras tanto,
    usar el ejecutable intermedio.

Independientemente de lo que se elija, propongo **reportar a HyperFrames** que el preflight de Windows
rechaza cualquier navegador que no sea headless-shell, cuando su propia ayuda anuncia «system Chrome».

## Seguridad (afecta al producto actual, no solo a este spike)

- **HyperFrames lanza el navegador de render con `--no-sandbox` en todas las plataformas**
  (`buildChromeArgs` en `dist/chunk-RDDVQSNQ.js`). Pasa también con el CfT que ya se empaqueta. El HTML de la
  composición y las **imágenes del usuario** se procesan en un renderer sin aislamiento.
- **Chromium 152 ya va cinco versiones por detrás de la estable** (157 el 2026-10-29). Ni el CfT 152 ni un
  snapshot de tronco reciben parches.
- Juntando las dos cosas, un fallo explotable en un decodificador de imagen daría ejecución de código con
  los permisos del usuario.
- Hoy el riesgo es moderado: son ficheros del propio usuario y la composición no puede cargar URLs
  externas (D10). Pero **sube con la importación desde YouTube de la fase 3** o con cualquier imagen que no
  elija el usuario.
- **Mitigaciones para la fase 1:**
  1. Recodificar con ffmpeg a PNG/JPEG propios toda imagen antes de meterla en la composición. Así el
     navegador solo decodifica ficheros que hemos generado nosotros.
  2. Subir HyperFrames en cuanto fije una Chrome más nueva.
  3. Estudiar lanzar el render con token restringido o en un Job Object con límites. Requiere probar si
     HyperFrames lo tolera.
- **Si se adopta la descarga en el primer uso:** HTTPS, SHA-256 comprobado **antes** de abrir el zip,
  extracción en una carpeta nueva y vacía, ruta fija (sin override por entorno) y error visible si el hash
  no cuadra.
- **Observado en el spike:** `chrome.exe` ejecutado sin los flags de headless abre una ventana normal del
  navegador. Un fallo de configuración en el motor sería visible para el usuario. Es otro motivo para no
  depender de un rodeo frágil.

## Decisión de Marc (2026-10-29) y comprobación de los dos problemas de seguridad previos

**Decisión: CfT descargado en el primer uso,** a condición de que los dos problemas que ya tenía el producto
(navegador sin parches y `--no-sandbox`) tuvieran solución por otras vías. Se comprobó así:

**1. Navegador sin parches: resuelto fijando nosotros un CfT actual.**
- Esperar a HyperFrames no sirve. Hasta su última versión, la 0.8.216 (publicada el 2026-10-29), y su rama
  `main`, siguen fijando la 152.0.7977.30. Su único techo de versión es para macOS 12
  (`chromeMajorCeiling`).
- En Windows, HyperFrames 0.8.206 acepta cualquier headless-shell por `HYPERFRAMES_BROWSER_PATH`, y
  headless-shell sí contesta `--version`, así que pasa el preflight.
- Se probó **CfT 156.0.8078.73**, el estable de CfT a esa fecha. Zip de 119,7 MB; MD5 `BKSbEKThWqM1IU4kh8c63A==`
  verificado; SHA-256 `e6d26810df71efd0a3dfd0f7246d75d279ebdf8a8ec153d1ac44069657298628`; 282 MB descomprimido.
  Renderiza sin tocar nada.

| Composición (372 fotogramas) | Idénticos a la 152 | SSIM mínimo |
|---|---|---|
| Sin GPU | 287–306 | 0,99988 |
| Con clip H.264 | 290–317 | 0,99993 |
| `aurora` con GPU | 288–305 | 0,99942 |

Subir de versión queda en cambiar una versión y un hash, **siempre repitiendo esta comparación**, porque
HyperFrames lleva una versión concreta de Puppeteer y flags pensados para la 152.

**2. `--no-sandbox`: resuelto para el renderer; el proceso de GPU se queda sin sandbox.**
- Se midió el nivel de integridad del renderer (`spikes/chromium/sandbox-renderer.mjs`):
  - **Medium** con `--no-sandbox`, que es como lo lanza HyperFrames: los permisos del usuario.
  - **Untrusted** sin ese flag, con la 152 y con la 156.
- **Sandbox completo (renderer y GPU):** el render se cuelga en 5 de 6 ejecuciones, con y sin GPU. El
  codificador deja de recibir fotogramas a mitad del vídeo y HyperFrames lo mata a los 10 minutos. Causa
  sin identificar; solo se observa con el sandbox del proceso de GPU activo. **No es viable hoy.**
- **Configuración adoptada: sandbox del renderer activo y `--disable-gpu-sandbox`.**
  - **6 de 6** renders correctos: 2 con GPU (152 y 156) y 4 sin GPU o con clip (156).
  - Fotogramas iguales a los de hoy y sin coste de tiempo apreciable (~85 s, como sin sandbox).
  - El renderer, que es quien interpreta el HTML y decodifica las imágenes del usuario, queda en Untrusted.
- **Riesgo residual:** el proceso de GPU sigue sin aislar. No lee contenido, sino órdenes de dibujo del
  renderer, así que un atacante tendría que comprometer antes el renderer. Pero ha tenido vulnerabilidades
  propias.
- **Cómo llevarlo al producto:** HyperFrames fija `--no-sandbox` en `buildChromeArgs`, sin opción para
  quitarlo. Hace falta un parche local mínimo (`patch-package`: quitar `--no-sandbox` y
  `--disable-setuid-sandbox` en win32 y añadir `--disable-gpu-sandbox`), pedir el cambio a HyperFrames y un
  smoke test que falle si el renderer no está en Untrusted. Lo que se sacrifica es mantenibilidad: el parche
  hay que revisarlo en cada subida de HyperFrames.
- **Límites de lo medido:** 6 ejecuciones en una sola máquina (RTX 4060 y Radeon 780M). Falta probarlo en un
  equipo sin GPU dedicada y en la instalación real.

**Observado de paso:** HyperFrames codifica con `h264_amf` (la iGPU AMD) aunque `--gpu` viene desactivado
por defecto. No influyó en los cuelgues, que solo se dieron con el sandbox de GPU activo, pero conviene
saber qué codificador elige en cada equipo (punto 6 del handoff, bitrate).

## Cómo reproducirlo

Desde `video-mcp-server/` en Git Bash, con `npm run build` hecho y el motor empaquetado. Los zips se bajan
de la URL de arriba a `spikes/salidas/chromium/descargas/`, se verifica el MD5 y se extraen en
`spikes/salidas/chromium/x-chrome-win/` y `x-content-shell/`.

```bash
E="$(cd .. && pwd)/app-ui/src-tauri/binaries/video-engine"; C=spikes/salidas/chromium
node spikes/waapi/montar.mjs "$E/ffmpeg" && cp -r spikes/salidas/waapi/proyecto/video001/_composicion $C/comp-css
node spikes/waapi/montar.mjs "$E/ffmpeg" aurora && cp -r spikes/salidas/waapi/proyecto/video001/_composicion $C/comp-aurora
node spikes/chromium/render-navegadores.mjs "$E" $C/comp-css css
node spikes/chromium/render-navegadores.mjs "$E" $C/comp-aurora aurora --gpu
node spikes/chromium/paginas.mjs "$C/x-chrome-win/chrome-win/chrome.exe" $C/credits.html   # identidad y licencias
B=$E/browser/chrome-headless-shell-win64/chrome-headless-shell.exe
node spikes/chromium/sandbox-renderer.mjs "$B"                         # integridad del renderer con sandbox
node spikes/chromium/sandbox-renderer.mjs "$B" --no-sandbox            # y como lo lanza HyperFrames
SANDBOX_GPU=off bash spikes/chromium/sandbox.sh "$PWD" "$E" "$PWD/$C" comp-aurora aurora-sb.mp4 --browser-gpu
```

Con `NAVEGADOR=<chrome-headless-shell.exe>`, `sandbox.sh` usa otro CfT (la 156 se bajó de
`storage.googleapis.com/chrome-for-testing-public/156.0.8078.73/win64/chrome-headless-shell-win64.zip`).

La composición del clip es `comp-css` con un `<video>` H.264 añadido a mano a la raíz (`data-start="3"`,
`data-duration="4"`, `muted`), generado con `ffmpeg -f lavfi -i testsrc2=… -c:v libopenh264`.
