# Contrato REST de la voz (UI, T11, motor T5)

Fija la frontera `UI -> app-backend (T11) -> motor (T5, voz.ts)` para todo lo que gasta o toca la voz.
Nace de la revisión de seguridad de T19 (hallazgos 1 a 5): la confirmación de coste ata el **contenido**
y no solo una cifra. Contrastado con `video-mcp-server/src/voz.ts` de `feat/t5-voz-frases`.

## Regla de oro

El backend **nunca recalcula el plan tras la confirmación**. Reenvía `plan_confirmado` (y
`caracteres_confirmados`) tal cual al motor, que los compara con su propio cálculo y rechaza si difieren.
Prohibido rellenar `planConfirmado` con una llamada a `vozCoste` dentro del mismo request. Un POST sin
`plan_confirmado` es un 422 (`esquema`).

La UI no calcula el coste en ningún caso: toda cifra y todo `plan` salen de `POST .../voz/coste`.

## Errores

Todo error lleva `detail: { mensaje: string, codigo: string }`. La UI decide por `codigo`, nunca por el texto.

| `codigo` | HTTP | Cuándo | Qué hace la UI |
|---|---|---|---|
| `coste_cambiado` | 409 | El motor lanza `coste_cambiado` (caracteres) o `plan_cambiado` (contenido): ambos salen con este código | Relee el coste, vuelve a pedir confirmación con la cifra nueva; no reintenta solo |
| `reintento_facturado` | 409 | Hay frases ya cobradas y no usables y no se envió `reintentar_facturadas: true` | Relee el coste y enseña la casilla de refacturado |
| `conflicto` | 409 | Revisión del proyecto obsoleta, o el motor ya está generando esa voz | Cierra el diálogo y entra en el flujo de conflicto del editor (reenvía el guardado); no es un error de conexión |
| `sin_clave` | 409 | El motor lanza el código `sin_clave`: falta la clave de ElevenLabs | Muestra `voz-sin-clave` con enlace a Ajustes |
| `sin_voz` | 409 | El motor lanza el código `sin_voz`: el perfil del proyecto no tiene una voz válida | Pide elegir la voz en el perfil; **no** dice «Falta la clave» |
| `voz_pendiente` | 409 | Faltan voces por generar (ensamblado) | Ofrece generar |
| `render_en_curso` | 409 | El proyecto tiene un render en curso (voz, quitar silencios y borrar) | Bloquea el botón y lo explica |
| `voz_en_curso` | 409 | Se está generando la voz del proyecto (render y borrar) | Bloquea el botón y lo explica |
| `fallo_facturado` | 502 | Solo en la muestra: ElevenLabs cobró y no se pudo usar | Pide confirmar el reintento |
| `recurso_en_uso` | 409 | Borrar un recurso que usa una escena | Pide quitarlo de la escena |
| `no_disponible` | 503 | Falta ffmpeg, el motor de vídeo no responde o no hay puerto de preview | Aviso de que la voz no está disponible ahora |
| `error_motor` | 502 | Error del motor sin tipar | Error genérico |
| `esquema` | 422 | Cuerpo inválido (incluye falta de `plan_confirmado`) | Error genérico |

Cualquier otro código se trata como error genérico. Desde T11 **todo** error de `/video/**` (409, 404 y 503 incluidos)
lleva `detail: { mensaje, codigo }` con mensaje fijo del backend: nunca texto libre del motor. T11 añadió a
`MENSAJES_POR_CODIGO` `sin_clave` y `sin_voz` (códigos propios del motor desde T8; el backend decide por el código y
nunca por el texto; hay un test contra el motor real), `reintento_facturado`,
`plan_cambiado -> coste_cambiado`, `voz_pendiente`, `fallo_facturado` y `en_uso -> recurso_en_uso`.

## `POST /video/proyectos/{id}/voz/coste`

