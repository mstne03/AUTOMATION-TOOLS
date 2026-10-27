# Spike D11 — codificación H.264 en dos pasadas sin libx264

Fecha: 2026-10-27 · Máquina: Windows 11, RTX 4060 Laptop (NVENC), HyperFrames 0.8.206.
Scripts: `spikes/codificacion.mjs` (renders) y `spikes/medidas.mjs` (SSIM/PSNR, pruebas de tasa, ficha y PNG de control.mp4) (salidas en `spikes/salidas/`, ignorada por git).

## Veredicto

**El criterio de salida se cumple, probado en la ruta webm e inferido en la ruta mov.**
- **Ruta webm (probada):** `inter.webm` lleva etiquetas `Lavc61.19.101 libvpx-vp9` / `Lavf61.7.103` (las del ffmpeg LGPL 7.1) y sus
  MP4 con `h264_mf` y `h264_nvenc` pasan ffprobe: 1080×1920, 30 fps, H.264 + AAC estéreo, duración 50,417 s (esperada 50,40;
  tolerancia ±0,1 s). Es la ruta sin `libx264` demostrada.
- **Ruta mov (inferida):** sus MP4 también pasan ffprobe (50,410 s) y el render terminó con código 0, pero no quedan etiquetas de
  `inter.mov` (lo borré), así que que usara el ffmpeg LGPL y no otro se **infiere** de que se ejecutó con el mismo script y PATH.
  Por la misma razón, «HyperFrames no pide `libx264` para `--format mov`» está **probado para webm e inferido para mov**
  (el render mov acabó sin error con un PATH que solo contenía el LGPL, donde `libx264` no existe).
- Se ejecutaron los dos intermedios y los dos codificadores de la segunda pasada (las cuatro combinaciones pasan ffprobe).

## ffmpeg LGPL usado

- Asset: `ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-7.1.zip` (BtbN/FFmpeg-Builds, release
  `autobuild-2026-07-31-14-10`, 139 452 771 bytes).
- URL: `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-7.1.zip`
- SHA-256: `b7c1c846dacca68ee4ebf5c390742c973b3d5d14a6d44b061f500d8e4ac74fc0` (coincide con el
  digest que publica GitHub para el asset).
