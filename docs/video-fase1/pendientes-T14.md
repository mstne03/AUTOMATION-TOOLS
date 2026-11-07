# T14 · Pendientes (2026-11-07)

- Revisión de seguridad: aprobada con cambios (2 Medium). Primera re-revisión reabierta:
  - credenciales reales que podían llegar a los E2E (`.env.local` con override y lista negra);
  - dos carreras del editor.
- Corregido en tres pasos:
  - `991ae75`: correcciones iniciales;
  - `3792a85`: `entornoSidecar` por lista blanca y `APP_BACKEND_SIN_DOTENV`;
  - `b2d2d2c`: el editor no reenvía con la revisión vieja durante un conflicto. Los dos tests de la
    carrera se comprobaron en rojo contra el código anterior.
- Segunda re-revisión: credenciales cerradas. La carrera (b), corregida después en `b2d2d2c`, no tiene
  re-revisión propia.
- Abiertos por decisión de producto: Low 4b (reintento tras error) y 4c (bloquear `editar` durante un
  conflicto).
- Menores:
  - `kb-seo/kb/config.py` carga `kb-seo/.env` sin mirar `APP_BACKEND_SIN_DOTENV`. Sin override, solo
    añade las contraseñas locales de Postgres.
  - Hasta integrar T5 (`VIDEO_PRUEBAS_TTS_URL`), el motor de los E2E llama a `api.elevenlabs.io` con la
    clave falsa: no gasta créditos, pero sí hay red.
- Los E2E de Playwright no se han ejecutado: quedan para la sesión local.