Cuerpo: `{ frases?: string[] }` (ids de frase; ausente = todas las pendientes). No gasta nada. Es POST porque
el plan depende del cuerpo.

200:

```json
{
  "pendientes": ["f0", "f1"],
  "caracteres": 120,
  "caracteresRefacturados": 0,
  "fallidasFacturadas": ["f1"],
  "plan": "<opaco, lo da el motor>",
  "voz": { "id": "21m00Tcm4TlvDq8ikWAM", "nombre": "Lucía" }
}
```

- `plan` es opaco para la UI y para T11: se guarda y se devuelve sin tocar.
- `voz.nombre` lo cruza T11 con `/video/voces`; si no está, usa el id.
- `pendientes` es lo que el motor llama `pendientes` (frases sin voz en el ámbito pedido); `caracteres` es 0 si no
  hay nada que generar.

## `POST /video/proyectos/{id}/voz`

Cuerpo:

```json
{
  "plan_confirmado": "<el plan del último /voz/coste>",
  "caracteres_confirmados": 120,
  "frases": ["f0"],
  "reintentar_facturadas": false
}
```

- `plan_confirmado`: obligatorio.
- `caracteres_confirmados`: obligatorio (ver «Diferencias con el motor»).
- `frases`: opcional; el mismo ámbito que se pidió en `/voz/coste`.
- `reintentar_facturadas`: opcional. El backend lo envía al motor como `true` **solo** si llega el `true` literal de
  JSON; cualquier otro valor (`"true"`, `1`, ausente…) equivale a `false`. La UI lo manda a `true` solo si la persona
  marcó la casilla de refacturado.

200: `{ "generadas": 2, "caracteresFacturados": 120, "fallo": { "fraseId", "facturada", "codigo", "mensaje" } }`
(`fallo` solo si el lote se cortó; `facturada: true` = ElevenLabs cobró la frase y no se pudo usar, `codigo` es
`fallo_facturado` o `fallo_voz`, y `mensaje` es un texto fijo: el del motor va al log). El motor **no** devuelve
`revision` al generar (no modifica el proyecto), así que la REST tampoco.

## `POST /video/proyectos/{id}/voz/quitar-silencios`

Cuerpo: `{ "frase_id": "f0" }`. No gasta: **no lleva** `plan_confirmado` ni `caracteres_confirmados`.

El motor (`vozQuitarSilencios`) **guarda** el proyecto y sube la revisión, pero **no la devuelve**. 200:
`{ "recorte": { "inicio", "fin" } }` (la versión anterior de este contrato prometía `revision`; el backend no la
inventa). La UI, tras el 200, vuelve a pedir el proyecto al servidor (`GET /video/proyectos/{id}`) y lo carga: ahí
está la revisión nueva. No aplica el recorte con `editar()` sobre la revisión vieja. Antes de llamar guarda lo pendiente (el motor guarda con la
revisión que ve en disco). Mismos códigos de error que arriba (`conflicto`, `no_disponible`, `esquema`).

## `POST /video/voces/muestra`

`GET /video/voces` → `{ voces: [{ id, nombre, idioma, planMuestra }] }`.

Cuerpo: `{ "voiceId": "..." | "perfil_id": "...", "plan_confirmado": "<planMuestra de /video/voces>", "caracteres_confirmados": 60, "reintentar_facturada": false }`
(`reintentar_facturada` opcional, solo cuenta el `true` literal). Exactamente uno de `voiceId` (al elegir una voz del
catálogo) y `perfil_id` (la voz de ese perfil); sin ninguno, o con los dos, 422. Un perfil sin voz válida da `sin_voz`.
200: `{ "audioBase64", "caracteres", "cache" }` (`caracteres: 0` si salió de la caché). Mismos códigos; con una
muestra ya cobrada y no usable, `reintento_facturado` hasta que llegue `reintentar_facturada: true`.

## Diferencias con el motor real (T5) y cómo se absorben

