# Pendientes de T2

1. **Fixtures con `libmp3lame` en tests/scripts** (L-3): `test/e2e-mock`, `matriz`, `seguridad`, `render-modos`, `herramientas`,
   `scripts/montar.mjs`, `ffmpeg-build/tests/muestras/generar.sh`, spikes. Pasar a `aac`/`.m4a` o WAV antes de probar con el ffmpeg
   LGPL (W3.2). `sin_lame` solo vigila `src/`.
2. **`npm run render:mock` no ejecutable aquí**: falla con «Falta el navegador del motor de vídeo» (no hay Chrome 152 del motor ni
   `VIDEO_ENGINE_DIR`; no se usa Chrome del sistema). Hay que repetirlo en la máquina de Marc.
3. **SSIM de piezas (`w2refs`) no medido**: las referencias no están en esta máquina (igual que en T3).
4. Sin test que fije `-t`, `-fs`, `-map` y `-ac` de `musica.ts` (opcional).
5. `npm test`: 52 ficheros pasan, 1066 tests (antes de los topes y de `-ac 2`; tras ellos se repitieron `audio-wav`,
   `render-verificacion` y `render-modos`; `-ac 2` solo con `audio-wav` y `tsc`).
6. Puerta W3.2 (2026-11-19): puntos 1, 2 y 4 cumplidos en código. La ejecución de CI
   [44585754745](https://github.com/mstne03/AUTOMATION-TOOLS/actions/runs/44585754745) (`ffmpeg-lgpl.yml`, commit `77ed5e8`, sin `SIN_MF`) da a y b idénticos y
   `ffmpeg.exe` `f8a83b58…6d85`, `ffprobe.exe` `d22d908e…e01`: los mismos que la construcción de
   testigo de Marc y los fijados en `prepare-video-engine.sh`, que aborta si no coinciden.
   `release.yml` empaqueta ese ffmpeg (`FFMPEG_LGPL_DIR` desde la release `vars.FFMPEG_LGPL_TAG`).
   `sin_lame` cubre ya el artefacto: el script rechaza un ffmpeg con `libmp3lame` y un `dist/` que lo nombre.
   **Falta:** la prueba de Marc con `h264_nvenc` y `h264_mf` usando ese build en un render real; la
   variable `REPO_FUENTE` (sin ella `empaquetar` falla y no hay avisos ni tarball de fuente) y la
   release `ffmpeg-lgpl-<rev>` desde `main` (`publicar`), y después `FFMPEG_LGPL_TAG`.
