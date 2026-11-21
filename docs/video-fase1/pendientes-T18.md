# T18 · Pendientes (2026-11-07)

Revisión de seguridad: aprobada con cambios (4 Medium).
- M1: base vieja. Resuelto integrando T16 (`13e1f0c`).
- M2–M4 y los Low baratos: corregidos en `5f27871`.

Pendientes de otras tareas:
- **T11:** fijar la respuesta de `video_voz_muestra` con audio reproducible. Hasta entonces, «Escuchar»
  está deshabilitado y no gasta.
- **T11:** confirmar que `POST …/recursos` devuelve `{ recurso, avisos }` y no sube la revisión del
  proyecto.
- **T17:** recargar la preview tras guardar un perfil, mediante `SesionPreview` (TODO en
  `PanelPerfil.tsx`).
- No hay E2E de los `data-testid` del panel: corresponden al E2E del editor (U2) en la sesión local.
- Añadir o borrar un recurso vacía el historial de deshacer y el panel lo avisa. Es una decisión de
  robustez frente al disco.
