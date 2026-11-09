# Auditoría de seguridad — T6 «Montaje de preview y de render» (módulo Vídeo, SEO Studio)

Fecha: 2026-11-09 · Auditor: Cybersecurity Auditor Agent · Modo: solo lectura (sin tests, sin red)
Alcance: `diff-T6-src.patch`, `diff-T6-backend.patch` (tests ojeados), más el código que el diff usa:
`proceso.ts` (barrido 590-872), `paths.ts` (`resolverDentro`, `borrarArbol`, `comprobarCarpeta`),
`composicion.ts` (`escribirPlan`, `urlsDeRed`), `linea.ts` (`desdeProyecto`), `voz.ts` (`ensamblarVoz`),
`patches/hyperframes+0.8.206.patch` (`seoStudioArgs`), `video_rest.py` (validación de `carpeta`).

## Resumen ejecutivo

El diff está bien encaminado: los ids pasan siempre por `validarId`, `carpeta` sale de un contador del motor y el
backend la vuelve a validar (`r[0-9]{1,9}`), `escribirPlan` comprueba todas las rutas relativas antes de borrar,
`borrarArbol` no atraviesa junctions, el MP4 deja de salir como ruta en modo integrado y el backend ya no lee `/proc`
en win32. No hay Critical ni High. El hallazgo principal es de disponibilidad: el barrido al arrancar (nuevo en T6)
puede tumbar el motor en bucle (`process.exit(70)`) por procesos ajenos que el motor no puede leer. El resto son
endurecimientos.

Recuento: **Critical 0 · High 0 · Medium 1 · Low 7 · Info 3**

---

## Findings

### MEDIUM — M-1: el barrido al arrancar puede dejar el motor en bucle de reinicios por procesos ajenos sin ruta legible (I7, I11)

- **Location**: `src/index.ts:210` (barrido en cada arranque), `src/proceso.ts:765,778` (`nombres` / `noVerificables`),
  `src/proceso.ts:851-856` y `815-818` (`deps.reiniciar` → `process.exit(70)`), `src/proceso.ts:870`.
- **Description**: `seleccionarBarrido` mete en `noVerificables` todo proceso **sin `ExecutablePath`** cuyo nombre sea
  `ffmpeg.exe`, `ffprobe.exe` o (con manifiesto) `chrome-headless-shell.exe`, salvo que `ajeno()` demuestre que es de
  otro sitio leyendo su `CommandLine` o la ruta del padre. A un proceso **elevado** (o de otra cuenta), un usuario
  estándar no le puede leer por WMI ni la ruta ni la línea de comandos: las dos salen vacías y `ajeno()` devuelve
  `false`. Tras 3 observaciones, `barrerProcesos` llama a `reiniciar()`, que hace `process.exit(70)`.
  Antes de T6 esto solo pasaba tras un timeout o un fallo de la CLI. Ahora pasa **en cada arranque del motor**
  (`index.ts:210`) y cada vez que el backend llama a `video_barrer_procesos` tras una cancelación.
- **Escenario**: el usuario tiene abierto cualquier programa elevado que lance un `ffmpeg.exe` (un grabador o
  conversor ejecutado como administrador) o una herramienta Puppeteer como administrador (`chrome-headless-shell.exe`).
  Arranca el motor → el barrido asíncrono lo ve sin ruta → `exit(70)` a los ~2-3 s. El backend lo relanza en la
  siguiente llamada → vuelve a barrer → vuelve a salir. El módulo Vídeo queda inutilizable mientras ese programa siga
  vivo. Como el barrido va con `void` y en paralelo a `server.connect`, el `exit` también **corta la llamada que estaba
  en curso**. Si era `video_generar_voz`, los créditos de ElevenLabs ya están gastados.
- **Impact**: denegación de servicio local persistente, provocada por un programa legítimo de terceros; pérdida de
  trabajo en vuelo. No mata procesos ajenos (eso está bien cerrado), pero sí al propio motor.
