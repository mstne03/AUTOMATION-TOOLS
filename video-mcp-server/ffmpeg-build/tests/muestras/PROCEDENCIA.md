# Procedencia de las muestras

Generadas el 2026-10-29 **sin red** con `generar.sh` (los comandos exactos están ahí), a partir de
fuentes sintéticas de lavfi (`testsrc2`, `sine`); no hay material de terceros. Herramientas:

- ffmpeg `n7.1.5-12-g1fdbca85aa-20260731` (BtbN LGPL, el del motor actual), que trae los
  codificadores que nuestro build no lleva (libkvazaar, libaom, libvpx, libwebp, libmp3lame,
  libvorbis) y `h264_nvenc` con la RTX 4060 de Marc para el H.264 Main con B-frames.
- ImageMagick 7 (`magick`) para el JPEG progresivo y el CMYK.

| Fichero | Qué cubre |
|---|---|
| `h264.mp4`, `hevc.mp4`, `av1.mp4`, `vp9.webm` | Clips de I15: H.264 Main con B-frames, HEVC (`hvc1`), AV1 (libdav1d), VP9/WebM |
| `foto.jpg`, `foto-cmyk.jpg` | JPEG progresivo y JPEG CMYK |
| `foto.png`, `foto16.png` | PNG de 8 y 16 bits por canal |
| `foto.webp`, `animado.webp` | WebP con pérdida (usa `vp8`) y WebP animado (ffmpeg 7.1 no lo decodifica: debe fallar limpio) |
| `musica.{mp3,wav,flac,ogg,m4a}` | Audio de I15: MP3, WAV, FLAC, OGG/Vorbis, M4A/AAC |
| `trampa-http.txt` | Lista concat con `http://127.0.0.1:1/x` (con `-protocol_whitelist file` no abre nada) |
| `trampa.ffconcat` | ffconcat con una ruta UNC `\\127.0.0.1\nada\x.wav` y `..\secreto.wav` (R0 M2) |

Todas ≤ 30 KB (lo comprueba `tests/verificar-binario.test.sh`). Si se regeneran, cambian los bytes
(NVENC y libaom no son deterministas) pero no lo que prueban.
