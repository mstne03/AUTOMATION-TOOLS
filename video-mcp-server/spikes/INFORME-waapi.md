# Spike GSAP → WAAPI (punto 1 del handoff de la fase 0)

Fecha: 2026-10-29 · Máquina: Windows 11, RTX 4060 Laptop · HyperFrames 0.8.206 · gsap 3.15.0 (solo como referencia).
Código del spike (desechable): `spikes/waapi/`. Salidas (MP4, PNG, JSON) en `spikes/salidas/waapi/` (ignorada por git).

## Veredicto

**Viable. Se cumplen los cinco criterios de salida.** Una pieza solo CSS (`gancho`) y una mixta, CSS más un
número que cuenta (`escena-cifra`, con fundido, punch, golpe y destello), se reescribieron sin GSAP. Dan
fotogramas equivalentes a los de GSAP en el render real y el mismo estado en la preview, tanto con seek como
reproduciendo. La composición WAAPI no carga ni una línea de GSAP, y el runtime de HyperFrames tampoco la lleva
(solo usa `window.gsap` si existe).

Recomiendo adoptar el enfoque en la fase 1: un motor de tiempo propio de unas 100 líneas (`hf-tiempo.js`) y
una migración mecánica, tween a tween, de las 14 piezas.

## Criterios de salida (los fijé yo: el handoff solo pedía «comparación de fotogramas por pieza»)

| # | Criterio | Resultado | Estado |
|---|---|---|---|
| 1 | Render real: cada fotograma con SSIM ≥ 0,99 frente a la versión GSAP | 372 fotogramas; mínimo **0,9945**, media 0,99946; **0** por debajo de 0,99 | cumple |
| 2 | Preview, seek en frío: mismo estado que GSAP | texto del contador **idéntico** en todos los instantes probados; posición del titular a ≤ **0,2 px** en plena salida | cumple |
| 3 | Preview, reproduciendo: las animaciones y el contador avanzan, y el reloj de WAAPI va con el del reproductor (≤ 1 fotograma, 33 ms) | `hf-seek` en cada fotograma del play; desfase WAAPI–reproductor de mediana **1,9 ms** y máximo **3,1 ms** | cumple |
| 4 | Un seek después de reproducir la composición entera da el mismo estado que el seek en frío (el fallo que tuvo el shader en la fase 0) | idéntico en 1; 4,2; 6,9 y 10 s | cumple |
| 5 | Sin GSAP cargado y `hyperframes check` sin errores nuevos | ningún `gsap` fuera de comentarios; `check` da los mismos hallazgos que la versión GSAP (ver «`check`») | cumple |

El peor fotograma del render (2,167 s) cae en la salida del gancho, que se mueve unos 100 px por fotograma. La
sonda mide 195,54 px (GSAP) frente a 195,34 px (WAAPI): la diferencia de SSIM es de rasterizado y
codificación, no de tiempo. En fotogramas quietos el SSIM es de 0,9996, también por rasterizado: GSAP escribe
una `matrix()` en `transform`, y WAAPI usa las propiedades `translate` y `scale` por separado.

**Lo que no cubre:**
- La preview se midió en `chrome-headless-shell` 152, servida como la sirve el spike de preview (runtime
  inyectado), no dentro del WebView2 de la app. WAAPI y `linear()` son de Chromium, igual que el WebView2,
  pero hay que repetirlo allí.
- No se migró ninguna pieza con three.js. Usan el mismo mecanismo que el contador (`hf-seek`), que es el
  protocolo documentado por HyperFrames para three.js, pero no está medido.
- Los tiempos de render (GSAP 45 s, WAAPI 35 s) son de una sola ejecución, con las sondas corriendo a la vez:
  no sirven para comparar.

## Cómo funciona (tres mecanismos)

