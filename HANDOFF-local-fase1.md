# Handoff · De la sesión en la nube a la sesión local: Trivy y fase 1 del módulo Vídeo

> Para la sesión local de Claude Code en la máquina de Marc (Windows, GPU, Chrome for Testing y
> referencias SSIM). Lo escribió la sesión en la nube el 2026-11-07. Léelo entero antes de empezar. Valen
> las normas de `CLAUDE.md` y de §1 de `HANDOFF-nube-trivy-fase1.md`; este fichero solo añade el estado y
> lo que falta. El detalle de cada tarea está en `docs/video-fase1/` de su rama: `seguridad-Tn.md` y
> `pendientes-Tn.md`. El resumen está en `docs/video-fase1/RESUMEN-sesion-nube.md` (en esta rama).

## 0. Antes de nada

- `git fetch origin` y `chmod +x .githooks/*`. En la nube los hooks no eran ejecutables: se lanzaron a mano
  y git los ignoró al hacer commit. Comprueba `git config core.hooksPath` (debe ser `.githooks`).
- **Nada está fusionado ni tiene PR**, salvo la #22 (`feat/video-fase1` → `ds/v1`), que sigue abierta.
  PR, fusión o push a `ds/v1`/`main`: solo con el sí de Marc.
- Todas las ramas tienen la CI en verde en su último commit (lanzada con `workflow_dispatch`). La CI no se
  dispara sola en `feat/…` ni `chore/…`: lánzala a mano o abre la PR.
- En ninguna rama quedan Critical ni High abiertos. Cada paquete pasó una revisión de seguridad con Opus y
  una re-revisión acotada a su corrección.
- `node_modules`, `.venv` y `dist/` no viajan. Hay que reinstalar: `npm ci` en `video-mcp-server`,
  `uv sync --extra dev` en `app-backend` y `pnpm install` en `app-ui` (desde Git Bash).

## 1. Tarea A · Trivy en la CI (`chore/ci-trivy`, `12ffd1b`)

- Job `trivy`: binario v0.76.1, de una release inmutable. SHA-256 fijado y atestación verificada con
  `gh release verify-asset`. No se usa ninguna action de Trivy, por el compromiso de marzo de 2026
  (GHSA-69fq-xp46-6x23).
- Incluye `tauri-plugin-updater` 2.14.1 con `zip` 9.0.5, incorporado desde `fix/updater-zip` por
  fast-forward. La #25 está cerrada sin fusionar. El `.trivyignore` queda vacío.
- **Antes de fusionar, paso manual de Marc:** probar una actualización real con la app instalada. Instalar
  la versión N, publicar una N+1 firmada y comprobar que se detecta, se instala el `-setup.exe` y la app
  reinicia en N+1.
- Orden: primero la #22, después la PR de `chore/ci-trivy` (aún sin abrir). Revisa `higiene-pr` en esa PR.
- `fix/updater-zip` ya no hace falta: se puede borrar.

## 2. Ramas de la fase 1 y cómo encajan

| Tarea | Rama | Cabeza | Contiene |
|---|---|---|---|
| T0 Enmiendas de la spec y R0 | `feat/t0-enmiendas-spec` | `e59efd6` | — |
| T1 Esquema | `feat/t1-esquema-guion` | `bf37c9f` | T0 |
| T4 Almacén | `feat/t4-almacen` | `5da0045` | T1 |
| T5 Voz por frases | `feat/t5-voz-frases` | `736d602` | T4 |
| T8 Perfiles + voz por perfil | `feat/t8-perfiles` | `a551d15` | T5 |
| T9 REST del guion | `feat/t9-rest-guion` | `d8de2d4` | T4 |
| T10 Preview (backend) | `feat/t10-preview` | `7801727` | T9 |
| T11 Voz, recursos y render REST | `feat/t11-voz-recursos-render` | `2686ee9` | T10 + T8 → **todo el motor y el backend** |
| T14 Contrato de UI | `feat/t14-contrato-ui` | `0b173cd` | T1 |
| T15 Guiones en modo Vídeo | `feat/t15-guiones-video` | `8ac54b5` | T14 |
| T16 Marco del editor | `feat/t16-editor-marco` | `508e865` | T14 |
| T17 Preview (UI) | `feat/t17-preview` | `1b62c5a` | T16 |
| T18 Panel lateral | `feat/t18-panel-lateral` | `61d2d9b` | T16 |
| T19 Timeline | `feat/t19-timeline` | `bba4338` | T16 |
| T20 Render, exportar y clave | `feat/t20-render-exportar` | `3f1efcb` | T14 |

