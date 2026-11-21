# Revisión de seguridad · T4 (almacén de guiones y proyectos)

Alcance: `git diff bf37c9f HEAD` en `feat/t4-almacen` (commits `0068567` y `d0d7f46`): `src/proyecto.ts`,
`src/herramientas-proyecto.ts`, `src/index.ts`, `src/paths.ts`, `src/herramientas.ts` y sus tests.
Referencias: PLAN-video-fase1.md «Task 4» y «Global Constraints»; SPEC-video.md §Seguridad (I1, I6, I13 y A4);
HANDOFF-video-fase1.md §2 («estado en %LOCALAPPDATA% escribible por cualquier proceso del usuario: ojo a TOCTOU»).

Ejecución:
- `npx vitest run test/proyecto.test.ts test/stdio.test.ts` → 26 PASS, 2 skipped, **1 FAIL**: `stdio.test.ts:58`
  («integrado y sin CfT, video_capacidades… (C3)»), un test que el diff no toca; parece del entorno Linux (no lo he
  comprobado contra `bf37c9f`). Los tests nuevos de T4 pasan.
- `app-backend/.venv/bin/python -m pytest tests/test_video.py -k 11_tools` → **FAIL**: `assert 15 == 11` (ver L6).
- He comprobado L1 (rutas en los errores) y que el hardlink y el symlink se rechazan con un script temporal en el
  scratchpad, sin tocar el repositorio. Ya está borrado.

## Veredicto

**Aprobable con cambios. Sin Critical ni High.** El núcleo cumple. Los ids pasan por regex anclada (`video\d{3}`,
`g-[0-9a-f]{16}`, sin `i` ni `u`, así que no hay colisiones de mayúsculas ni cifras Unicode): `..\x`, `CON`, ADS
(`:`), un punto o un espacio al final y los nombres cortos 8.3 no pasan. Todo documento se valida al leerlo, con
tope de 2 MB, y no hay otra vía que lea `proyecto.json` (`cargarProyecto` no se exporta). El `id` del documento se
cruza con su carpeta. `creado`, `revision` y `actualizado` los fija el almacén y `recursos` se compara con el disco.
`problemas` solo lleva ruta y código. Ninguna tool `video_*` entra en `registry.build()` del backend. Las 5 tools
antiguas (y `video_catalogo`) no se registran en integrado, y el stdio lo comprueba. El MP4 pasa a `<id>/video.mp4` y
el temporal del render queda dentro de la carpeta ya validada. Hay tres Medium que conviene cerrar antes de
integrar: la escritura «atómica» sin fsync, un `fs.rmSync` recursivo que el propio repo documenta como peligroso con
junctions, y una lectura de JSON que comprueba una ruta y abre otra.

| # | Sev. | Resumen |
|---|---|---|
| M1 | Medium | `escribirAtomico` no hace fsync: tras un corte de luz, `proyecto.json` puede quedar vacío o truncado y el proyecto se pierde |
| M2 | Medium | `proyectoCrear` limpia con `fs.rmSync({ recursive })`, que entra en junctions; el repo tiene `borrarArbol` justo para esto |
| M3 | Medium | `leerJson` hace `lstat`, luego `stat` y luego `readFileSync`, tres veces por ruta: TOCTOU y no cumple «cada fichero se abre una vez» (I6) |
| L1 | Low | Los errores llevan rutas absolutas (usuario de Windows) hasta el cliente MCP: `resolverDentro` y los mensajes de `fs` |
| L2 | Low | Se comprueba la carpeta y después se escribe por ruta: TOCTOU entre los dos pasos (junction cambiada a mitad) |
| L3 | Low | El 409 solo es atómico dentro de un proceso; el backend tiene dos motores sobre el mismo `VIDEO_ROOT` |
| L4 | Low | Los ids que no son válidos se repiten en el mensaje sin tope de longitud (`z.string()` sin `.max`) |
| L5 | Low | `musica.pistaId` sigue abierto (T1 L3): rompe la regla «nada referencia un fichero que no pasó por la importación» |
| L6 | Low | `test_motor_real_lista_las_11_tools` falla (15 ≠ 11): la guarda que fija la superficie integrada se rompe y además cuenta en vez de listar |
| L7 | Low | En integrado siguen `video_renderizar`, `video_vista_previa` y `video_fotograma` del formato anterior, con `musica:` como ruta y rutas absolutas en `datos` |
| L8 | Low | `rename` en Windows sin reintentos (EPERM/EBUSY con el antivirus o el indexador) y temporales huérfanos si el proceso muere |
| I1 | Info | Los listados callan los fallos de enlace (`guionListar` → `[]`, `proyectoListar` omite junctions): roza I11 |
| I2 | Info | `video_estado` sigue en `TOOLS_CANAL_RENDER` (`app-backend/app_backend/video.py:54`) y ya no existe en integrado |
| I3 | Info | R0-5: T4 no reutiliza ids peligrosamente, pero `siguienteId` = máx + 1 reutiliza el id al borrar el último; lo cubre la clave atada a `(id, carpeta, creado)` de T9 |