1. **`HF.tween(sel, desde, hasta, t, d, curva, {antes})`** equivale a `tl.fromTo(sel, desde, {…hasta, duration: d, ease}, t)`.
   - Crea `el.animate(...)` en pausa, con `delay` = inicio absoluto del host + `t`, porque WAAPI cuenta en
     tiempo de documento.
   - El adaptador `waapi` del runtime encuentra la animación (parchea `Element.animate`) y fija su
     `currentTime` en cada seek, también durante el play: la animación sigue en pausa y la mueve el runtime.
   - `immediateRender: false` de GSAP pasa a `fill: "forwards"`, y lo normal (`fromTo`) a `fill: "both"`.
     Con esa regla, varios tweens seguidos sobre la misma propiedad se componen igual que en GSAP: la
     animación posterior gana, pero no pinta antes de empezar.
   - `x`/`y`/`xPercent`/`yPercent` van a `translate`, `scale` a `scale` y `rotation` a `rotate`, que son
     propiedades CSS independientes y se componen en el mismo orden que el `transform` de GSAP.
2. **Las curvas son las de GSAP, copiadas:**
   - Cada familia se define por su `in` y `out`/`inOut` se derivan igual que en `gsap-core.js`. Incluye la
     `expo` «mezclada» de gsap 3.15, que **no** es la de libro: con la de libro, la escala a 0,3 s era 1,0033
     frente a 1,0024.
   - WAAPI las recibe muestreadas como `linear(…)` de CSS, con 65 puntos.
   - `curvas.test.mjs` comprueba 22 curvas contra las de gsap: diferencia < 1e-9.
3. **`HF.reloj(fn)`** cubre lo que WAAPI no anima (el texto del contador, y más adelante three.js, el reloj de
   `escena-barras` y el HUD de `capas`): llama a `fn(tLocal)` en cada evento `hf-seek`. El runtime lo dispara
   en cada seek y en cada fotograma del play, así que no hace falta `requestAnimationFrame` propio.
   `tLocal` sale solo del tiempo, sin estado acumulado.

## Hallazgos del runtime que fijan el diseño

- **El runtime desenvuelve la raíz de cada subcomposición**: `<div id="bloque1" data-composition-id>`
  desaparece y el host `h-bloque1` hace de raíz. `document.getElementById("bloque1")` da null.
- **Los scripts de las subcomposiciones no se ejecutan en su sitio**: `document.currentScript` es null.
- **El runtime quita `data-duration` del host al montarlo.** La primera versión leía la duración del DOM y
  calculaba todo con D = 0.
- Por esos tres puntos, la pieza recibe el id, el inicio absoluto y la duración como datos generados
  (`{{ID}}`, `{{INICIO}}`, `{{DURACION}}`, que rellena `composicion.ts`), nunca leídos del DOM.
  `composicion.ts` ya conoce el `inicio` de cada host.
- **`missing_timeline_registry`:** sin `window.__timelines`, `hyperframes check` da error. El motor trata
  los errores de `check` como bloqueantes (`render.ts`, `comprobarComposicion`), así que no se renderizaría.
  La exclusión oficial es el atributo **`data-no-timeline`** en la raíz (`#root`); con él la regla calla.
- **Pista para el punto 4 (fallo de fase del shader), sin verificar:** el adaptador `typegpu` pone su tiempo
  a `null` al hacer `play()`. Mientras se reproduce, el shader corre con su propio reloj, no con el de la
  composición. Encaja con «fotogramas distintos tras reproducir 50 s». Merece mirarlo primero al diagnosticar
  ese punto.

## `check`

Las dos variantes recortadas dan el mismo único error, `content_overlap` a 0,689 s: el gancho tapa el número
del bloque 1. Es cosa de la composición de prueba (escena `cifra` en el bloque 1, bajo el gancho), no de la
migración. Sin `data-no-timeline`, la variante WAAPI añade además `missing_timeline_registry`.

## Límites conocidos de `hf-tiempo.js` (para la fase 1)

- **`x` e `y` comparten `translate`:** un tween que mueve solo `y` y otro que mueve solo `x` sobre el **mismo
  elemento** se pisarían. GSAP sí lo permite. `hf-tiempo.js` lo detecta y lanza un error. Si alguna pieza lo
  necesita, se resuelve con un elemento envoltorio o con `composite: "add"`.
