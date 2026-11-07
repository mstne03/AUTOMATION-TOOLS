# Revisión de seguridad · T18 (panel lateral del editor)

- Worktree: `wt-u3`, rama `feat/t18-panel-lateral` (commit `5694979`).
- Diff revisado: `git diff feat/t16-editor-marco HEAD` y, para aislar lo propio de T18,
  `git diff $(git merge-base feat/t16-editor-marco HEAD) HEAD`.
- Referencias: Task 18 y Global Constraints de `PLAN-video-fase1.md`; D7/M-D3, D8/M-D2, D9, I1,
  I6, I10 e I15 de `SPEC-video.md`; `CLAUDE.md`; contrato `app-ui/docs/pantallas.md`.
- `pnpm test`: 23 ficheros, 213 tests, todos PASS. `tsc --noEmit` sin errores.
- Sin ficheros temporales creados en el worktree.

## Veredicto

**Aprobado con cambios.** Ningún hallazgo Critical ni High. No hay HTML con datos, la UI no envía
ni enseña rutas, los `data-testid` están todos en el contrato y el gasto de ElevenLabs exige
confirmación explícita. Hay cuatro Medium que conviene cerrar antes de integrar: la rama está
sobre una base de T16 anterior a sus correcciones, el perfil puede perder cambios por PUT
concurrentes, deshacer/rehacer se desincroniza de los recursos del servidor, y «Escuchar» gasta
sin dejar escuchar nada.

## Lo que está bien (comprobado)

- **Texto, no HTML (I1, CLAUDE.md):** `nombreOriginal`, `que_debe_salir`, `nombre` del perfil y
  de la voz, avisos del servidor y errores se pintan como hijos de texto de React. Sin
  `innerHTML` ni `dangerouslySetInnerHTML` en `app-ui/src/video/`. Hay test `nombre_html_es_texto`.
- **Rutas (I6):** `PanelRecursos.tsx:51-55` solo maneja el `bandeja_id`, validado con
  `/^[0-9a-f]{32}$/` antes del POST; el cuerpo es `{ bandeja_id, clase }`, con `clase` literal
  de la UI. Los errores pasan por `sinRutas` (`PanelRecursos.tsx:36`, `PanelPerfil.tsx:28`),
  también los avisos del servidor (`PanelRecursos.tsx:62`).
- **Respuesta del servidor validada:** `leerRecurso` (`PanelRecursos.tsx:26-34`) exige id
  `r-[0-9a-f]{16}`, clase y extensión de lista cerrada y números finitos antes de que el recurso
  entre en el proyecto. `elegir` exige `PERFIL_ID_RE` (`PanelPerfil.tsx:60-66`), también para el
  id que devuelve «Duplicar».
- **Coste (I10, D7, M-D3):** «Escuchar» solo abre el diálogo (`PanelPerfil.tsx:167`). El POST
  sale desde `onConfirm`, con `caracteres_confirmados: 60`, y el diálogo dice el coste. No hay
  `preview_url` en ningún sitio. El modelo no interviene. El doble clic sobre «Generar muestra»
  no repite la llamada: `ConfirmDialog` cierra en el mismo evento y el overlay no tiene animación
  de salida, así que el botón se desmonta antes del segundo clic.
- **Carreras de cambio de proyecto:** las respuestas asíncronas comprueban
  `useEditor.getState().proyecto?.id !== proyectoId` antes de `editar()`.
- **Contrato:** todos los `data-testid` nuevos (`panel-*`, `escena-*`, `recursos-*`,
  `recurso-*`, `perfil-*`) están en `pantallas.md:515-522`. Ninguno fuera.
- **Aviso de derechos (D9):** `recursos-aviso` está siempre visible en la pestaña.
- **Subida, tamaño, tipo y nombre:** la UI no lee el fichero y no debe hacerlo. Los límites van
  en el comando Rust (T13: handle único, tamaño por clase) y en el motor (I15: bytes iniciales y
  recodificación). La UI valida lo único que maneja: el id de bandeja y la forma del recurso
  devuelto.

## Hallazgos

### 1. Medium · La rama está sobre una base de T16 anterior a sus correcciones

- **Dónde:** el diff contra `feat/t16-editor-marco` afecta a `app-ui/src/screens/EditorVideoScreen.tsx:20-48`,
  `app-ui/src/state/editor.ts:190-193`, `app-ui/src/video/Editor.tsx` y borra `app-ui/src/video/EditorPreview.ts`.
