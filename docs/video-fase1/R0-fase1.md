# R0 · Fase 1 de vídeo: enmiendas de la spec y plan (T1, T3, T4, T8, T9, T10)

Rama `feat/t0-enmiendas-spec`, revisión en solo lectura. Referencias: `HANDOFF-video-fase1.md` §2–§3 y `SPEC-video.md` §Seguridad (A1–A4, I1–I15).

## Comprobación de las enmiendas contra el código

| Enmienda | Qué se afirma | Código | Resultado |
|---|---|---|---|
| M-1 · I2 (b) | `--proxy-server=0.0.0.0:1`, resolver `MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, bypass `<-loopback>;<host>:<puerto>` (solo localhost/127.0.0.1), se descartan los flags de proxy/resolución/WebRTC, se añaden `disable_non_proxied_udp` y `--disable-quic` | `patches/hyperframes+0.8.206.patch:93-123` (`SEO_STUDIO_ARGS_WIN32`, `SEO_STUDIO_FUERA`, `seoStudioBypass`); prelanzamiento anulado (`:72-74`) | Coincide |
| W1.3 · residual | Rechaza `--single-process`/`--in-process-gpu`; `WebRtcHideLocalIpsWithMdns` se funde en un solo `--disable-features` | patch `:108-121` | Coincide (el mensaje de error dice «--single-process» también para `--in-process-gpu`: cosmético) |
| M-2 · I4 | `debug.log` se tolera solo en `chrome-headless-shell-win64/debug.log`, sin enlaces duros; el manifiesto no puede listarlo; el backend y el motor aplican la misma regla | `src/proceso.ts:178,264-271`; `app_backend/config.py:115`, `navegador.py:255` | Coincide |
| W1.5 · I4 | ffmpeg BtbN LGPL con SHA-256 fijado en `prepare-video-engine.sh` | `app-ui/scripts/prepare-video-engine.sh:29-32` (el hash es del **zip**) | Coincide (ver R0-13) |
| M-3 · I7 | El barrido por ruta de imagen se lanza tras un timeout o si la CLI termina con error; protege a los hijos en vuelo y a otro motor vivo; falla cerrado con los procesos no verificables | `src/proceso.ts:476-478, 597-609, 722-763` | Coincide. Se pierde el disparo por «cancelación» y no se cubre la muerte del motor (R0-6) |
| M-D1 · I8 | `frame-src` exacto con 47810–47813 | `tauri.conf.json:23-24`: hoy `csp` no tiene `frame-src` y `devCsp` tiene `frame-src http://127.0.0.1:*` | Es un estado objetivo de T12, no algo ya cumplido; la tabla de enmiendas debe decirlo (R0-13) |
| M-D7 · D9 | «el ffmpeg LGPL del bundle no incluye `boxblur` ni `gblur`» | `ffmpeg-build/componentes.conf:46`: el build propio no los incluye. `boxblur` es GPL. El BtbN LGPL actual probablemente sí trae `gblur` | Impreciso (R0-13) |

Invariantes que se refuerzan: I2 (b), con bypass por puerto y proxy a `0.0.0.0`, que en Windows no conecta; e I8, con `frame-src` exacto en vez de `127.0.0.1:*`. Invariantes que se relajan, de forma acotada: I4 (`debug.log`), I3 (renderer en Low < 2 s, W1.3 c) e I7 (desaparece «cancelación»). Ninguna relajación es grave, pero dos piden más texto (R0-6, R0-12).

---

## Hallazgos

