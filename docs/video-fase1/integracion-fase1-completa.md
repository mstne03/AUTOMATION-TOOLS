# Integración completa de la fase 1 de vídeo (SEO-107)

Rama `feat/video-fase1-integrada`, creada desde `origin/feat/7-recursos` (27b4d91, CI en verde).
Fecha: 2026-11-11.

## Ramas fusionadas (en orden, `--no-ff`)

| Rama | Punta | Estado antes de fusionar | Resultado |
|---|---|---|---|
| `feat/t0-enmiendas-spec` | 624a4b6 | Solo dos documentos (`HANDOFF-local-fase1.md`, `RESUMEN-sesion-nube.md`); el código de T0 ya entró con T11 | Fusionada, sin conflictos |
| `chore/ci-trivy` | 12ffd1b | Job `trivy` con binario verificado; `.trivyignore` sin excepciones activas (zip 9.0.5 ya corrige los dos CVE) | Fusionada, sin conflictos |
| `fix/updater-zip` | 12ffd1b | Misma punta que `chore/ci-trivy` (updater 2.14.1 + zip 9.0.5) | *Already up to date*: no aporta nada aparte |
| `feat/12-csp-preview` | 49023ab | `seguridad-T12.md`: 0 Critical, 0 High. Abiertos: 1 Medium, 1 Low (abajo) | Fusionada, sin conflictos |
| `feat/t17-preview` | 1b62c5a | `seguridad-T17.md`/`pendientes-T17.md`: 0 Critical, 0 High; los 5 Low cerrados; Medium 1 = condición de integración con T12 | Fusionada, sin conflictos |
| `feat/13-importar-exportar` | 9ba9cc3 | `seguridad-T13.md`: 0 Critical, 0 High. Abiertos: 1 Medium, 2 Low (abajo). Ya traía T12 y T17 fusionadas | Fusionada, sin conflictos |

No hubo ningún conflicto. Ninguna rama tenía Critical/High abiertos ni estaba a medias.

**Condición T12 ↔ T17 (Medium 1 de T17), cumplida:** `csp` y `devCsp` de `tauri.conf.json` fijan
`frame-src` a `http://127.0.0.1:47810 … 47813`, y `app-backend/tests/test_preview.py`
(`test_frame_src_sin_comodin`, `test_puertos_coinciden_con_frame_src`) falla si aparece un comodín.

**`TODO(T17)` de T18:** ya resuelto en `feat/13-importar-exportar` (9ba9cc3): `PanelPerfil.tsx:114` llama a
`recargarPreview()` tras cada guardado correcto, con su test en `preview.test.tsx`. No queda ningún
`TODO(T17)` en el código.

## Resultados de los tests (rama integrada, máquina de Marc)

| Suite | Resultado |
|---|---|
| `video-mcp-server`: `npm test` | 56 ficheros / 1150 tests OK, 69 omitidos (los de render real, excluidos por diseño) |
| `app-backend`: `uv run --extra dev pytest -q` | 625 OK, 10 omitidos (20 min) |
| `app-ui`: `pnpm test` | 30 ficheros / 386 tests OK |
| `app-ui/src-tauri`: `cargo test --locked` | 14/14 OK (con los marcadores de `binaries/` y `dist/` que crea el job de CI; sin ellos `build.rs` falla por el sidecar ausente, como se espera) |
| `app-ui`: `pnpm e2e` | **151 OK, 53 fallan** (detalle abajo) |

Dependencias: `pnpm install --frozen-lockfile` (app-ui) y `npm ci` (video-mcp-server), ambos sin errores.
`npm ci` avisa de que no ejecutó el `postinstall` de `esbuild` (política de scripts de npm); no afectó a
los tests.

### Los 53 E2E que fallan: previos a esta integración

Ninguna rama fusionada toca `app-backend/app_backend`, `video-mcp-server/src`, los helpers de `app-ui/e2e`
ni pantallas fuera de `src/video` (comprobado con `git diff origin/feat/7-recursos HEAD`). CI no ejecuta
E2E, así que la base no tenía este dato.