---

## M1 · Escritura atómica sin fsync (Medium)

**Dónde:** `video-mcp-server/src/paths.ts:300-313` (`escribirAtomico`), usado por `proyecto.ts:81-83` y
`herramientas.ts`.

**Qué pasa:** el temporal está en la misma carpeta y es único (`wx` + 4 bytes aleatorios). El rename es correcto. Pero
se renombra **sin `fsync` del temporal**. En NTFS, el journal protege los metadatos y no los datos: con un corte de luz
o un BSOD justo después de guardar, el rename puede estar en disco y el contenido no. Queda un `proyecto.json` de 0
bytes o con ceros. La versión anterior ya no existe, porque el rename la sustituyó.

**Escenario:** el editor autoguarda (Review Focus 3) cada pocos segundos. Se va la luz o el portátil se queda sin
batería. Al volver, `cargarProyecto` da `json_invalido`, `proyecto_listar` lo marca `valido:false` y el usuario pierde
el proyecto entero (protegemos «los vídeos y recursos del usuario»). El test `escritura_atomica` solo simula un fallo
en `renameSync`, no un fallo de durabilidad.

**Corrección:**
```ts
const fd = fs.openSync(tmp, "wx");
try { fs.writeFileSync(fd, datos); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(tmp, ruta);
// POSIX (desarrollo): fsync también de la carpeta; en Windows FlushFileBuffers del fichero basta.
```
Opcional: guardar `proyecto.json.bak` con la revisión anterior antes del rename, para poder recuperar.

## M2 · `fs.rmSync({ recursive })` en la limpieza de `proyectoCrear` (Medium)

**Dónde:** `video-mcp-server/src/proyecto.ts:250-259`.

**Qué pasa:** si falla `mkdir(voz)`, `mkdir(recursos)` o la escritura de `proyecto.json`, la carpeta se borra con
`fs.rmSync(dir, { recursive: true, force: true })`. El propio repo documenta en `paths.ts:216-221` que
`rmSync({ recursive })` **entra en las junctions** a `\??\Volume{GUID}\…`, que `mklink /J` crea sin privilegios, y
**borra su destino**. Para eso existe `borrarArbol`. La SPEC exige la prueba negativa «proyecto con una junction interna
que apunta a una carpeta centinela → al borrar, la centinela queda intacta».

**Escenario (A4 / proceso del usuario sobre %LOCALAPPDATA%):** un proceso vigila `proyectos/` con
`ReadDirectoryChangesW`. Cuando aparece `video007/`, crea `video007/voz` como junction a una carpeta del usuario. Entonces
`mkdirSync(voz)` falla con EEXIST, salta el `catch` y `rmSync` recursivo recorre la junction y vacía la carpeta. El fallo
también se puede provocar sin carrera fina: basta con ENOSPC en la escritura y la junction ya puesta. El impacto real queda
acotado, porque ese proceso ya tiene los permisos del usuario. Aun así es una regresión frente a una mitigación explícita del
proyecto, y se arregla con una línea.

**Corrección:** `borrarArbol(dir)` en lugar de `fs.rmSync(...)`. Mejor todavía: crear `voz/`, `recursos/` y
`proyecto.json` en una carpeta temporal `.<id>.creando-<hex>` y publicarla con un `rename` a `<id>`. Así la limpieza
borra solo lo propio, y el `rename` falla si otro proceso ya tomó el id. Añadir el test de la centinela en
`proyecto.test.ts`, con un symlink en Linux y una junction en Windows.

