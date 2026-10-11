# Handoff: Fase 3 del producto `.exe` (interfaz Tauri 2 + React/TypeScript)

Pega este documento entero como primer mensaje de una sesión nueva abierta en
`C:\Users\Marc\Documents\PROJECTS\AUTOMATION TOOLS` (monorepo git, rama `main`).

---

## Contexto en tres líneas

Convertimos `kb-seo` (base de conocimiento sobre SEO en redes) y `youtube-mcp-server`
(41 tools de YouTube) en un `.exe` gratuito para Windows. La **Fase 1 está hecha y
verificada E2E** (2026-10-11): `app-backend/` es un sidecar FastAPI con agente, gate de
aprobación, jobs y secretos en el Credential Manager. Esta fase construye la interfaz
que habla con ese sidecar. Informe completo: `INFORME-producto-exe-2026-10-10.md`
(secciones 2.1 y 6; léelo entero antes de tocar nada). La Fase 2 (KB como snapshot) va
en paralelo y **no bloquea** esta: la UI usa `/kb/*` igual con Postgres o con SQLite.

## Decisiones ya tomadas (no reabrir)

- Shell: **Tauri 2** (`tauri-plugin-shell` para el sidecar, `tauri-plugin-updater`).
  Electron es el plan B solo si Rust bloquea. UI: **React + TypeScript + Vite**,
  **TanStack Query** para las llamadas, SSE para el chat.
- El sidecar es `app-backend` empaquetado después con PyInstaller (Fase 4). En esta fase
  se arranca con `uv run app-backend` desde Tauri o a mano; el empaquetado no entra.
- Modo didáctico en IA/backend/seguridad; frontend a ritmo normal (Marc es sólido ahí).
- Español con acentos. "ejecución", nunca "corrida". Sin co-autoría de agente en commits.
- Tests E2E de UI **estrictos**: no hay Figma, así que antes de cada pantalla hay que
  fijar por escrito layout y estados, y exigirlos después.

## Contrato con el sidecar (ya implementado, no cambiar sin tocar `app-backend/`)

Arranque: `uv run app-backend` imprime en la **primera línea de stdout**
`{"port": N, "token": "..."}` y escucha solo en `127.0.0.1`. Toda petición lleva
`Authorization: Bearer <token>`. Variables: `APP_BACKEND_TOKEN` (fijo, opcional),
`APP_BACKEND_DIR` (estado; por defecto `%LOCALAPPDATA%\seo-studio`),
`APP_BACKEND_SECRETS` (`keyring` por defecto). `app-backend/README.md` tiene la tabla.

| Ruta | Uso en la UI |
|---|---|
| `POST /chat` `{message, conversation_id?}` | SSE. Eventos: `text{delta}`, `tool_use{id,name,input}`, `tool_result{tool_use_id,is_error,content}`, `approval_required{approval}`, `approval_resolved{approval}`, `job_started{job}`, `job_finished{job}`, `done{conversation_id,stop_reason,usage}`, `error{message}`. Una conversación admite un turno a la vez (409 si hay otro). Historial en memoria del proceso. |
| `POST /approvals/{id}` `{decision: approve\|reject, confirm_id?}` | Tarjeta inline en el chat. `approval` trae `tool`, `args`, `risk` (`write`/`destructive`), `quota{bucket,cost}` y `requires_confirm_id`; las destructivas exigen escribir el `video_id`. |
| `GET/POST /jobs`, `GET /jobs/{id}` | `{kind: upload\|transcribe, args}`; `status` queued/running/done/failed, `progress` 0–1, `result`, `error`. Un job cada vez. |
| `GET /kb/estado`, `/kb/fuentes?plataforma=`, `/kb/buscar?q=&plataforma=&k=` | Devuelven `{texto}` ya formateado (no JSON estructurado). |
| `GET /youtube/status` | `{auth{profile,profiles,authenticated,store,...}, quota{buckets{general,search,video_insert}{used,limit}}}`. |
| `POST /youtube/auth` `{profile?, reauthorize?}` | Única ruta que abre el navegador (flujo OAuth de Google). |
| `GET /youtube/tools` | Lista `{name, risk, quota, job_kind}` para mostrar riesgos. |
| `GET/PUT /settings` | `model` (`claude-opus-5-5`/`claude-sonnet-5-5`), `allowed_dirs` `[{path,language}]`, `profile`, `anthropic_api_key` (solo escritura; GET da `has_anthropic_key`), `has_client_secret`, `secret_store`, `state_dir`. |
| `POST /settings/client-secret` `{path}` o `{json_text}` | Importa el `client_secret.json` al Credential Manager. |

