# T4 · Pendientes tras la re-revisión de seguridad (2026-11-07)

Re-revisión de `af70ec8`: **cerrada con cambios menores**. Sin Critical, High ni Medium abiertos.

Menores de la re-revisión:
- `sincronizarCarpeta` va fuera del `try`: un EIO tras el rename devuelve error con el guardado ya en
  disco, y el siguiente guardado da 409. Debería ser best-effort (log y seguir).
- Los reintentos del rename usan `Atomics.wait`, que bloquea el motor hasta 0,5 s. Además reintentan
  EACCES/EPERM permanentes. Mejor: reintento asíncrono y solo ante EBUSY o EPERM transitorio.
- Un `.tmp-*` que sobrevive a un EBUSY no se barre nunca (falta el barrido de temporales de L8).
- Si `borrarArbol` lanza dentro del `catch` de `proyectoCrear`, se pierde el error original.
- Solo en POSIX: un FIFO cambiado entre `lstat` y `open` bloquearía `openSync` (`O_NONBLOCK`).

Abiertos de la revisión original (para Plane): L2, L3 (candado entre procesos, ligado a M-4/T12), L5
(`musica.pistaId` sin cruzar con recursos, como T1 L3), L7 (superficie de tools y la ruta absoluta de
`render.ts:306`) y los Info. Detalle en `seguridad-T4.md`.
