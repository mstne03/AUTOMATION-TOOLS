# Revisión de seguridad · T16 (lista de proyectos y marco del editor)

Rama `feat/t16-editor-marco`, diff `feat/t14-contrato-ui..HEAD` (commits 9d39db9 y ae676df).
Revisión de solo lectura. `pnpm test`: 22 ficheros, 186 tests en verde. No se ha ejecutado `pnpm e2e`.

## Veredicto

**Aprobado con cambios.** No hay hallazgos Critical ni High. Sí hay tres Medium:

- la clave de preview puede quedarse viva por una carrera entre el POST y el DELETE;
- los atajos actúan aunque haya un diálogo abierto;
- las ediciones hechas mientras se ve el aviso de conflicto se pierden en silencio.

Todo lo que se pinta es texto: no hay `innerHTML` ni `dangerouslySetInnerHTML` en el diff. El borrado pide confirmación y los errores pasan por `sinRutas` y se muestran como texto. La importación del store desde el E2E no mete código de prueba en producción.

## Hallazgos

### 1. Medium: el DELETE de la preview no se coordina con el POST que la abre (I8)

- **Dónde:** `app-ui/src/screens/EditorVideoScreen.tsx:41-48`.
- **Escenario:** T17 abrirá la preview con un `POST …/preview` 400 ms después de cada guardado (Task 17, Interfaces). Al desmontar, esta pantalla lanza `DELETE …/preview` sin esperar a nada y descarta cualquier error.
  - Si el usuario sale mientras un POST está en vuelo, o mientras el temporizador de 400 ms de T17 aún no ha saltado, el backend puede procesar el DELETE antes que el POST.
  - El POST crea entonces una clave nueva. Esa clave sigue viva hasta que se borre el proyecto o se reinicie el sidecar. I8 exige invalidarla al cerrar el editor.
  - Lo mismo pasa al cambiar de `/video/a` a `/video/b`: la clave de `a` puede sobrevivir.
- **Por qué es Medium y no más:** la clave es de 32 bytes, va solo por loopback y solo sirve `_composicion/` de ese proyecto. Aun así incumple un invariante de la spec.
- **Ojo con el comentario de la línea 44** («si no se cierra, no pasa nada grave»): contradice I8 y anima a no ocuparse de esto.
- **Corrección:**
  - Que un solo dueño lleve el ciclo de vida de la preview. Por ejemplo, un módulo `previewSesion` en el store o en `Preview` con:
    - una bandera `cerrada`;
    - la promesa del POST en curso.
  - Al salir:
    1. marcar `cerrada = true` y cancelar el temporizador de 400 ms;
    2. esperar a que termine el POST en vuelo;
    3. después, enviar el DELETE.
  - Si el POST se resuelve con `cerrada` ya a `true`, enviar otro DELETE.
  - Reintentar una vez si el DELETE falla, en vez de tragarse el error.
  - Fijarlo ya como contrato de la interfaz hacia T17 y cubrirlo con un test: POST lento, desmontar, comprobar que el último DELETE va después del POST.
  - Reescribir el comentario.

### 2. Medium: Ctrl+Z / Ctrl+Y actúan con un diálogo abierto

- **Dónde:** `app-ui/src/video/Editor.tsx:31-36` y `46-56`.
- **Escenario:**
  - El oyente está en `window` y solo excluye `INPUT`, `TEXTAREA`, `SELECT` y `contentEditable`.
  - Los diálogos de Radix se montan en un portal, pero el `keydown` de un botón con foco dentro del diálogo sigue subiendo hasta `window`. Afecta a la confirmación de render (T20), a `voz-confirmar` (T19) y a cualquier `ConfirmDialog` futuro.
  - Resultado: el usuario pulsa Ctrl+Z con el diálogo abierto y deshace el proyecto que hay detrás del modal. Confirma un render o un gasto sobre algo distinto de lo que veía.
  - En la voz, `caracteres_confirmados` y el 409 del servidor limitan el daño. En el render no hay nada equivalente.
  - Además, el oyente no mira `ev.defaultPrevented` ni `ev.isComposing`.
