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
| `ANTHROPIC_API_KEY` | Respaldo para desarrollo. La clave guardada por `PUT /settings` (Credential Manager) tiene prioridad. |

Para desarrollo, copia `.env.example` a `.env` junto a `pyproject.toml`: se carga al arrancar
y esta en `.gitignore`.

**Base de conocimiento.** Por defecto el sidecar usa el **snapshot SQLite firmado**
(`KB_BACKEND=sqlite`, fijado antes de importar `kb.config`): al arrancar, si han pasado mas
de 24 h desde la ultima comprobacion, descarga `manifest.json` + `.minisig` de
`KB_UPDATE_URL` (`https://kb.mstne.dev/kb/`), verifica la firma con la clave publica
embebida (`KB_MINISIGN_PUBKEY`), y si el SHA-256 cambio descarga el `.sqlite`, lo valida y
lo activa de forma atomica en `APP_BACKEND_DIR/kb/`, conservando el anterior para rollback.
Despues precarga el modelo de embeddings ONNX (`EMBED_CACHE_DIR`, ~120 MB la primera vez).
La KB privada (`APP_BACKEND_DIR/kb/kb-private.sqlite`) se crea al guardar algo. Para
desarrollar contra el Postgres de `kb-seo`: `KB_BACKEND=postgres` en `.env.local`.

## Rutas

| Ruta | Que hace |
|---|---|
| `POST /chat` | `{message, conversation_id?}` -> SSE con eventos `text`, `tool_use`, `tool_result`, `approval_required`, `approval_resolved`, `job_started`, `job_finished`, `done`, `error`. |
| `GET /approvals`, `POST /approvals/{id}` | `{decision: approve\|reject, confirm_id?}`. Las destructivas exigen `confirm_id` = ID del video. |
| `GET/POST /jobs`, `GET /jobs/{id}` | `{kind: upload\|transcribe, args}`; progreso en `[0, 1]`. |
| `GET /kb/estado`, `/kb/fuentes`, `/kb/buscar?q=` | Fachada sobre las tools de `kb-seo`. `estado` incluye `snapshot` (version, fecha, ultimo error). |
| `POST /kb/update`, `POST /kb/rollback` | Fuerza la comprobacion del snapshot (502 si la firma o el hash fallan; el instalado no se toca) y vuelve a la version anterior (409 si no hay). |
| `GET/POST/DELETE /kb/privada/fuentes`, `POST /kb/privada/notas` | KB privada: URLs http(s) por `ingest/extractors.py`, notas de texto (`{identificador, titulo, texto}`), listado y borrado (`{url}` en el cuerpo). |
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

## Empaquetado (binario del producto)

El producto no lleva Python instalado: el sidecar se congela con **PyInstaller `--onedir`**
(`app-backend.spec`) y Tauri lo arrastra como `externalBin`. Dos conceptos:

- *onedir*: un `app-backend.exe` pequeno (arrancador) mas una carpeta `_internal/` con el
  interprete, las dependencias y los datos. Arranca mas rapido que *onefile* (que se
  descomprime en un temporal en cada ejecucion) y Tauri la copia tal cual como recurso.
- *hidden imports*: PyInstaller sigue los `import` estaticos; lo que se importa por cadena
  (`uvicorn` elige el loop por nombre, `keyring` el backend por entrypoint) o dentro de una
  funcion (`faster_whisper`, `fastembed`, `sqlite_vec`) hay que listarlo en el spec. Los hooks
  de `pyinstaller-hooks-contrib` ya cubren onnxruntime, googleapiclient (discovery docs),
  psycopg (libpq), av, lxml y tzdata.

```bash
uv sync --extra dev                         # pyinstaller esta en el extra dev
uv run python scripts/fetch_model.py        # modelo ONNX -> models/multilingual-e5-small (470 MB, una vez)
uv run pyinstaller --noconfirm --clean app-backend.spec   # -> dist/app-backend/ (~900 MB)
uv run python scripts/smoke_test.py         # lanza el .exe, lee el puerto, GET /settings y /kb/buscar sin red
```

Hazlo con el **CPython de `uv`**, no con Anaconda: el `_ctypes` de Anaconda depende de una
`ffi.dll` que PyInstaller no recoge y el binario muere con "DLL load failed" al importar
`psycopg`. `uv sync --managed-python` (o `uv python install 3.12`) lo deja bien; el pipeline
de CI usa ese mismo CPython.

Diferencias del binario congelado (`sys.frozen`, ver `config.py` y `kb/config.py`):

- **No lee ningun `.env`**: la configuracion solo llega por variables de entorno que fija el
  propio producto. Un `.env` junto al ejecutable no puede cambiar nada.
- **Modelo de embeddings dentro del bundle** (`_internal/models/multilingual-e5-small`):
  `EMBED_MODEL_PATH` apunta ahi y `fastembed` lo carga con `specific_model_path`, sin tocar
  Hugging Face (`HF_HUB_OFFLINE=1` por si acaso). El modelo es el ONNX fp32 oficial, el mismo
  que ingesta el VPS: cuantizarlo a int8 cambiaria los vectores respecto al snapshot.
- Whisper (`faster-whisper`) va en el bundle pero su modelo se descarga en el primer uso.
- Playwright (extractor `browser`) queda excluido: es solo del VPS.

## Tests

```bash
uv run pytest -q
```

El cliente de Anthropic se simula con `httpx2.MockTransport` sirviendo SSE reales, asi
que el bucle del runner, el gate y el historial se prueban de verdad sin red.
