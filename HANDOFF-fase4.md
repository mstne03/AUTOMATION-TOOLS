# Handoff: Fase 4 del producto `.exe` (empaquetado y distribución)

Pega este documento entero como primer mensaje de una sesión nueva abierta en
`C:\Users\Marc\Documents\PROJECTS\AUTOMATION TOOLS` (monorepo git, rama `main`).

---

## Contexto en tres líneas

`kb-seo` + `youtube-mcp-server` → producto gratuito para Windows. **Fases 0-3 hechas y
mergeadas en `main` (2026-10-11):** `app-backend/` (sidecar FastAPI con agente, gate de
aprobación, jobs, secretos en Credential Manager, KB en SQLite firmado) y `app-ui/` (Tauri 2 +
React, seis pantallas, 20 E2E). Esta fase convierte eso en un instalador `.exe` con updater.
Informe: `INFORME-producto-exe-2026-10-10.md` (secciones 2.1, 2.2, 6 "Fase 4" y 7; léelo
entero). READMEs: `app-backend/README.md`, `app-ui/README.md`, `kb-seo/README.md`.

## Decisiones ya tomadas (no reabrir)

- Sidecar: **PyInstaller `--onedir`** del paquete `app-backend` (con `youtube_mcp` y `kb_seo`
  dentro). Tauri lo arrastra como **`externalBin`** y lo lanza con
  `app.shell().sidecar("app-backend")`. Instalador **NSIS** (`-setup.exe`),
  **`tauri-plugin-updater`** con firma minisign propia de Tauri, pipeline en **GitHub Actions**
  (`windows-latest`). Solo Windows x64.
- El contrato Tauri ↔ sidecar no cambia: primera línea de stdout `{"port": N, "token": "..."}`,
  `APP_BACKEND_TOKEN` por entorno, loopback, `Authorization: Bearer`. CORS ya admite
  `http://tauri.localhost` y `https://tauri.localhost` (producción) y `http://localhost:1420` (dev).
- La KB pública llega como snapshot SQLite firmado desde el VPS (`POST /kb/update` ya existe);
  el instalador **no** incluye Postgres ni Ollama. El modelo de embeddings
  `intfloat/multilingual-e5-small` (fastembed/ONNX) **debe ir dentro del bundle**: hoy se
  descarga de Hugging Face al primer uso.
- Whisper (`faster-whisper`/`ctranslate2`) y su modelo se descargan en el primer uso, no van en
  el instalador (informe, sección 7). ONNX Runtime solo CPU.
- Modo didáctico en empaquetado/CI/firma; frontend a ritmo normal. Español con acentos.
  "ejecución", nunca "corrida". Sin co-autoría de agente en commits.

## Estado real de `app-ui/` que esta fase toca

- `app-ui/src-tauri/src/lib.rs`: en desarrollo lanza `uv run app-backend` con
  `cwd = CARGO_MANIFEST_DIR/../../app-backend` (comentario `ponytail:` marca el sitio). Lee la
  primera línea de stdout, guarda `{port, token}` en memoria, comando async `sidecar_info`
  (espera hasta 60 s), `CommandChild::kill()` en `RunEvent::Exit`.
  **Huérfano conocido:** un cierre forzoso de la app (crash, `taskkill /F`) no pasa por
  `RunEvent::Exit` y el sidecar sigue vivo. Hay que atar el hijo a un **Job Object** con
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (crate `windows` o `win32job`). En dev, `uv` ya mete
  a su hijo Python en un Job propio (matar `uv.exe` mata `python.exe`, verificado); con el
  binario de PyInstaller eso desaparece.
- `app-ui/src-tauri/tauri.conf.json`: `bundle.targets: "all"` (cambiar a `["nsis"]`), CSP
  restrictiva ya puesta, ventana 1200×800 mín. 900×600, identificador `com.seostudio.app`.
  `capabilities/default.json` solo `core:default` (el WebView no puede lanzar procesos; el
  sidecar lo lanza Rust). No añadir `shell:allow-execute` ni similares.
