# Diagnóstico del fallo de fase del fondo shader en la preview (W1.1, SEO-114)

Fecha: 2026-10-29 · Máquina: Windows 11, RTX 4060 Laptop + Radeon 780M · HyperFrames 0.8.206 · shaders 4.0.0.
Código: `spikes/shader/` (desechable, solo desarrollo). Salidas (PNG, JSON, trazas): `spikes/salidas/shader/`, ignorada por git.

## 1. Veredicto

**Causa raíz: confirmada (H1).** El *glue* de `plantilla/vendor/shaders.iife.js` (bloque del catálogo de HyperFrames)
encola **un `renderSyntheticFrame` por cada evento `hf-seek`** en una cadena de promesas serie (`T0`), y cada render
espera a `queue.onSubmittedWorkDone()`. Durante el *play* el runtime despacha un `hf-seek` **por fotograma** (144/s en
esta pantalla). Si la GPU pinta menos renders por segundo de los que llegan, la cola crece sin límite: tras 50 s de play
quedaron **2 171–2 336 renders pendientes** y el shader iba **16 s por detrás** del vídeo (`globalElapsedTime` 34–35 s con
el reproductor en 50,4 s). Un seek tras pausar entra al **final** de esa cola: el lienzo sigue mostrando los fotogramas
viejos del play durante **~17 s** hasta vaciarla; luego la imagen es exacta (SSIM 1,0000, bytes idénticos).

**Arreglo recomendado:** parche mínimo al glue, «el último gana» (coalescer los `hf-seek` pendientes en uno). Medido en
memoria: **12/12 + 51/51 + 4/4… capturas idénticas** a la referencia, coste del seek 13–16 ms (mediana), sin depender de
`'unsafe-eval'`. Lo integra **W2.6** (diff en §6). Los arreglos sin parche que proponía el plan **no funcionan** (§6).

Los tiempos del runtime son correctos: la pista del adaptador `typegpu` (H2) queda **descartada**.

## 2. Entorno

| | |
|---|---|
| Navegador medido | **Chrome 156.0.8078.48 del sistema, `--headless=new`, no CfT** (ver abajo) |
| Adaptador WebGPU (S0) | `amd / rdna-3` (Radeon 780M), `isFallbackAdapter: false` (hardware). La RTX **no** se midió |
| Runtime | `hyperframe.runtime.iife.js` 0.8.206, SHA-256 `cafd7cc9…607e` (igual al del origen) |
| Biblioteca | `shaders.iife.js` 4.0.0, SHA-256 `6ad60b5f…5f2d` |
| Banderas | `--enable-unsafe-webgpu --disable-dawn-features=use_dxc --use-gl=angle --use-angle=d3d11 --enable-gpu-rasterization --ignore-gpu-blocklist --autoplay-policy=no-user-gesture-required --proxy-server=127.0.0.1:1 --host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1`, CDP por `--remote-debugging-pipe`, perfil temporal nuevo, **sandbox por defecto** |
| Node / ffmpeg | Node 24.22.1 del sistema (el `puppeteer-core` 25.16.0 del lock); ffmpeg LGPL del bundle, solo para SSIM |

**CfT 152 headless-shell: sin adaptador WebGPU con el sandbox por defecto** (S0: `requestAdapter()` → `null`,
«Failed to create WebGPU Context Provider», la biblioteca falla con `no-adapter`). La R0 permitía una única escalada,
`--disable-gpu-sandbox` (la configuración ya adoptada para el render en `INFORME-chromium.md`), pero **el sistema de
permisos de la sesión bloqueó ese lanzamiento** y no lo reintenté. Por eso se midió con el Chrome del sistema como
diagnóstico (R0 L1: `pipe:true`, perfil nuevo bajo `salidas/shader/perfil-tmp` borrado al acabar, mismas banderas y
mismo control positivo). La causa es lógica JavaScript del glue, independiente del binario; pero **Marc debe decidir** si
quiere repetir la reproducción en el CfT con `--disable-gpu-sandbox` (comando en §8).