## M3 · `leerJson`: tres aperturas por ruta (Medium)

**Dónde:** `video-mcp-server/src/proyecto.ts:66-79`. `comprobarRecurso(ruta)` hace `lstat` (68), luego
`fs.statSync(ruta).size` **sigue enlaces** (73) y `fs.readFileSync(ruta)` vuelve a abrir la ruta (75).

**Qué pasa:** I6 pide que las comprobaciones (tipo, tamaño, enlace, hardlink) se hagan **sobre el handle abierto** y
que se lea de ese handle. `copiarRecurso` (`paths.ts:163-180`) ya lo hace bien. Aquí, entre el `lstat` y el
`readFileSync`, el fichero se puede cambiar por un symlink o un hardlink a otra cosa.

**Escenario:** un proceso cambia `proyecto.json` por un enlace a un fichero de varios GB (o, en desarrollo, a
`/dev/zero`) justo después del `lstat`. `readFileSync` lo carga entero en memoria, sin tope, y el motor muere por memoria.
Eso tumba el editor y los renders en curso del mismo proceso. No hay fuga de contenido: la validación posterior lo
impide, y el `catch` del `JSON.parse` no repite el texto. Por eso es Medium y no High. Además, la validación al cargar
**no se salta**: se valida lo que se leyó.

**Corrección:** mismo patrón que `copiarRecurso`:
`lstat(bigint)` → `openSync(ruta, "r")` → `fstat(fd)`. Se comprueba que es fichero, que `nlink === 1`, que `dev`/`ino`
coinciden con el `lstat` y que `size ≤ MAX_JSON_BYTES`. Luego `readSync` del descriptor **hasta `MAX_JSON_BYTES + 1`** y
error si llega al tope, para que un fichero que crece no se cuele. Después, `JSON.parse` y la validación.

---

## L1 · Rutas absolutas en los mensajes de error (Low)

**Dónde:** `paths.ts:28` y `:33` (`resolverDentro`: «La ruta C:\Users\<usuario>\…\video001 apunta fuera de VIDEO_ROOT
(…)»), que `proyecto.ts:198-199` envuelve tal cual en `ErrorAlmacen("esquema", e.message)`. También los errores crudos de
`fs`: `EEXIST: …, mkdir '…\video007'` (`proyecto.ts:251`), y `stat`, `read`, `rename` y `ENOSPC` (`proyecto.ts:73-75`,
`paths.ts:303-304`). `herramientas-proyecto.ts:66-70` y `index.ts:32-34` los devuelven y los registran tal cual.

**Comprobado:** con `video001` como symlink fuera, `proyectoLeer` devuelve `codigo: "esquema"` con las dos rutas absolutas
en el mensaje.

**Escenario:** la arquitectura dice que «la UI nunca ve rutas». Si T9 reenvía `mensaje` a la UI, o en desarrollo al
modelo de Claude Desktop, el nombre del usuario de Windows y la estructura del estado salen de la máquina. No son
secretos de I5, por eso es Low.

**Corrección:** en `resultadoDeError`, para los errores que no son `ErrorAlmacen`, un mensaje genérico con `code`
(`ENOSPC`, `EEXIST`…) y la ruta completa solo en el log. En `resolverDentro`, mensajes con `path.basename`. Una
colisión de id en `proyectoCrear` debería ser `ErrorAlmacen("conflicto")` y no un `EEXIST` crudo.

## L2 · TOCTOU entre comprobar la carpeta y escribir (Low)

**Dónde:** `proyecto.ts:109-119` y `:129-138` (guiones), `:192-204` y `:312` (proyecto), y `:250-255` (crear: después
de `mkdir` no se vuelve a comprobar la carpeta).

**Escenario:** entre `comprobarCarpeta(dir)` y `escribirAtomico(path.join(dir, …))`, la carpeta (o `guiones/`) se cambia
por una junction. El JSON validado se escribe en el destino de la junction y pisa allí un `proyecto.json` o un
`g-….json`. El contenido es dato validado y el actor ya tiene los permisos del usuario, por eso es Low.
`guionBorrar` (`:174-178`) tiene la misma ventana, pero solo puede borrar un `g-<16hex>.json`.