- **References**: CWE-400 / CWE-703 (gestión de condiciones excepcionales); OWASP A04 Insecure Design.
- **Recommendation (mínimo)**: separar «barrido oportunista» (al arrancar o a petición) de «barrido tras un timeout
  propio». En el oportunista, los `noVerificables` se **registran y se dejan**, sin `reiniciar()`, porque al arrancar
  el motor no tiene trabajo en vuelo que esos procesos puedan estar bloqueando. Por ejemplo, un parámetro
  `{ reiniciarSiDudas: false }` en `barridoAlArrancar`. Como alternativa, que solo cuenten como dudosos los que tengan
  un padre de la cadena del motor (`process.execPath` del bundle). Un test con un `ProcesoVivo` sin `ruta` ni `linea`
  y nombre `ffmpeg.exe` que no provoque `reiniciar`.

---

### LOW — L-1: el filtro de argumentos de Chrome del parche se salta con mayúsculas o con otros prefijos (I13, I3)

- **Location**: `patches/hyperframes+0.8.206.patch:107-111` (`SEO_STUDIO_CDP`, `SEO_STUDIO_FUERA`, `SEO_STUDIO_UN_PROCESO`).
- **Description**: las regex exigen `--` y minúsculas. En Windows, `base::CommandLine` de Chromium acepta como prefijo
  de switch `--`, `-` y `/`, y pasa los nombres de switch a minúsculas. Por eso `-remote-debugging-port=0`,
  `--Remote-Debugging-Port=0`, `/no-sandbox` o `--No-Sandbox` pasan el filtro y Chrome los aplica.
- **Escenario**: una versión futura de HyperFrames (o una opción o variable que añada argumentos a Puppeteer) mete
  `--remote-debugging-port` con otra grafía. Chrome abre CDP en loopback y cualquier proceso local puede manejar el
  navegador del render. Hoy los argumentos los genera código fijado por SHA-256, así que el riesgo es residual.
- **Recommendation**: normalizar antes de comparar, con `a.replace(/^(--|-|\/)/, "--").toLowerCase()`, en las tres
  regex. Para CDP, rechazar cualquier argumento que contenga `remote-debugging-` salvo `--remote-debugging-pipe`.

### LOW — L-2: `_composicion/` y `_render/` no se comprueban como junction: escritura fuera de VIDEO_ROOT (I13)

- **Location**: `src/montaje.ts:133` (`fs.mkdirSync(base, { recursive: true })` sobre `rutas.composicion`),
  `src/render.ts:636` (`path.join(prep.rutas.dir, "_render", job.job_id)`), `src/composicion.ts:766-769`.
- **Description**: la carpeta del proyecto pasa por `resolverDentro` y `comprobarCarpeta`, pero las subcarpetas
  `_composicion` y `_render` no. `borrarArbol(destino)` mira solo si `r<n>` o `<job>` son enlaces, no si lo es su padre.
  Si `_render` o `_composicion` son una junction (que `mklink /J` crea sin privilegios), el motor escribe composición
  y `voz.wav` dentro del destino de la junction y borra allí `r<k>` (`k < n-1`) y `render-<id>-<hex>`.
- **Escenario**: un proyecto copiado de otra máquina, o un proceso local sin privilegios, deja
  `video001\_composicion` → `C:\Users\Marc\Documents`. Cada preview borra en Documentos las carpetas `r1`, `r2`… que
  existan. Hace falta escritura local previa, así que el impacto es limitado.
- **Recommendation**: `comprobarCarpeta(base)` tras el `mkdirSync`, en `montarPreview` y antes de escribir en
  `_render` (las dos rutas). También `resolverDentro(rutas.dir, "_render", job.job_id)`.

### LOW — L-3: `prepararProyecto` del render va fuera de `enSerie`: los temporales de la caché de voz pueden chocar y dejar un WAV corrupto en caché

- **Location**: `src/render.ts:445-446` (fuera de la cola y de `enSerie`), `src/montaje.ts:60-63`
  (`${destino}.tmp-${process.pid}`), `src/voz.ts:520` (`ensamblada-${h}.tmp-${process.pid}.wav`).
