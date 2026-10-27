# Spike D11 — codificación H.264 en dos pasadas sin libx264

Fecha: 2026-10-27 · Máquina: Windows 11, RTX 4060 Laptop (NVENC), HyperFrames 0.8.206.
Script: `spikes/codificacion.mjs` (salidas en `spikes/salidas/`, ignorada por git).

## Veredicto

**El criterio de salida se cumple.** El modo Compatible (HyperFrames → intermedio sin `libx264` →
ffmpeg LGPL → H.264) produce MP4 que pasan ffprobe: 1080×1920, 30 fps, H.264 + AAC estéreo,
duración 50,41 s (esperada 50,40; tolerancia ±0,1 s). HyperFrames **no** pide `libx264` para
`--format mov` ni `--format webm`. Con las dos salidas y los dos codificadores de la segunda
pasada.

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
- Comprobación de que HyperFrames usó este ffmpeg y no el de winget 8.1: el MP4 directo lleva la
  etiqueta `Lavc61.19.101 h264_nvenc` (libavcodec 61 = ffmpeg 7.1; el de winget sería 62), y el
  PATH del proceso solo tenía la carpeta LGPL.

## Composición de prueba

La de `test/e2e-mock.test.ts` (voz sintética, ruta con espacios), con voz de 50 s sin música →
50,4 s, 1512 fotogramas. Escenas de color con número, sin fotos reales.

## Tiempos (una sola ejecución de cada una, máquina sin otra carga)

| Fase | Tiempo | Tamaño | Notas |
|---|---|---|---|
| Rápido: HyperFrames mp4 directo (sin `--gpu`, cae solo a NVENC) | **517 s** (8 m 37 s) | 20,3 MB | captura 6 m 29 s, codificación 16,5 s |
| Rápido con `--gpu` explícito | **falló a los 717 s** | — | ver hallazgo 1 |
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
| Rápido | h264 Main 1080×1920 yuv420p 30/1, 3 182 kb/s | aac LC 2 can., 191 kb/s | 50,400 |
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
`comparativa_25s.png` pone Rápido · mov-mf · webm-mf · mov-nvenc en fila).

| Salida | SSIM | PSNR (dB) |
|---|---|---|
| Rápido (NVENC directo) | 0,9958 | 52,1 |
| mov → mf | 0,9961 | 52,6 |
| mov → nvenc | 0,9979 | 56,5 |
| webm → mf | 0,9944 | 38,5 |
| webm → nvenc | 0,9946 | 38,6 |
| (el propio intermedio webm) | 0,9948 | — |

- Visualmente las cinco salidas son indistinguibles a tamaño real en la composición de prueba:
  mismo layout, mismo texto, mismos degradados.
- Los `webm` pierden ~14 dB de PSNR porque VP9 ya es con pérdida; los `mov` solo pierden lo de
  H.264. `h264_mf` y NVENC quedan a la par con el mismo origen.
- **Límite de esta medición:** la composición de prueba son fondos lisos y degradados, el peor caso
  para detectar diferencias de codificador. Falta repetirla con fotos reales (grano, texturas).

## Hallazgos que cambian el diseño

1. **`--gpu` explícito es frágil.** Falló tras 12 min de captura con
   `Unrecognized option 'x264-params'`: el codificador de chunk recibió «sin GPU» y montó
   argumentos de libx264, que el ffmpeg LGPL no entiende. El mismo render **sin** `--gpu` funcionó
   (HyperFrames detecta que no hay libx264 y cae a GPU por su cuenta). Causa probable, no
   confirmada del todo: la sonda de NVENC de HyperFrames tiene un timeout fijo de 2 s
   (`GPU_PROBE_TIMEOUT_MS2`, `chunk-RDDVQSNQ.js`) y se ejecuta en paralelo con las de qsv/vaapi/amf;
   en reposo la sonda tarda 0,9–1,2 s con picos medidos de 2,9–5,4 s, y bajo carga de 5 Chromes puede
   no llegar. Consecuencia: **no se puede confiar en que la detección dentro de HyperFrames no
   falle a mitad de una ejecución larga.** Recomendación: (a) el motor lanza el Rápido sin
   `--gpu` y detecta el fallo por código de salida/texto; (b) el reintento en Compatible de D11 es
   obligatorio, no opcional; (c) el motor hace su propia sonda NVENC (ffmpeg del bundle, 256×256,
   timeout ≥ 10 s) antes de ofrecer «Rápido».
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

**Formato intermedio: `mov` (ProRes 4444).** Es el único sin pérdida: la calidad final depende solo
de la segunda pasada, y es el que menos sorpresas da con fotos. Cuesta 785 MB de disco temporal
por 50 s (≈ 16 MB/s; un vídeo de 60 s ≈ 0,95 GB) que se borran al terminar, y 1 minuto más de
codificación que webm. **Alternativa documentada: `webm` (VP9) si el disco temporal libre es
< 3 GB**: 6 MB, mismo tiempo total, ~0,2 % de SSIM menos en este contenido; no se ha probado
con `--crf` bajo para acercarlo. El motor comprueba el espacio libre antes de elegir.

**Argumentos de la segunda pasada** (ffmpeg LGPL del bundle; entrada `inter.mov`):

- GPU (NVENC, preferente si la sonda propia funciona), 9,4 s:
  `ffmpeg -y -i inter.mov -c:v h264_nvenc -preset p5 -rc vbr -b:v 12M -maxrate 16M -profile:v high -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart salida.mp4`
- Media Foundation (cualquier Windows), 13,3 s:
  `ffmpeg -y -i inter.mov -c:v h264_mf -b:v 12M -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart salida.mp4`
  (el bitrate no se respeta; mantener `-b:v 12M` por si otra versión de Windows o un codificador
  por hardware sí lo respeta, y verificar el tamaño con fotos reales).

Bitrate elegido: **12 Mb/s** como tope en ambos; no se puede validar más alto con esta prueba.

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