### R0-1 · High (condicional) · El puerto CDP de Chrome en loopback deja a otro usuario de Windows controlar el navegador del render
**Dónde:** `SPEC-video.md:489` (I7: «Ningún servidor que abran HyperFrames o Chrome escucha fuera de `127.0.0.1`») y el diagrama de `:441-443`. El plan no lo trata.
**Escenario (A4):** puppeteer usa por defecto `pipe: false` y lanza Chrome con `--remote-debugging-port=0`, que deja el puerto CDP en 127.0.0.1 y sin autenticación. Otro usuario del mismo equipo recorre los puertos de loopback mientras dura el render (minutos), llega a `/json/version` y se conecta al WebSocket del navegador, porque un cliente nativo no envía `Origin`. Con `Target.createTarget` y `file:///C:/Users/<víctima>/…` más `Runtime.evaluate`, lee ficheros de la víctima con sus permisos. Así se salta I3 por completo: el proceso del navegador va en integridad Medium. «Solo en loopback» no protege frente a A4, que comparte el loopback.
**Estado:** el paquete `hyperframes` no está instalado en este checkout y el parche no fija `pipe`, así que no se ha podido confirmar. Es High salvo que se demuestre `pipe: true`.
**Cambio en la spec (I7, añadir al final):**
> Chrome se controla **solo por pipe** (`--remote-debugging-pipe`, puppeteer `pipe: true`): el parche rechaza `--remote-debugging-port` y `--remote-debugging-address`, y lanza un error si HyperFrames los pide. Ningún proceso del motor escucha en un puerto sin autenticar salvo el servidor de ficheros de HyperFrames (riesgo residual, ver «Riesgos residuales»).

**Cambio en el plan:** en T6 o T21, el test `render_sin_puerto_cdp`. Durante un render real enumera los sockets en escucha de los PID con imagen bajo la carpeta del CfT (`Get-NetTCPConnection -State Listen -OwningProcess`) y falla si hay alguno. En el parche, añadir `remote-debugging-port=` y `remote-debugging-address=` a `SEO_STUDIO_FUERA`, o mejor convertirlos en un error, como `SEO_STUDIO_UN_PROCESO`.

### R0-2 · Medium · El servidor de ficheros de HyperFrames expone la composición (fotos y textos del usuario) a otros usuarios de Windows
**Dónde:** `SPEC-video.md:442` («HyperFrames ──servidor de ficheros en 127.0.0.1──▶ Chrome») y la sección de riesgos residuales, que no lo menciona.
**Escenario (A4):** durante el render, `_render/` se sirve sin clave en un puerto de loopback. Otro usuario lo descubre recorriendo puertos y descarga las fotos normalizadas, la voz y la narración: activos protegidos («los vídeos y recursos del usuario»).
**Cambio en la spec (Riesgos residuales, nueva viñeta):**
> **Servidor de ficheros de HyperFrames (A4):** durante el render sirve `_render/` en `127.0.0.1:<efímero>` sin autenticación; otro usuario de Windows del equipo podría leer la composición mientras dura. Se acepta en la fase 1 porque solo sirve `_render/` (nunca la carpeta del proyecto ni `recursos/` originales) y vive lo que dura el render; se estudiará un prefijo de ruta aleatorio en el parche.

**Cambio en el plan (T6):** el test `servidor_hf_solo_render`, en el que pedir `../proyecto.json` o `../../` al servidor de HyperFrames da 404.

### R0-3 · Medium · Ids de perfil sin patrón y sin regla de id de la ruta frente al del cuerpo (T8, T9): recorrido de rutas al escribir `perfiles/<id>.json`
**Dónde:** `PLAN-video-fase1.md:320` (T8, `Perfil = { id, … }` sin regex), `:363` (T9 solo fija `id` y `gid`), y la tabla de T9 con `POST /video/perfiles/{pid}/duplicar`, `PUT /video/perfiles/{pid}` y `POST /video/proyectos {perfil_id}`.
**Escenario:** el id llega desde la UI (M-D2) y aparece dos veces, en la ruta (`{pid}`) y en el cuerpo (`perfil.id`). Si el backend valida uno y el motor escribe con el otro, un `PUT /video/perfiles/p-…` con `"id":"../proyectos/video001/proyecto"` sobrescribe `proyecto.json` con un JSON de perfil, o `navegador/…json` (el manifiesto), lo que da una corrupción o una denegación de servicio. Si «Duplicar» acepta un id del cliente, se puede pisar el perfil por defecto. Hoy solo lo alcanzaría un fallo de la UI o una tool futura (A1 no llega a REST), por eso es Medium, pero hay que cerrarlo antes de T8 y T9.
**Cambio en el plan (T8, Interfaces), texto listo para pegar:**
> `PERFIL_ID_RE = /^(defecto|p-[0-9a-f]{16})$/`. El id lo genera **siempre el motor** (`video_perfil_duplicar` devuelve el nuevo); `video_perfil_guardar` exige que el perfil exista (si no, `no_encontrado`) y **ignora `id` del cuerpo**: escribe en el id de la ruta o del argumento. `voz` con la misma regex que T5 (`^[A-Za-z0-9]{10,40}$`), `idioma` de una lista cerrada, `nombre` con `textoSeguro` y ≤ 60. Negativas añadidas: `perfil_id_cuerpo_distinto_ignorado`, `perfil_guardar_inexistente_404`, `duplicar_no_acepta_id`, `perfil_voz_regex`.