1. **29 specs de vídeo** (`video-editor`, `video-guion`, `video-render` y los 9 nuevos de
   `video-preview`, de T17): todos caen en el `beforeEach`, en `limpiarVideo()` (`e2e/video-comun.ts:45`),
   con `TypeError: … is not iterable`. **Causa raíz, error de contrato real:** el motor devuelve
   `datos: { proyectos }` y `datos: { guiones }` (`herramientas-proyecto.ts:35` y `:55`), y
   `video_rest.py` reenvía ese objeto tal cual (`listar_proyectos` hace `return datos` en vez de la lista
   que ya extrae; `listar_guiones` no desenvuelve). La UI (`client.videoProyectos(): ProyectoVideoResumen[]`)
   y `test_video_rest.py` esperan una lista, pero los tests del backend usan un motor falso que ya
   devuelve lista, por eso pytest pasa. **Con `VIDEO_ENGINE=1` y el motor real, la lista de proyectos de
   la UI también se rompería.** Se ha dejado sin corregir aquí (fuera del encargo de integración); es el
   primer arreglo antes de T21.
2. **23 capturas de `visual.spec.ts`** (chat, publicar, guiones, canal, kb, ajustes, ajustes-video,
   catalogo; claro y oscuro; ~1 % de píxeles distintos). Afectan a pantallas que esta integración no toca:
   o las capturas de referencia son de otra máquina/versión de Chromium, o hay una regresión anterior.
   Sin diagnosticar.
3. **`ajustes.spec.ts:80`** (clave): tras «Borrar clave» el estado sigue mostrando la clave guardada
   en `FileSecretStore`. Tampoco lo toca ninguna rama fusionada. Sin diagnosticar.

Consecuencia: **los E2E de T17 (`video-preview.spec.ts`) no se han podido verificar de punta a punta**;
solo los tests unitarios de la preview pasan.

## Hallazgos abiertos heredados (ninguno bloquea la integración)

- T12 Medium: `disable_non_proxied_udp` no cierra WebRTC del todo (solo evita la fuga de IP local).
  Decidir el riesgo residual o cerrarlo con `--disable-features=WebRtc…`.
- T12 Low: posible carrera del mutex de instancia única con el relanzamiento del updater. Prueba manual.
- T13 Medium M1: se rechaza cualquier `REPARSE_POINT` (también ficheros de OneDrive). Falla cerrado;
  confirmarlo en la máquina de Marc con OneDrive.
- T13 Low L2: MP4 truncado con el nombre final si el proceso muere exportando (`.parcial` + renombrar).
- T13 Low L3: `blocking_*` en comandos `async` y sin cerrojo de un diálogo a la vez.
- T17 Info 7–9: tests de `postMessage` poco estrictos, falta de tiempo de espera para `listo`,
  `mensaje_hostil_ignorado` admite mensajes ajenos.
- Manual de Marc (T12): WebRTC en WebView2 y la sonda de red con la app real.

## Lo que queda para T21

1. **Arreglar el contrato de listados** (`GET /video/proyectos` y `GET /video/guiones` devuelven lista) y
   un test REST contra la forma real del motor; volver a ejecutar `pnpm e2e` y confirmar los 29 de vídeo.
2. Diagnosticar las 23 capturas y el E2E de la clave (¿regenerar referencias o regresión?).
3. Las pruebas de aceptación del plan (Task 21): `fidelidad-preview`, `aceptacion`, `rendimiento-180s`,
   `render:aceptacion`, `render:mock`, `render:sandbox`, `smoke_test.py`, capturas `video` y
   `video-editor`, y repetir la tabla de pruebas negativas y la R2 de punta a punta.
4. W3.2 (ffmpeg LGPL en el bundle) y W3.5 (borrado del spike).
5. Pruebas manuales de Marc: M2 (WebGPU en WebView2), equipo sin GPU, WebRTC y OneDrive; después el
   piloto con `VIDEO_ENGINE=1`.
6. No se ha abierto PR ni fusionado a `ds/v1`/`main`: pendiente del sí de Marc.