- **Corrección:**
  ```ts
  if (ev.defaultPrevented || ev.isComposing) return;
  if (t instanceof Element && t.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')) return;
  if (document.querySelector('[role="dialog"][data-state="open"], [aria-modal="true"]')) return;
  ```
  Añadir también el caso `role="textbox"`. Test negativo: un `ConfirmDialog` abierto con el foco en «Cancelar» y Ctrl+Z no cambia el historial.

### 3. Medium: las ediciones hechas con el aviso de conflicto abierto se pierden en silencio

- **Dónde:** `app-ui/src/video/Editor.tsx:104-131`. Lo provoca el store de T14: `app-ui/src/state/editor.ts:131-134` (`cambiado`) y `191-193` (`descartarBorrador`).
- **Escenario:** tras un 409, el proyecto pasa a la versión del servidor con `conflicto = true`. El marco deja activos el cuerpo y la timeline, que es donde editarán T18 y T19. Con `conflicto` a `true`, `editar()` cambia el proyecto y el historial, pero `cambiado()` no programa ningún guardado. Después:
  - **«Recuperar mi edición»:** sustituye el proyecto por el borrador. Lo editado durante el aviso se pierde.
  - **«Descartar la mía»:** pone `guardado = "guardado"` con cambios sin guardar. El indicador miente y, si el usuario sale, `salvarSaliente` no guarda nada porque el estado es `guardado`.
  - **Además:** «Descartar la mía» borra la edición local con un clic y sin confirmación, justo al lado del botón principal.
  - **Pruebas:** el E2E `editor-conflicto` y los tests unitarios solo cubren el camino sin ediciones intermedias.
- **Corrección en T16:**
  - Mientras `conflicto` esté a `true`:
    - poner `inert` (y `aria-disabled`) en `.cuerpo` y `.zonaTimeline`;
    - deshabilitar deshacer y rehacer, y cortar los atajos.
  - Que «Descartar la mía» pida confirmación con `ConfirmDialog` («Tu edición local se perderá»).
- **Corrección en el store (avisar a U0/T14):**
  - `descartarBorrador` debería llamar a `cambiado()` si el proyecto difiere del remoto;
  - o bien `editar()` debería no hacer nada mientras `conflicto` esté a `true`.
- **Tests:** editar durante el conflicto y comprobar que no se pierde nada o que no se puede editar.

### 4. Low: el `calc(100vh - 2 * var(--space-20))` no cuenta el `UpdateBanner`

- **Dónde:** `app-ui/src/video/Editor.module.css:6`. El banner se monta en `app-ui/src/shell/AppShell.tsx:18`, dentro de `<main>` y antes del `Outlet`.
- **Escenario:**
  - Cuando hay una actualización, el banner ocupa altura dentro de `<main>` y el editor (100vh − 40 px) desborda en vertical. A 900×600 la timeline queda en parte fuera de la vista y `<main>` hace scroll.
  - El E2E `layout_b_900x600` no lo detecta porque no simula el banner.
  - El valor queda atado al relleno de `.principal`: si cambia `--space-20` o el relleno, se rompe sin avisar.
  - `100vh` es correcto en WebView2, pero no se adapta si cambia el marco.
- **Corrección:**
  - Lo limpio es añadir `/video` a `A_SANGRE` (ese fichero es de U0) y que el editor use `flex: 1; min-height: 0` dentro de `.principalSangre`.
  - Si no se puede tocar AppShell: `height: 100%` sobre un contenedor flex, o restar la altura del banner con una variable.
  - Añadir un caso al E2E con el banner visible.

### 5. Low: el contrato de `data-testid` y su E2E van en commits distintos

- **Dónde:** commit 9d39db9 (código y E2E con `editor-zona-*`) frente a ae676df (`app-ui/docs/pantallas.md:510-511`).
- **Escenario:** CLAUDE.md exige que el `data-testid` y su E2E entren «en el mismo commit». En 9d39db9 el E2E usa testids que todavía no están en el contrato.
- **Corrección:** unir los dos commits (fixup) antes de integrar.