- `app-ui/src/sidecar.ts`: dentro de Tauri usa `invoke("sidecar_info")`; fuera, variables
  `VITE_SIDECAR_PORT/TOKEN` (solo dev/E2E).
- Dependencias Rust: `tauri`, `tauri-plugin-shell`, `rand`, `tokio`, `serde(_json)`. Falta
  añadir `tauri-plugin-updater` (y `tauri-plugin-process` para reiniciar tras actualizar).

## Alcance (informe, sección 6 "Fase 4")

1. **Spec de PyInstaller** en `app-backend/` (`app-backend.spec`, `--onedir`, consola oculta,
   nombre `app-backend`). Hidden imports y datos que seguro hacen falta: `fastembed` + su
   modelo ONNX custom (ver cómo lo registra `kb-seo` en `kb_seo/embeddings.py` o similar),
   `onnxruntime` (DLLs), `sqlite_vec` (extensión `.dll`), `keyring.backends.Windows`,
   `googleapiclient` (discovery docs de `youtube` v3 y `youtubeAnalytics` v2 como datos),
   `google_auth_oauthlib`, `httpx2`/`anthropic`, `sse_starlette`, `uvicorn` (loops/protocols
   se importan por string), `lxml`, `av`, `ctranslate2`/`faster_whisper`, `python-dotenv`
   (no debe cargar `.env` en producto: comprobar `config.py`). Playwright del extractor
   `browser` es solo del VPS: excluirlo. **Test de arranque del binario** (lanza, lee la
   línea JSON, `GET /settings` con el token, cierra) ejecutable en CI.
2. **`externalBin`** en `tauri.conf.json`: el binario debe llamarse
   `app-backend-x86_64-pc-windows-msvc.exe` dentro de `src-tauri/binaries/` (Tauri exige el
   sufijo de target triple), con la carpeta `--onedir` como `resources`. Cambiar `lib.rs`:
   `#[cfg(debug_assertions)]` → `uv run`; release → `app.shell().sidecar("app-backend")`
   con `current_dir` en el directorio de recursos. Job Object en ambos casos.
3. **Modelo de embeddings en el bundle** y `fastembed` apuntando a él sin red (`cache_dir`
   o `specific_model_path`); verificar que `POST /kb/buscar` funciona sin conexión.
4. **Updater**: `tauri signer generate` (clave privada FUERA del repo; la pública en
   `tauri.conf.json > plugins.updater.pubkey`), endpoint `latest.json` servido por el VPS
   (Nginx ya sirve `/kb/*`; añadir `/app/latest.json` y los artefactos) o por GitHub Releases.
   UI mínima: comprobar al arrancar, avisar, descargar e instalar con confirmación.
5. **Firma de código**: decidir entre sin firma (SmartScreen avisará; documentarlo para el
   usuario) o certificado. No comprar nada sin preguntar a Marc.
