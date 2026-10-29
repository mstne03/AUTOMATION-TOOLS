# Spike D6 — preview de la composición en el WebView2

Fecha: 2026-10-27/28 · Máquina: Windows 11, portátil con RTX 4060 Laptop + Radeon 780M · HyperFrames 0.8.206.
Código del spike (desechable, solo desarrollo): `app-backend/app_backend/spike_preview.py`,
`app-ui/src/spikes/PreviewSpike.tsx` (ruta `/#/spike-preview`), `app-ui/scripts/spike-preview-medir.mjs`
(conductor Playwright) y, en `video-mcp-server/spikes/`: `preview-montar.mjs`, `preview-render.mjs`,
`preview-comparar.mjs`. Salidas (PNG, MP4, JSON) en `spikes/salidas/preview/` (ignorada por git).

## Veredicto

**El criterio de salida NO se cumple del todo: hay que llevarlo a Marc antes de planificar la fase 1.**
Tres de los cuatro puntos se cumplen con margen; el cuarto (fotogramas iguales al MP4) falla en un
escenario reproducible: el **fondo WebGPU `aurora` muestra una fase distinta tras reproducir el vídeo entero**.

| Criterio | Resultado | Estado |
|---|---|---|
| ≥ 30 fps con fondo WebGPU | 59–60 fps (Chrome/RTX 4060) y 133–135 fps (Radeon 780M, incl. WebView2). **Solo hay medición de WebView2 en la Radeon; en la RTX no** (ver nota) | cumple en lo medido; sin WebView2/RTX |
| Seek < 200 ms | mediana 14 ms (WebView2), máx. 21 ms; hasta 43 ms en la ruta NVIDIA | cumple |
| Deriva < 1 fotograma (33 ms) en 50 s | deriva (pendiente) −6…+8 ms en 50 s; **desfase instantáneo** timeline−`audio.currentTime` hasta 46–53 ms (media 20–31 ms) | deriva pequeña, pero el desfase instantáneo supera 33 ms: **no concluyente** (ver matiz) |
| Fotogramas visualmente iguales al MP4 | iguales con la página recién cargada o tras reproducir 4 s (SSIM 0,93–0,98); **fallan tras reproducir 50 s** (SSIM 0,60–0,86 en 10 s y 25 s) | **no cumple** |

Se midió en el WebView2 **real** (Microsoft Edge WebView2 Runtime 155.0.4283.62, dentro de `pnpm tauri dev`) y en
Chrome 155.0.8059.85 (misma versión mayor de Chromium), ambos con ventana visible (headed).

**Nota sobre el fps:** el método cuenta *callbacks de `requestAnimationFrame`* dentro del iframe, no fotogramas
realmente presentados ni tiempo de GPU. El WebView2 corrió en la Radeon 780M (elección de Windows) y **no existe
medición del WebView2 en la RTX 4060**: «≥ 30 fps» no está demostrado para el hardware de Marc con la RTX en WebView2;
hay que repetirlo con la preferencia gráfica fijada.

## Decisión para Marc: el fallo de fase del shader (fase 1)

1. **Diagnosticar la causa raíz primero** (shader `Aurora` de `shaders.iife.js` / runtime: estado acumulado tras `play`
   que el seek hacia atrás no reinicia). Lo robusto; coste: investigar código de terceros, quizá un parche local.
2. **Seek de calentamiento** (tras pausar, ir a otro instante y luego al pedido). Barato y probado a mano (basta 10,5 s o
   25 s antes), pero es un parche: cada scrub paga un seek extra (~14–33 ms medidos) y no sé si cubre todos los instantes
   ni si se repite con la RTX.
3. **Fondo CSS por defecto en la preview** y shader solo en el render final. Elimina el fallo y la dependencia de GPU,
   pero rompe «lo que se ve es lo que se renderiza» justo en el fondo.

**Recomendación:** (1) acotada en tiempo, con (2) de red de seguridad; (3) solo si (1) no da resultado. Falta medir:
el fallo con la RTX en WebView2, si (2) lo cubre en un barrido de instantes (cada 1 s) y tras varias reproducciones, y si
`plasma`/`nebula`/`mesh` lo comparten. **Decide Marc.**

## Cómo se sirve la composición al iframe (decisión)

1. **URL de capacidad**: `GET /spike/preview/{clave}/{ruta:path}` en el sidecar (`127.0.0.1`), con
   `clave = secrets.token_urlsafe(32)` generada al arrancar. La clave se entrega por
   `GET /spike/preview-info`, que sí exige el Bearer. Toda ruta se resuelve con `Path.resolve()` y comprobación
   de prefijo (`is_relative_to`): `..`, rutas absolutas y rutas con NUL devuelven 404 (test en
   `app-backend/tests/test_spike_preview.py`).
