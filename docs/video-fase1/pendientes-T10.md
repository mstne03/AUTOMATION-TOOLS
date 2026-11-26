# T10 · Pendientes (2026-11-07)

Revisión de seguridad: integrable, sin Critical, High ni Medium. Se comprobó con un uvicorn real en
loopback que `despachar` separa la API de la preview en ambos sentidos y que la clave no sale en los
logs. Los 5 Low, cerrados en el último commit `Backend:` de la rama.

- **Validar en Windows:**
  - los tests de `SO_EXCLUSIVEADDRUSE` (el job `backend-windows` ya ejecuta `test_preview.py` y
    `test_video_rest.py`);
  - medir el TIME_WAIT al reabrir la app (`TODO(Windows)` en `reservar_puertos`).
- **T12 (local):** fijar `frame-src` en `tauri.conf.json` exactamente a los puertos `47810–47813`. El
  test `puertos_coinciden_con_frame_src` se salta hasta entonces.
- **T3/T6 (local):** confirmar la respuesta de `video_montar_preview` y de dónde sale `creado`.
- **T21:** confirmar la ruta del runtime en el instalador y añadir a la CI la comprobación del hash del
  runtime.
- CORP y COOP se omiten a propósito, porque romperían el iframe de origen opaco.
