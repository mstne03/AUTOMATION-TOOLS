# Revisión de seguridad · T20 (render, exportar y clave de ElevenLabs)

- Rama: `feat/t20-render-exportar` (commit `e0e29df`), diff `feat/t14-contrato-ui..HEAD`, 16 ficheros, solo `app-ui/`.
- Referencias: `PLAN-video-fase1.md` (Task 20 y Global Constraints), `SPEC-video.md` D11 con M-D6, I5, I6, I10, I11 y I12, `CLAUDE.md`.
- Contraste con el backend: tests de `feat/t11-voz-recursos-render` (`app-backend/tests/test_video_t11.py`, `motor_falso.py`). El endpoint de render y el comando Rust `exportar_mp4` todavía no existen en esta rama.
- `pnpm test`: 22 ficheros y 212 tests, todos en verde. No he creado ni dejado ningún fichero temporal en el worktree.

## Veredicto

**Aprobable con un cambio Medium antes de integrar (H1).** La clave de ElevenLabs está bien tratada. El campo es `type=password` con `autoComplete="off"` y se vacía al enviar. La clave no pasa por zustand, `localStorage` ni la caché de consultas, y los errores la quitan antes de pintarse. Se valida antes del `PUT`. `exportar_mp4` solo recibe `{ id }`, el WebView sigue con `core:default` y el modelo no tiene ninguna vía para lanzar el render. El fallo que encuentro está en otro sitio: el parser del resultado no coincide con el contrato real del backend de T11. Por eso la reserva de I11 no se vería nunca, y nadie se daría cuenta.

## Hallazgos

### H1 · Medium · La reserva y los avisos del render se pierden en silencio (I11)
- **Dónde:** `app-ui/src/video/render/resultado.ts:21` y `:29`. Las fixtures que lo ocultan están en `app-ui/src/test/render.test.tsx:39,225` y `app-ui/e2e/video-render.spec.ts:11`.
- **Escenario:** el contrato que fijan los tests de T11 (`test_render_hasta_resultado_sin_rutas_ni_clave`) es `result = { …, "avisos": [{"codigo": "fondo_degradado"}], "reserva": ["fondo_degradado"] }`. Es decir, `reserva` es una **lista de códigos** y cada aviso es un objeto **con `codigo`, sin `mensaje`**. Pero `aResultadoRender` solo acepta `reserva` como texto (`texto(o.reserva)` da `null` con una lista) y solo saca `a.mensaje` de cada aviso. Supongamos que Rápido falla por el codificador y el motor repite el render en Compatible (D11): el job registra la reserva, pero `render-avisos` enseña solo el codificador. I11 pide que una reserva «nunca en silencio» y el plan exige `render-avisos pinta reserva`. Los tests de UI y E2E pasan porque sus fixtures usan cadenas que el backend no produce.
- **Corrección:** acordar el contrato con T11 y que el parser acepte la forma real. Para `reserva`: `string | string[]`. Para cada aviso: texto, o un objeto con `codigo` (y `mensaje` si lo trae). Traducir los códigos con una tabla cerrada de textos en la UI; si un código es desconocido, enseñarlo tal cual, siempre como texto y con `sinRutas`. Cambiar las fixtures de `render.test.tsx` y `video-render.spec.ts` a la forma del backend y añadir un caso `reserva_lista_de_codigos`.

### H2 · Low · Un job de render aparece en la barra lateral y en el aviso final como «transcripción», y su error sale sin `sinRutas`
- **Dónde:** `app-ui/src/state/jobs.ts:16-17` y `app-ui/src/shell/Sidebar.tsx:32,35`.
- **Escenario:** `seguirJob` registra el job `video_render` en el store global. `JobActivo` lo pinta en `nav-job` como «Transcribiendo», cuando el plan dice que `nav-job` muestra `args.titulo`. Al terminar, `avisarFin` saca el toast «La transcripción ha fallado» con `description: job.error` **sin `sinRutas`**. Según T11, el backend devuelve un texto fijo (`MENSAJE_RENDER_FALLIDO`), así que hoy no se filtra nada; pero esta es la única vía de la UI que pinta `job.error` del render sin enmascarar rutas, y el mensaje confunde al usuario (I11, «el fallo se ve» de forma legible).
- **Corrección:** distinguir `kind === "video_render"` («Renderizando <args.titulo>», «El render ha fallado» o «ha terminado») y pasar `description` por `sinRutas` en `avisarFin`. Añadir un test.

### H3 · Low · Con el modo «Rápido» guardado, el render puede salir en Compatible antes de que lleguen las capacidades
- **Dónde:** `app-ui/src/video/render/RenderDialogo.tsx:51-55` y `:126`.
- **Escenario:** `esperandoCap` solo vale `true` si `navegadorListo`. Mientras `useNavegadorVideo` sigue pendiente (`nav.data` sin definir), `hayGpu` es `false`, así que `efectivo` es `"compatible"` y el botón está habilitado. Si se pulsa ahí, se envía Compatible aunque el equipo tenga GPU, y la descripción dice «Rápido no está disponible en este equipo». No supone un riesgo de seguridad, porque se degrada hacia el modo que funciona en cualquier equipo y el backend rechaza con 422 cualquier valor fuera del enum. Pero el mensaje no es verdad durante esa ventana.
- **Corrección:** `esperandoCap = modo === "rapido" && (nav.isPending || (navegadorListo && cap.isPending))`.