**Integración propuesta** (en una rama nueva `feat/video-fase1-integracion` desde `feat/video-fase1`):
1. Fusionar `feat/t11-voz-recursos-render`, que arrastra T0, T1, T4, T5, T8, T9 y T10.
2. Fusionar `feat/t15`, `t18`, `t19` y `t20`. T17 se fusiona al final; ver §3.
3. Conflictos esperables en ficheros compartidos:
   - `app-ui/docs/pantallas.md`;
   - `app-ui/src/api/client.ts` y `types.ts`: T19 y T20 añaden los dos `ApiError.codigo`; quédate con
     una sola definición;
   - `app-ui/src/state/jobs.ts` y `shell/Sidebar.tsx` (T20);
   - `app-ui/src/state/editor.ts` (T14/T16/T18);
   - las listas de tools esperadas en `video-mcp-server/test/stdio.test.ts` y
     `app-backend/tests/test_video.py`.

   Tras cada fusión, `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, `npm test` y `pytest`.
4. T18 tiene un `TODO(T17)`: llamar a `recargarPreview()` de `src/video/previewRecarga.ts` (T17) tras
   guardar un perfil.

## 3. Condiciones de integración (no te las saltes)

- **T17 no se integra sin T12.** `tauri.conf.json` aún tiene `frame-src http://127.0.0.1:*` en `devCsp`,
  y `csp` no tiene `frame-src`. T12 debe fijarlos exactamente a `http://127.0.0.1:47810` … `47813`
  (M-D1, I8). Al hacerlo, quita el `skip` de `puertos_coinciden_con_frame_src` (T10).
- **La R1 de T1+T9 se cierra con T3.** Hace falta:
  - el test de XSS con un POST real: ningún fichero de `_composicion/**` contiene el texto del atacante
    sin escapar y `urlsDeRed` queda vacío;
  - que T3 consuma solo el `Proyecto` ya validado;
  - repetir la R1 sobre T1 + T3 + T9.

  Detalle en `docs/video-fase1/R1-T1-T9.md` (rama T9).
- **R0-6, barrido de procesos, es de T6.** El motor debe barrer al arrancar y tras una cancelación;
  `src/proceso.ts` hoy solo barre tras un timeout o un error de la CLI (test `barrido_al_arrancar`). El
  backend (T11) registra PID con `/proc`, **que en Windows no sirve**, y pide `video_barrer_procesos` si
  existe. Esa tool está por crear en T6.
- **R0-1, puerto CDP:** Chrome va por pipe, verificado. En T6, endurece el parche para que rechace
  `--remote-debugging-port`/`--remote-debugging-address` y añade el test `render_sin_puerto_cdp`.
- **T12, instancia única:** M-D4 está aplazado. Si Marc no autoriza `tauri-plugin-single-instance`, usa
  `CreateMutexW` con `Local\SEOStudio-<identifier>` antes de lanzar el sidecar (R0-5). Sin esto,
  `VIDEO_ENGINE=1` no se activa.

## 4. Tareas de la fase 1 que quedan (todas locales)

- **T2, T3, T6 y T7:** ffmpeg real, composición de N escenas, montaje y recursos y capas. Supuestos que
  validar:
  - T10 espera que `video_montar_preview {id, webgpu}` devuelva `{carpeta: "r<n>", duracion, avisos}` y
    lee `creado` de `video_proyecto_leer`;
  - T11 da 501 `no_disponible` en recursos y música hasta que T7 cree las tools;
  - `video_renderizar` aún no acepta `modo` (T6).
- **T12 y T13:** Rust y Tauri. T13 debe validar el `id` en `exportar_mp4`, que hoy devuelve `Option<()>`,
  igual al cancelar que al guardar.
- **T21:** aceptación con la app instalada. Comprueba que el backend congelado no pasa
  `VIDEO_PRUEBAS_TTS_URL`, que la voz sale del perfil y la ruta del runtime de la preview en el instalador.

## 5. Validar en Windows lo que la nube no pudo

- Los E2E de Playwright de todas las tareas de UI. Se escribieron y compilan, pero no se ejecutaron. Los
  que dependen de una tarea posterior van en `test.fixme`. Falta `regenerar_una_frase` (T19, carril U2).
- Regenerar la captura `ajustes-video` de `visual.spec.ts` (T20).
- El TIME_WAIT de `SO_EXCLUSIVEADDRUSE` al reabrir la app (`TODO(Windows)` en `reservar_puertos`, T10).
- Los tests de voz con ffmpeg real: ya pasan en la CI de Windows, pero conviene repetirlos tras integrar.
- La CI no compila `video-mcp-server/dist` en el job `python`, así que los `test_real_*` del backend se
  saltan allí. En local: `npx tsc -p tsconfig.json` y `VIDEO_ENGINE_R1=1 uv run pytest tests/test_video_rest.py`.
  Conviene añadir el build al job.

## 6. Decisiones tomadas en la nube que Marc puede revisar

- Contrato de voz (`docs/video-fase1/contrato-voz.md`, en T11 y T19): se confirma el **plan** del motor,
  no una cifra; el refacturado exige una casilla explícita; los errores llevan `{mensaje, codigo}`.
- `PUT /settings` con una clave nueva durante una voz o un render da 409 `generacion_en_curso`, en vez de
  aplazar el cambio.
- Al añadir o borrar un recurso se vacía el historial de deshacer (T18).
- El perfil `defecto` usa la voz `21m00Tcm4TlvDq8ikWAM` (T8).
- «Escuchar» la muestra de voz está deshabilitado hasta que la respuesta de la muestra traiga audio
  reproducible (T18).
- El esquema rechaza las banderas de Inglaterra y Escocia, porque usan caracteres de etiqueta (T1).

## 7. Plane

No había conector en la nube. Tareas en Plane:
- crear las subtareas de SEO-107 para T0–T21;
- pasar los Low de cada `pendientes-Tn.md` y los R0-9…R0-12 del plan.

Los commits de la nube no llevan `(SEO-xx)`.
