# T20 · Pendientes (2026-11-07)

- Revisión de seguridad: aprobada con un Medium (H1, reserva y avisos con la forma real del backend) y
  Lows H2 a H4, cerrados en el commit de correcciones. Informe en `seguridad-T20.md`.
- Para T13: el comando Rust `exportar_mp4` debe validar el `id` con la misma regex del backend (sin
  `..`, `:` ni rutas) antes de tocar el disco.
- `exportar_mp4` devuelve `Option<()>`: es igual al cancelar el diálogo que al guardar. La UI no puede
  distinguirlos para avisar de «MP4 exportado»; hay que devolver un booleano o un estado explícito.
- T11 usa `sin_voz` para «falta la voz elegida» y T20 para «faltan frases con voz»: son dos casos
  distintos con el mismo código. Unificarlo al integrar.
- Regenerar en local la captura `ajustes-video` de `visual.spec.ts` (el campo de la clave cambió de
  atributos y la sección de Ajustes cambió en T20).
- Los E2E de Playwright no se han ejecutado en esta sesión.
- H6 (confirmar el borrado de la clave) queda abierto por decisión de producto.

## Códigos de bloqueo del render (unificados con T11)

El backend de T11 (`video_rest.py`) da `voz_pendiente` cuando faltan frases por generar y `sin_voz`
cuando el perfil no tiene una voz válida. `RenderDialogo` trata los dos como bloqueo, no como error
genérico. Se descarta la propuesta `frases_sin_voz` porque el motor ya emite `voz_pendiente`.