- `fallidasFacturadas`: el motor devuelve `{ fraseId, intentos, caracteresCobrados }[]`; el contrato REST lo
  aplana a `string[]` de ids de frase. La cifra para la persona es `caracteresRefacturados`.
- `voz`: el motor da `{ voiceId, modelo }`; el REST da `{ id, nombre }`.
- `caracteres_confirmados` se mantiene además de `plan_confirmado` porque `vozGenerar` y `vozMuestra` exigen los
  dos (`exigirCoste` + `exigirPlan`). El plan ata el contenido; los caracteres, la cifra que se vio.
- `reintentarFacturadas` (generar) y `reintentarFacturada` (muestra, singular) tienen distinto nombre en el motor;
  el REST usa `reintentar_facturadas` y `reintentar_facturada` respectivamente, igual que el motor.
- `vozQuitarSilencios` recibe un solo `fraseId` (no una lista) y no tiene plan.
- El motor emite el mismo código `coste_cambiado` para cifra y contenido distintos (la ruta interna es
  `plan_cambiado`); el REST los unifica en `coste_cambiado`.
- `conflicto` del motor («Ya se está generando…») y el de revisión de T9 comparten código: para la UI son lo mismo
  (la versión del servidor no es la que se vio), y el flujo del editor lo resuelve.

## Cerrojos por proyecto (T11)

`Cerrojos` es un `dict[id, "render" | "voz"]` en el backend. Voz (generar y quitar silencios) con render activo da
`render_en_curso`; render con voz activa da `voz_en_curso`; borrar el proyecto con cualquiera de las dos, lo mismo.
`PUT` sigue permitido durante un render (compone en `_render/`). El cerrojo se suelta siempre (`finally`; el del render,
al acabar el job, falle como falle). `/voz/coste` y la muestra no lo toman: no escriben nada.

Timeout de `video_voz_generar`: `60 + 200 × frases` s; sin `frases`, el número de frases se acota por
`min(540, caracteres_confirmados)`.

## Voz en curso y reinicios del motor (revisión de seguridad de T11)

- La voz sale del `voz` del perfil que referencia el proyecto (`defecto` trae la predefinida); `ELEVENLABS_VOICE_ID` ya
  no cuenta y el backend solo la reenvía en desarrollo por compatibilidad con los E2E antiguos.
- `generar`, `quitar-silencios` y la muestra llaman al motor como llamadas **protegidas**: mientras haya una en vuelo,
  o algún cerrojo de voz o de render, el timeout de cualquier otra llamada al motor principal (`/voces`, `/voz/coste` de
  otro proyecto, la preview) falla solo esa llamada (503 `no_disponible`, mensaje fijo «ocupado con otra tarea») y **no
  reinicia el proceso**. Sin trabajo en curso, el timeout reinicia como siempre. La llamada protegida que vence ella misma
  sí reinicia (está colgada de verdad), salvo que haya otra protegida distinta en vuelo.
- `/voces` y el catálogo de `/voz/coste` llevan un timeout propio de 20 s (`TIMEOUT_VOCES`).
- **`PUT /settings` con una clave de ElevenLabs distinta de la guardada** con una voz o un render en curso: 409
  `generacion_en_curso`, mensaje fijo, **sin guardar nada**; la persona repite el cambio cuando acabe. Se eligió el 409 y
  no aplazar el reinicio porque aplazar deja la clave guardada pero sin efecto hasta quién sabe cuándo (estado confuso)
  y obliga a recordar un reinicio pendiente. Una clave igual a la guardada no reinicia nada. El render no usa la clave,
  pero se bloquea igual: es la regla más simple y el coste (esperar a que acabe) es pequeño.

## Pendiente de integración (fuera del carril del backend)

- Ver `docs/video-fase1/pendientes-T11.md`: R0-6 y `video_barrer_procesos` (T6), tools de recursos (T7), `modo` de
  `video_renderizar` (T6), rutas `/video/musica` (T7) y el código `sin_voz` frente a T20.
