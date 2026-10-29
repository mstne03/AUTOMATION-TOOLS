# Diagnóstico del fallo de fase del shader (W1.1, SEO-114) — BORRADOR

> Borrador del paso 1.3: predicciones registradas **antes** de medir. Se completa al final.

## Predicciones (antes de medir)

| # | Hipótesis | Predicción si es cierta | Qué la descarta |
|---|---|---|---|
| H1 | Cola atrasada en `T0` (cola serie de `renderSyntheticFrame` de la biblioteca) | Encolados − resueltos > 0 al pausar, creciente con el play; el fallo desaparece al vaciar la cola; play 50 s falla y play 4 s no | Cola vacía al pausar y la imagen sigue mal tras vaciar y esperar 30 s |
| H2 | Adaptador `typegpu` del runtime (`play()` pone `e=null`; `_s` deduplica) | Algún `hf-seek` tras play→pausa→seek con tiempo ≠ pedido, o falta un despacho; las variantes `runtimeSinNullEnPlay`/`runtimeSeekForzado` arreglan la imagen | Todos los `hf-seek` posteriores llevan el tiempo pedido y las variantes no cambian nada |
| H3 | Acumulador de la biblioteca (`globalElapsedTime` u otro tiempo acumulado no sigue a lo pedido) | `Pe` ≠ pedido tras el seek malo, o el fallo reproduce sin play (seek 50 → 10) | `Pe` = pedido y sin play no falla |
| H4 | Presentación/captura (lienzo no presentado al capturar) | La imagen converge sola entre +0,2 y +10 s | Imagen estable y errónea a todos los retardos |
| H5 | Bucle propio de la biblioteca rearmado | `animating:true` o `Pe` cambia sin `hf-seek` | `animating:false` y `Pe` estable |

Expectativa global: H2 «pura» cae (el informe de preview ya vio `__hfTypegpuTime` correcto); H1 es la más probable.

Nota de lectura de código previa a medir (shaders 4.0.0): `globalElapsedTime` (`Pe`) y el tiempo animado
de `Aurora` (`_animTime`, `animatedTime:{speed:"speed"}`) avanzan con el **mismo** `deltaTime` en cada `W0`
(`L0`: `Pe += dt`; `F0`: `_animTime += dt·speed`). Si ambos reciben siempre los mismos deltas, no pueden
desfasarse entre sí; si el fallo existe con `Pe` correcto, el estado erróneo está en otro sitio.
