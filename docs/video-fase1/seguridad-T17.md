# Revisión de seguridad · T17 (preview aislada, protocolo `postMessage`)

Rama `feat/t17-preview` (13aa093) frente a `feat/t16-editor-marco`. Revisión de solo lectura.
`pnpm test`: 25 ficheros y 225 tests en verde. Los E2E no se han ejecutado (necesitan el sidecar y Git Bash).

## Veredicto

**Aprobado con cambios.** El componente cumple I8 en lo que es suyo: sandbox exacto, `src` filtrado,
`source` + `origin` + esquema cerrado, ningún dato sensible hacia dentro y ninguna acción de la UI
alcanzable desde la composición. Queda **1 Medium**, que hay que tratar como condición de integración (la
CSP de Tauri, que depende de T12), y varios Low de cobertura y de endurecimiento.

## Lo que se ha comprobado y está bien

- **`sandbox`** (`Preview.tsx:238`): `"allow-scripts"` exacto, sin `allow-same-origin`, `allow-popups`,
  `allow-top-navigation`, `allow-forms`, `allow-modals` ni `allow-downloads`. `allow="autoplay"`
  (`:239`) y `referrerPolicy="no-referrer"` (`:240`), que se suma al `Referrer-Policy` del backend. El
  `key={src.n}` (`:230`) crea un iframe nuevo en cada reapertura, así que el `contentWindow` antiguo no
  sigue siendo una fuente válida.
- **`src`** (`Preview.tsx:81`): siempre pasa por `aPreviewUrl` (`modelo.ts:104-115`). Exige
  `http://127.0.0.1:4781[0-3]/p/<clave>/…`, rechaza `..`, `%2e`, `%2f`, `%5c` y `//`, y además exige que
  `new URL(u).href === u`, sin credenciales y con host `127.0.0.1`. Si no pasa, se pinta un error de texto
  fijo y no hay iframe. Los tests unitarios cubren URL fuera de lista, URL ajena y `javascript:`.
- **Hacia dentro, `targetOrigin "*"`** (`previewProtocolo.ts:100-104`): `enviarOrden` es el único
  `postMessage` de la UI y solo se llama con `iframeRef.current?.contentWindow` (`Preview.tsx:123`).
  `OrdenIframe` solo admite `seek {id entero, t acotado}`, `play` y `pause`: no viaja ni la clave, ni
  rutas, ni texto del proyecto. La composición ya conoce su propia URL de capacidad (`location.href`), así
  que el `"*"` no le da nada que no tenga. Con un origen opaco no se puede hacer de otra forma.
- **Hacia fuera, validación** (`previewProtocolo.ts:41-69`): `e.source === ventana` y
  `e.origin === "null"`, objeto plano (el prototipo es `Object.prototype` o `null`), `tipo` de una lista
  cerrada con `switch` sobre el primitivo (un `toString` no la burla), claves exactas, `id` como
  `Number.isSafeInteger` y presente en `pendientes`, `t` finito y en `[0, duración + 1e-3]`, `reproduciendo`
  booleano. Devuelve una copia nueva. En `Preview.tsx:137-154` se filtra por `source` antes del
  limitador (las otras ventanas no gastan su cupo) y lo descartado se cuenta en `data-descartados`.
- **Compatibilidad con `CONTROL_JS` de T10** (`feat/t10-preview:app-backend/app_backend/preview.py:78-135`):
  los cuatro tipos y sus claves coinciden. Los `error` sin `id` (`id: undefined`) y un `listo` con
  `duracion: null` se descartan, lo cual es seguro (ver hallazgo 8).
- **Ninguna acción de la UI desde el iframe**: un mensaje válido solo toca `duracion`, `estado`, `tActual`,
  `reproduciendo` y `fijarTiempo` (`state/editor.ts:180`, un `setState({ tiempo })` que ni marca cambios
  ni programa un guardado; `editar()` no participa y no hay ningún `useEditor.subscribe`). No hay ruta para
  guardar, gastar (voz o render), navegar ni abrir URLs. Nada se pinta como HTML: tiempos con `formato()`,
  avisos y errores con `sinRutas()` como texto.
- **Bucle seek/tiempo**: `ultimoT` se actualiza antes que `fijarTiempo`, y el efecto del cabezal
  (`Preview.tsx:185-191`) no reenvía con diferencias de 0,05 s o menos. No hay eco infinito.
- **Sesión única** (pendientes-T16): `Preview` guarda `sesionPreview()` al montar (`:43`), comprueba
  `sesion.id === proyectoId` (`:70`), reabre solo con `sesion.programar` (`:112`) y descarta las respuestas
  viejas o tardías por generación y por `montada` (`:80`, `:94`).

## Hallazgos