2. El router **solo se monta con `APP_BACKEND_SPIKES=1`** (y `APP_BACKEND_SPIKE_COMPOSICION`); hay un test de que
   sin la variable no existe. La ruta de UI solo existe bajo `import.meta.env.DEV`; `frame-src http://127.0.0.1:*`
   está solo en `devCsp`, nunca en `csp`.
3. Al `index.html` se le inyecta, justo tras `<head>`, el **runtime de HyperFrames** (`hyperframe.runtime.iife.js`)
   y el script de control. Sin el runtime la composición no funciona: las subcomposiciones
   (`data-composition-src`) las carga y anida él, y `main` es solo un timeline vacío en pausa.
4. Cabeceras: `Access-Control-Allow-Origin: *` (el origen del iframe es opaco, `fetch` de subcomposiciones y
   fuentes lo necesita; el contenido es de solo lectura bajo una URL no adivinable),
   `Content-Security-Policy: sandbox allow-scripts` (aunque se abra la URL a mano sigue sandboxed) y
   `Cache-Control: no-store`. `FileResponse` atiende `Range`, necesario para audio/vídeo.

## Cómo se controla (decisión) y por qué se desvía del enunciado

`<iframe sandbox="allow-scripts" allow="autoplay">` **sin `allow-same-origin`**. Control solo por `postMessage`:
el script inyectado acepta `{tipo: "seek", t}`, `"play"`, `"pause"` (más `medir-fps`, `medir-deriva`, `estado`
para el arnés de medición), comprueba `e.source === window.parent`, que `data` sea un objeto con `tipo` de una lista
cerrada y que `t` sea un número finito (se limita a `[0, duración]`).

**Desviación del enunciado:** el script no llama a `window.__timelines["main"].seek(t)` sino a **`window.__player.seek(t)`**
del runtime. Motivo: `__player.seek` hace el seek del timeline raíz y de los anidados, **sincroniza los
`<audio>`/`<video>`** y mueve el tiempo del shader WebGPU (`__hfTypegpuTime`); con `__timelines["main"]` solo se
movería un timeline vacío. En el WebView2, el runtime avisa de que no puede capturar el audio por Web Audio
(`opaque_document_origin`) y lo reproduce por `HTMLMediaElement` nativo, que es lo que queremos.

### Aislamiento comprobado (dentro del iframe, en el WebView2/Chrome)

`window.origin === "null"`; `parent.document`, `localStorage`, `document.cookie` y `window.top.__TAURI_INTERNALS__`
lanzan `SecurityError`. `isSecureContext === true` y `navigator.gpu` disponible: **WebGPU funciona en un iframe con
origen opaco**, que era la duda principal del spike.

## Mediciones

Método: página `/#/spike-preview` (preview a escala 0,4); botón «Medir» → (1) `seek(0)`, `play`, 1 s de calentamiento y
conteo de `requestAnimationFrame` **dentro del iframe** durante 10 s; (2) 12 seeks (1, 10, 25, 45 s × 3), midiendo el
viaje de ida y vuelta por `postMessage` y el tiempo hasta pintar (`seek` + dos `rAF`); (3) reproducción de 50 s
muestreando cada 250 ms `__player.getTime()`, `audio.currentTime` y el reloj. Composición de 50,4 s, 1080×1920, voz
sintética (tono de 220 Hz, **sin ElevenLabs**), escenas `cartel` sobre fondo (aurora, o `gradiente` como reserva CSS).
La pista dura 50,0 s, así que el último medio segundo se excluye de la regresión (el `<audio>` ya terminó).

| Entorno (GPU que eligió Windows) | fps (10 s) | peor intervalo | seek viaje med/máx | seek hasta pintar med/máx |
|---|---|---|---|---|
| WebView2 155, aurora (Radeon 780M) | **135** | 69,5 ms | 13,8 / 19,5 ms | 12,9 / 18,6 ms |
| Chrome 155, aurora (Radeon 780M) | 133 | 102 ms | 14,1 / 21,1 ms | 12,6 / 19,8 ms |
| Chrome 155, aurora (RTX 4060) | 59,2 | 83,7 ms | 33,4 / 42,6 ms | 32,4 / 32,7 ms |
| Chrome 155, reserva CSS (RTX 4060) | 59,9–60 | 33–50 ms | 33,2 / 34–50 ms | 32,2 / 32–49 ms |

