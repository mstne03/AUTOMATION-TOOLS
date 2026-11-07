# Integración local de la fase 1 del módulo Vídeo

Rama `feat/video-fase1-integracion`, creada desde `origin/feat/video-fase1` (`6c97fd2`, comprobado). Fusiones con
`merge --no-ff`, sin rebase, en el orden de la §2 de `HANDOFF-local-fase1.md`. Máquina de Marc, Windows.

## Entorno

- `npm ci` en `video-mcp-server`: el postinstall aplicó el parche de HyperFrames 0.8.206. Hashes contra
  `patches/hyperframes+0.8.206.sha256.json`: **14/14** (13 parcheados más 1 sin parche). No hizo falta copiar
  `node_modules` de otro worktree.
- `uv sync --extra dev` en `app-backend` y `pnpm install --frozen-lockfile` en `app-ui` (Git Bash).

## Revisión de `borrarArbol` (`6c97fd2`, solo lectura, Opus)

Veredicto: **0 Critical, 0 High, 1 Medium, 5 Low**. No se creó `fix/borrar-arbol`. El detalle, con escenarios, está en
la carpeta de notas de la sesión (`revision-borrarArbol.md`). Pendientes, a decidir por Marc:

- **M1** (`paths.ts` ~223): si `lstat` falla por algo distinto de ENOENT, `borrarArbol` vuelve sin borrar y sin
  avisar. Un `_composicion\` bloqueado un instante dejaría ficheros del plan anterior que la preview serviría
  (I11). Debería lanzar. Pesa más porque `proyecto.ts` lo usa para borrar un proyecto entero.
- **L1**: si `raiz` no aparece en el listado de su padre (padre ilegible, nombre 8.3, carpeta sensible a
  mayúsculas) se decide «no es enlace» y falla abierto. `borrarArbol("")` borraría el cwd: falta exigir una ruta
  absoluta bajo una base conocida.
- **L2**: carrera TOCTOU entre leer el `Dirent` y borrar por nombre. Hoy no cruza frontera gracias a I3.
- **L3**: el `Dirent` marca también carpetas de OneDrive y deduplicación; con `VIDEO_ROOT` en OneDrive el borrado
  falla tras ~3,3 s (falla cerrado, pero es una regresión). Sin verificar.
- **L4**: `Atomics.wait` reintenta EPERM/EACCES permanentes (~3,3 s por entrada, con el bucle del servidor MCP
  bloqueado); si lanza dentro de un `finally` tapa el resultado y en `vistaPrevia` se salta el segundo borrado.
- **L5** (`proceso.ts`): exigir letra de unidad no garantiza ruta local (unidad de red mapeada o `subst`).
- Fuera de alcance: `comprobarCarpeta` no detecta un padre enlazado aunque su comentario dice que sí.

## Fusiones

| # | Rama | Commit de fusión | Conflictos |
|---|---|---|---|
| 1 | `feat/t11-voz-recursos-render` (T0, T1, T4, T5, T8, T9, T10) | `a247a6d` | ninguno |
| – | Corrección de test (ver abajo) | `067141b` | – |
| 2 | `feat/t15-guiones-video` (T14) | `2b8aeb3` | ninguno |
| 3 | `feat/t18-panel-lateral` (T16) | `5a490b2` | ninguno |
| 4 | `feat/t19-timeline` | `6d9c7b2` | `docs/video-fase1/contrato-voz.md` |
| 5 | `feat/t20-render-exportar` | `05ac8dc` | `app-ui/docs/pantallas.md` |

No se fusionó `feat/t17-preview` (depende de T12) ni `feat/t16-editor-marco` aparte (ya llega con T18 y T19).

### Conflictos resueltos

- **`contrato-voz.md` (T19 contra T11, add/add)**: me quedo con la versión de T11. Es posterior y corrige lo que
  prometía la de T19: no devuelve `revision` al generar ni al quitar silencios, añade `sin_voz`, `voz_en_curso`,
  `render_en_curso`, `fallo_facturado`, `recurso_en_uso`, `error_motor`, y el apartado de cerrojos por proyecto.
  Con la de T19 el contrato contradiría al backend. No estaba en la lista de la §2.3 del handoff, que solo lo
  menciona en §6.
- **`pantallas.md` (T20 contra T19)**: conservo las adiciones de T19 (`voz-onda`, `voz-confirmar-*`,
  `subtitulo-*`, atajos de teclado) y sustituyo el resumen de una línea de «Render» por la descripción completa de
  T20, que incluye los mismos `data-testid` (`render-dialogo`, `-bloqueo`, `-lanzar`, `-progreso`, `-resultado`,
  `-avisos`, `-exportar`, `-error`) con su semántica. Contrato intacto.
- `client.ts`/`types.ts`: fusionaron sin conflicto y queda **una sola** definición de `ApiError.codigo`.

## Fallo encontrado y corregido

`tests/test_video_t11.py::test_motor_muere_en_render` fallaba en esta máquina (`assert 0 == 2`, reproducido aislado).
Es un test pensado para Linux que enumera procesos por `/proc`; su `skipif` es `not Path("/proc").is_dir()`. En esta
máquina existe `C:\proc\self\fd` (creada el 2026-07-07, ajena al repo), así que Python en Windows resuelve
`/proc` a `C:\proc`, no se salta y no encuentra procesos. Corrección en `067141b`: el `skipif` añade
`sys.platform == "win32"`. No toca código de producto. En Windows lo cubre el `test_real_*`, que sigue saltado hasta
T6. Aviso: `app_backend/video.py` y `tests/motor_falso.py` también leen `/proc`; en Windows no sirve (R0-6, T6).

## Baterías

Tras T11 y T15: baterías completas. Tras T18 y T19, solo `app-ui`, porque esas ramas solo tocan `app-ui/` y `docs/`
(comprobado con `git diff --name-only`), así que motor y backend no pueden cambiar. Tras T20, completa.

| Punto | `app-ui` (typecheck, lint, test, build) | motor `npm test` / `tsc` | backend `pytest -q` | R1 `test_video_rest.py` |
|---|---|---|---|---|
| T11 | verde | 1023 pasan, 67 saltados / verde | 1 fallo de entorno (arriba), corregido; luego verde | 64 pasan, 4 saltados |
| T15 | verde | igual / verde | 591 pasan, 13 saltados | verde |
| T18 | verde | no aplica | no aplica | no aplica |
| T19 | verde | no aplica | no aplica | no aplica |
| T20 | verde | 1023 pasan / verde | 591 pasan, 13 saltados | 64 pasan, 4 saltados |

`proceso-barrido > Review Focus 2` no falló en ninguna ejecución. No se ejecutó `render:sandbox` ni nada fuera de loopback.

## Pendiente

- T17 (necesita T12: `frame-src` exacto en `tauri.conf.json`), T12/T13, T2/T3/T6/T7, T21.
- `TODO(T17)` en T18: llamar a `recargarPreview()` tras guardar un perfil.
- M1 y las Low de `borrarArbol`.
- E2E de Playwright de las tareas de UI (no se han ejecutado aquí) y captura `ajustes-video` de `visual.spec.ts`.
- Si hay que quitar `C:\proc`: es una carpeta vacía ajena al repo; no la he tocado.