### 1. Medium · La CSP de Tauri todavía no aplica I8: `devCsp` con `frame-src http://127.0.0.1:*` y `csp` sin `frame-src`

- **Fichero**: `app-ui/src-tauri/tauri.conf.json:23-24` (no está en el diff, pero es T17 lo que estrena el iframe).
- **Escenario**: con `tauri dev` (y con cualquier build que salga de esta rama con ese `devCsp`), una
  composición comprometida, o una dependencia de la composición, ejecuta `location = "http://127.0.0.1:11434/…"`.
  El sandbox no impide que un marco navegue a sí mismo, y el único freno es `frame-src`. Con
  `127.0.0.1:*`, el marco carga Ollama, LM Studio, el puerto de la API del sidecar o un servicio local que
  acepte GET con efectos secundarios. Es justo lo que M-D1 descarta. Además, el `targetOrigin "*"` de
  `enviarOrden` entregaría las órdenes a ese documento. El daño aquí es poco (solo `seek`/`play`/`pause`),
  pero sí se rompe la premisa de que el `"*"` solo llega a nuestra composición. En producción, `csp` no
  tiene `frame-src` y hereda `default-src 'self'`, así que el iframe en `127.0.0.1:47810` queda
  **bloqueado**: la preview no funciona en el instalador.
- **Corrección**: no integrar T17 en `feat/video-fase1` (ni sacar un build) sin T12, o adelantar aquí el
  cambio de T12: `frame-src http://127.0.0.1:47810 http://127.0.0.1:47811 http://127.0.0.1:47812 http://127.0.0.1:47813`
  tanto en `csp` como en `devCsp`, sin `127.0.0.1:*`, y un test de fichero que lea `tauri.conf.json` y falle
  si aparece `127.0.0.1:*` en `frame-src`. Que quede apuntado en los pendientes de T17.

### 2. Low · `listo` admite una duración de hasta 3 h y con ella amplía el rango de `tiempo` que llega a `fijarTiempo`

- **Fichero**: `app-ui/src/video/previewProtocolo.ts:21`, `:54`; `Preview.tsx:156-162`, `:176`.
- **Escenario**: una composición hostil manda `listo {duracion: 10800}` (se acepta cuando quiera, no solo
  una vez) y luego `tiempo {t: 10800}`. El cabezal del editor (`useEditor.tiempo`) queda en 3 h, en un
  proyecto que por I1 no pasa de 180 s. Hoy solo lo lee `Preview`, pero T19 (timeline y geometría) lo va a
  usar para pintar y quizá para colocar elementos. No hay gasto ni guardado, pero es estado manipulable
  desde fuera.
- **Corrección**: acotar `listo` a `min(DURACION_MAXIMA_I1 = 180 s, duración del servidor) + margen`, o
  ignorar `listo` cuando cambie mucho la duración que dio el POST. Aceptar un único `listo` por generación
  del iframe. Opcional: `fijarTiempo(Math.min(t, duración del proyecto))`.

### 3. Low · El test de aislamiento se esquiva con facilidad y no cubre `iniciarSesionPreview`/`cerrarSesionPreview`

- **Fichero**: `app-ui/src/test/previewAislamiento.test.ts:14-20`.
- **Escenario**: busca solo el literal `videoPreview(Abrir|Cerrar)`. Se lo saltan
  `client["videoPreview" + "Abrir"]`, una llamada directa a `req(\`/video/proyectos/${id}/preview\`, { method: "POST" })`
  o un `fetch` con el bearer. Tampoco impide que otro módulo llame a `iniciarSesionPreview` o a
  `cerrarSesionPreview`, que según `EditorPreview.ts:96-107` solo puede usar `EditorVideoScreen`. Un
  segundo dueño rompería la secuencia de cierre de I8 (la clave sobreviviría al editor).
- **Corrección**: añadir al test (1) que la ruta `/preview` (regex `\/preview\b` junto a `video/proyectos`)
  solo aparezca en `api/client.ts`, y (2) que `iniciarSesionPreview|cerrarSesionPreview` solo aparezcan en
  `video/EditorPreview.ts` y en la pantalla del editor.

### 4. Low · El cambio en los dos tests de T16 quita la aserción de que un POST en vuelo devuelve `null` tras cerrar

- **Fichero**: `app-ui/src/test/videoLista.test.tsx:441-442`, `:456` (diff).
- **Escenario**: el ajuste es razonable. La `Preview` real ya lanza el POST al montar, y el test esperaba
  un `orden` que ahora incluiría dos POST. Pero en el segundo test desaparece
  `expect(await abierta).toBeNull() // cerrada: T17 no debe usar la clave`, que era la prueba directa de
  que `SesionPreview.abrir` devuelve `null` si se cierra con el POST en vuelo. Lo que queda
  (`sesion.abrir(false)` después de cerrar) es la rama trivial (`cerrada` antes de llamar). Ningún test de
  `preview.test.tsx` cubre una `Preview` montada cuya sesión se cierra con el POST en vuelo (por ejemplo,
  `iniciarSesionPreview` de otro proyecto) para comprobar que no llega a fijar `src`.