Puppeteer añade por su cuenta `--disable-features=…,IsolateSandboxedIframes` (queda en `lanzamiento.json`); no está en
la lista prohibida de la R0, pero hace que el iframe sandboxed comparta proceso con el anfitrión, distinto del WebView2.

## 3. Reproducción

Referencia «fresca» (S1): página recién cargada → seek → `__hfWaitForSeekCompletion` → 1,5 s → captura del
`canvas[data-shader]`. **Suelo de ruido: 0** (3 cargas, bytes idénticos, SSIM 1,0000). Umbral de «igual»: 0,995.

**Hallazgo de método:** con el procedimiento del plan (capturar tras `__hfWaitForSeekCompletion`), S2 **no falla**
(12/12 iguales), porque esa espera ya incluye vaciar la cola del shader: el primer seek tras el play tardó
**17,8–19,5 s** en completarse. La preview real **no** espera eso: `CONTROL_JS` responde tras `seek` + dos `rAF`. Con ese
flujo (`--esperar-seek no`, 1,5 s y captura) el fallo reproduce:

| Escenario (modo directo, Chrome 156) | 1 s | 10 s | 25 s | 45 s | n/N con fallo |
|---|---|---|---|---|---|
| S1 fresco (×3) | 1,0000 | 1,0000 | 1,0000 | 1,0000 | 0/3 |
| **S2 play 50,4 s → pausa → seeks (×3)** | **0,567–0,575** | **0,503–0,506** | **0,886–0,896** | **0,827–0,834** | **3/3** (12/12 capturas mal) |
| S3 play 4 s (×3) | 1,0000 | 1,0000 | 1,0000 | 1,0000 | 0/3 |
| S4 sin play, seek 50 → t (×3) | 1,0000 | 1,0000 | 1,0000 | 1,0000 | 0/3 |

(SSIM contra S1. PSNR de S2: 11–25 dB.) Que falle a 1 y 45 s aquí y no en el informe de preview es lo esperable: qué
capturas caen dentro del vaciado depende de cuántos renders quedan y del ritmo de la GPU (ver §5).

## 4. Hipótesis

| # | Predicción (paso 1.3, antes de medir) | Observado | Estado |
|---|---|---|---|
| H1 cola `T0` | cola > 0 al pausar y creciente; se cura al vaciarla; 50 s falla y 4 s no | 2 171–2 336 pendientes al pausar (144 `hf-seek`/s frente a 101 renders/s); S6 (esperar a vaciar, 17,0–17,5 s, +30 s): **12/12 iguales, 3/3**; S7: la imagen es errónea mientras `pend > 0` y exacta en cuanto llega a 0; S3 (4 s) sin fallo | **Confirmada** |
| H2 adaptador `typegpu` | `hf-seek` con tiempo ≠ pedido o perdido; variantes lo arreglan | todos los `hf-seek` tras el seek llevan el tiempo pedido; `__player.getTime()` y `__hfTypegpuTime` = pedido; `runtimeSinNullEnPlay` 0/4 y `runtimeSeekForzado` 0/4 | **Descartada** |
| H3 acumulador | `Pe` ≠ pedido tras vaciar, o falla sin play | `Pe` = pedido exacto en cuanto se vacía la cola; S4 sin play 12/12 iguales. `_animTime` = 5·`Pe` − 0,08 en todos los casos (desfase constante del arranque, igual en la referencia) | **Descartada** |
| H4 presentación | converge sola sin nuevos seeks | sí converge, pero exactamente cuando la cola llega a 0 (S7: `t10` mal a +0,2/+1,5/+4 s con `pend` 789→255, bien a +10 s con `pend` 0). Es la cola, no la presentación | **Descartada como causa propia** |
| H5 bucle propio | `animating:true` o `Pe` cambia sin `hf-seek` | `animating:false` siempre; `Pe` solo avanza al vaciar renders encolados | **Descartada** |

