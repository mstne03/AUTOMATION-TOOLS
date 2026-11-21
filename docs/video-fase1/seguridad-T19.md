# Revisión de seguridad de T19 · Timeline de cinco pistas

- Rama: `feat/t19-timeline` (commit `bd231a0`), diff `git diff feat/t16-editor-marco HEAD` (12 ficheros, +2001).
- Contraste: motor de T5 (`feat/t5-voz-frases:video-mcp-server/src/voz.ts`), frontera REST de T9
  (`feat/t9-rest-guion:app-backend/app_backend/video_rest.py`), PLAN T11/T14/T16/T19, SPEC D3, D6, D7, I10.
- Pruebas: `pnpm exec vitest run src/test/timeline.test.tsx src/test/timelineGeometria.test.ts` → 39/39 en verde.
  No se ha creado ni dejado ningún test temporal.
- Nota de alcance: la ruta REST de voz (T11) **no existe todavía** en ninguna rama; `app-backend` no tiene rutas
  `/voz`. El contrato UI → backend → motor se juzga con lo que fija la UI (`CuerpoVoz` de T14, usado aquí) y lo que
  exige el motor.

## Veredicto

**No apto tal cual.** Lo que se pinta está bien (todo texto, sin HTML) y el modelo no alcanza ningún gasto. Pero el
contrato de confirmación de coste **no cierra**: la UI confirma solo un número y el motor exige además el hash del
plan y una confirmación expresa del refacturado, que la UI ni recibe ni envía. T11 tendría que inventarse esos dos
valores, y con eso desaparece la garantía de T5. Además, la UI distingue los 409 por un texto que T9 no produce.

| # | Severidad | Título |
|---|---|---|
| 1 | High | La confirmación no lleva `plan`: T11 tendría que fabricar `planConfirmado` (TOCTOU de contenido) |
| 2 | Medium | Refacturado (`reintentarFacturadas`) sin confirmación ni aviso; toast engañoso |
| 3 | Medium | Los 409 se distinguen por texto; con T9, «sin clave» nunca se ve y `conflicto` se confunde |
| 4 | Medium | El coste de una frase se calcula en el cliente, no en el servidor; bucle de 409 sin salida |
| 5 | Medium | «Quitar silencios»: el motor guarda el proyecto y la UI vuelve a editar → 409 de revisión seguro |
| 6 | Low | `voz-confirmar` va en un Portal, fuera del `inert` de T16; ediciones asíncronas durante el conflicto |
| 7 | Low | `CosteVoz.voz` tipado `string`, el motor da `{ voiceId, modelo }`: el diálogo se cae |
| 8 | Low | Carreras en `pedir` y diálogo que no dice qué frase se regenera |
| 9 | Low | Defensa de rendimiento: picos y regla sin tope propio en la UI |
| 10 | Low | Falta el E2E `regenerar_una_frase` y los tests de 409 usan códigos, no los mensajes reales |
| — | Info | Comprobaciones superadas |

---

## 1 · High · La confirmación no lleva `plan`: el contenido facturado no queda atado a lo que se vio

**Dónde.** `app-ui/src/api/types.ts:266-282` (`CosteVoz` sin `plan`, `fallidasFacturadas`, `caracteresRefacturados`;
`CuerpoVoz` sin `plan_confirmado`), `app-ui/src/video/timeline/useVoz.ts:65-72` (lee coste) y `:98` (cuerpo del POST).
Motor: `voz.ts` `vozGenerar` → `exigirCoste` + `exigirPlan(plan.plan, a.planConfirmado)`, comentario «La confirmación
ata también el contenido: si cambió algo con el mismo total de caracteres, no se llama».

**Problema.** El motor exige `planConfirmado` (hash de voz, modelo, hashes de los textos y marcas de fallo). La UI no
lo recibe del `GET …/voz/coste` (el tipo lo descarta) ni lo envía en el `POST …/voz`. Para que el motor acepte,
T11 solo puede hacer `coste = video_voz_coste(); video_voz_generar(planConfirmado=coste.plan)` en el mismo
request, es decir, recalcular el plan después de la confirmación y dárselo por bueno. Eso anula `exigirPlan`: queda
solo la igualdad del total de caracteres.