### H4 · Low · `autoComplete="off"` en un campo de contraseña
- **Dónde:** `app-ui/src/screens/MotorVideoClave.tsx:78`.
- **Escenario:** Chromium (y por tanto WebView2) no hace caso de `off` en campos `password`, ni para rellenar ni para ofrecer guardar. En WebView2 el autoguardado de contraseñas viene desactivado por defecto, así que hoy no se guarda nada; el riesgo aparecería si alguien lo activara o si la UI se abre en un navegador (`pnpm dev`).
- **Corrección:** `autoComplete="new-password"`, que Chromium sí respeta; opcionalmente, añadir `name` y `data-1p-ignore` / `data-lpignore` para los gestores de contraseñas.

### H5 · Info · La validación de `id` y la ausencia de rutas en `exportar_mp4` dependen de un comando Rust que todavía no existe
- **Dónde:** `app-ui/src/video/render/exportar.ts:9`. En `app-ui/src-tauri/src/lib.rs` no hay `exportar_mp4`; llega con T13.
- **Escenario:** la UI cumple I6: envía solo `{ id }` (sacado de `useEditor().proyecto.id`, que viene del backend), no lee el valor de vuelta y pasa los errores por `sinRutas`. Hasta que se integre T13, «Exportar MP4» falla en Tauri con «command not found», y lo hace de forma visible. La validación del id (por regex, sin `..`, `:` ni rutas) y la regla «abrir una sola vez desde el handle» tienen que estar en Rust.
- **Corrección:** al integrar T13, que el comando valide el id con la misma regex del backend y devuelva como mucho un booleano o nada, nunca la ruta de destino. Como defensa adicional, la UI puede comprobar el id con la regex antes del `invoke`. Añadir un aviso de éxito («MP4 exportado»), sin ruta.

### H6 · Info · `borrar` la clave sin confirmación
- **Dónde:** `app-ui/src/screens/MotorVideoClave.tsx:48`.
- **Escenario:** un clic borra el secreto del almacén. Se puede recuperar volviendo a escribir la clave y no tiene impacto de seguridad, pero el resto de acciones destructivas de Ajustes piden confirmación.
- **Corrección:** opcional. Usar un `ConfirmDialog` como en el resto de Ajustes.

## Comprobaciones sin hallazgo

- **Clave de ElevenLabs (I5):**
  - Vive solo en el `useState` local del campo, porque el input es controlado, y en la variable `enviada` de la propia petición. Se vacía (`setClave("")`) antes de validar.
  - No va a zustand, `localStorage` ni `sessionStorage`. `qc.setQueryData(["settings"])` guarda la respuesta del `PUT`, que solo trae `has_elevenlabs_key` (`main.py:542`).
  - No hay ningún `console.*` en este código.
  - Los errores pasan por `limpio()`, que quita la clave exacta y las rutas.
  - El backend recorta los espacios (`str_strip_whitespace`) y la UI envía la clave ya recortada, así que un eco en un 422 coincide con la que se quita.
  - El orden es validar (`POST /settings/validate-elevenlabs-key`, sin coste) y, solo si es válida, hacer el `PUT`. Una clave inválida no se guarda.
  - Doble envío: impedido por `trabajando`.
- **`invoke("exportar_mp4", { id })`:** no lleva rutas, no hay plugin de diálogo en el WebView y `capabilities/default.json` sigue con `core:default`.
- **Modo de render:**
  - El valor de `localStorage` se valida contra el enum (`renderModo.ts`), y si no es válido vale `auto`.
  - Rápido sin GPU se envía como Compatible (`modoEfectivo`); `h264_mf` no cuenta como GPU (M7).
  - Automático se envía como `auto` y lo resuelve el motor (D11, M-D6).
  - El backend devuelve 422 con `turbo`, con un número o con un cuerpo que lleve `ruta` (`test_render_cuerpo_y_proyecto`).
- **Doble clic en `render-lanzar`:** `lanzando` lo deshabilita; en cuanto llega el job, `activo` oculta el botón, y el backend responde 409 `render_en_curso`.
- **Progreso y resultado:** solo se pintan como texto, con `sinRutas` en el codificador, el modo, la reserva, los avisos, `job.error` y los errores del POST y de la exportación. No hay `innerHTML` ni `dangerouslySetInnerHTML` en `src/video/`. `aResultadoRender` sanea los tipos.
- **`ApiError.codigo`:** solo se toma si `detail` es `{ mensaje: string, codigo?: string }`; cualquier otra cosa se queda como antes. La UI decide por `codigo === "sin_voz"`, no por el texto, como fija T11. `chat` sigue con `detalle()` sin código, sin cambio de comportamiento. `NO_INSTALADO.test(e.detail)` sigue funcionando con el `detail` en texto.
- **I10:** el render solo se lanza desde el botón `editor-render`, porque `client.videoRender` tiene una sola llamada en `RenderDialogo.tsx:102`. Este diff no toca ninguna tool ni `registry`, y el backend rechaza `POST /jobs` con `video_render` (`test_jobs_rechaza_video_render_por_el_endpoint`). Al montarse, el diálogo solo lee jobs (`listJobs`) y no lanza ninguno.
- **Retirada de `ajustes-render-modo-nota`:** retirada de `MotorVideo.tsx`, `pantallas.md` actualizado, y `nota_retirada` cubierto en `motorVideo.test.tsx:242` y `motor-video.spec.ts:228,235`, en el mismo commit. No queda ninguna referencia viva.
- **I12:** no hay dependencias nuevas, ni GSAP.