Comportamientos observados en los E2E que la UI debe reflejar:
- El modelo puede pasar `file_path` sin extensión ("demo cs finance"); la lista blanca lo
  resuelve a `.mp4`. La tarjeta de aprobación debe mostrar la **ruta real resuelta**
  (viene en el `tool_result`/`job.result.file`), no solo lo que escribió el modelo.
- Distinguir visualmente datos de inferencias del modelo en los análisis.
- El rechazo de una propuesta llega al modelo como resultado normal; la UI no debe
  tratarlo como error.
- `usage.cache_read_input_tokens` (≈13.861 por turno) sirve para un indicador de coste.

## Alcance (informe, sección 2.1)

1. **Proyecto Tauri 2** en `app-ui/` (subdirectorio del monorepo). Rust mínimo: lanzar
   el sidecar con `APP_BACKEND_TOKEN` generado por Tauri, leer la primera línea de stdout,
   exponer `{port, token}` a la UI por un comando, cerrar el sidecar al salir. En
   desarrollo el sidecar es `uv run app-backend` con `cwd=app-backend/`.
2. **Seis pantallas**, cada una con layout y estados escritos antes de codificar:
   onboarding (clave, asistente de Google Cloud con validador por paso, OAuth, estado de
   la KB), chat con tarjetas de aprobación inline, publicar vídeo (selector dentro de
   `allowed_dirs`, transcripción como job, borrador editable, progreso de subida), panel
   de canal, base de conocimiento, ajustes (modelo, cuota, carpetas, perfil).
3. **Cliente HTTP tipado** del contrato anterior (un módulo, sin generadores) y hook de
   SSE que reconstruye el turno a partir de los eventos.
4. **Seguridad**: el token nunca se escribe en disco ni en logs; la UI no puede llamar a
   nada fuera de `127.0.0.1:<port>`; CSP de Tauri restrictiva; la clave de Anthropic se
   envía una vez y no se vuelve a mostrar.
5. **Tests**: unitarios del hook SSE y del cliente con respuestas grabadas de los E2E
   reales; E2E de UI estrictos por pantalla (Playwright o WebdriverIO con Tauri) contra el
   sidecar real con `APP_BACKEND_SECRETS=file` y un directorio temporal.

## Orden sugerido y verificación

1. Tauri + Vite vacío que arranca el sidecar y muestra `GET /settings`. Commit.
2. Cliente tipado + hook SSE con tests. Commit.
3. Chat con aprobaciones (es la pantalla que valida el contrato entero). E2E real: el
   flujo de publicación de la Fase 1 (rechazo, aprobación, borrado con ID).
4. Resto de pantallas en el orden: ajustes, onboarding, publicar, canal, KB.
5. Actualizar `INFORME-...`, `app-ui/README.md`, aprendizajes en
   `C:\Users\Marc\Desktop\VPS_HETZNER\aprendizajes-YYYY-MM-DD.md` (guion bajo) y la
   memoria `producto-exe-decisiones.md`.

## Estado de la máquina (2026-10-11)

- `uv` instalado por winget (en shells viejos: `%LOCALAPPDATA%\Microsoft\WinGet\Packages\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\uv.exe`).
  Los tres paquetes Python tienen venv sincronizado en el checkout principal.
- Credenciales ya configuradas: clave de Anthropic en `app-backend/.env.local`
  (`ANTHROPIC_API_KEY`, ignorado por git), OAuth de Google y `client_secret` en el
  Credential Manager (servicio `youtube-mcp`, perfil `default`, canal Candisito), Postgres
  `kb_seo_db` en Docker (`kb-seo/.env`), `bge-m3` en Ollama. Vídeo de prueba:
  `C:\Users\Marc\Videos\demo cs finance.mp4`, carpeta ya en `allowed_dirs`.
- La app OAuth de Google está en modo "Prueba": el `refresh_token` caduca a los 7 días
  (`POST /youtube/auth {"reauthorize": true}` lo renueva). Pasarla a "En producción".
- Suites: `app-backend` 23 tests, `youtube-mcp-server` 163, `kb-seo` 80 (el de latencia
  < 1 s falla en frío la primera vez).
- Hay que comprobar si Rust/cargo y Node están instalados; no se ha verificado.

## Hechos verificados que conviene no volver a investigar

- La API de Anthropic admite **20 tools con `strict: true`** como máximo; ya está
  resuelto en `app-backend/registry.py` (solo write/destructive).
- El SDK `anthropic` 1.x usa `httpx2`, no `httpx` (afecta a tests con transporte simulado).
- `httpx.ASGITransport` no ejecuta el lifespan ni hace streaming real.
- El Credential Manager limita cada credencial a 2560 bytes UTF-16; el almacén trocea.
- Cuota real: análisis de canal completo = 4 unidades; subida = 1 llamada de
  `video_insert` (100/día); borrado = 50; Analytics API no consume cuota de Data API.