## 5. Causa raíz

1. Durante el play, el adaptador `typegpu` del runtime (`qb`, `seek(i)` → `_s(e)`) despacha `hf-seek` en cada fotograma
   con el tiempo actual (traza S5: 7 254 eventos en 50,4 s, 144/s, tiempos crecientes cada ~7 ms).
2. El glue de `shaders.iife.js` hace, por cada evento:
   `T0 = T0.then(() => Ji.renderSyntheticFrame(t − globalElapsedTime))`, y `renderSyntheticFrame` = `W0(delta)` +
   `await queue.onSubmittedWorkDone()`. Es una **cola serie sin coalescer** y cada elemento espera a la GPU.
3. En modo directo la GPU sostuvo **~101 renders/s**: la cola crece ~43/s → ~2 200 pendientes al pausar.
4. El seek tras pausar encola su render **detrás** de ~2 200 fotogramas del play: durante ~17 s el lienzo «reproduce»
   el tramo 34→50 s en cámara rápida y después salta al tiempo pedido. Cualquier captura (o lo que ve el usuario) en
   ese intervalo muestra otra fase. El mismo defecto hace que **durante el propio play** el fondo vaya a cámara lenta
   (16 s de retraso en 50 s) y siga moviéndose tras pausar.
5. Por qué se cura con un seek previo a otro instante (informe de preview): no lo cura el seek, lo cura el **tiempo** que
   pasa mientras tanto. Por qué depende del entorno: con el iframe sandboxed (y con la CSP del producto, también origen
   opaco) la GPU dio **133–142 renders/s**: la cola al pausar fue de 97–506 y se vació antes o durante las capturas
   (S2 en iframe: 4/4 bien; S5 con CSP: 1/4 mal, el primero, con 224 pendientes). Es una carrera: **el margen depende del
   refresco de pantalla y de la GPU**; con 135 fps de la Radeon en el WebView2 el informe de preview sí lo vio. Los
   shaders baratos (`plasma`, `nebula`) no acumulan cola aquí (4/4 bien sin arreglo); `mesh` sí (1/4 mal).
6. Defecto latente del mismo código: si un render **rechaza**, `T0` queda rechazada para siempre y todos los
   `hf-seek` posteriores se saltan (el fondo se congela). El arreglo de §6 también lo corrige.

## 6. Propuestas de arreglo

| Opción | Dónde vive | Resultado medido | Coste | Riesgo | Recomendación |
|---|---|---|---|---|---|
| (a) `__hfReseekGpu(t)` tras `p.seek(t)` en el control | `CONTROL_JS` | directo: **0/4** (encola otro render al final de la misma cola) | 1 línea | no arregla nada | No |
| (b) Seek de calentamiento | control | **0/4** (SSIM ≥ 0,70) | +1 seek | no arregla nada | No |
| (c) Variantes del adaptador `typegpu` | runtime (parche) | **0/4** las dos | — | — | No |
| (d) Esperar a vaciar la cola antes de mostrar | control | 4/4 bien, pero **hasta 16,9 s** por seek | inaceptable en UX | — | No |
| **(e) Glue «el último gana»** | `plantilla/vendor/shaders.iife.js` (parche, W2.6) | **3/3 S8 (12/12)**, barrido 0–50 s 51/51, 3 plays seguidos 4/4, pausa a 20 s 4/4, barrido rápido 60 seeks/1 s 4/4, `plasma`/`nebula`/`mesh` 4/4, con y sin CSP del producto, en modo directo y en iframe; S1 con el parche **idéntico** al original (51/51) | ~6 líneas; seek 13–16 ms (mediana) | parchear un bloque de tercero: se pierde al re-vendorizar | **Sí** |
| (f) Fondo CSS en la preview | plantilla | no medido | — | rompe «lo que se ve es lo que se renderiza» | Solo si (e) se descarta |