**Corrección:** volver a llamar a `comprobarCarpeta` justo antes del rename y, después, comprobar que el
`realpath(ruta)` sigue dentro de la carpeta esperada. No cierra la carrera, pero la estrecha. En Windows, la solución
completa sería abrir la carpeta con `FILE_FLAG_OPEN_REPARSE_POINT` y usar rutas relativas a ese handle, algo que no está
disponible desde Node. Aceptarlo como riesgo residual y documentarlo.

## L3 · Carrera de revisión entre procesos (Low)

**Dónde:** `proyecto.ts:298-313`.

**Qué pasa:** dentro de un proceso, el 409 es correcto. `proyectoGuardar` es síncrono de principio a fin y no hay
`await` entre leer la revisión y hacer el rename. Pero el backend lanza **dos motores**, `estado.motor` y
`estado.motor_render` (`video.py:54` y `:355`), sobre el mismo `VIDEO_ROOT`. En desarrollo puede haber además el motor de
Claude Desktop. Dos procesos que leen la revisión N pasan los dos el control y escriben N+1: se pierde una actualización
sin ningún 409. Hoy solo escribe el canal principal, pero T5 y T6 (voz, render) pueden querer actualizar el proyecto.

**Corrección:** un candado por proyecto (`proyecto.lock` creado con `wx`, con pid y caducidad) alrededor del ciclo
leer-comprobar-escribir. Como mínimo, volver a leer la revisión del disco justo antes del rename. Y dejar escrito que
**solo** el canal principal escribe `proyecto.json`.

## L4 · Valores del atacante sin tope en los mensajes (Low)

**Dónde:** `proyecto.ts:104` (`JSON.stringify(id)`), `paths.ts:13` (igual) y `herramientas-proyecto.ts:75-76` (`z.string()`
sin `.max`).

**Escenario:** un `id` de varios MB se repite en el mensaje de error, en el log (`index.ts:33`) y en la respuesta.
`JSON.stringify` escapa los saltos de línea, así que no hay inyección en el log. Solo es ruido y amplificación del log.

**Corrección:** `.max(40)` en `ID_GUION` e `ID_PROYECTO`, y truncar el valor en el mensaje (o no incluirlo).

## L5 · `musica.pistaId` sin cruce con `recursos` (Low)

**Dónde:** `esquema.ts:268`; la regla de `proyecto.ts:308`.

**Qué pasa:** `proyectoGuardar` impide cambiar `recursos` para que «un PUT no pueda referenciar un fichero que no pasó
por la importación». `capa.recursoId` se cruza con `recursos`, pero `musica.pistaId` acepta cualquier `ID_LOCAL_RE`
(admite `CON` y `NUL`) y no se cruza. Es el hallazgo L3 de T1, que sigue abierto. T4 hereda el hueco: si T6 o T7
resuelven la pista como `recursos/<pistaId>.wav`, un PUT puede referenciar un fichero que no pasó por la importación.

**Corrección:** `pistaId` con `RECURSO_ID_RE` y cruzado con un recurso de clase `musica` en el `superRefine` del proyecto.

## L6 · El test del backend que fija la superficie integrada falla (Low)

**Dónde:** `app-backend/tests/test_video.py:531-538`.

**Qué pasa:** con el motor compilado, `assert len(nombres) == 11` da 15. T4 quita 5 tools y añade 9. La comprobación de
los nombres antiguos ya la hace el stdio del motor. Pero la guarda del lado del backend está rota, y como cuenta en vez de
listar, una tool nueva no deseada habría pasado si sustituía a otra.

**Corrección:** en el mismo commit, cambiar la cuenta por un conjunto exacto de nombres esperados en integrado y añadir
`not any(n in nombres for n in ANTIGUAS)`.

## L7 · Tools del formato anterior que siguen en integrado (Low)

**Dónde:** `index.ts:101-165`: `video_renderizar`, `video_estado_render`, `video_fotograma`, `video_vista_previa` y
`video_ayuda`. También `render.ts:297-306`.