**Escenario.**
1. El usuario corrige «casa» por «cosa» en una frase y pulsa «Generar voz» antes de los 800 ms del autoguardado.
   `pedir()` lee el coste del servidor (texto antiguo) y el diálogo muestra N.
2. El autoguardado no se bloquea con el diálogo abierto: guarda el texto nuevo.
3. Confirma N. El total sigue siendo N, así que se factura un contenido distinto del que se calculó. Lo mismo pasa si
   otra ventana u otra fuente cambia el proyecto (o la voz o el modelo del perfil, que sí entran en el hash) entre el
   GET y el POST, con el mismo recuento.

La cifra cobrada coincide con la mostrada. El hueco es que la confirmación ya no ata el **qué**, y esa es justo la
garantía que T5 añadió a propósito.

**Corrección.**
- `CosteVoz` gana `plan: string`, `fallidasFacturadas` y `caracteresRefacturados`. `CuerpoVoz` gana
  `plan_confirmado: string` (y `reintentar_facturadas?: boolean`, ver #2). `Gasto` guarda el `plan` del mismo GET que
  dio la cifra, y `confirmar()` lo envía.
- T11 reenvía `plan_confirmado` tal cual y **nunca** llama a `video_voz_coste` para rellenarlo. Test de T11:
  `plan_no_se_fabrica` (POST sin `plan_confirmado` → 422).
- En la UI, «Generar voz» y «Regenerar» quedan deshabilitados mientras `guardado !== "guardado"`, o `pedir()` fuerza
  `guardar()` antes de leer el coste. Así la cifra corresponde a lo que hay en pantalla.
- Test: `confirmar_envia_plan` y `plan_cambiado_409_reabre`.

## 2 · Medium · El refacturado no se confirma ni se avisa; el toast promete lo contrario

**Dónde.** `useVoz.ts:98` (no hay `reintentar_facturadas`), `useVoz.ts:102-104` (toast), `Timeline.tsx:174-179` (el
diálogo solo muestra el total). Motor: `vozGenerar` lanza `reintento_facturado` si
`plan.fallidas.length && a.reintentarFacturadas !== true`.

**Problema.** Si ElevenLabs cobró una frase y el audio se descartó (MP3 inválido, alineación que no cuadra), el motor
deja `voz/<hash>.fallo` y exige confirmar de forma expresa que se volverá a cobrar. La UI no tiene ese paso, así que
caben dos salidas:
- T11 manda `reintentarFacturadas: true` siempre: el refacturado pasa sin que el usuario sepa que esa frase ya se le
  cobró. Va contra la decisión de T5 y contra «coste visible» de I10.
- T11 no lo manda: `reintento_facturado` no está en `MENSAJES_POR_CODIGO` de T9, sale un 502 y el toast genérico
  («Revisa tu conexión y tu cuenta de ElevenLabs»). La generación queda bloqueada para siempre desde la UI.

Además, tras un `fallo` con `facturada: true`, el toast de `useVoz.ts:103` dice «reintentar solo factura lo que
falta», que es falso para la frase facturada.

**Corrección.** Mostrar en `voz-confirmar` `caracteresRefacturados` y las frases afectadas («N caracteres ya se
cobraron una vez y se cobrarán de nuevo») con una casilla explícita. Solo con ella marcada se envía
`reintentar_facturadas: true`. T9/T11 mapean `reintento_facturado` a un 409 con código propio. Si `r.fallo.facturada`,
el toast lo dice. Test: `refacturado_pide_casilla`.

## 3 · Medium · Los 409 se distinguen por el texto del detalle, y T9 no produce esos textos

**Dónde.** `useVoz.ts:45-46` (`/coste/i`, `/clave/i` sobre `e.detail`), `useVoz.ts:107-117`. T9:
`MENSAJES_POR_CODIGO` solo tiene `esquema`, `conflicto` («El proyecto ha cambiado desde otra fuente; recárgalo.»),
`coste_cambiado` («El coste ha cambiado; revísalo y confirma de nuevo.») y `no_encontrado`. Todo lo demás sale como
`502 "El motor de vídeo no pudo completar la acción."`.

**Problema y escenarios.**
- **Sin clave:** el motor lanza `sin_configurar` («Añade tu clave de ElevenLabs…»). T9 no lo mapea, sale un 502 y
  `voz-sin-clave` no aparece nunca. Falla un requisito explícito de T19.
- **Doble generación** (dos ventanas, o un segundo POST mientras dura el primero): el motor lanza `conflicto`
  («Ya se está generando…»), sale el 409 genérico «El proyecto ha cambiado…» y la UI enseña un toast que culpa a la
  conexión o a ElevenLabs.
- **Fragilidad:** cualquier mensaje futuro de T11 con «coste» (por ejemplo, el refacturado de #2: «…cobra N caracteres
  más…» o un texto que diga «coste») cae en la rama de reabrir. Uno con «clave» (por ejemplo, «La clave de caché…»)
  cae en «Falta la clave».
- Los tests (`timeline.test.tsx:189`, `:203`) simulan `ApiError(409, "coste_cambiado")` y
  `ApiError(409, "sin_clave_elevenlabs")`: códigos, no los mensajes reales. Por eso tapan el desajuste.

**Corrección.** El backend devuelve `detail: { mensaje, codigo }` también en los 409 (como ya hace con el 422), y la
UI decide por `codigo` (`coste_cambiado`, `plan_cambiado`, `sin_clave`, `reintento_facturado`, `conflicto`,
`voz_con_render`). T11 añade a `MENSAJES_POR_CODIGO` la entrada `sin_configurar` → 409 con su código (el plan ya pide
`sin_clave_elevenlabs_409`). `ApiError` expone `codigo`. Los tests usan los mensajes y códigos reales del backend.

## 4 · Medium · El coste de una frase sale del cliente, no del servidor

**Dónde.** `useVoz.ts:48-55` (`caracteresDe`), `api/client.ts:202` (`videoVozCoste(id)` no acepta `frases`).

**Problema.** El plan dice «abren `voz-confirmar` con los caracteres del servidor». Con varias frases pendientes, la
cifra de «Regenerar esta frase» es `[...f.texto].length` del store local. El motor sí admite
`vozCoste(cfg, id, frases)`, pero la UI no lo usa. El servidor rechaza cualquier diferencia, así que no se cobra de
más, pero:
- **Unidades distintas:** la UI cuenta puntos de código y el motor `texto.length` (UTF-16). Una frase con emoji o
  con un carácter fuera del plano básico da siempre 409, la UI reabre con la misma cifra local, y así sin fin.
- **Frase ya generada** (`voz-regenerar` aparece en todos los clips, no solo en los pendientes): el motor da 0
  caracteres y la UI enseña la longitud del texto. Otra vez 409 sin fin, y el usuario cree que se le van a cobrar
  caracteres que no se cobrarán.
- **Texto sin guardar:** el diálogo enseña la longitud del texto local, que el servidor aún no tiene.

**Corrección.** `videoVozCoste(id, frases?)` con `?frases=` y el `plan` correspondiente (#1). Se borra
`caracteresDe`. `voz-regenerar-<id>` se deshabilita si la frase no está en `pendientes`, o se explica que no hay nada
que regenerar. Test: `regenerar_frase_usa_coste_del_servidor` con un texto con emoji.

## 5 · Medium · «Quitar silencios» provoca un conflicto de revisión seguro

**Dónde.** `useVoz.ts:131-160`. Motor: `vozQuitarSilencios` guarda el proyecto (`proyectoGuardar(..., revision)`) y
sube la revisión.

**Problema.** Tras la respuesta, la UI aplica el mismo recorte con `editar()` sobre su copia, que sigue en la revisión
antigua. El autoguardado (800 ms) hace un PUT con revisión vieja, recibe 409 y salta `editor-conflicto` con el
borrador. Si el usuario tenía ediciones locales sin guardar cuando pulsó el botón, el motor guarda encima de la
versión del servidor (sin esas ediciones) o devuelve `conflicto` (409 genérico, #3). Es la Review Focus 3, autoguardado
en carrera. No hay gasto: el cuerpo lleva `caracteres_confirmados: 0`, que sobra en una acción sin coste y confunde el
contrato.

**Escenario.** Pulsar «Quitar silencios» en cualquier frase con voz. A los 800 ms sale el aviso de conflicto. Si el
usuario elige «usar borrador», pisa la revisión del motor (mismo recorte, sin daño). Si había ediciones cruzadas, el
aviso aparece igual y el usuario puede descartar trabajo.

**Corrección.** Una de dos:
- Que la ruta REST devuelva la revisión nueva (o el proyecto) y la UI la adopte sin pasar por `editar()`, metiendo el
  cambio en el historial a mano.
- Mejor: que el motor solo **calcule** el recorte (sin guardar) y la UI lo aplique con `editar()`, como ya hace.

En los dos casos, forzar `guardar()` antes de la llamada y quitar `caracteres_confirmados` del cuerpo. Test:
`quitar_silencios_sin_conflicto`.

## 6 · Low · El diálogo de gasto escapa del `inert` del conflicto; ediciones asíncronas durante el aviso

**Dónde.** `Timeline.tsx:157-180` (`Dialog` con `R.Portal`, `ui/Dialog.tsx:30`), `Editor.tsx:143,154` (`inert` solo
en el cuerpo y la zona de timeline), `state/editor.ts:144` (`editar()` no mira `conflicto`), `useVoz.ts:143`.

**Problema.** El `inert` de T16 se respeta en todo el árbol de la timeline (clips, botones, regla, campos): no hay
atajos de teclado globales nuevos y los de T16 se bloquean con el diálogo abierto (`hayDialogoAbierto`). Pero:
- `voz-confirmar` se monta en un Portal bajo `body`, fuera del subárbol inerte. Si el autoguardado entra en conflicto
  con el diálogo abierto, «Confirmar y generar» sigue activo y se puede gastar sobre una versión del servidor que el
  usuario no ha visto (agrava #1).
- Una respuesta tardía de «Quitar silencios» llama a `editar()` cuando ya hay `conflicto`, y aplica el recorte sobre
  la base remota. `descartarBorrador` lo deja como «sin guardar». Es una edición que nadie pidió sobre esa versión.

**Corrección.** En `Timeline`, cerrar el diálogo (o deshabilitar `voz-confirmar-ok`) cuando
`useEditor(e => e.conflicto)` es true. Que `editar()` no haga nada con `conflicto` (o que lo comprueben los
callbacks asíncronos), y descartar resultados cuyo `id` o revisión ya no sean los actuales.

## 7 · Low · `CosteVoz.voz` no coincide con el motor

**Dónde.** `types.ts:270` (`voz: string`), `Timeline.tsx:177` («con la voz «{voz.gasto?.voz}»»). Motor:
`ResultadoCoste.voz: { voiceId, modelo }`.

**Problema.** Si T11 reenvía la forma del motor, React lanza «Objects are not valid as a React child» al abrir el
diálogo, y se cae la pantalla del editor o, como poco, el flujo de gasto. Si T11 lo aplana a `voiceId`, el usuario ve
un identificador opaco en vez del nombre de la voz, y no puede saber con qué voz se le cobra.

**Corrección.** Fijar en el contrato `voz: { id, nombre }` (T11 cruza con `/video/voces`) y pintar el nombre. Validar
la forma en el cliente (`typeof === "string"`) antes de pintarla.

## 8 · Low · Carreras en `pedir` y diálogo que no identifica la frase

**Dónde.** `useVoz.ts:82-88`, `Timeline.tsx:122,135,162`.

**Problema.** Doble clic en «Generar» está bien cubierto: `ocupado` (ref) más `loading` en el botón evitan el doble
POST, y el modal impide otra acción mientras está abierto. Lo que queda sin guardia es `pedir()`. Si se pulsan
«Regenerar» en A y luego en B antes de que vuelva el GET, gana la respuesta que llegue última, y el título
«Regenerar esta frase» no dice cuál es. Frases y cifra se fijan juntas, así que el servidor factura lo que se ve. Aun
así, el usuario puede confirmar la frase que no quería. Y si tras un 409 `coste` falla el GET de `leerCoste`, el diálogo
sigue abierto con la cifra vieja y `cambio: false`.

**Corrección.** Un contador de petición en `pedir` (se ignoran las respuestas viejas) y un `ocupado` mientras se lee
el coste. Mostrar en el diálogo el texto de la frase, como texto. Si falla la relectura tras un 409, cerrar el diálogo.

## 9 · Low · Rendimiento: sin tope propio en la UI

**Dónde.** `PistaVoz.tsx:175-187` (`Onda`), `Timeline.tsx:28` (marcas de la regla), `geometria.ts:127`.

**Problema.** Con 90 escenas la UI va bien: hay test (`timeline.test.tsx:329`), los clips van con `memo` y las
estructuras son lineales. Pero la UI se fía de los tamaños del backend. `picos` no tiene tope (el motor recorta a
`MAX_PICOS = 2000`, la UI no), y `total` sale de la suma de `recorte` (cada uno ≤ 180 s por esquema). Con ≈ 540
frases, la regla puede llegar a ~20 000 marcas y ~4 M px de ancho. No es explotable por el modelo (escribe JSON que
valida el motor), pero un proyecto raro tumba el render.

**Corrección.** `picos.slice(0, 2000)` en la UI, acotar `total` a `LIMITES.duracionS` para la regla y las marcas, y
acotar cada recorte a su `audio`.

## 10 · Low · Faltan pruebas que habrían destapado #1–#5

**Dónde.** No hay cambios en `app-ui/e2e/`. `pantallas.md` añade `voz-onda`, `voz-confirmar-cancelar`,
`subtitulo-dividir`, `subtitulo-unir` y `subtitulo-error`.

**Problema.** El plan pide el E2E `regenerar_una_frase` (CA3) con ElevenLabs simulado y el motor real, y
`CLAUDE.md` exige el E2E de cada `data-testid` nuevo en el mismo commit. Los tests unitarios simulan el cliente con
códigos inventados (#3) y un `CosteVoz` sin `plan` (#1). Por eso pasan aunque el contrato no cierre.

**Corrección.** E2E `regenerar_una_frase` contra el motor real (en cuanto exista T11), más casos para `plan_cambiado`,
`sin_clave` y `reintento_facturado`.

---

## Info · Comprobaciones superadas

- **Nada de HTML con datos.** Ni `innerHTML` ni `dangerouslySetInnerHTML` en `src/video/timeline/`. Etiquetas de
  escena, nombres de recurso y de música, texto de frase y líneas de subtítulo van como hijos de texto o en `title` y
  `aria-label` (atributos escapados por React). El campo de corrección usa `defaultValue`. Test
  `subtitulo_html_es_texto` en verde. `style` solo recibe números calculados.
- **Correcciones de subtítulo.** Cada palabra se corta a 80 caracteres (`PistaSubtitulos.tsx:249`), se exige el mismo
  número de palabras y los cortes se normalizan (enteros, únicos y ordenados en `cortesEfectivos`).
- **Editar no gasta (I10).** Editar texto, reordenar, recortar y la música solo pasan por `editar()`. Ningún efecto
  llama a `videoVozGenerar`. Test `editar_no_llama_voz` en verde. El modelo no alcanza ninguna de estas acciones.
- **Doble POST.** `ocupado` (ref) más el botón con `loading` y el modal evitan la doble confirmación, y tras un 409
  `coste` no se reintenta solo (`coste_409_reabre`).
- **Atajos y `inert`.** Los atajos nuevos están en los propios clips o en la regla (dentro del subárbol inerte). Los
  globales de T16 no actúan con un diálogo abierto ni durante el conflicto.
- **Entradas numéricas.** `geometria.ts` sanea `NaN`/`Infinity` (`finito`). `esRecorte` valida la respuesta de
  quitar silencios. Música: inicio y volumen acotados.
- **Sin dependencias nuevas** y sin rutas en el cliente.