- Solo traduce lo que usan las plantillas: `fromTo` con `x`, `y`, `xPercent`, `yPercent`, `scale`,
  `rotation`, y el resto de propiedades CSS tal cual (`opacity`, `color`, `textShadow`). Al migrar cada pieza
  hay que revisar si usa `stagger`, `repeat`, `onUpdate` o `.to()` encadenados.
- **Riesgo por medir:** los subtítulos crean una animación por cambio de color de cada palabra, cientos en un
  vídeo de 60 s, y el runtime recorre todas en cada fotograma del play. Hay que medir el coste en la preview
  con los subtítulos migrados. Si pesa, esa pieza va con `HF.reloj` (un solo listener) en vez de WAAPI.

## Recomendación para la fase 1

1. Mover `hf-tiempo.js` a `plantilla/vendor/`, con `composicion.ts` copiándolo como hoy copia `gsap.min.js`.
2. Añadir `{{INICIO}}` a las piezas que tienen host. `{{ID}}` y `{{DURACION}}` ya existen.
3. En `index.html`, quitar `gsap.min.js` y el timeline `main` y añadir `data-no-timeline`.
4. Migrar las 14 piezas tween a tween:
   - `fromTo` pasa a `hf.tween`, e `immediateRender: false` a `{antes: false}`.
   - Los setters de objetos JS (contador, reloj, three.js) pasan a `hf.reloj`.
   - Cada pieza lleva su comparación de fotogramas contra la versión GSAP, con el arnés de este spike
     generalizado (render más SSIM por fotograma, y sondas de preview).
   - **La comparación se hace antes de quitar GSAP del repo:** la referencia es su render.
5. Al terminar, quitar `gsap` de `package.json`, `GSAP_JS` de `composicion.ts` y las copias de gsap del
   paquete `hyperframes` del bundle (`dist/vendor/npm/`, `dist/studio/`). Hay que resolver también las
   composiciones de `catalogo/` que cargan GSAP desde jsDelivr.
6. `curvas.test.mjs` compara contra el paquete gsap. Antes de quitarlo, congelar sus valores en una tabla
   dentro del test, para que gsap no se quede ni como dependencia de desarrollo.

## Seguridad

- WAAPI y `hf-tiempo.js` son código propio, sin terceros: se quita una biblioteca entera de la superficie de
  la composición.
- Los datos de la pieza (`{{ID}}`, `{{INICIO}}`, `{{DURACION}}`) los genera `composicion.ts`, no el modelo,
  igual que hoy. Los textos del guion siguen yendo escapados y fuera del JS.
- La sonda del spike (`sondear.mjs`) sirve solo en `127.0.0.1`, con puerto aleatorio, comprobación de prefijo
  de ruta y solo lectura. No pasa al producto.

## Cómo reproducirlo

Desde `video-mcp-server/` en Git Bash, con `npm run build` hecho y el motor empaquetado
(`app-ui/src-tauri/binaries/video-engine`, de `prepare-video-engine.sh`):

```bash
E="$(cd .. && pwd)/app-ui/src-tauri/binaries/video-engine"
node spikes/waapi/montar.mjs "$E/ffmpeg"            # composición de 12,4 s, variantes gsap/ y waapi/
node spikes/waapi/render-comparar.mjs "$E"           # render de las dos y SSIM por fotograma → render.json
node spikes/waapi/curvas.test.mjs                    # curvas iguales a gsap
B="$E/browser/chrome-headless-shell-win64/chrome-headless-shell.exe"
node spikes/waapi/sondear.mjs spikes/salidas/waapi/waapi "$B" "$(cat spikes/waapi/sonda-play.js)"
node spikes/waapi/sondear.mjs spikes/salidas/waapi/waapi "$B" "$(cat spikes/waapi/sonda-deriva.js)"
```