- **Corrección**: recuperar la aserción con un espía,
  `const espia = vi.spyOn(sesion, "abrir")` antes de montar y luego `expect(await espia.mock.results[0]!.value).toBeNull()`,
  y añadir en `preview.test.tsx` un caso «sesión cerrada con el POST en vuelo: no hay iframe».

### 5. Low · La CSP de los E2E de fixture no es la del backend y trae `sandbox allow-scripts`, lo que tapa una regresión del atributo

- **Fichero**: `app-ui/e2e/video-preview.spec.ts:9-11`, `:46-48`, `:68-123`.
- **Escenario**: el comentario dice «la misma CSP que el backend», pero falta `base-uri`, `form-action`,
  `worker-src`, `media-src`, `font-src` y `https://tauri.localhost`. Además, la directiva `sandbox allow-scripts`
  de la cabecera fuerza el origen opaco por sí sola: si alguien añadiera `allow-same-origin` al atributo,
  `iframe_sin_token` seguiría en verde (solo lo vería `atributos_exactos`, que compara texto).
  `sonda_red_cero` prueba la CSP del fixture, no la de `cabecera_csp()` del backend.
- **Corrección**: una variante de `iframe_sin_token` servida **sin** cabecera CSP, que demuestre que el
  atributo aísla por sí solo, y construir la CSP del fixture con el mismo texto que `cabecera_csp(47810)`
  (o lanzar la sonda de red contra el sidecar real cuando esté T10).

### 6. Low · El limitador es de ventana fija: admite hasta 240 mensajes en un segundo que cruce el borde

- **Fichero**: `app-ui/src/video/previewProtocolo.ts:72-92`.
- **Escenario**: 120 mensajes al final de una ventana y 120 al principio de la siguiente. El impacto es
  pequeño (re-renders de React acotados). El limitador va antes de la validación, así que la basura de la
  propia composición gasta su cupo, pero eso solo la perjudica a ella.
- **Corrección**: aceptable tal cual. Si se quiere precisión, una ventana deslizante (cola de marcas de
  tiempo) o un cubo de fichas de 120/s.

### 7. Info · El test «postMessage solo a la ventana del iframe» no comprueba lo que dice

- **Fichero**: `app-ui/src/test/preview.test.tsx:134-143`.
- **Escenario**: solo comprueba que `destino` es una cadena. No espía `window.postMessage` ni
  `window.parent.postMessage` para ver que no se llaman.
- **Corrección**: `vi.spyOn(window, "postMessage")` con `not.toHaveBeenCalled()`, y `expect(destino).toBe("*")`
  para dejar la decisión documentada en el test.

### 8. Info · Un fallo del runtime en el iframe se queda en «Preparando la preview…» para siempre

- **Fichero**: `Preview.tsx:155-171`; `preview.py` (T10) `CONTROL_JS:117`, `:133`.
- **Escenario**: si `window.__player` no existe, `CONTROL_JS` manda `listo {duracion: null}` y
  `error {id: undefined}`, que se descartan con razón. La UI no muestra ningún error. No es un fallo de
  seguridad, pero sí de diagnóstico.
- **Corrección**: un tiempo de espera (con `sesion.programar`) que pase a `estado error` con un texto fijo
  si no llega `listo` en unos 15 s.

### 9. Info · `mensaje_hostil_ignorado` puede pasar por mensajes de otras fuentes

- **Fichero**: `app-ui/e2e/video-preview.spec.ts:133`.
- **Escenario**: `not.toHaveAttribute("data-descartados", "0")` también se cumple con mensajes que no son
  del iframe (extensiones o DevTools que hacen `postMessage` a `window`). La comprobación de `0:00` sí es
  significativa.
- **Corrección**: contar solo los descartes por validación (un contador aparte) o comparar con `≥ 2`
  habiendo medido antes la línea base.

## Resumen por severidad

| Nº | Severidad | Tema |
|---|---|---|
| 1 | Medium | `frame-src` de Tauri (`127.0.0.1:*` en dev, ausente en prod): condición de integración con T12 |
| 2 | Low | `listo` admite 3 h y deja manipular el cabezal |
| 3 | Low | El test de aislamiento solo busca el nombre del método |
| 4 | Low | Aserción de POST en vuelo perdida en los tests de T16 |
| 5 | Low | La CSP de los E2E tapa una regresión del atributo `sandbox` |
| 6 | Low | Limitador de ventana fija |
| 7-9 | Info | Tests poco estrictos y falta un tiempo de espera para `listo` |
