# Pendientes de `borrarArbol`

Origen: revisión de `6c97fd2` (ver `integracion.md`). En `fix/borrar-arbol` se corrigen **M1** y **L1**. El resto queda
anotado, sin arreglar.

## Corregido en `fix/borrar-arbol`

- **M1**: un `lstat` que falla por algo distinto de ENOENT ya lanza (antes volvía sin borrar).
- **L1**: ruta vacía o no absoluta y raíz de unidad lanzan `ErrorVideo`; si el padre no se puede listar o la raíz no
  aparece en su listado, falla en cerrado. Efecto colateral aceptado: una ruta 8.3 como último componente, o un padre
  sin permiso de lectura, ahora lanza en vez de borrar.
- Test: `test/borrar-arbol.test.ts`. Los casos peligrosos anulan `unlinkSync`/`rmdirSync`/`rmSync`, así que ni sin la
  corrección pueden borrar nada real.

## Sin arreglar

- **L2**: carrera TOCTOU entre leer el `Dirent` y borrar por nombre. Hoy no cruza frontera gracias a I3.
- **L3**: el `Dirent` marca también carpetas de OneDrive y de deduplicación; con `VIDEO_ROOT` en OneDrive el borrado
  falla tras ~3,3 s (falla cerrado, pero es una regresión). Sin verificar.
- **L4**: `Atomics.wait` reintenta EPERM/EACCES permanentes (~3,3 s por entrada, con el bucle del servidor MCP
  bloqueado). Si lanza dentro de un `finally` tapa el resultado y en `vistaPrevia` se salta el segundo borrado. M1 lo
  agrava un poco: ahora hay más casos que lanzan.
- **L5** (`proceso.ts`): exigir letra de unidad no garantiza ruta local (unidad de red mapeada o `subst`).
- **`comprobarCarpeta`**: su comentario dice que detecta un padre enlazado y no lo hace. Corregir el comentario o la
  función.

## Re-revisión del diff (Opus, solo lectura): 0 Critical, 0 High, 0 Medium

La corrección es correcta y los 8 usos pasan rutas absolutas. Anotado, sin arreglar:

- **L6**: si `borrarArbol` lanza dentro de un `finally`/`catch` tapa el resultado (`fotograma.ts:30`,
  `capacidades.ts:99`, `render.ts:371`, `herramientas.ts:568-569`, `proyecto.ts:294`). Ya ocurría con `conReintentos`; M1 y
  L1 añaden dos causas. Propuesta: en limpiezas de temporales capturar y registrar con `log.warn`; en `proyecto.ts`
  relanzar el error original. Los borrados previos a escribir (`render.ts:333`, `composicion.ts:687`,
  `herramientas.ts:548`) deben seguir lanzando.
- **I1**: el `throw e` de M1 y el error de `readdirSync` propagan el mensaje nativo con la ruta absoluta. Envolver en
  `ErrorVideo` con `nombreDe`.
- **I2**: la guarda no impide borrar p. ej. `C:\Users`; se podría exigir estar dentro de `VIDEO_ROOT`, el temporal o
  `STATE_DIR` con `estaDentro`.
- **Test que falta**: un caso con mayúsculas distintas en Windows que sí borre, para proteger `igualRuta`.