- **Description**: el propio comentario de `enSerie` dice que la caché de audio no admite dos escritores. Sin
  embargo, `encolarRender` ejecuta `prepararProyecto` (y con él `ensamblarVoz` y `normalizadaEnCache`) en cuanto
  llega la llamada, sin serializar. Dos `video_renderizar` seguidos del mismo id (o render y preview en el mismo
  proceso, como en el modo independiente) escriben **el mismo** temporal, porque el nombre solo lleva el pid. Si uno
  renombra mientras el otro sigue escribiendo, queda un WAV truncado o mezclado. `esFichero` solo comprueba
  `size > 0`, así que ese WAV se reutiliza en silencio hasta que cambien las frases (va contra I11: nada en silencio).
- **Recommendation**: envolver `prepararProyecto` de `encolarRender` en `enSerie`, o añadir `randomBytes` al nombre
  del temporal, como ya hace `voz.ts:339`.

### LOW — L-4: `video_barrer_procesos` se registra también en modo independiente, donde el modelo la ve

- **Location**: `src/index.ts:118-126` (fuera de los bloques `if (!esIntegrado())`).
- **Description**: el comentario dice que la tool «no entra en el registro del modelo». Eso es cierto en integrado,
  donde el registro lo hace el backend. En modo independiente (cliente MCP directo), en cambio, `tools/list` la
  expone al modelo. Sumado a M-1, un modelo manipulado por una inyección de prompt puede llamarla en bucle y forzar
  `exit(70)` en mitad de otra tarea.
- **Recommendation**: registrarla solo con `esIntegrado()`, porque solo el backend la necesita, o como mínimo que en
  modo independiente nunca llame a `reiniciar()`.

### LOW — L-5: en desarrollo, si `HYPERFRAMES_BROWSER_PATH` apunta al Chrome del usuario, el barrido al arrancar lo mata

- **Location**: `src/proceso.ts:622-624` (`exactos.push(...ambas(navegador))`), `src/index.ts:210`.
- **Description**: sin manifiesto, el objetivo es el exe exacto del navegador. Si alguien fija
  `HYPERFRAMES_BROWSER_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`, todos los Chrome del usuario
  encajan. Ninguno tiene un Node en su cadena de padres, así que no quedan protegidos y se matan en **cada arranque**
  del motor (antes, solo tras un timeout).
- **Recommendation**: en `carpetasDelBundle`, rechazar como objetivo un navegador que viva bajo `%ProgramFiles%`,
  `%ProgramFiles(x86)%` o `%LOCALAPPDATA%\Google\Chrome` (o exigir que el nombre sea `chrome-headless-shell.exe`). Si
  no se cumple, registrarlo y no barrer el navegador.

### LOW — L-6: `reserva` y `avisos` llevan mensajes de error crudos (posibles rutas absolutas) hasta la UI (I6)

- **Location**: `src/render.ts:537-540` (`Rápido falló (${(e as Error).message})`), `src/herramientas.ts:452-458`
  (nuevo campo `reserva` en `estadoRender`).
- **Description**: en integrado se oculta `mp4`, pero `reserva` (campo nuevo) y `avisos` repiten
  `(e as Error).message` de `ejecutar` o ffmpeg. Ese texto puede incluir `C:\Users\<usuario>\…\_render\render-…`.
  Ya pasaba con `avisos`; T6 lo saca además en un campo dedicado.
- **Recommendation**: en integrado, pasar el texto por el mismo `nombreDe` o recorte de rutas que usa `paths.ts`
  antes de guardarlo en `job.reserva` y `job.avisos`, o guardar solo una causa tipada (`codificador_gpu`, `timeout`…).

### LOW — L-7: carpetas `_render/<job>` huérfanas si el motor muere a mitad de render

- **Location**: `src/render.ts:633-641` (borrado solo en `finally`).
- **Description**: si el motor cae (por timeout del backend, por M-1 o por `exit(70)`), el `finally` no se ejecuta.
  Quedan `_render\render-*` con una copia de `voz.wav` y de la composición. Nadie las limpia: el barrido al arrancar
  es de procesos, no de carpetas.
