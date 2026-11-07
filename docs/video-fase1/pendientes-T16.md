# T16 · Pendientes (2026-11-07)

Revisión de seguridad: aprobada con cambios (3 Medium), corregidos en `499c97c`. Re-revisión: cerrada
con cambios menores.

Requisitos que pasan a otras tareas:
- **T17:** la preview se abre y se cierra SOLO con `sesionPreview()` (`src/video/EditorPreview.ts`).
  Añadir una regla ESLint `no-restricted-properties`, o un test que falle si se llama a
  `client.videoPreviewAbrir`/`videoPreviewCerrar` fuera de `EditorPreview.ts`. Además, `Preview` debe
  guardar la sesión al montarse y comprobar que `sesion.id` coincide con el proyecto.
- **T10 (backend):** `DELETE …/preview` debe invalidar TODAS las claves del proyecto. Si no, un DELETE
  atrasado de una sesión vieja tumba la preview de la nueva al reentrar rápido.

Menores:
- Si el DELETE falla dos veces, la clave sigue viva hasta reiniciar el sidecar. Hay que poner una espera
  antes del reintento.
- Si falla el GET tras un 409, «Descartar la mía» vuelve a guardar con la revisión vieja: hay que vaciar
  `historial` y `futuro` o deshabilitar el botón.
- Faltan tests: POST que falla, StrictMode y reabrir el mismo proyecto.
- El `calc(100vh…)` no cuenta el `UpdateBanner`. Necesita que `/video` entre en `A_SANGRE` de `AppShell`
  (U0).