**Cambio en el plan (T9, Interfaces):**
> Patrones de ruta: `id` `^video\d{3}$`, `gid` `^g-[0-9a-f]{16}$`, `pid` `^(defecto|p-[0-9a-f]{16})$`, `rid` (regex de recurso de T1), `bandeja_id` (formato de T13). Test `todas_las_rutas_con_patron`: recorre `app.routes` y falla con cualquier parámetro de ruta sin regex. En `PUT /video/proyectos/{id}`, el `id` del cuerpo debe coincidir con el de la ruta (si no, 422); lo mismo en perfiles.

### R0-4 · Medium · El esquema (T1) no acota todas las cadenas, arrays y enums de `EscenaBase`, `opciones` y `Proyecto`
**Dónde:** `PLAN-video-fase1.md:114-131`. `LIMITES` solo cubre título, gancho, frases y `que_debe_salir`. No hay tope para `opciones.etiqueta`, `golpe.palabra`, `series[]` y `series[].valores[]`, `series[].nombre`, textos de `cartel`/`titulo3d`, la zona de `mapa`, `subtitulos.correcciones[]`/`cortes[]`, `recursos[].nombreOriginal`, `resolucion_minima` ni la paleta. No se dice que `fondo`, `look`, `subtitulos`, `clase`, `ext` y `estilo` sean enums.
**Escenario:** A1 manda 90 escenas `barras` con 10⁵ valores cada una, o un `etiqueta` de 900 KB (cabe en el tope de 1 MiB de T9). Eso da una composición de decenas de MB, un `check` y un seek fuera de los límites medidos (Review Focus 5) y un desbordamiento de texto en silencio (Review Focus 1). En `Proyecto` en disco, una `ext` libre (`"../x"`) acabaría en el nombre `<id>.<ext>` (I1, I6). Si `fondo` o `look` eligen un fichero de la plantilla y no son un enum, se convierten en un campo de ruta encubierto.
**Cambio en el plan (T1, Seguridad, añadir):**
> Toda cadena lleva `.max()` y todo array `.max()`; `fondo`, `look`, `subtitulos.estilo`, `recursos[].clase`, `recursos[].ext` y la región de `mapa` son `z.enum` de listas cerradas; `ext` ∈ `{jpg,png,webp,mp4,wav}` según `clase`. Números: enteros donde toque (`ancho`, `alto` ≤ 8192), tiempos finitos, ≥ 0 y crecientes (`recorte`, `ajusteCorte`, `inicio`). Test `sin_cadena_sin_tope`, que recorre el esquema de zod igual que `sin_campos_ruta` y falla con cualquier `ZodString`/`ZodArray` sin `max` o cualquier campo de estilo que no sea enum. Test `ext_libre_rechazada` en `validarProyecto`.

