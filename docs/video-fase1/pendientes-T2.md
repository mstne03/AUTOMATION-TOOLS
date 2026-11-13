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
6. Puerta W3.2: punto 1 cumplido; faltan SHA-256 de CI, prueba de nvenc/mf por Marc y fijar el SHA.