- Extraído en `%LOCALAPPDATA%\seo-studio-dev\descargas\ffmpeg-lgpl-7.1.5-12\x\`.
- `-encoders` contiene `h264_mf`, `h264_nvenc`, `h264_qsv`, `h264_amf`, `libopenh264`, `prores_ks`,
  `libvpx-vp9`, `aac`; **no** contiene `libx264` (configuración: `--disable-libx264`, sin
  `--enable-gpl`).
- **Evidencia de que HyperFrames usó este ffmpeg** (ffprobe de los ficheros de salida):
  - `control.mp4` (mp4 directo): stream `encoder=Lavc61.19.101 h264_nvenc`, formato `encoder=Lavf61.7.103`, `hyperframes_version=0.8.206`.
  - `inter.webm`: vídeo `ENCODER=Lavc61.19.101 libvpx-vp9`, audio `Lavc61.19.101 libopus`, formato `ENCODER=Lavf61.7.103`.
  - Lavc 61.19 / Lavf 61.7 son las bibliotecas de ffmpeg 7.1 (n7.1.5); el ffmpeg de winget (8.1) usaría Lavc 62 / Lavf 62.
    El log del render fallido con `--gpu` también imprimía `libavformat 61.7.103`.
  - **`inter.mov`: no queda prueba por etiquetas.** Lo borré tras el spike (785 MB) sin guardar sus etiquetas; los MP4 derivados
    no prueban nada sobre el primer paso. Se ejecutó con el mismo script y el mismo PATH que el webm, pero es una inferencia.
  - PATH usado por los procesos de HyperFrames: la carpeta bin del LGPL al principio y el PATH original **sin** las carpetas que
    contenían `ffmpeg.exe` (`spikes/codificacion.mjs`, líneas 13–18; además `FFMPEG_DIR` apuntaba al LGPL). En esta máquina la
    única carpeta retirada fue:

    ```
    C:\Users\Marc\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin
    ```

    y la carpeta puesta delante fue:

    ```
    C:\Users\Marc\AppData\Local\seo-studio-dev\descargas\ffmpeg-lgpl-7.1.5-12\x\ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-7.1\bin
    ```

## Composición de prueba

La de `test/e2e-mock.test.ts` (voz sintética, ruta con espacios), con voz de 50 s sin música →
50,4 s, 1512 fotogramas. Escenas de color con número, sin fotos reales.

## Tiempos (una sola ejecución de cada una, máquina sin otra carga)

| Fase | Tiempo | Tamaño | Notas |
|---|---|---|---|
| Rápido = `control.mp4`: HyperFrames mp4 directo **sin `--gpu`** (cae solo a NVENC) | **517 s** (8 m 37 s) | 20,3 MB | captura 6 m 29 s, codificación 16,5 s |
| mp4 directo con `--gpu` explícito | **falló a los 717 s** | — | ver hallazgo 1 |
| Intermedio `mov` (ProRes 4444) | 772 s | **785 MB** | captura 10 m 39 s, codificación 52,8 s |
| Intermedio `webm` (VP9) | 830 s | **6,3 MB** | captura 11 m 25 s, codificación 61 s |
| Paso 2 `mov` → `h264_mf` | 13,3 s | 20,6 MB | |
| Paso 2 `mov` → `h264_nvenc` | 9,4 s | 25,2 MB | |
| Paso 2 `webm` → `h264_mf` | 6,1 s | 14,6 MB | |
| Paso 2 `webm` → `h264_nvenc` | 4,1 s | 24,6 MB | |

Totales Compatible: mov+mf 785 s, mov+nvenc 782 s, webm+mf 836 s, webm+nvenc 834 s. Rápido: 517 s.
Compatible tarda ~1,5× el Rápido, y casi todo es la captura de fotogramas de Chrome, no la
codificación.

## ffprobe de las salidas (comando: segundo paso de la tarea)

| Salida | Vídeo | Audio | Duración |
|---|---|---|---|
| Rápido (`control.mp4`) | h264 Main 1080×1920 yuv420p 30/1, 3 182 kb/s | aac LC 2 can., 191 kb/s | 50,400 |
| mov → mf | h264 **Constrained Baseline** 1080×1920 yuv420p 30/1, 3 236 kb/s | aac LC 2 can. | 50,410 |
| mov → nvenc | h264 Main 1080×1920 yuv420p 30/1, 3 987 kb/s | aac LC 2 can. | 50,410 |
| webm → mf | h264 Constrained Baseline 1080×1920 30/1, 2 237 kb/s | aac LC 2 can. | 50,417 |
| webm → nvenc | h264 Main 1080×1920 30/1, 3 899 kb/s | aac LC 2 can. | 50,417 |

Intermedios: `mov` = prores 4444 `yuva444p12le` 130 Mb/s (HyperFrames impone este perfil con alfa
para MOV, no se puede cambiar: «MOV always uses the fixed alpha-preserving ProRes 4444»);
`webm` = vp9 `yuv420p` + opus.

## Calidad

Comparación objetiva contra el intermedio ProRes (referencia casi sin pérdida) y visual de PNG en
los segundos 1, 10, 25 y 45 de cada salida (`spikes/salidas/*_{1,10,25,45}s.png`;
`comparativa_25s.png` pone Rápido (control) · mov-mf · webm-mf · mov-nvenc en fila).

| Salida | SSIM | PSNR (dB) |
|---|---|---|
| Rápido (`control.mp4`, sin `--gpu`) | 0,9958 | 52,1 |
| mov → mf | 0,9961 | 52,6 |
| mov → nvenc | 0,9979 | 56,5 |
| webm → mf | *retirado* | *retirado* |
| webm → nvenc | *retirado* | *retirado* |

- Visualmente las cinco salidas son indistinguibles a tamaño real en la composición de prueba:
  mismo layout, mismo texto, mismos degradados.
- **Las cifras SSIM/PSNR de mov que se mantienen no están validadas:** la misma cadena de medición (`format=yuv420p` en ambos lados +
  `ssim`/`psnr`) da un ~19,6 dB inexplicado al comparar webm con su propio origen. Léanse como indicativas, no como prueba.
- **Cifras retiradas para webm:** las comparaciones objetivas que involucran webm (SSIM 0,994–0,995, PSNR ~38,5 dB frente a mov) no son fiables.
  Al repetir la medición con `medidas.mjs` frente a `inter.webm` salió ~33 dB, y una comprobación corta de `webm_mf.mp4` contra su propio
  `inter.webm` (10 s) dio ~19,6 dB tanto con el decodificador nativo como con libvpx, con `setpts` o con `fps=30`: no es
  alineación ni decodificador, y no se ha encontrado la causa (sospecha sin verificar: el intermedio VP9 lleva `ALPHA_MODE=1`).
  **No se puede afirmar nada sobre la calidad relativa de webm.** Las cifras de la tabla para Rápido, mov→mf y mov→nvenc salen solo de la
  ejecución manual contra `inter.mov` (borrado: no reproducible sin regenerarlo). Solo la comparación visual (PNG) es válida para webm.
- **Límite de esta medición:** la composición de prueba son fondos lisos y degradados, el peor caso
  para detectar diferencias de codificador. Falta repetirla con fotos reales (grano, texturas).

## Hallazgos que cambian el diseño

1. **Un fallo de detección de GPU a mitad de una ejecución larga.** Es **un solo fallo frente a un solo éxito**, no una tasa.
   El render con `--gpu` explícito falló tras 12 min de captura con `Unrecognized option 'x264-params'` (el codificador de
   chunk montó argumentos de libx264, que el ffmpeg LGPL no entiende); el mp4 sin `--gpu` funcionó. Por el código leído, ambos
   caminos usan la misma detección (sin libx264 HyperFrames activa `gpu` por su cuenta), así que **no hay diferencia entre
   lanzar con o sin `--gpu` y no es una mitigación.** *Hipótesis, sin confirmar:* la sonda de NVENC tiene un timeout fijo de 2 s
   (`GPU_PROBE_TIMEOUT_MS2`, `chunk-RDDVQSNQ.js`) y en reposo tardó 0,9–1,2 s con picos de 2,9–5,4 s medidos aparte; bajo la
   carga de 5 Chromes podría no llegar. No se reprodujo. **Conclusión firme:** (a) el reintento en Compatible de D11 es
   obligatorio, no opcional; (b) el motor de la fase 1 debe sondear los codificadores él mismo (ffmpeg del bundle, con timeout
   generoso) antes de ofrecer «Rápido», en vez de fiarse de la detección interna de HyperFrames.
2. **`h264_mf` ignora el bitrate.** Con `-b:v 12M`, `-rate_control cbr`, `pc_vbr` o `quality`
   salió siempre ~3,2–3,4 Mb/s, perfil Constrained Baseline (es el codificador software de
   Windows; `-hw_encoding 1` falla en esta máquina: «format negotiation failed»). Aquí basta
   (PSNR 52,6 dB) porque el contenido es simple; con fotos puede quedarse corto. A revisar con
   contenido real en fase 1.
3. **NVENC sí respeta el bitrate** si se le pide `-rc`: `-rc vbr -b:v 12M -maxrate 16M` → 27 MB
   (~4,3 Mb/s reales porque el contenido no necesita más) y mejor PSNR (57,1 dB);
   `-rc cbr -b:v 12M` → 73 MB (12 Mb/s exactos). Sin `-rc` explícito el valor por defecto da ~4 Mb/s.
4. **Captura de Chrome muy lenta:** 6,5 min (mp4) a 11,4 min (webm) para 50 s, ~8–14× tiempo real,
   con 5 trabajadores, «screenshot capture · hardware gpu». mov/webm van por la ruta «layered»
   (la composición ya cae a CSS: `usaWebgpu=false` aunque la sonda dio WebGPU). No es tarea de este
   spike, pero el tiempo de Compatible lo marca la captura, no el ffmpeg. Conviene medirlo en
   la tarea de rendimiento y revisar `--workers`.
5. **El audio sale en AAC (mov) u Opus (webm)** y la segunda pasada lo recodifica a
   AAC 192 k: sin problema, solo una recodificación más.

## Decisión

**Formato intermedio: `mov` (ProRes 4444).** Es el visualmente sin pérdida (no matemáticamente lossless): la calidad final
depende de la segunda pasada, y es el que menos sorpresas debería dar con fotos (no medido con fotos). Coste: **785 MB de disco
temporal por 50,4 s** (≈ 15,6 MB/s; 60 s ≈ 0,94 GB), que se borran al terminar. Tiempos (tabla): el render mov fue 57 s más rápido
(772 s frente a 830 s; en la codificación interna de HyperFrames 52,8 s frente a 61 s) pero su segunda pasada tarda más con mf
(13,3 s frente a 6,1 s) y con NVENC (9,4 s frente a 4,1 s); total mov+mf 785 s frente a webm+mf 836 s, mov+nvenc 782 s frente
a webm+nvenc 834 s. Es decir, **webm no es más rápido: ~50 s más lento en total**, pero ocupa 6,3 MB en vez de 785 MB.
**Alternativa documentada: `webm` (VP9) si el disco temporal libre es escaso** (el umbral exacto se fija en la fase 1; este
spike no lo mide): su calidad frente a mov **no está medida de forma fiable** (VP9 es con pérdida y no se probó `--crf` bajo).
El motor comprueba el espacio libre antes de elegir.

**Argumentos de la segunda pasada** (ffmpeg LGPL del bundle; entrada `inter.mov`):

- GPU (NVENC, preferente si la sonda propia funciona), 9,4 s:
  `ffmpeg -y -i inter.mov -c:v h264_nvenc -preset p5 -rc vbr -b:v 12M -maxrate 16M -profile:v high -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart salida.mp4`
- Media Foundation (cualquier Windows), 13,3 s:
  `ffmpeg -y -i inter.mov -c:v h264_mf -b:v 12M -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart salida.mp4`
  (el bitrate no se respeta; mantener `-b:v 12M` por si otra versión de Windows o un codificador
  por hardware sí lo respeta, y verificar el tamaño con fotos reales).

**Bitrate: decisión ABIERTA.** Los 12 Mb/s vienen del brief, no de una medición. En este contenido `h264_mf` los ignora
(~3,3 Mb/s con cualquier ajuste) y NVENC en VBR no los alcanza (~4,3 Mb/s reales; solo CBR llega a 12). Con fondos lisos no
se puede concluir nada sobre fotos. La fase 1 debe medir, con fotos reales (grano, texturas, movimiento de cámara) y 60 s:
tamaño y bitrate reales de `h264_mf` y de NVENC (vbr/cbr/cq), y SSIM/PSNR frente al intermedio, para fijar el bitrate o
pasar a calidad constante (`-rc vbr -cq N` en NVENC).

## Ejecución

```
cd video-mcp-server
npm run build
node spikes/codificacion.mjs "<carpeta bin del ffmpeg LGPL>"
```

Tarda ~45 min (cinco renders de HyperFrames de 8–14 min); resultados en
`spikes/salidas/resultados.json`.

## Fuera de este spike (anotado)

- El render de control «mp4 sin `--gpu`» es en realidad el modo Rápido y no falla: la hipótesis de
  la spec («sin codificador lanza `H264EncoderUnavailableError`») solo se cumple si tampoco hay GPU
  utilizable; aquí HyperFrames sí cae solo a NVENC. El error se dará en máquinas sin GPU, que no
  hemos podido probar.
- Máquina sin GPU NVIDIA (qsv/amf/mf puro) sin probar: el camino mov → mf se ha ejecutado, pero con
  la captura de HyperFrames usando la GPU del equipo.

## Reproducibilidad: mediciones de calidad y tasa

`node spikes/medidas.mjs "<bin LGPL>" inter.mov` repite lo siguiente (ficha y PNG de `control.mp4`, pruebas de tasa,
SSIM/PSNR → `spikes/salidas/medidas.json`). Los números de este informe salieron de estos mismos comandos lanzados a mano
contra `inter.mov` (que luego borré, 785 MB); el script debe ejecutarse con un `inter.mov` regenerado por `codificacion.mjs`.
Una pasada de comprobación del script contra `inter.webm` funcionó y reprodujo el patrón de tamaños (mf ≈ 14–15 MB con cualquier
ajuste; nvenc vbr 25 MB; nvenc cbr 73 MB), pero sus SSIM/PSNR frente a webm (PSNR ~33 dB para todas las salidas) **no son
comparables** con los de la tabla y no se han investigado; no se usan como resultado.

Salidas crudas de la ejecución original (segunda pasada desde `inter.mov`, tamaño en MB):

```
mf -b:v 12M                      → 20,6   (3,24 Mb/s, Constrained Baseline)
mf -rate_control cbr -b:v 12M    → 20,6
mf -rate_control pc_vbr -b:v 12M → 19,9
mf -rate_control quality -quality 100 → 21,5
mf -hw_encoding 1 ...            → error: "format negotiation failed (1/0)" (sin MFT por hardware aquí)
nvenc -preset p5 -rc vbr -b:v 12M -maxrate 16M -profile:v high → 27,2
nvenc -preset p5 -rc cbr -b:v 12M -profile:v high             → 73,4
nvenc -preset p5 -rc vbr -cq 19 -b:v 0 -profile:v high        →  8,9
```

SSIM (`-lavfi "[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim"`, `All:`): control 0.995828, mov_mf 0.996079,
mov_nvenc 0.997854 (frente a `inter.mov`; las cifras de webm quedan retiradas, ver «Calidad»).
PSNR medio (mismo grafo con `psnr`): control 52.08, mov_mf 52.62, mov_nvenc 56.53.
