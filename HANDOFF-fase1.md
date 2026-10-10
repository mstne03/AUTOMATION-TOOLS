# Handoff: Fase 1 del producto `.exe` (backend local unificado)

Pega este documento entero como primer mensaje de la nueva sesión, abierta en
`C:\Users\Marc\Documents\PROJECTS\AUTOMATION TOOLS`, que desde el 2026-10-11 es un **monorepo git**
(rama `main`) con `kb-seo/` y `youtube-mcp-server/` como subdirectorios y todo su historial.

---

## Contexto en tres líneas

Estamos convirtiendo dos repos (`kb-seo`, base de conocimiento vectorizada sobre SEO en
redes sociales; `youtube-mcp-server`, 41 tools sobre las APIs de YouTube) en un producto
gratuito distribuible como `.exe` en Windows. El informe completo con arquitectura,
decisiones y costes está en `INFORME-producto-exe-2026-10-10.md` (léelo entero antes de
tocar nada; secciones 2.2, 2.5 y 6 son las de esta fase). La Fase 0 (saneamiento de los
dos repos) está hecha y commiteada el 2026-10-10.

## Decisiones ya tomadas (no reabrir)

- LLM del agente: API de Claude con clave del usuario (BYOK). `claude-opus-5-5` por
  defecto, `claude-sonnet-5-5` seleccionable. Ollama solo para tareas sin tools.
- Cada usuario aporta su propio proyecto de Google Cloud (`client_secret.json`).
- KB pública: ingesta en el VPS Hetzner, distribuida como snapshot SQLite + `sqlite-vec`
  firmado. **Eso es Fase 2, no esta.** En Fase 1 la KB sigue siendo Postgres local.
- Shell: Tauri 2 + React/TS (Fase 3). Backend: sidecar Python con FastAPI (esta fase).
- Prioridades: robustez > mantenibilidad > escalabilidad > simplicidad. Seguridad siempre.
- Modo didáctico en IA/backend/seguridad: explicar conceptos antes de decidir.
- Español con acentos. "ejecución", nunca "corrida". Sin co-autoría de agente en commits.

## Estado de los repos tras la Fase 0

Ambos usan `uv` (instalado por winget; en shells abiertos antes del 2026-10-10 no está en
PATH: ruta `%LOCALAPPDATA%\Microsoft\WinGet\Packages\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\uv.exe`),
`.python-version` = 3.12, `uv sync --extra dev`, `uv run pytest -q`.

**`youtube-mcp-server/`** (153 tests):
- `mcp` acotado a `<2`; usa `FastMCP` de 1.x. `kb-seo` ya usa `MCPServer` de 2.x.
  **Unificar en 2.x es parte de esta fase.**
- `src/youtube_mcp/auth.py`: `YouTubeAuth(profile=...)`, `authenticate(interactive=False,
  force_consent=False)`; solo la tool `youtube_auth` puede abrir el navegador. Token en
  JSON en claro (`token-<perfil>.json`): **pasar a `keyring` es tarea de esta fase.**
- `src/youtube_mcp/utils/quota.py`: tres cubos (`general` 10.000 unidades, `search` 100
  llamadas, `video_insert` 100 llamadas), persistido en `quota.json`, medianoche Pacífico.
- `src/youtube_mcp/utils/paths.py`: lista blanca `YOUTUBE_MCP_ALLOWED_DIRS` (`ruta[=idioma];...`)
  usada por subida, miniatura y `transcribe_local`.
- `tools/publishing.py`: subida reanudable con reintentos; `publish_at` validado;
  `youtube_delete_video(confirm=True)` como gate mínimo.
- Las tools son funciones Python normales con `@mcp.tool()`; importan `auth, mcp, quota`
  desde `youtube_mcp.server` (estado global, hay que romper esa dependencia al reutilizarlas).
- `PENDIENTE.md` sección 0 resume la Fase 0.

**`kb-seo/`** (54 tests + 26 que se saltan sin Postgres/`bge-m3`):
- `mcp_server/server.py`: tres tools (`buscar_kb`, `listar_fuentes`, `estado_kb`) con
  helper `_error()` que no filtra DSN. `kb/search.py::search()` es la búsqueda híbrida.
- `kb/db.py` con `connect_timeout=5`. Rol `kb_reader` solo SELECT.
- `sources.yaml` con rutas relativas; `cli.resolve_location`.
- En esta máquina: Docker con Postgres **no está levantado** y Ollama **no tiene `bge-m3`**
  (`ollama pull bge-m3` + `docker compose up -d` para los tests de integración).

