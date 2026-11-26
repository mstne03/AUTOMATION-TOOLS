# R1 · T8 · Perfil visual mínimo (rama `feat/t8-perfiles`)

Diff revisado: `git diff feat/t5-voz-frases HEAD` (9 ficheros, +500/−9). Referencias: PLAN Task 8 (con R0-3 de
`docs/video-fase1/R0-fase1.md:40`), SPEC D8 (M-D2), I1, I2 (c), I6, y HANDOFF-video-fase1 §2.

## Veredicto

**Integrable.** Sin Critical, High ni Medium. Quedan 5 Low y 5 Info, ninguno bloqueante.

Tests: `npx vitest run test/perfil.test.ts test/generico.test.ts` da 34/34 en verde. Además lancé una sonda temporal
(`test/zz-sec-tmp.test.ts`, ya borrada; `git status` limpio) con estos resultados:

| Sonda | Resultado |
|---|---|
| `perfilGuardar({id:"defecto", perfil:{id:"../proyectos/video001/proyecto"}})` | `id_distinto`, no escribe |
| `id: null` en el cuerpo | `id_distinto` |
| Clave `constructor` en el cuerpo | `unrecognized_keys` |
| `__proto__` | rechazado (lo cubre ya el test del propio paquete) |
| `nombre` con bidi o con URL al duplicar | `texto_inseguro` / `url_en_texto` |
| `proyectoCrear` con guion inexistente | `no_encontrado` antes de mirar el perfil |
| `defecto.json` roto a mano | `guardar` y `duplicar` de `defecto` fallan con `json_invalido`; `listar` da `{id:"defecto", valido:false}` (ver L1) |

## Lo que se comprobó y está bien

- **Recorrido de rutas.** `PERFIL_ID_RE = /^(defecto|p-[0-9a-f]{16})$/` (`esquema.ts:32`) está anclada, sin la bandera `m`,
  y en JS `$` no admite un `\n` final (el test incluye `"defecto\n"`). Hay tres puntos de entrada y los tres pasan por
  `validarPerfilId` antes de componer la ruta: `perfil.ts:72` en `guardar` (`:133`), `duplicar` (`:148`) y `cargarPerfil` (`:88`).
  `listar` solo toma nombres que casan con `FICHERO_RE` (`:99`). El `perfilId` del proyecto también tiene la regex, en
  `proyecto.ts:243` y en `esquema.ts:251`.
- **Pisar `defecto` o el perfil de otro.** El id del cuerpo distinto del argumento se rechaza con `id_distinto` y no escribe
  nada (`perfil.ts:134-136`), tal como pide el plan enmendado (rechazar, no ignorar). Si el id no viene, se toma el del
  argumento. Lo que se escribe es el objeto que devuelve zod, nunca el cuerpo crudo (`:137-139`). `duplicar` no acepta id:
  lo genera el motor con `randomBytes(8)` y comprueba antes que no exista (`:151-153`). A la tool solo llegan `id` y
  `nombre` (el `z.object` del SDK quita lo demás) y la función rechaza además cualquier clave de más (`:145-147`).
  Que se pueda editar `defecto` es lo que pide D8 («editables a mano»), no un fallo.
