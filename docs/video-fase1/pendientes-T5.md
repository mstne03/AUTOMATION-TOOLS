# T5 · Pendientes (2026-11-07)

- Revisión de seguridad: aprobada con cambios (1 Medium: facturación doble).
- Corrección (`a6cbd47`) y re-revisión acotada: cerrada con cambios menores.
- Residuales corregidos en `7195eba`:
  - concat inyectado con ID3 + `ffconcat`: sync MPEG obligatorio tras el ID3, rechazo de `ffconcat`,
    `-safe 1`, y `.ffconcat` fuera de `DEMUXERS`;
  - marca de vuelo antes de llamar a ElevenLabs, para que una caída no permita refacturar sin aviso.
- **Validar en Windows (CI `video` o sesión local):** los tests de voz con ffmpeg real se saltan en
  Linux por `hfHome()`. Son la Review Focus 2 (`reintento_no_refactura`), CA3, las respuestas hostiles y
  `clave_fuera_de_error`.
- Abiertos para Plane:
  - `planMuestra` es calculable: ata el contenido, pero no autoriza;
  - las tools de voz se registran fuera del modo integrado (T13);
  - en desarrollo, la ruta de muestras es `~/Videos/muestras`;
  - TOCTOU mínimo entre `ficheroNormal` y `readFileSync`.
- Integración: el backend y la UI (T11, T13 y T20) deben enviar `planConfirmado` y `reintentarFacturadas`.