## Alcance de la Fase 1 (del informe, sección 6)

Paquete nuevo `app-backend/` (subdirectorio del monorepo, con su propio `pyproject` y `uv`)
que importa `youtube_mcp` y `kb` como dependencias locales (`[tool.uv.sources]` con
`path = "../youtube-mcp-server"` y `path = "../kb-seo"`). Commits en la raíz del monorepo.

1. **FastAPI en `127.0.0.1`, puerto aleatorio, token por arranque** en cabecera
   `Authorization` (lo generará Tauri en Fase 3; ahora lo imprime el proceso al arrancar).
   Endpoints: `POST /chat` (SSE), `GET/POST /jobs`, `GET /kb/*`, `GET /youtube/*`,
   `GET/PUT /settings`, `POST /approvals/{id}`.
2. **Registro de tools**: envuelve cada función de ambos repos con nombre, esquema JSON,
   `risk: read | write | destructive` y cubo de cuota. Las fachadas MCP por stdio se
   conservan como interfaz opcional, pero el agente llama a las funciones en proceso.
3. **Bucle del agente con el Tool Runner del SDK de Anthropic**
   (`client.beta.messages.tool_runner` + `@beta_tool`). Cargar la skill `claude-api` y leer
   `python/claude-api/tool-use.md` y `shared/tool-use-concepts.md` ANTES de escribirlo.
   Prompt caching sobre system prompt + definiciones de tools. `strict: true` en los
   esquemas. Incluir `fallbacks: "default"` con el beta `server-side-fallback-2026-07-01`.
4. **Gate de aprobación**: toda tool `write`/`destructive` devuelve una propuesta
   (`approval_id`, tool, argumentos, coste de cuota) y se bloquea hasta
   `POST /approvals/{id}` con `approve|reject`. Las `destructive` exigen repetir el ID
   del vídeo. Se implementa en los hooks por turno del Tool Runner.
5. **Cola de jobs** (`asyncio` + estado en SQLite) para subida y transcripción, con
   progreso consultable.
6. **Secretos en `keyring`** (Windows Credential Manager): clave de Anthropic,
   `client_secret.json` y tokens OAuth. Sustituye `_save_token/_load_token` de
   `youtube_mcp/auth.py` por un backend inyectable (archivo para tests, keyring en real).
7. **Migrar `youtube-mcp-server` a `mcp` 2.x** (`MCPServer`) para que las dos fachadas MCP
   compartan versión. Guía: https://py.sdk.modelcontextprotocol.io/v2/migration/
8. **Seguridad transversal**: salida del modelo = entrada no confiable; contenido de
   `buscar_kb` tratado como datos en el system prompt; nada escucha en `0.0.0.0`.

## Orden sugerido y verificación

1. Migración `mcp` 2.x en `youtube-mcp-server` (suite 153 verde) y commit.
2. Backend de secretos inyectable + `keyring` (tests con backend en memoria) y commit.
3. `app-backend/`: registro de tools + FastAPI con token (probar con `curl`).
4. Tool Runner + gate de aprobación (tests con el cliente de Anthropic mockeado).
5. Jobs (subida y transcripción).
6. E2E, uno por flujo, con el backend arrancado de verdad: pregunta a la KB, análisis de
   canal, publicación completa con aprobación. Sin credenciales reales se verifica el
   rechazo y el flujo de aprobación; con ellas, el flujo entero.
7. Actualizar `INFORME-...` si algo cambia, `PENDIENTE.md` de cada repo, el documento de
   aprendizajes `C:\Users\Marc\Desktop\VPS_HETZNER\aprendizajes-YYYY-MM-DD.md` (guion
   bajo) y la memoria `producto-exe-decisiones.md`.

## Hechos verificados que conviene no volver a investigar

- Cuota oficial YouTube (tabla actualizada 2026-10-08): `search.list` y `videos.insert`
  tienen cubos propios de 100 llamadas/día; `captions.list` cuesta 50; el resto 10.000
  unidades/día. Techo real: 100 subidas/día por usuario.
- Precios Anthropic por millón de tokens: Opus 5.5 4 $/20 $, Sonnet 5.5 2 $/10 $,
  Haiku 5.5 0,10 $/0,50 $; lectura de caché 0,20 $.
- Ejecutar un servidor MCP con `python -m paquete.server` registra las tools en una
  segunda instancia (el módulo se carga como `__main__`); usar siempre el console script.
- `psycopg.connect` sin `connect_timeout` cuelga la tool si Postgres no está.