- **Inyección de CSS.** Los colores se validan con `COLOR_RE`, que solo admite hexadecimal anclado (`composicion.ts:49`),
  dos veces: en `EsquemaPerfil` y otra vez en `validarTema` (`perfil.ts:44-52`, llamado desde `validarPerfil`, `:80`).
  Con solo `[0-9a-f#]` no cabe `url(`, `expression`, `;`, `}`, `@import`, `var(` ni un escape `\`. La fuente sale de
  `z.enum(FUENTES)` y luego de la unión de literales `cara()` en `validarTema`, que fija también `archivo` y `peso`; así,
  `CARAS_FUENTE` no puede colar otro fichero aunque se mutase. `nombre` pasa por `textoSeguro(60, 1)`, que no deja pasar
  invisibles, bidi, controles ni URL (I2 c), y no llega al CSS (`tema.nombre` no se usa en `composicion.ts`).
- **Escrituras y lecturas.** Todas las escrituras van por `escribirAtomico`: temporal con `wx` y `rename`, que reemplaza
  un enlace plantado sin seguirlo. Todas las lecturas van por `leerJson`: lstat, fstat del descriptor, `nlink == 1`, mismo
  dev/ino y tope de 2 MiB. `dirPerfiles` aplica `comprobarCarpeta`. Los enlaces en la carpeta se listan como
  `valido:false` y nunca se siguen (lo cubre un test).
- **Exportaciones.** `textoSeguro`, `validar`, `esquema`, `validando`, `leerJson`, `escribirJson`, `existe`, `COLOR_RE` y
  `CARAS_FUENTE` son funciones puras o constantes. Exportarlas no cambia el comportamiento de nadie y no relaja ninguna
  comprobación. `COLOR_RE` no lleva `g` ni `y`, así que `lastIndex` no le afecta.
- **`registry.build()`.** Solo recorre `yt_mcp` y `kb_mcp` (`app-backend/app_backend/registry.py:180-182`): las tres tools
  nuevas viven en el motor y no pueden llegar al modelo. `test_video.py` solo cambia la expectativa del motor (24 tools).
- **Errores sin valores.** `problemas` solo lleva ruta y código. Con el centinela en un color, este no aparece (test).

## Hallazgos

### L1 · Low · Un perfil roto en disco ya no se puede reparar desde la app; con `defecto` se pierde el perfil «que siempre existe»
**Dónde:** `video-mcp-server/src/perfil.ts:138`. `perfilGuardar` llama a `cargarPerfil`, que valida el fichero **actual**.
**Escenario:** D8 dice que los perfiles son «editables a mano». Una coma de más en `defecto.json`, o cualquier proceso del
usuario (A4), lo deja inválido. A partir de ahí, `guardar` y `duplicar` de `defecto` fallan con `json_invalido` (comprobado
con la sonda) y no hay tool de borrado, así que el usuario no puede recuperarlo desde la UI. Ningún proyecto con
`perfilId:"defecto"` tendrá tema mientras siga así. El fallo se ve, así que I11 se cumple: es disponibilidad, no una
fuga ni una escalada.
**Corrección:** en `guardar`, comprobar solo que exista: un fichero normal sin enlaces (lstat) o el `defecto` virtual.
El cuerpo nuevo, ya validado, sustituye al fichero inválido. Test: `guardar_repara_perfil_roto`. Otra opción es que
`defecto` inválido en disco se pueda restaurar al neutro desde la UI.

### L2 · Low · `proyectoCrear` no comprueba que el perfil exista
**Dónde:** `video-mcp-server/src/proyecto.ts:241-256`. Solo aplica la regex.
**Escenario:** se crea `video00N` con `perfilId:"p-…"` inexistente (por un fallo de la UI o una carrera con un borrado
futuro). Hoy no hay ningún consumidor del perfil en render ni en preview (`temaDePerfil` solo se usa en los tests). Si el
consumidor que llegue en T10/T12 cae al neutro cuando falta el perfil, eso sería un fallo silencioso (I11).
**Corrección:** en `proyectoCrear`, llamar a `cargarPerfil` (exportarlo o exponer `perfilExiste`) y devolver
`no_encontrado` o 404 en REST. Dejar escrito en el plan que el consumidor del tema lanza `no_encontrado` y **nunca** cae a
`defecto`. Test: `crear_con_perfil_inexistente_404`.

### L3 · Low · El error de id inválido repite hasta 40 caracteres del valor recibido
**Dónde:** `video-mcp-server/src/perfil.ts:72` (`valorCorto(id)`).
**Escenario:** con la sonda, `perfilGuardar({id:"SECRETO-CENTINELA-123"})` da `Id de perfil no válido: "SECRETO-CENTINELA-123".`
El patrón ya estaba en `validarGuionId`. A1 no llega a REST, pero T9 prevé `error_sin_centinela`, y un id pegado por
error podría acabar en logs.
**Corrección:** mensaje fijo, «Id de perfil no válido.», o que T9 lo cubra explícitamente con `error_sin_centinela` en `/video/perfiles/{pid}`.

### L4 · Low · Carpeta real `<estado>/video/video/perfiles` en vez de `<estado>/video/perfiles`, y sin comprobar los componentes intermedios
**Dónde:** `video-mcp-server/src/perfil.ts:55-57`, con `app-backend/app_backend/video.py:363` (`VIDEO_ROOT = <estado>/video/proyectos`).
**Escenario:** `dirname(VIDEO_ROOT)/video/perfiles` da `<estado>/video/video/perfiles`. Es la misma convención que los
guiones (`proyecto.ts:124`), pero las muestras usan `<estado>/video/muestras` (`voz.ts:584`) y la spec dice
`<estado>/video/perfiles`. `comprobarCarpeta` solo mira el último componente: si `<estado>/video/video` fuera una junction
a otro sitio, `mkdirSync({recursive:true})` y las escrituras irían a parar allí. Necesita A4, que ya puede escribir en el
estado, así que no se gana privilegio.
**Corrección:** usar `path.join(path.dirname(path.resolve(raiz)), "perfiles")` (y lo mismo con los guiones en otro
paquete), o comprobar con `comprobarCarpeta` cada componente entre `<estado>/video` y `perfiles`. Alinear la spec o el código.

### L5 · Low · Sin tope de número de perfiles, y tope de lectura de 2 MiB para un documento de < 1 KB
**Dónde:** `video-mcp-server/src/perfil.ts:104-124` (`listar` carga todos), `:144-157` (`duplicar` sin límite) y `proyecto.ts:52` (`MAX_JSON_BYTES`).
**Escenario:** un bucle en la UI, o A4 sembrando ficheros `p-*.json` de 2 MiB, hace que `listar` lea N × 2 MiB en cada
llamada y que la respuesta crezca sin límite. Esto afecta al tiempo y al disco, no a la confidencialidad.
**Corrección:** `MAX_PERFILES` (p. ej., 200): `duplicar` responde `conflicto` al llegar y `listar` corta ahí. Pasar a
`leerJson` un tope propio para perfiles (p. ej., 16 KiB), con un parámetro opcional `max`.

### I1 · Info · Voz por defecto fija `21m00Tcm4TlvDq8ikWAM`
**Dónde:** `perfil.ts:34`. Es una voz predefinida antigua de ElevenLabs y no es un secreto. Hoy no se consume: `voz.ts` no lee
el perfil. Si ElevenLabs la retira, la generación fallará de forma visible (I11 se cumple). Conviene que la UI avise cuando
la voz del perfil no esté en `video_voces`.

### I2 · Info · No hay un test de regresión que impida que `video_*` entre en `registry.build()`
Hoy la exclusión es estructural, porque solo se recorren `yt_mcp` y `kb_mcp`. El test `test_registry_sin_tools_video` está
previsto en T9: no hay que olvidarlo, porque estas tres tools son de escritura (`guardar` y `duplicar`).

### I3 · Info · Descripciones de las tools desalineadas con lo que se valida
`video_perfil_duplicar.nombre` admite `max(240)` en el `inputSchema`, pero se valida a 60
(`herramientas-proyecto.ts:215`). `video_perfil_guardar` dice «#RGB/#RRGGBB», pero `COLOR_RE` también admite 4 y 8 dígitos
(alfa). No es un riesgo, pero conviene alinearlo.

### I4 · Info · `CARAS_FUENTE` y `PERFIL_DEFECTO` son mutables en tiempo de ejecución
`as const` solo protege en tipos. Hoy no debilita nada, porque `validarTema` vuelve a fijar los literales y `cargarPerfil`
devuelve `structuredClone(PERFIL_DEFECTO)`. Para un endurecimiento barato: `Object.freeze` (profundo en `PERFIL_DEFECTO`).

### I5 · Info · `escribirJson` se exporta pero `perfil.ts` no lo usa
Usa `escribirAtomico` directamente. Es equivalente. La exportación sobra, aunque no debilita nada.