Mediana del coste de (e): `ms hasta listo` 13 (barrido), 14–16 (resto). Durante el play con (e) el shader va al día (no
hay cola) en vez de 16 s por detrás.

**Diff para W2.6 (no aplicado).** En `plantilla/vendor/shaders.iife.js`, última línea, sustituir exactamente:

```diff
-Ji=YE(),T0=Promise.resolve();function OE(e){return T0=T0.then(()=>Ji.renderSyntheticFrame(e-Ji.__testing.getFrameDiagnostics().globalElapsedTime)),T0}
+Ji=YE(),T0=null,hfPendiente=0,hfHay=!1;function OE(e){if(!Number.isFinite(e))return T0||Promise.resolve();hfPendiente=e;hfHay=!0;return T0||(T0=(async()=>{await null;try{for(;hfHay;){hfHay=!1;let t=hfPendiente;await Ji.renderSyntheticFrame(t-Ji.__testing.getFrameDiagnostics().globalElapsedTime)}}finally{T0=null;hfHay&&OE(hfPendiente).catch(()=>{})}})())}
```

(`hfPendiente` y `hfHay` no existen en el bundle; `P0`, por ejemplo, sí: el bundle minificado comparte ámbito.) Es la
variante `shadersParcheW26`.

Semántica: se guarda solo el último tiempo pedido y un indicador aparte (`hfHay`); un único bucle lo pinta y vuelve a
mirar si llegó otro mientras tanto. `await null` es la primera sentencia: `T0` queda asignada antes de ejecutar el
cuerpo, así que un `throw` síncrono (p. ej. de `getFrameDiagnostics()`) no la deja apuntando a una promesa resuelta para
siempre. Los tiempos no finitos (`null`, `NaN`, `Infinity`) se ignoran. Si un render rechaza y entretanto llegaron
peticiones nuevas, el `finally` relanza el bucle con la última (quien esperaba recibe el rechazo). La promesa que
reciben `waitUntil` y el arranque (`await OE(...)`) se resuelve cuando ya está pintado el último tiempo pedido, así que el
render fotograma a fotograma (un seek, espera, captura) no cambia: nunca hay más de un pendiente.

**Corrección de la ronda 1.** La primera versión del diff usaba `null` como centinela y no tenía `await null`: con
`OE(null)` (o un `throw` síncrono) el `finally` ponía `T0=null` antes de que se asignara y `T0` quedaba resuelta para
siempre (fondo congelado; reproducido con `Ji` falso: tras `OE(null)`, `OE(5)` no pinta). La versión de arriba lo
corrige. **Prueba en Node, sin navegador:** `node spikes/shader/glue.test.mjs` (con un `Ji` falso): no se congela con
`OE(null)`/`NaN`/`Infinity`, con un `throw` síncrono ni tras un rechazo; tras un rechazo con peticiones nuevas pinta la
última; 60 llamadas seguidas dejan un solo render en curso y pintan el último valor. W2.6 debe reutilizarla.

**Qué se midió en navegador y qué no.** La lógica «el último gana» se midió con `shadersUltimoGana` (contadores) en S8 y
todo S9. El texto literal se midió **solo en S8, modo directo, sin CSP** (3/3, 12/12 idénticas, 15 ms), y en su
**primera versión**; la corregida de la ronda 1 solo tiene la prueba en Node. **W2.6 debe repetir S8 y S9 con el texto
literal, en modo iframe y con la CSP del producto.**

Lo que W2.6 debe añadir: (1) un test que falle si el glue cambia (ancla exacta, 1 coincidencia) o si desaparece el
parche, más `glue.test.mjs`; (2) el SHA-256 nuevo en `catalogo/hyperframes.lock.json` y en `LICENCIAS.md` la nota de modificación; (3) **un
render real** de HyperFrames con el parche comparado con el actual (aquí solo se comprobó el seek fresco, no la CLI de
render); (4) redactar el issue a HyperFrames.

