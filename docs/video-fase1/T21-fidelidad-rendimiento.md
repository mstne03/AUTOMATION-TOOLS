# T21 · Fidelidad de la preview (CA4) y rendimiento con 180 s

Ficheros (todo en `video-mcp-server/test/`, sin tocar `src/` ni `package.json`):

- `ayudas-aceptacion.ts`: proyecto con ElevenLabs simulado (el `fetch` inyectado de `vozGenerar`, como `montaje.test.ts`),
  preview servida como la sirve la UI (`servirComposicion` de `scripts/sondear-preview.mjs`: servidor de capacidad, iframe
  sandbox sin `allow-same-origin`, CSP real de la composición, runtime inyectado, flags de red del render) y SSIM con el
  ffmpeg LGPL.
- `fidelidad-preview.test.ts`: `fotogramas_fijos_ssim` (CA4).
- `rendimiento-180s.test.ts`: `rendimiento_180s`.

Ambos usan `FFMPEG_DIR` (de `VIDEO_E2E_FFMPEG`) y el CfT (de `VIDEO_E2E_NAVEGADOR`); si faltan, `exigirEntorno()` lanza error
(no salta ni cae al PATH). Sin `VIDEO_NAVEGADOR_MANIFIESTO` (modo no integrado) el motor acepta el navegador sin copiarlo.

## Comandos

```
export VIDEO_E2E_FFMPEG="<bin del ffmpeg LGPL del bundle>"
export VIDEO_E2E_NAVEGADOR="<carpeta con chrome-headless-shell-win64>"
npx vitest run test/fidelidad-preview.test.ts                 # ~5 min
VIDEO_MEDIR=1 npx vitest run test/rendimiento-180s.test.ts    # ~3 min
```

`render:aceptacion` tiene que fijar `VIDEO_MEDIR=1` para que `rendimiento-180s` se ejecute (sin él se salta, como
`rendimiento.test.ts`). `VIDEO_E2E_CONSERVAR=<carpeta>` deja los PNG de cada par para mirarlos; `VIDEO_E2E_FONDO=ninguno`
cambia el fondo (solo diagnóstico).

## CA4 · `fotogramas_fijos_ssim`: NO CUMPLE el umbral 0,99

Cómo: proyecto de 6 escenas (mapa, cartel, cifra…) con 3,2 s de voz por frase (≈ 19,2 s), fondo `aurora` con `webgpu=false`
(degradado CSS). Se monta la preview con `video_montar_preview`, se abre con la CSP real, se hace `__player.seek(t)` en
t = 2, 5, 8, 11, 14 s y se captura el iframe (1080×1920). Se renderiza el mismo proyecto con `video_renderizar` (modo auto,
resultó `compatible` = `h264_mf` 12 Mbps), se extrae cada instante del MP4 con `-ss t` y se compara con el filtro `ssim`.
Como control, la misma composición se renderiza sin pérdida (`--format png-sequence`) con la misma CLI.

| t | preview ↔ MP4 | preview ↔ render sin pérdida |
|---|---|---|
| 2 s | 0,97823 | 0,98126 |
| 5 s | 0,97841 | 0,98966 |
| 8 s | 0,97857 | 0,99085 |
| 11 s | 0,97821 | 0,98907 |
| 14 s | 0,97870 | 0,98905 |

Con fondo `ninguno` (sin degradado): MP4 0,973 a 0,978; sin pérdida 0,984 a 0,992.

Diagnóstico (no es un bug del motor, no se ha tocado `src/`):

1. Visualmente los pares son idénticos (mismo texto, posiciones y fondo). La diferencia entre la preview y el render sin
   pérdida es de ±1 nivel en degradados suaves y sombras de texto (anillos concéntricos al amplificar la diferencia 10×;
   PSNR 48,8 dB a 8 s). El SSIM global de un fotograma casi negro y con degradados es hipersensible a eso.
2. El resto de la caída es el codificador: pasar el PNG de la propia preview por `h264_mf -b:v 12M` da SSIM 0,983 contra
   el original, es decir, el MP4 no puede llegar a 0,99 en este contenido aunque la preview fuera perfecta.
3. Los tests por MP4 (5) y por render sin pérdida (5) quedan estrictos a ≥ 0,99, así que hoy fallan 9 de 10 (solo pasa el
   de 8 s sin pérdida, 0,99085). Es el resultado honesto del criterio tal como está escrito.

Decisión para Marc/orquestador: o se reformula la métrica de CA4 (p. ej. PSNR ≥ 40 dB, o SSIM tras un desenfoque leve /
solo sobre regiones de texto, o frente al render sin pérdida con umbral 0,98), o se sube la calidad de `h264_mf`
(`-b:v 12M` en `render.ts:50`, cambio de motor que no he hecho). Relacionado con el riesgo del plan «`h264_mf` da poca
calidad».

## Hallazgo del motor (no arreglado): escena 1 con texto + gancho = `check` falla

Un proyecto cuya escena 1 es `cifra` o `cartel` (con o sin etiqueta/subtexto) y que lleva `gancho` (obligatorio) hace que
`hyperframes check` devuelva `content_overlap` en `esc1.html @1.102s` y el render falle. `composicion.ts:543-549` acorta el
gancho solo si la escena que choca es de `ventanas.slice(1)` (bloque 2 en adelante); la escena 1 queda fuera. En el
modelo de proyecto toda escena trae `base` (`linea.ts:100`), así que el caso es alcanzable por un usuario. Con `mapa` en la
escena 1 no ocurre. El fixture usa mapa en la escena 1 para esquivarlo. Conviene un issue en Plane.

## `rendimiento_180s`: PASS

Proyecto de 90 escenas (cifra/cartel alternos, mapa en la 1), 1,95 s de voz por frase: 179,1 s de vídeo (el máximo es 180).
Nota: el esquema limita la narración a 3000 caracteres, por eso las frases del fixture son cortas.

| Fase | Medido | Timeout aplicado | Fuente | Cabe |
|---|---|---|---|---|
| montar `video_montar_preview` (voz en frío: ensamblar + loudnorm + 90 subcomposiciones) | 5,9 s | 120 s | `app-backend/app_backend/video.py:209` (`timeout_llamada` por defecto; `video_rest.py:851` llama sin timeout propio) | sí |
| montar con la voz normalizada en caché | 0,7 s | 120 s | idem | sí |
| `check` (CLI de HyperFrames, sin GPU) | 145,4 s | 600 s | `video-mcp-server/src/render.ts:19` (`TIMEOUT_CHECK_MS`) | sí |
| carga de la preview (iframe + runtime + 90 subcomposiciones) | 4,2 s | ninguno | UI y backend no ponen plazo a la carga | n/a |
| seek máximo (7 saltos de 0,5 a 175 s) | 426 ms (161 a 426) | 2 s | objetivo del plan, «Riesgos abiertos»; la UI (`Preview.tsx`) no pone timeout al seek | sí |

El `check` es la fase con menos holgura (24 % del timeout); el resto va sobrado. La preview no pasa por `check` (solo el
render), pero se mide porque es la mayor carga de CPU de la ruta. `rendimiento_180s` necesita el CfT (check y seek), por
eso va tras `VIDEO_MEDIR=1`.