- **Escenario:** `merge-base` = `ae676df`. `feat/t16-editor-marco` ya tiene `499c97c` («cierra los
  hallazgos de la revisión de T16»), que no está en T18. Comparado con T16, el diff deshace I8
  (`SesionPreview`: esperar al POST en vuelo antes del DELETE, temporizadores cancelables,
  reintento), `inert` en el cuerpo durante un conflicto, los atajos bloqueados con un diálogo
  abierto o en conflicto, la confirmación de «Descartar la mía» y el `programar()` de
  `descartarBorrador`. Si la integración se hace llevando los ficheros de esta rama (resolver un
  conflicto con «la suya», `checkout` de ficheros o un squash mal rebasado), esas correcciones se
  pierden en silencio. Además, los tests de T18 no se han ejecutado con el editor corregido.
  Ejemplo: con `conflicto`, `editar(() => {})` de `PanelPerfil` ya no programa guardado y la
  preview no se recarga tras cambiar el perfil.
- **Corrección:** `git rebase feat/t16-editor-marco` antes de integrar. Comprobar que el diff
  queda limitado a los 6 ficheros de T18 y volver a ejecutar `pnpm test`. Si T17 usa
  `sesionPreview()`, comprobar que el panel no abre ni cierra la preview por su cuenta (hoy no lo
  hace).

### 2. Medium · El perfil pierde cambios con dos guardados seguidos (lost update)

- **Dónde:** `app-ui/src/video/panel/PanelPerfil.tsx:81-91` (y `:37`, `:147`, `:157`).
- **Escenario:** `guardar` construye el PUT desde `perfil`, la copia de la caché de React Query
  del último render, y no actualiza la caché hasta que responde el servidor. Secuencia normal: se
  edita «Fondo» y se hace clic en el selector de fuente. El `blur` lanza PUT1 con el fondo nuevo.
  Se elige una fuente antes de que PUT1 responda y PUT2 sale con el fondo **viejo**. El servidor
  aplica PUT2 al final y el color se pierde, aunque la UI lo mostró guardado. Pasa lo mismo con
  color y voz, o con dos colores. Al no haber revisión en el perfil, el servidor tampoco detecta
  el conflicto.
- **Corrección:** serializar los guardados del perfil en una cola por `perfil.id` y construir
  cada cuerpo desde la última versión conocida (la respuesta del PUT anterior o la caché
  actualizada de forma optimista con `qc.setQueryData` **antes** del `await`). Otra opción es
  desactivar los campos mientras hay un PUT en vuelo. Test: dos `guardar` sin esperar y el
  segundo cuerpo conserva el cambio del primero.

### 3. Medium · Deshacer y rehacer se desincronizan de los recursos y perfiles del servidor

- **Dónde:** `app-ui/src/video/panel/PanelRecursos.tsx:59` y `:74-79`; `PanelPerfil.tsx:88`.
- **Escenario:**
  - (a) Se borra un recurso: DELETE en el servidor (el fichero desaparece) y luego `editar()` lo
    quita del proyecto. Ctrl+Z devuelve al proyecto la entrada de un recurso que ya no existe en
    disco. El siguiente PUT o el render fallan, o la capa apunta a la nada, y la UI no explica por
    qué.
  - (b) Se añade un recurso y luego se deshace: el fichero queda huérfano en la carpeta del
    proyecto. También ocupa sitio dentro del tope de 30 recursos si el motor cuenta los ficheros.
  - (c) `editar(() => {})` mete en el historial una instantánea idéntica. El primer Ctrl+Z tras
    cambiar un color «no hace nada» y no deshace el color, porque el perfil vive en el servidor.
    Esto es inconsistente con `elegir`, cuyo cambio de `perfilId` sí se deshace.
- **Corrección:** las operaciones con efecto en el servidor no deben entrar en el historial
  normal. Aplicarlas fuera de `editar()`, por ejemplo con una función del store que mute el
  proyecto y marque pendiente sin apilar instantánea (`marcarCambiado()`), o vaciar el historial
  al confirmar un DELETE. Para forzar el guardado tras cambiar el perfil, exponer en
  `state/editor.ts` un `forzarGuardado()` explícito en lugar de `editar(() => {})`. Test:
  borrar, deshacer y el recurso no vuelve (o se avisa).

### 4. Medium · «Escuchar» gasta créditos y no reproduce nada

- **Dónde:** `app-ui/src/video/panel/PanelPerfil.tsx:94-103`.
- **Escenario:** la respuesta de `videoVozMuestra` se descarta y solo se muestra «Muestra
  generada (60 caracteres)». D7 pide un «botón de escuchar»: el usuario confirma un gasto de su
  cuota y no oye nada. Repetirlo tampoco sirve: el diálogo le dice que la caché evita el gasto,
  pero sigue sin poder oír la muestra. Es un fallo de contrato con coste para el usuario, aunque
  no sea una vulnerabilidad de inyección.
- **Corrección:** reproducir el audio que devuelva el endpoint. Si el backend da un id, servirlo
  como `blob:` tras `fetch` con bearer y reproducirlo con `<audio>`. No meter URLs de terceros:
  I14 y M-D3 lo prohíben, y la CSP `media-src` ya limita el origen. Validar la forma de la
  respuesta antes de usarla. Si el contrato de T11 todavía no define el audio, dejarlo como
  pendiente explícito de T11 y T18 y quitar el «Escuchar» del texto del botón hasta entonces.