**Condiciones de la R0 (§6) si alguna vez se usara `__hfReseekGpu` desde el control** (aquí se midió y **no** arregla
este fallo; las fijo igualmente para W2.6): (1) sin tipo de mensaje nuevo: la llamada va dentro del `case "seek"`
existente, justo tras `p.seek(t)`, con la misma `t` acotada por `num(d.t, 0, p.getDuration())` (`__hfReseekGpu` no acota
por arriba: `Infinity` rompe la cola); prohibido un mensaje genérico `{tipo:"llamar", fn, args}`; (2) el padre nunca
invoca funciones del iframe; (3) las respuestas no se amplían con diagnóstico en producción (si se añaden para
depurar, se validan por esquema, I8); (4) si `typeof window.__hfReseekGpu !== "function"` → `{tipo:"error",
motivo:"reseek-no-disponible"}`, nunca saltarlo en silencio ni guardar la referencia al cargar; (5) W2.6 añade una prueba
que falla si la función desaparece o cambia de firma; (6) barrido rápido (60 seeks en 1 s): cola acotada y vaciada.
La ampliación de `CONTROL_JS` del spike (`servir.mjs`, `control(true)`) cumple 1–4.

**Ningún arreglo puede exigir `allow-same-origin`, `allow-popups`, `allow-top-navigation` ni llamar al iframe desde el
padre por otra vía que no sea `postMessage`.** El (e) no toca el iframe ni el control.

## 7. Seguridad

- **I2 (sin red):** 62 ejecuciones (más 3 de `shadersParcheW26`, con el mismo resultado), 442 peticiones al servidor, **0** con `Host` distinto de `127.0.0.1:<puerto>`,
  **0** peticiones de página fuera de la lista blanca (`http://127.0.0.1:<puerto>/`, `data:`, `blob:`); el tráfico
  propio del proceso browser (fuera de las páginas) no lo ve `page.on("request")`: lo cubren el proxy y el control
  positivo. Control
  positivo en **cada** lanzamiento (62/62): `fetch http://203.0.113.1/`, `fetch http://ejemplo.test/` y
  `WebSocket ws://203.0.113.1/` fallan (`net::ERR_PROXY_CONNECTION_FAILED`). El proxy corta antes que
  `--host-resolver-rules`, así que la segunda barrera no queda probada por separado.
- **M1:** CDP por pipe. S0: el navegador (9 PID con nuestro perfil) **no escucha en ningún puerto TCP**; el único listener
  del spike es `servir.mjs` en `127.0.0.1`. Ronda 1: la comprobación usa `netstat -ano` sin `-p` (TCP en LISTENING y
  UDP, IPv4 e IPv6, por PID); repetida en S0: 0 escuchas TCP/UDP del navegador, una sola del spike (TCP `127.0.0.1`).
- **CORS del servidor de prueba:** solo `Access-Control-Allow-Origin: null` cuando la petición llega con `Origin: null`
  (iframe sandboxed o CSP `sandbox`); nunca `*`. Es andamiaje del spike y **no se traslada al producto** (I8).
- **M3:** `lanzamiento.json` en cada escenario; `repro.mjs` aborta con `--no-sandbox`, `--single-process`,
  `--in-process-gpu`, `--disable-web-security` o `--use-webgpu-adapter=swiftshader`, y si faltan las dos banderas de red.
  Ninguna escalada usada.
- **M5 (CSP del producto):** `default-src 'none'; script-src/connect-src/img-src http://127.0.0.1:<p> data: blob:;
  style-src 'unsafe-inline'; sandbox allow-scripts` + `nosniff`. Única violación: `script-src eval` desde
  `shaders.iife.js` (una detección `new Function("return true")` en `try/catch`); la biblioteca sigue funcionando.
  **Ni el fallo ni el arreglo dependen de `'unsafe-eval'`** (S2/S5 con CSP reproducen; S9 con CSP 51/51). `style-src
  'unsafe-inline'` se puso de partida por los `<style>` y `style=` de las plantillas; no medí si se puede quitar (es de W1.2).
