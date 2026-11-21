#!/usr/bin/env bash
# Regenera las muestras de la Tarea 6 SIN red, con un ffmpeg completo (el de BtbN que ya está en la
# máquina) e ImageMagick 7 para los JPEG progresivo y CMYK. Cada muestra ≤ 30 KB.
#   FFMPEG=/ruta/a/ffmpeg.exe MAGICK=magick bash generar.sh
# h264.mp4 usa h264_nvenc (Main con B-frames): hace falta una GPU NVIDIA; con otra, cámbialo por
# h264_mf o h264_amf manteniendo -profile:v main y -bf 2.
set -euo pipefail
cd "$(dirname "$0")"
FF=${FFMPEG:?define FFMPEG}; MG=${MAGICK:-magick}
f() { "$FF" -hide_banner -loglevel error -y "$@"; }
v=(-f lavfi -i testsrc2=size=160x120:rate=15:duration=1)
a=(-f lavfi -i sine=frequency=440:sample_rate=22050:duration=1)

f "${v[@]}" -c:v h264_nvenc -profile:v main -bf 2 -b:v 100k -pix_fmt yuv420p h264.mp4
f "${v[@]}" -c:v libkvazaar -b:v 100k -pix_fmt yuv420p -tag:v hvc1 hevc.mp4
f "${v[@]}" -c:v libaom-av1 -cpu-used 8 -b:v 100k -pix_fmt yuv420p av1.mp4
f "${v[@]}" -c:v libvpx-vp9 -b:v 100k -deadline realtime vp9.webm
f -f lavfi -i testsrc2=size=160x120 -frames:v 1 foto.png
f -f lavfi -i testsrc2=size=160x120 -frames:v 1 -pix_fmt rgb48be foto16.png
f -f lavfi -i testsrc2=size=160x120 -frames:v 1 -c:v libwebp -quality 60 foto.webp
f -f lavfi -i testsrc2=size=96x72:rate=5:duration=1 -c:v libwebp_anim -loop 0 -quality 40 animado.webp
"$MG" foto.png -interlace Plane -quality 70 foto.jpg
"$MG" foto.png -colorspace CMYK -quality 70 foto-cmyk.jpg
f "${a[@]}" -ac 1 -c:a libmp3lame -b:a 32k musica.mp3
f "${a[@]}" -ac 1 -ar 11025 -c:a pcm_s16le musica.wav
f "${a[@]}" -ac 1 -c:a flac musica.flac
f "${a[@]}" -ac 1 -c:a libvorbis -q:a 0 musica.ogg
f "${a[@]}" -ac 1 -c:a aac -b:a 32k musica.m4a

# Listas trampa (texto): ninguna debe abrir red ni salir de la carpeta (R0 M2).
printf "file 'http://127.0.0.1:1/x'\n" >trampa-http.txt
printf "ffconcat version 1.0\nfile '\\\\\\\\127.0.0.1\\\\nada\\\\x.wav'\nfile '..\\\\secreto.wav'\n" >trampa.ffconcat
ls -l