Lectura: con la ruta NVIDIA el fps queda **limitado a 60** (probablemente por la presentación entre GPU, ya que la
pantalla del portátil cuelga de la iGPU) y el seek cuesta ~2 fotogramas de 60 Hz (los dos `rAF` de la propia medición);
con la AMD sube a ~135 y baja a ~14 ms. Los intervalos peores (70–100 ms) son tirones puntuales de un fotograma
(arranque del `play`); no hay degradación sostenida. La reserva CSS no se midió en WebView2 (solo en Chrome/NVIDIA).

**Deriva de audio/vídeo en 50 s** (diferencia timeline − `audio.currentTime`, con signo; regresión lineal):

| Entorno | desfase medio | pendiente | deriva extrapolada a 50 s | rango | muestras > 33 ms |
|---|---|---|---|---|---|
| WebView2, aurora | +25,6 ms | +0,171 ms/s | **+8,4 ms** | −12,3…+46,1 ms | 99 / 200 |
| Chrome (Radeon), aurora | +19,9 ms | −0,117 ms/s | **−5,7 ms** | −11,6…+53 ms | 66 / 200 |
| Chrome (RTX), reserva CSS | +30,6 ms | −0,062 ms/s | **−3,0 ms** | −7,8…+41,9 ms | 30 / 200 |

Frente al reloj de pared el timeline se desvía como mucho 3–23 ms (22,6 ms en WebView2). **Matiz honesto:** lo que
crece con el tiempo (la deriva) es de unos pocos ms y cumple de sobra; lo que *no* cumple 33 ms es el **desfase
instantáneo** entre el timeline y `audio.currentTime` (oscila entre −12 y +53 ms alrededor de una media de +20…+31 ms).
Es en parte artefacto de medir (`currentTime` se actualiza a saltos de buffer y el timeline en cada `rAF`) y no mide la
latencia de salida de audio, que no se puede observar por software. A oído no puedo decir si se nota; hay que
escucharlo con voz real.

## Comparación de fotogramas con el MP4

MP4 de referencia: `hyperframes render --browser-gpu --quality delivery` con el ffmpeg LGPL (282 s). Capturas de la
preview a 1080×1920 sin escalar (viewport 1140×1980, `escala=1`), seek a 1, 10, 25 y 45 s, 1,5 s de espera, captura del
elemento. MP4: `ffmpeg -ss t -i aurora.mp4 -frames:v 1`. Métrica: SSIM y PSNR de `ffmpeg` (más imagen
lado a lado con la diferencia ×6 en `spikes/salidas/preview/aurora_*_lado_*.png`).

| Segundo | Chrome/RTX (página recién cargada) | WebView2 y Chrome/Radeon (recién cargada = tras 4 s de play) | WebView2 tras reproducir **50 s** | Chrome/Radeon tras 50 s |
|---|---|---|---|---|
| 1 s | 0,980 / 30,8 dB | 0,982 / 32,7 | 0,982 / 32,7 | 0,982 / 32,7 |
| 10 s | 0,972 / 37,6 | 0,930 / 29,9 | **0,625 / 18,1** | **0,603 / 18,3** |
| 25 s | 0,982 / 37,1 | 0,970 / 36,8 | **0,861 / 21,4** | **0,773 / 19,0** |
| 45 s | 0,979 / 39,5 | 0,979 / 41,0 | 0,979 / 41,0 | 0,979 / 41,0 |

(SSIM / PSNR.) A ojo, **con la preview recién cargada o tras unos segundos de reproducción los fotogramas son
iguales**: capas, texto, subtítulos y posiciones idénticos; la diferencia está en el borde de los glifos (el MP4
va comprimido a 12 Mb/s) y, en la Radeon, en un fondo aurora algo distinto en 10 s (matiz de coma flotante entre GPU;
con la RTX coincide mejor).

**Fallo encontrado:** tras reproducir el vídeo completo y volver atrás, `seek(10)` y `seek(25)` muestran el fondo
aurora en **otra fase** (las capas de texto siguen bien). Los valores de tiempo son correctos (`__player.getTime()` y
`__hfTypegpuTime` valen 10 y 25), así que el estado erróneo es del propio shader. Se recupera haciendo un seek
previo a otro instante (10,5 s o 25 s) y luego al deseado; seek a 0 o repetir el mismo no basta. Reproduce en Chrome
y en WebView2 con la Radeon; **no se probó con la RTX** (Windows eligió la Radeon en las últimas ejecuciones). No lo
he diagnosticado más allá de eso.

## Hallazgo sobre la GPU