- **L2:** autotest de `servir.mjs`: `..%5C..%5C`, `%00`, `%E0`, `C:%5C…` → 400; `Host: evil.test` → 421; POST → 405;
  sigue vivo.
- **L3:** 0 procesos restantes tras cada ejecución (CfT por ruta de imagen; Chrome del sistema por perfil temporal, para
  no contar el navegador de Marc) y 0 al final, incluido el ffmpeg del bundle.
- **L4:** runtime copiado = origen (`cafd7cc9…607e`); `puppeteer-core` 25.16.0 = lock; `chrome-headless-shell.exe`
  (`909fa4a0…e7e6`) y `ffmpeg.exe` (`3e79ae08…956f`) iguales al ejecutable dentro de los zips de la caché de
  `prepare-video-engine.sh`, cuyos SHA-256 (`5d7df999…275e`, `b7c1c846…4fc0`) coinciden con los fijados en el script.
- **L3 y L4 automatizados (ronda 1):** `node spikes/shader/verificar.mjs` compara runtime, `shaders.iife.js` (contra
  `catalogo/hyperframes.lock.json`), `puppeteer-core` (contra el lock), CfT y ffmpeg con sus referencias y cuenta los
  procesos restantes; sale con 1 si algo no cuadra. Salida actual: todo `ok`, 0 procesos.
- **Rutas:** `--etiqueta` y `--salida` solo `[A-Za-z0-9_-]` y bajo `spikes/salidas/shader` antes de borrar nada;
  `comparar.mjs` solo acepta PNG bajo esa carpeta y llama a ffmpeg con `-protocol_whitelist file`.
- **I9:** `git diff 0353fae -- package.json package-lock.json` vacío; `node_modules` copiado, no instalado.
- **Ningún parche aplicado:** variantes solo en memoria al servir; SHA-256 de runtime y `shaders.iife.js` iguales antes y
  después.
- **I1 (informativo):** `montar.mjs` usa las mismas props que `composicion.ts`, escapadas para atributo. El esquema de props
  del shader debe ser **lista cerrada sin URLs**.

## 8. Lo que no cubre y cómo repetirlo

No cubre: el CfT (§2), la RTX 4060, el WebView2 (M2, lo mide Marc), una sola máquina, el render de la CLI con el parche.

```bash
cd video-mcp-server
CH="/c/Program Files/Google/Chrome/Application/chrome.exe"
FF=".../video-engine/ffmpeg/ffmpeg.exe"
node spikes/shader/montar.mjs
node spikes/shader/variantes.mjs --autotest && node spikes/shader/servir.mjs --autotest
node spikes/shader/glue.test.mjs && node spikes/shader/verificar.mjs
node spikes/shader/repro.mjs --navegador "$CH" --headless new --escenario S1 --repeticiones 3 --etiqueta c156
node spikes/shader/repro.mjs --navegador "$CH" --headless new --esperar-seek no --escenario S2 --repeticiones 3 --etiqueta c156-preview
node spikes/shader/comparar.mjs --ffmpeg "$FF" --escenario S2-c156-preview --referencia S1-c156
node spikes/shader/repro.mjs --navegador "$CH" --headless new --esperar-seek no --escenario S8 --variantes shadersUltimoGana --repeticiones 3 --etiqueta e-ultimogana
# CfT, si Marc autoriza la escalada de la R0: añadir --disable-gpu-sandbox a ARGS de repro.mjs y usar
# --navegador ".../chrome-headless-shell-win64/chrome-headless-shell.exe" (headless shell por defecto).
```