- **Recommendation**: al encolar un render de proyecto, o al arrancar, `borrarArbol` de cada `_render/render-*` que
  no sea un job vivo de `jobs`.

---

### INFO — I-1: `desdeProyecto` pasa `base` con `as never` y descarta `imagen`

- **Location**: `src/linea.ts:113`.
- **Description**: el cast anula la comprobación de tipos entre el esquema del Proyecto y `Escena` de
  `composicion.ts`. Si el esquema del Proyecto admite un `tipo` que el `switch` no cubre, `p` queda `undefined` y el
  fallo es un `TypeError`, no un error accionable. Las escenas foto, sin `base`, fallan con «Falta la imagen».
  Hoy el escapado lo hacen las piezas (`escaparHtml` y `jsonParaScript`), así que no se ve ninguna vía de HTML sin
  escapar desde el texto del modelo. Conviene que los tipos lo garanticen.
- **Recommendation**: un mapeo tipado (sin `never`) y una rama `default` en el `switch` que lance `ErrorVideo`.

### INFO — I-2: una preview fallida deja `r<n>` en disco sin verificar

- **Location**: `src/montaje.ts:98` (`urlsDeRed` lanza después de escribir).
- **Description**: la carpeta queda en disco con contenido que no pasó I2c. El riesgo está mitigado porque el
  backend solo sirve una `carpeta` que el motor haya devuelto con éxito (`video_rest.py:808-810`) y aplica
  `CSP default-src 'none'`.
- **Recommendation**: `borrarArbol(destino)` en el `catch` de `montarProyecto`.

### INFO — I-3: un render en cola puede perder su WAV normalizado

- **Location**: `src/montaje.ts:69-74`.
- **Description**: `prep.voz` se resuelve al encolar. Si mientras el job espera en cola se montan dos previews con
  frases distintas, la poda («se conservan las dos más recientes») borra ese WAV y el render falla en
  `copyFileSync`. El fallo es visible, sin impacto de seguridad.

---

## Remediation Roadmap

1. **M-1**: barrido oportunista sin `reiniciar()` (y L-4: tool solo en integrado). Juntos cierran la DoS.
2. **L-2**: `comprobarCarpeta` sobre `_composicion` y `_render` antes de escribir o borrar.
3. **L-3**: `enSerie` o un temporal aleatorio en la caché de voz.
4. **L-1**: normalizar prefijo y mayúsculas en `seoStudioArgs` y recalcular el SHA-256 del chunk.
5. **L-5, L-6, L-7**: endurecimientos menores; I-1 a I-3 cuando se toque el código.

## Positive Security Observations

- `id` siempre por `validarId`; `carpeta` sale de un contador del motor (`Math.max` de disco y proceso) y el backend
  la revalida con `re.fullmatch(r"r[0-9]{1,9}", …, re.ASCII)`.
- `contadores()` ignora entradas que sean enlace o junction (`!e.isSymbolicLink()`), y todo borrado pasa por
  `borrarArbol`, que falla cerrado si no ve la entrada en el listado del padre.
- `escribirPlan` comprueba todas las rutas del plan antes de borrar nada; `urlsDeRed` se ejecuta tras copiar la voz,
  con todo el árbol ya escrito.
- `vozDeProyecto` nunca llama a ElevenLabs y no toca la clave; los nombres de caché son hashes hex.
- `seleccionarBarrido` protege los hijos en vuelo y los de otro motor vivo (`Node` más alto con padre vivo, fechas
  de creación contra la reutilización de pid); `matarProcesos` vuelve a casar pid y ruta antes de matar.
- La comprobación de CDP del parche se hace antes del `return` de no-win32: vale en todas las plataformas.
- En integrado, el MP4 ya no viaja como ruta absoluta; `modo` se valida con zod y otra vez en `renderizar` y en
  `encolarRender`.
- Backend: `_descendientes` devuelve `[]` en win32 sin tocar `/proc`, y el test lo vigila con un espía de `Path`.