### 6. Low: errores del DELETE de la preview y del guardado de fondo descartados sin rastro

- **Dónde:** `app-ui/src/screens/EditorVideoScreen.tsx:45-47`.
- **Escenario:** `.catch(() => undefined)`. Si el DELETE falla (sidecar ocupado, 5xx), nadie se entera ni se reintenta. Agrava el hallazgo 1.
- **Corrección:** un reintento y, como mínimo, un `console.warn` sin el id de la clave. Ya se propone en el 1.

### 7. Info: cerrar la ventana con un guardado pendiente

- **Escenario:** al cerrar la ventana, React no desmonta, así que ni `reiniciarEditor` ni el DELETE se ejecutan.
  - **Clave:** no hay riesgo. El sidecar muere con la app (`kill_sidecar` en `RunEvent::Exit` y `on_before_exit`, más el Job Object con `KILL_ON_JOB_CLOSE`, `app-ui/src-tauri/src/lib.rs:166-199,303`) y las claves se invalidan al reiniciar el backend (I8).
  - **Datos:** se pierden hasta 800 ms de edición y los borradores en memoria (`borradores`) de proyectos con conflicto.
- **Corrección (opcional):** un `pagehide` o un `onCloseRequested` en Rust que fuerce `guardar()` y espere a que termine.

### 8. Info: el E2E importa `/src/state/editor.ts`

- **Dónde:** `app-ui/e2e/video-editor.spec.ts:162-168`.
- **Comprobado:**
  - El `import()` vive en el spec y corre en la página solo contra el servidor de desarrollo de Vite (`baseURL http://localhost:1420`, `server.host: false`).
  - No añade ningún gancho al código de la app: no hay `window.__…` ni exportaciones solo para tests en `src/`.
  - `dist/` no sirve `/src/…` y la CSP de producción no lo permitiría.
  - Es la misma instancia del módulo que usa la app, porque se pide por la misma URL.
- **Limitación:** si algún día los E2E corren contra un build (`vite preview`), este test se rompe. Cuando exista el panel de T18, conviene cambiarlo por una edición desde la UI.

### 9. Info: documentación y commits

- `app-ui/docs/pantallas.md:486` sigue diciendo «Hasta que U2 las rellene, ambas pantallas están vacías». Ya no es cierto.
- La primera línea del commit no lleva `(SEO-xx)`, que el plan pide.

## Comprobado sin hallazgos

- **Títulos del usuario o del modelo:** en la lista (`VideoScreen.tsx:93`), en la cabecera del editor (`Editor.tsx:71`), en el `aria-label`, en la descripción del `ConfirmDialog` (`R.Description` como texto, `src/ui/Dialog.tsx:44`) y en el toast, siempre como texto de React. Los tests `titulo_html_es_texto` (unitario y E2E con `TEXTO_HOSTIL`) comprueban que no hay `<img>`.
- **Borrado (D6b, I10):** pasa por `ConfirmDialog`, y «Cancelar» no borra (`borrar_pide_confirmacion`). El backend borra a partir del id. Un error se avisa con un toast que pasa por `sinRutas`. Un 409 por render en curso se muestra como texto. El diálogo se cierra antes del `await`, así que no hay doble envío.
- **Errores de carga y de lista:** `editor-error` y `video-error` llevan `role=alert` y pasan por `sinRutas`. El 503 se distingue como `video-sin-motor`.
- **Navegación:** el id va en la URL con `encodeURIComponent`. El cliente también lo codifica. El GET de una época anterior se descarta (`vivo`).
- **Cliente:** `client` es estable (sale de `useState` en `App.tsx`), así que el efecto no se repite con las dependencias `[id, client]`.
- **Contrato:** las zonas `editor-zona-preview`, `editor-zona-panel` y `editor-zona-timeline` constan en `pantallas.md`. Los testids de la lista coinciden con el contrato.