**Qué pasa:** la Task 4 pide quitar `video_musica` «que admite `musica:` como ruta». Sin embargo, `video_renderizar` y
`video_vista_previa` siguen leyendo `guion.md` y aplican `musica:` como **ruta** (acotada por `resolverDentro`, pero sin
`comprobarRecurso`). Como `video_guardar_guion` ya no existe en integrado, el único `guion.md` posible es uno que haya
escrito otro proceso. `video_fotograma` y `video_estado_render` devuelven en `datos` la ruta absoluta del MP4. Hoy el
backend solo llama a `video_capacidades`, así que no hay forma de llegar a ellas: Low.

**Corrección:** registrarlas solo fuera de integrado hasta que T6 las rehaga sobre `proyecto.json`, o al menos
ignorar `musica:` en integrado. Y quitar las rutas de `datos`.

## L8 · Rename en Windows sin reintentos y temporales huérfanos (Low)

**Dónde:** `paths.ts:304`.

**Qué pasa:** `MoveFileExW(REPLACE_EXISTING)` falla con EPERM o EBUSY si el destino está abierto (antivirus, indexador,
copias de seguridad). El autoguardado fallaría de vez en cuando. Además, si el motor muere entre la escritura y el rename,
queda `proyecto.json.tmp-<pid>-<hex>` para siempre.

**Corrección:** `conReintentos` (ya existe en `paths.ts`) alrededor del rename. Al arrancar, o en `proyecto_listar`,
barrer los `*.tmp-*` con más de unos minutos.

---

## Info

- **I1:** `guionListar` (`proyecto.ts:143-148`) devuelve `[]` si `guiones/` es una junction, mientras que
  `guion_guardar` falla. `proyectoListar` (`:273-277`) omite en silencio las carpetas enlazadas. Mejor
  `{ id, valido: false }` o un aviso, como pide I11 («si algo falla, el fallo se ve»).
- **I2:** `TOOLS_CANAL_RENDER` contiene `video_estado`, que en integrado ya no existe. Hay que limpiarlo en T9/T11.
- **I3 (R0-5):** T4 no introduce reutilización nueva. Los guiones usan 64 bits aleatorios. `creado` lo pone el almacén
  (`proyecto.ts:221`) y `guardar` lo conserva del disco (`:311`), así que T9 puede atar la clave a
  `(id, carpeta, creado)`. `siguienteId` sigue contando los `videoNNN.mp4` sueltos del formato anterior, y eso evita
  reutilizar esos ids. Un fichero basura `video999` en la raíz agota los ids (DoS menor).

## Comprobaciones que pasan

- Ids: `^video\d{3}$` y `^g-[0-9a-f]{16}$` anclados, sin `i` ni `u`; `..\x`, `video1`, `CON`, `video001:ads`,
  mayúsculas y nombres 8.3 rechazados.
- Symlink y hardlink en `proyecto.json` o `g-….json`: rechazados (`comprobarRecurso`, `nlink`). Carpeta de proyecto o de
  guiones enlazada: rechazada (`resolverDentro` + `comprobarCarpeta`). Comprobado.
- Escritura: temporal en la misma carpeta, `wx`, nombre aleatorio; el rename sustituye un symlink o hardlink de destino sin
  tocar a dónde apunta; un fallo deja el fichero anterior intacto.
- Validación al cargar en `cargarGuion` y `cargarProyecto`, sin otra vía de lectura; `doc.id === carpeta`; tope de 2 MB.
- `proyectoGuardar`: 409 con `revision_antigua` antes de validar el cuerpo; `id`, `creado`, `revision` y `actualizado` del
  almacén; `recursos` con `isDeepStrictEqual` contra el disco.
- `problemas` sin valores, y las claves desconocidas salen como `?`.
- Ninguna `video_*` en `app-backend/app_backend/registry.py` (`registry.build()`).
- En integrado no se registran `video_listar`, `video_guardar_guion`, `video_estado`, `video_generar_voz`, `video_musica`
  ni `video_catalogo` (test `sin_tools_antiguas_en_integrado`).
- MP4 en `<id>/video.mp4` (`paths.ts:46-48`). El temporal `videoNNN.renderizando.mp4` queda en la carpeta del proyecto ya
  validada por `imagenesValidadas → comprobarCarpeta`. `rmSync` sin `recursive` sobre el MP4 previo solo quita el nombre.
