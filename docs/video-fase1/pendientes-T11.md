# T11 · Pendientes (2026-11-07)

Revisión de seguridad en `seguridad-T11.md`: apta con cambios, sin Critical ni High. Los dos Medium y los Low se cierran
en el commit `Backend: cierra los hallazgos de la revisión de T11`; lo que sigue depende de otras tareas.

- **R0-6 / T6 (sesión local), condición explícita de cierre:**
  - el barrido real de procesos huérfanos (Chrome, ffmpeg) **al arrancar el motor** es de T6: hoy `proceso.ts` solo
    barre tras un timeout o un fallo de la CLI y `index.ts` no llama a `barrerProcesos` antes de `server.connect`.
    **R0-6 sigue abierto** hasta que T6 lo haga, con un test `barrido_al_arrancar` en el motor;
  - `test_motor_muere_en_render` pasa contra el **simulador**, que barre al arrancar por su cuenta: no prueba el motor
    real. El `skip` razonado es `test_real_motor_muere_en_render_sin_procesos_huerfanos` (Windows, CfT descargado, ffmpeg
    del bundle y un render real; lo valida Marc / T21);
  - el backend ya hace lo que le toca: al vencer el deadline registra los PID conocidos (motor y descendientes) y, tras
    relanzar, pide el barrido al motor nuevo **si** existe la tool `video_barrer_procesos` (`reiniciar_motor_render`);
    si no existe, deja `TODO(T6)` en el log. `test_real_el_motor_expone_el_barrido` (con `skip`) obliga a T6 a registrarla
    con ese nombre o a cambiar `TOOL_BARRIDO`.
- **T7, tools de recursos:** `video_recurso_importar` y `video_recurso_borrar` (con el código `en_uso` en `CodigoAlmacen`).
  Mientras falten, las rutas de recursos responden **501 `no_disponible`** («todavía no está disponible») y no un 502 con
  texto. Cuando existan, quitar el `skip` de `test_real_recurso_en_uso_409` y escribir el 409 contra el motor real; la
  forma de la respuesta de `importar` (`recurso`, `avisos`, revisión que sube) está supuesta en `video_rest.py`.
- **T6, `modo` de `video_renderizar`:** el backend envía `{ id, modo }`; el motor real debe aceptar `modo`
  (`auto | rapido | compatible`) y devolverlo en el resultado.
- **T7, rutas `/video/musica`:** la música (clase `musica` de los recursos) y sus rutas REST no están en T11.
- **T20, unificar `sin_voz`:** T20 usa `sin_voz` para «faltan frases con voz» (ensamblado). En T11 `sin_voz` significa
  «el perfil no tiene una voz válida». Son cosas distintas y la UI decide por código: proponemos que T20 use otro, por
  ejemplo **`frases_sin_voz`** (hoy el motor da `voz_pendiente` para eso), y que `sin_voz` quede solo para el perfil.
- **Validar en Windows:** el job `backend-windows` ya ejecuta los tests de vídeo; el descubrimiento de PID hijos usa
  `psutil` si está y, si no, `/proc` (solo Linux): en Windows sin `psutil` solo se registra el PID del motor.
- **Sin cubrir:** una guarda que impida que un `test_real_*` llegue a `api.elevenlabs.io` (el motor es un proceso Node;
  desde Python no se puede interceptar). Lo evita el aislamiento del almacén de secretos por test (`conftest.py`).
