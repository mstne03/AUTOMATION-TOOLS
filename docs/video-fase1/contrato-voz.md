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
| `sin_clave` | 409 | El motor lanza `sin_configurar` (falta la clave de ElevenLabs) | Muestra `voz-sin-clave` con enlace a Ajustes |
| `no_disponible` | 503 | Falta ffmpeg, o el motor de vídeo no responde | Aviso de que la voz no está disponible ahora |
| `esquema` | 422 | Cuerpo inválido (incluye falta de `plan_confirmado`) | Error genérico |

Cualquier otro código se trata como error genérico. T9 debe añadir a su `MENSAJES_POR_CODIGO` las entradas
`sin_configurar -> sin_clave (409)`, `reintento_facturado (409)`, `plan_cambiado -> coste_cambiado (409)` y
`conflicto` (también para el «Ya se está generando…» del motor).

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
- `reintentar_facturadas`: obligatorio. `true` solo si la persona marcó la casilla de refacturado.

200: `{ "revision": 7, "generadas": 2, "caracteresFacturados": 120, "fallo": { "fraseId", "mensaje", "facturada" } }`
(`fallo` solo si el lote se cortó; `facturada: true` = ElevenLabs cobró la frase y no se pudo usar). Generar no
modifica el proyecto: `revision` es informativa.

## `POST /video/proyectos/{id}/voz/quitar-silencios`

Cuerpo: `{ "frase_id": "f0" }`. No gasta: **no lleva** `plan_confirmado` ni `caracteres_confirmados`.

El motor (`vozQuitarSilencios`) **guarda** el proyecto y sube la revisión. 200: `{ "revision": 8, "recorte": { "inicio", "fin" } }`.
La UI, tras el 200, vuelve a pedir el proyecto al servidor (`GET /video/proyectos/{id}`) y lo carga; no aplica el
recorte con `editar()` sobre la revisión vieja. Antes de llamar guarda lo pendiente (el motor guarda con la
revisión que ve en disco). Mismos códigos de error que arriba (`conflicto`, `no_disponible`, `esquema`).

## `POST /video/voces/muestra`

Cuerpo: `{ "voiceId": "...", "plan_confirmado": "<planMuestra de /video/voces>", "caracteres_confirmados": 60, "reintentar_facturada": false }`.
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