### 5. Low · Colores y números no se validan en el cliente antes de enviarlos

- **Dónde:** `PanelPerfil.tsx:31-40` y `:147`; `PanelEscena.tsx:118-128` (`decimales` 0–3,
  `valor`).
- **Escenario:** cualquier cadena de hasta 32 caracteres, como `red;}body{…` o `url(...)`, se
  envía en el PUT del perfil. El motor la rechaza con `COLOR_RE` y `strictObject`
  (`feat/t8-perfiles:video-mcp-server/src/perfil.ts:19,25`), así que el riesgo real es bajo: no
  llega CSS al tema. Pero el borrador inválido se queda en el campo, el error es genérico y
  depende por completo del servidor. Lo mismo pasa con `decimales: 7` o un `valor` fuera de
  rango, que solo fallan en el PUT del proyecto («Error al guardar»).
- **Corrección:** validar en el cliente con la misma regex de color que el motor (exportarla en
  `video/modelo.ts`) y los rangos de `esquema.ts`. No enviar si no cumple, con el error en el
  `Field` (`aria-invalid`). La validación del servidor sigue siendo la autoridad.

### 6. Low · Sin bloqueo mientras hay una llamada en vuelo (muestra y borrar)

- **Dónde:** `PanelPerfil.tsx:167` y `:180`; `PanelRecursos.tsx:135`.
- **Escenario:** mientras el POST de la muestra está en vuelo, «Escuchar» sigue activo y no hay
  indicador. El usuario puede confirmar otra vez y lanzar un segundo POST antes de que la caché
  por voz exista, con un posible doble cargo. Cada gasto se confirma, así que I10 se cumple. El
  icono de borrar admite doble clic: el segundo DELETE da 404 y aparece un error falso.
- **Corrección:** estado `generando` que desactive «Escuchar» (`loading`) hasta que acabe, y un
  conjunto `borrando` por id de recurso.

### 7. Low · Datos del servidor tipados pero no validados en el perfil

- **Dónde:** `PanelPerfil.tsx:112` (`p.nombre ?? p.id`) y `:161` (`v.nombre`).
- **Escenario:** si el backend o la API de voces devuelve un `nombre` no string (un objeto), React
  lanza «Objects are not valid as a React child» y cae la pestaña o el editor entero. Es una
  denegación de servicio local, sin inyección.
- **Corrección:** usar `texto(p.nombre) || p.id` y filtrar las voces con `typeof v.id ===
  "string" && typeof v.nombre === "string"`, como ya hace `leerRecurso`.

### 8. Low · Dependencias sin verificar en esta base

- **Dónde:** `PanelRecursos.tsx:51`; `app-ui/src-tauri/src/lib.rs`.
- **Escenario:** el comando `importar_recurso` (T13) no existe en esta base y el endpoint
  `POST /video/proyectos/{id}/recursos` (T11) tampoco. El panel asume tres cosas no comprobadas:
  (a) la firma `{ clase } -> Option<String>`; (b) que el backend **no** escribe el recurso en
  `proyecto.json` ni sube la revisión, porque si lo hace, el `editar()` posterior provoca un 409
  y el aviso de conflicto en cada subida; (c) el tope de 30 recursos. El plan dice «Música y
  fotos», pero el panel y el contrato solo ofrecen foto y clip. La música queda, por lo que parece,
  para T19 (`musica-elegir`).
- **Corrección:** al integrar T11 y T13, un test que fije el contrato (o que el recurso lo añada
  solo uno de los dos lados). Mostrar el 409/422 de «30 recursos» con texto legible. Anotar en
  el HANDOFF que la música va en T19.

### 9. Info · Sin E2E para los `data-testid` del panel

- **Dónde:** `app-ui/e2e/`. No hay ningún spec que use `panel-*`, `recursos-*` ni `perfil-*`.
- **Escenario:** las Global Constraints piden el E2E en el mismo commit que los `data-testid`. Los
  ids ya estaban en el contrato (T14), pero ningún E2E los vigila, así que un cambio de id no
  rompería nada.
- **Corrección:** un `video-panel.spec.ts` mínimo (pestañas, aviso D9, diálogo de coste de la
  muestra sin llamada al servidor hasta confirmar), o dejarlo explícitamente para T21.

### 10. Info · `nombreOriginal` sin `sinRutas`

- **Dónde:** `PanelRecursos.tsx:134-135`.
- **Escenario:** se confía en que el motor guarda solo el nombre de fichero, recortado y con
  `textoSeguro` (T7). Si algún día llegara una ruta completa, se enseñaría.
- **Corrección (defensa en profundidad):** `sinRutas(r.nombreOriginal)` o, mejor, recortar al
  último segmento tras `/` o `\`.