El adaptador WebGPU lo decide Windows, no la app: `powerPreference` se ignora en Windows
(crbug 369219127). El WebView2 usó la **Radeon 780M**; Chrome usó la RTX al principio y la Radeon después. Hay que
fijar la preferencia por app en *Configuración → Sistema → Pantalla → Gráficos* (para `app-ui.exe` y
`msedgewebview2.exe`) si se quiere la RTX, y el informe de fase 1 no debe suponer una GPU concreta.

## Procedimiento manual para Marc (WebView2 real, sin Playwright)

Hecho en Git Bash, desde la raíz del worktree. Una sola vez, montar la composición (necesita `npm run build` en
`video-mcp-server`): `node spikes/preview-montar.mjs "<carpeta bin del ffmpeg LGPL>"`.

```bash
cd app-ui
# Tauri exige que existan los binarios del bundle aunque en dev se use `uv run app-backend` (están en .gitignore):
: > src-tauri/binaries/app-backend-x86_64-pc-windows-msvc.exe; mkdir -p src-tauri/binaries/_internal; echo x > src-tauri/binaries/_internal/placeholder.txt
R="C:\\ruta\\al\\worktree"
export APP_BACKEND_SPIKES=1
export APP_BACKEND_SPIKE_COMPOSICION="$R\\video-mcp-server\\spikes\\salidas\\preview\\aurora\\footy999\\_composicion"   # o ...\\css\\...
export APP_BACKEND_SPIKE_RUNTIME="$R\\video-mcp-server\\node_modules\\hyperframes\\dist\\hyperframe.runtime.iife.js"
export APP_BACKEND_SECRETS=file APP_BACKEND_DIR="C:\\Temp\\spike-d6"      # no toca tus credenciales reales
pnpm tauri dev
```

En la ventana de la app: abre las herramientas de desarrollo (clic derecho → *Inspeccionar*) y en la consola ejecuta
`location.hash = "#/spike-preview"`. Espera a «Runtime listo», pulsa **Medir** (≈ 1 min 10 s sin tocar nada, con la
ventana visible) y copia el JSON que aparece (fps, seek, deriva). Para comparar GPU, repite tras fijar `app-ui.exe` y
`msedgewebview2.exe` en «Alto rendimiento» (RTX). Los botones Play/Pause/Seek sirven para mirarlo a ojo y escuchar la voz.
Cierra con Ctrl+C; el puerto 1420 queda libre.

Para repetir **mi** medición (Playwright sobre el WebView2 real vía CDP): añade
`WEBVIEW2_USER_DATA_FOLDER="C:\\Temp\\wv2-datos"` y `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --disable-features=CalculateNativeWinOcclusion"`
antes de `pnpm tauri dev` (la carpeta de datos propia evita el error `0x8007139F` si ya hay un WebView2 con otros
argumentos), y luego `node scripts/spike-preview-medir.mjs --variante aurora --cdp http://127.0.0.1:9222 --salidas <carpeta> --fotogramas`.

## Seguridad (resumen)

- Aislamiento por `sandbox="allow-scripts"` sin `allow-same-origin`: probado (ver arriba). El texto derivado del
  modelo vive en una página sin acceso al token ni a `window.__TAURI__`.
- URL de capacidad: la clave aparece en el `src` del iframe y en el log de acceso de uvicorn (stderr del sidecar). No da
  acceso a nada fuera de la carpeta de la composición; en producción conviene rotarla por proyecto/sesión.
- `CORS: *` solo en estas rutas de solo lectura. Para producción hará falta `frame-src http://127.0.0.1:*` en el `csp`
  real (el spike lo deja fuera a propósito) y decidir si el runtime se sirve desde el bundle de HyperFrames (Apache-2.0, con su aviso).
- El mensaje de `postMessage` del padre al iframe usa `targetOrigin "*"` (origen opaco, no hay otro posible); no lleva datos sensibles.

## Preocupaciones / pendiente

1. **Fondo WebGPU tras reproducir entero** (arriba): bloquea el «lo que se ve es lo que se renderiza» para fondos con
   shader. Opciones a evaluar en la fase 1: seek «de calentamiento» a otro instante tras pausar, reinicializar el
   fondo al terminar la reproducción, o conducir el shader con un tiempo propio. Probar también con la RTX.
2. Desfase instantáneo audio/timeline hasta 46–53 ms: escuchar con voz real antes de darlo por bueno.
3. Una sola máquina y una ejecución por celda; el fps depende de la tasa de refresco y de la GPU que elija Windows.
4. La reserva CSS no se midió en WebView2 (sí en Chrome/RTX: 60 fps, seek 33 ms, deriva −3 ms/50 s).
5. El runtime se inyecta desde `node_modules/hyperframes`: en producción hay que fijar de dónde sale y su versión.
