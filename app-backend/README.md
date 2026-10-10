# app-backend

Sidecar Python del producto: FastAPI en `127.0.0.1` con puerto aleatorio y token por
arranque, agente con el Tool Runner del SDK de Anthropic sobre las tools de
`youtube-mcp-server` y `kb-seo` (importadas como dependencias locales), gate de
aprobacion para toda escritura, cola de jobs y secretos en el Credential Manager.

## Arrancar

```bash
uv sync --extra dev
uv run app-backend
```

La primera linea de stdout es `{"port": N, "token": "..."}`. Todas las rutas exigen
`Authorization: Bearer <token>`. Variables:

| Variable | Efecto |
|---|---|
| `APP_BACKEND_DIR` | Directorio de estado (ajustes, `quota.json`, `jobs.sqlite`). Por defecto `%LOCALAPPDATA%\seo-studio`. |
| `APP_BACKEND_SECRETS` | `keyring` (por defecto) o `file` (JSON en claro; solo desarrollo y tests). |
| `APP_BACKEND_TOKEN` | Token fijo; si falta se genera uno por arranque. |

La KB sigue siendo el Postgres local de `kb-seo` (Fase 2 la sustituye por el snapshot):
necesita `kb-seo/.env`, `docker compose up -d` y `ollama pull bge-m3`.

## Rutas

| Ruta | Que hace |
|---|---|
| `POST /chat` | `{message, conversation_id?}` -> SSE con eventos `text`, `tool_use`, `tool_result`, `approval_required`, `approval_resolved`, `job_started`, `job_finished`, `done`, `error`. |
| `GET /approvals`, `POST /approvals/{id}` | `{decision: approve\|reject, confirm_id?}`. Las destructivas exigen `confirm_id` = ID del video. |
| `GET/POST /jobs`, `GET /jobs/{id}` | `{kind: upload\|transcribe, args}`; progreso en `[0, 1]`. |
| `GET /kb/estado`, `/kb/fuentes`, `/kb/buscar?q=` | Fachada sobre las tools de `kb-seo`. |
| `GET /youtube/status`, `POST /youtube/auth`, `GET /youtube/tools` | Estado, flujo OAuth (unica ruta que abre el navegador) y tabla de riesgos. |
| `GET/PUT /settings`, `POST /settings/client-secret` | Modelo, carpetas permitidas, perfil, clave de Anthropic (solo escritura), `client_secret.json`. |

## Como esta hecho

- **Registro** (`registry.py`): lee las tools ya registradas en los `MCPServer` de ambos
  repos y les anade riesgo (`read` / `write` / `destructive`), coste de cuota y, para
  subida y transcripcion, el tipo de job. Esquemas transformados para `strict: true`.
- **Agente** (`agent.py`): `client.beta.messages.tool_runner(stream=True)` con
  `fallbacks="default"`, `cache_control` en el system prompt (cubre tools + system) y
  tools ordenadas por nombre para que el prefijo cacheado no cambie. El gate vive dentro
  de la funcion envuelta: una tool `write`/`destructive` publica la propuesta y espera.
- **Seguridad**: solo loopback; token obligatorio; la salida del modelo es entrada no
  confiable (gate + system prompt que trata `buscar_kb`, comentarios y transcripciones
  como datos); la clave de Anthropic nunca se devuelve por la API; `youtube_auth` no esta
  disponible para el modelo.

## Tests

```bash
uv run pytest -q
```

El cliente de Anthropic se simula con `httpx2.MockTransport` sirviendo SSE reales, asi
que el bucle del runner, el gate y el historial se prueban de verdad sin red.