6. **GitHub Actions** (`.github/workflows/release.yml`): `windows-latest`, `uv sync` +
   PyInstaller, `pnpm install`, `pnpm tauri build`, test de arranque del sidecar, subir
   `-setup.exe` + firma + `latest.json`. Secretos: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`.
7. **Prueba de reinstalación sobre una versión anterior** (pitfall del informe 2.1: NSIS puede
   reutilizar un sidecar cacheado; limpiar `target/release` y comprobar hash del binario
   dentro del instalador en cada release).
8. Pasar la app OAuth de Google a **"En producción"** (hoy "Prueba": el `refresh_token` caduca
   a los 7 días) — lo hace Marc en la consola; recuérdaselo.
9. Actualizar `INFORME-...` (Fase 4 hecha + desviaciones), `app-ui/README.md`,
   `app-backend/README.md`, aprendizajes en
   `C:\Users\Marc\Desktop\VPS_HETZNER\aprendizajes-YYYY-MM-DD.md` (guion bajo) y la memoria
   `producto-exe-decisiones.md`.

## Orden sugerido y verificación

1. Spec de PyInstaller + test de arranque del binario en local. Commit.
2. `externalBin` + `lib.rs` release + Job Object. `pnpm tauri build` local → instalar el
   `-setup.exe` en esta máquina, abrir la app, repetir desde la UI el flujo de la Fase 1
   (rechazo, subida privada, borrado con ID) con las credenciales reales. Commit.
3. Modelo ONNX dentro + prueba sin red de `/kb/buscar`. Commit.
4. Updater + `latest.json` + reinstalación sobre la versión anterior. Commit.
5. GitHub Actions. Commit. Docs.

## Estado de la máquina (2026-10-11, tras la Fase 3)

- Rust 1.99 (`rustup` por winget; `cargo` en `%USERPROFILE%\.cargo\bin`, puede no estar en
  el PATH de shells ya abiertos), VS Build Tools 2022 con `VCTools` + Windows SDK 10.0.26100,
  WebView2 154, Node 22, pnpm 9, `uv` 0.13. Playwright con Chromium descargado.
- **`pnpm tauri dev` y `pnpm tauri build` solo desde Git Bash**: desde PowerShell la CLI de
  Tauri intenta "installing dependencies" con el shim `pnpm.ps1` y rompe `node_modules`
  (`ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`). Arreglo: `rm -rf node_modules && pnpm install`.
- Primera compilación Rust ~3,5 min; incrementales ~2 s. `target/` del worktree de la Fase 3
  puede borrarse (los worktrees `fase2-…` y `fase3-…` ya están mergeados; límpialos con
  `git worktree remove`).
- Credenciales: clave Anthropic en `app-backend/.env.local` (checkout principal; **el producto
  no debe leer `.env`**), OAuth y `client_secret` en el Credential Manager (servicio
  `youtube-mcp`, perfil `default`, canal Candisito), Postgres `kb_seo_db` en Docker ya migrado a
  384 dims (`kb-seo/.env` con `EMBED_BACKEND=fastembed`, `EMBED_MODEL=intfloat/multilingual-e5-small`).
  Vídeo de prueba `C:\Users\Marc\Videos\demo cs finance.mp4`, carpeta en `allowed_dirs`.
  Estado del producto en `%LOCALAPPDATA%\seo-studio` (`settings.json`, `jobs.sqlite`, `quota.json`).
- VPS: la Fase 2 dejó `~/kb-seo/` desplegado como `marc`; **pendiente** que Marc ejecute
  `deploy/install.sh` con sudo y `deploy/setup-user.sh` (issue 020 en VPS_HETZNER). Clave
  pública minisign del snapshot embebida en `app-backend` (`RWQuXbso1VRON6x1Ol6g6zSn7XH35VZZaRZh7yCYtsfhLwH5O8+IdTxe`).
- Suites: `app-backend` 34 tests (`uv run pytest -q`), `app-ui` 18 unitarios (`pnpm test`) y
  20 E2E (`pnpm e2e`; cierra antes cualquier `tauri dev`/`pnpm dev`: el setup aborta si el
  1420 está ocupado), `youtube-mcp-server` 163, `kb-seo` ~90.

## Hechos verificados que conviene no volver a investigar

- El WebView de Tauri es un origen distinto al sidecar: sin CORS, el preflight `OPTIONS`
  daba 405 y la UI veía "Failed to fetch" sin más pista. Ya resuelto en `main.py`
  (`CORS_ORIGINS`); si cambias el `identifier` o el esquema de Tauri, revisa esa lista.
- El sidecar hace `sock.listen(128)` **antes** de imprimir el puerto: sin eso, la primera
  conexión se rechazaba durante los segundos de arranque de uvicorn. Mantenlo en el binario.
- La API de Anthropic admite 20 tools `strict`; el SDK 1.x usa `httpx2`; el Credential
  Manager limita cada credencial a 2560 bytes UTF-16 (el almacén trocea).
- El SSE de `/chat` solo emite `job_started`/`job_finished`; la UI sondea `GET /jobs/{id}`.
- `EventSource` no admite `Authorization`: la UI usa `fetch` + parser SSE propio.
- WebView2 `0x800700AA` al arrancar = otra instancia de la app viva con el mismo directorio
  de datos; `tasklist | findstr app-ui`.