### R0-5 · Medium · La decisión M-D4 aplazada deja sin cubrir M-4 y las reglas que dan por hecha una sola instancia
**Dónde:** `PLAN-video-fase1.md:48` (M-D4), `:460` (T12: «Instancia única según M-D4»), `:667` (`VIDEO_ENGINE=1` exige «M-4 cerrada»), y T11 (`Cerrojos` en memoria del backend).
**Escenario:** el usuario abre la app dos veces. Hay dos backends con cerrojos y claves separados sobre el mismo `<estado>/video/`. En la instancia B se borra un proyecto mientras la A lo renderiza, y `borrar_con_render_409` no salta. En las dos se genera la voz del mismo proyecto, se factura dos veces ElevenLabs (I10) y se pierden escrituras de `proyecto.json` (la revisión no es atómica entre procesos). La clave de preview de A no se invalida al borrar en B (I8), y como `siguienteId` reutiliza `video00N`, la clave vieja de A puede servir el proyecto nuevo de B.
**Cambio en el plan (T12), texto listo para pegar:**
> Instancia única: **M-D4 aplazada (sin plugin)**. Se aplica el respaldo ya previsto, que no añade dependencias: `CreateMutexW` con nombre `Local\SEOStudio-<identifier>` (nunca `Global\`) en `setup`, **antes de lanzar el sidecar**; si ya existe, se muestra un diálogo y la segunda instancia sale sin lanzar el sidecar. Test `#[cfg(test)]`: el segundo `adquirir` falla. Si tampoco se hace esto, M-4 sigue abierta y `VIDEO_ENGINE=1` no se activa (T21, paso 5).

**Cambio en T10:** la clave de preview se ata a `(id, carpeta, creado)` del proyecto, no solo al `id`, para que un id reutilizado no herede una clave.

### R0-6 · Medium · El barrido de I7 no se ejecuta cuando muere el motor ni al arrancar, y la enmienda quita «cancelación»
**Dónde:** `SPEC-video.md:489` (I7 enmendada), `src/proceso.ts:478` (solo `r.timeout || (cli && r.code !== 0)`) y `PLAN-video-fase1.md:439` (T11 `motor_muere_en_render`).
**Escenario:** el motor muere a mitad del render (lo prueba T11) y el sidecar lo relanza. Los Chrome y ffmpeg del motor muerto siguen vivos, porque el Job Object cuelga del sidecar, no del motor. El barrido de `seleccionarBarrido` los reconoce como huérfanos, pero solo corre tras el siguiente timeout o error. Mientras tanto quedan Chrome huérfanos, lo que la sección de pruebas negativas prohíbe expresamente, y el disco y la CPU se agotan en silencio.
**Cambio en la spec (I7), sustituir «Tras un timeout, o si la CLI de HyperFrames termina con error» por:**
> Tras un timeout, una cancelación, o si la CLI de HyperFrames termina con error, **y al arrancar el motor** (para recoger lo que dejó un motor muerto), el motor barre por ruta de imagen…

**Cambio en el plan (T11):** `motor_muere_en_render` también comprueba que, tras el relanzamiento, no queda ningún proceso con imagen bajo el CfT o el ffmpeg del bundle. En T6, `barrido_al_arrancar`.

### R0-7 · Medium · Puertos fijos de preview: secuestro por otro usuario y sumidero de exfiltración en los puertos libres de la lista (T10)
**Dónde:** `SPEC-video.md:490` (I8) y `PLAN-video-fase1.md:402-405` (T10: `PUERTOS_PREVIEW`, sockets pasados a uvicorn, sin opciones de socket).
**Escenario (A4):** (a) Otro usuario de Windows abre `127.0.0.1:47810` antes de que arranque la app. La app usa el 47811, pero `frame-src` sigue admitiendo el 47810. Si una composición se compromete (un fallo de I1 en T3 o T9), navega su propio iframe a `http://127.0.0.1:47810/?d=<datos>`: la CSP `connect-src` no gobierna las navegaciones y `frame-src` las permite. Los textos o la clave salen hacia otro usuario. Es justo el problema que M-D1 quería evitar con Ollama, ahora en tres puertos que nadie reserva. (b) Sin `SO_EXCLUSIVEADDRUSE`, el endurecimiento de Windows por usuario se debilita en la vinculación comodín frente a la específica.
**Cambio en el plan (T10, Interfaces), texto listo para pegar:**
> Al arrancar, el backend **vincula los cuatro puertos** de `PUERTOS_PREVIEW` en `127.0.0.1` con `SO_EXCLUSIVEADDRUSE` (Windows; nunca `SO_REUSEADDR`) y los mantiene mientras viva: sirve en el primero y los demás responden 404 con la CSP, como reserva. Si alguno no se puede vincular, la preview funciona en el que haya, pero `POST …/preview` devuelve el aviso `puertos_preview_ajenos` (visible en la UI y en el log) con los puertos afectados. Si no hay ninguno, da 503. El puerto de la API (efímero) se comprueba fuera de `PUERTOS_PREVIEW`; si coincide, se vuelve a vincular. Tests: `reserva_cuatro_puertos`, `segundo_bind_falla`, `api_fuera_de_lista`, `puerto_ajeno_avisa`.

**Cambio en la spec (I8), añadir tras «Si los cuatro puertos están ocupados…»:**
> El backend reserva los cuatro puertos con uso exclusivo mientras vive; un puerto de la lista ocupado por otro proceso se avisa, porque la composición podría navegar a él.

### R0-8 · Medium · Una URL en un texto del guion tumba el render al final, y el plan no fija el comportamiento esperado (T3, T9)
**Dónde:** `PLAN-video-fase1.md:184` (`sin_url_de_red`: «`urlsDeRed` solo ve datos escapados y el render no lo interpreta»), T9 `url_en_texto_inerte`, y `src/composicion.ts:738-786` (`hallazgosDeRed` busca `http:`, `//host`, etc. también dentro de los nodos de texto, después de quitar entidades).
**Escenario:** A1, o el uso normal, mete «visita https://x.com» o «50//60» en una frase. El escape es correcto, pero `urlsDeRed` encuentra la URL en `index.html` y el render se rechaza después de pagar la voz. Es una denegación de servicio barata. El riesgo de seguridad es que alguien «arregle» esto haciendo que `urlsDeRed` ignore los textos o `DATOS`, lo que debilita I2 (c). La expresión «no lo interpreta» del test admite las dos lecturas.
**Cambio en el plan (T1 y T3), texto listo para pegar:**
> T1: `textoSeguro` **rechaza** en los campos de texto los patrones que `urlsDeRed` detectaría (`[a-z][a-z0-9+.-]*:`//, `//host`, `file:`), con `codigo: "url_en_texto"`, y `recomendaciones` sugiere escribir el dominio sin esquema. T3: `sin_url_de_red` pasa a ser «un `Proyecto` cargado a mano con `http://x` en un texto → `planificarComposicion` lo rechaza antes de escribir nada; `urlsDeRed` no cambia (test que fija su comportamiento sobre `DATOS` y nodos de texto)». Prohibido excluir texto o `DATOS` de `urlsDeRed`.

### R0-9 · Low · `frame-ancestors` admite `http://localhost:1420` también en producción (T10)
**Dónde:** `PLAN-video-fase1.md:412`. En el binario congelado, cualquier proceso que escuche en `localhost:1420`, incluido otro usuario (A4), puede incrustar la preview. Necesita la clave, así que el impacto es bajo.
**Cambio:** «`http://localhost:1420` solo si `not config.FROZEN`; test `frame_ancestors_produccion`.»

### R0-10 · Low · Robustez del runtime y de la reescritura de la CSP en T10
**Dónde:** `PLAN-video-fase1.md:407-409`. (a) Si se comprueba el SHA-256 «al abrir» y luego se lee el runtime de disco en cada petición, hay una ventana TOCTOU. (b) «Reescribe `'self'` por el origen exacto en el `<meta>`» debe tocar solo el `<meta>` generado por el motor, no hacer un reemplazo global.
**Cambio:** «El runtime se lee una vez, se verifica y se sirve **desde memoria**. La reescritura de la CSP sustituye exactamente la cadena del `<meta>` que emite `composicion.ts` (constante compartida) y falla si no aparece una vez exactamente. Test `meta_csp_unica`.»

### R0-11 · Low · El script en línea de la preview depende solo del escape para contener un fallo de I1
**Dónde:** `PLAN-video-fase1.md:412` (`script-src … 'unsafe-inline'`). T9 es la primera vía por la que datos del modelo llegan a la composición. Si falla un escape, `<img onerror>` o `<script>` se ejecutan en la preview.
**Cambio (defensa en profundidad, opcional en la fase 1):** «En la preview, `script-src` lista los `sha256-…` de los `<script>` en línea que genera el motor, más el origen exacto, en lugar de `'unsafe-inline'`, si las piezas lo permiten. Si no, se justifica en `preview.py` (I2 a). Además, `control.js` borra `RTCPeerConnection`, `RTCDataChannel` y `WebSocket` del `window` antes de ejecutar nada de la composición.»

### R0-12 · Low · W1.3 (c) admite un renderer en Low sin justificar por qué es seguro
**Dónde:** `SPEC-video.md:457-463`. Que un renderer se vea en Low menos de 2 s es la fase previa a `LowerToken()`, el nivel de integridad diferido de Chromium, antes de cargar contenido web. La spec no lo explica, y el umbral de 2 s, por sí solo, admitiría un renderer que ejecutara la composición en Low si viviera poco.
**Cambio (añadir a la viñeta c):**
> Es el nivel inicial antes de `LowerToken()` (nivel de integridad diferido), previo a cargar contenido. El test de I3 además exige que, **en el instante de la primera captura de fotograma**, todos los renderers vivos estén en Untrusted.

### R0-13 · Low · Exactitud y completitud de las enmiendas
- `SPEC-video.md:293` (M-D7): «el ffmpeg LGPL del bundle no incluye `boxblur` ni `gblur`» → «`boxblur` es GPL y el build LGPL propio (`ffmpeg-build/componentes.conf`) no incluye `gblur`».
- `SPEC-video.md:486` (W1.5): «su SHA-256, fijado en `prepare-video-engine.sh`» → «el SHA-256 del **zip** fijado en `prepare-video-engine.sh`» (hoy no se fija el hash del exe extraído).
- `SPEC-video.md:484` (I2 b): añadir por qué es `0.0.0.0:1` y no `127.0.0.1:1`: «en Windows conectar a `0.0.0.0` falla siempre; con `127.0.0.1:1`, cualquier proceso, incluido otro usuario (A4), que escuche en el puerto 1 recibiría todo el tráfico como proxy». Así nadie lo «corrige» en el futuro.
- `SPEC-video.md:490` (I8): «nunca `127.0.0.1:*`» se aplica también a `devCsp`, que hoy lo tiene (`tauri.conf.json:24`). La tabla de enmiendas debe decir que T12 lo cumple, todavía no el código. Y la frase «no alcanza la API ni sin bearer» debe dar el motivo real: «`frame-src` no incluye el puerto de la API, así que el marco no puede navegar a ella; `connect-src` de la preview solo admite su propio origen, y la API exige bearer».
- `SPEC-video.md:525-543`: la tabla cita M-D1, M-D2, M-D5, M-D7 y M-D8, pero **M-D3** (muestra generada, nunca `preview_url`: protege I14) y **M-D6** (Automático = Compatible, contra D11 `:369-370`) también cambian el texto vinculante. Hay que añadir a D7 (`:258`): «El botón de escuchar genera una muestra de 60 caracteres con coste visible y caché por voz; nunca se descarga `preview_url` (I14)», y ajustar D11. También conviene registrar «M-D4: aplazada» (ver R0-5).
- Nota de mantenimiento en `mapas.ts:192`: `ALIAS_PAISES[q]` sobre un objeto literal resuelve `constructor`/`toString`. Hoy es inocuo (no hay zona «Object»), pero `mapa_fuera_de_atlas` (T1) debería incluir `constructor`, `__proto__` y `toString`, y el código usar `Object.hasOwn` o un `Map`.

---

## Respuestas del protocolo R0 (§3)

- **¿Qué consigue A1 controlando el guion (T1, T3, T9)?** Con el plan corregido: texto escapado e inerte. No puede producir rutas, URLs ni ids HTML, ni disparar gasto. Los huecos son la denegación de servicio por cadenas y arrays sin tope (R0-4) y por URLs en el texto (R0-8).
- **¿Qué consigue A4?** Más de lo que modela la spec: el puerto CDP (R0-1), el servidor de HyperFrames (R0-2) y la ocupación de los puertos fijos (R0-7).
- **¿Hay fronteras nuevas?** Sí, la preview en un puerto fijo. Está modelada en el diagrama, pero falta la reserva de los puertos (R0-7).
- **¿Hay salidas cómodas contra I11?** La tentación de relajar `urlsDeRed` (R0-8) y la clave de preview reutilizada con ids secuenciales (R0-5). Los demás caminos de error del plan fallan de forma visible (503 del runtime, 503 sin puerto, `ok:false`).

## Veredicto

**Aprobada con cambios.** No hay Critical. Hay un High condicional (R0-1): o se demuestra que HyperFrames lanza Chrome con `pipe: true`, o se incorpora el cambio a I7 y el test `render_sin_puerto_cdp` antes de integrar T6, T9 o T10. Los siete Medium (R0-2 a R0-8) se incorporan al plan en T0, paso 3, antes de empezar T1, T8, T9, T10 y T12. Los Low van a Plane.

Recuento: Critical 0 · High 1 (condicional) · Medium 7 · Low 5.
