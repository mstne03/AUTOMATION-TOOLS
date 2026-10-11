# Handoff: Fase 2 del producto `.exe` (KB pública como snapshot firmado)

Pega este documento entero como primer mensaje de una sesión nueva abierta en
`C:\Users\Marc\Documents\PROJECTS\AUTOMATION TOOLS` (monorepo git, rama `main`).

---

## Contexto en tres líneas

Convertimos `kb-seo` y `youtube-mcp-server` en un `.exe` gratuito. La **Fase 1 está
hecha y verificada E2E** (2026-10-11): `app-backend/` es el sidecar FastAPI con agente,
gate de aprobación y jobs, y hoy consulta la KB en el **Postgres local** de `kb-seo` vía
las tools `buscar_kb` / `listar_fuentes` / `estado_kb`. Esta fase sustituye ese Postgres
por un **snapshot SQLite firmado** que se ingesta en el VPS y se descarga en el cliente,
para que el usuario no necesite Docker ni Ollama. Informe:
`INFORME-producto-exe-2026-10-10.md` (secciones 1.3, 2.3, 2.4 y 6; léelo entero).

## Decisiones ya tomadas (no reabrir)

- Ingesta **centralizada en el VPS Hetzner** (acceso por IP Tailscale; el 22 público está
  cerrado). Distribución como `kb-public.sqlite` con `sqlite-vec` (tablas `vec0`) + FTS5,
  firmado con **minisign (ed25519)** y servido por **Caddy** en `/kb/manifest.json` y
  `/kb/*.db`. Sin autenticación: no hay datos de usuario; la firma es la garantía.
- Embeddings: migrar de `bge-m3` (1024 dims, Ollama) a **`multilingual-e5-small`**
  (384 dims, ONNX ≈120 MB) servido en el cliente con `fastembed` u `onnxruntime`. El VPS
  reingesta con el mismo modelo. Ollama deja de ser requisito del usuario.
- KB privada: segundo fichero SQLite con el **mismo esquema**, escritura local
  (transcripciones, resúmenes de analíticas, URLs del usuario vía `ingest/extractors.py`).
- Prioridades: robustez > mantenibilidad > escalabilidad > simplicidad. Seguridad siempre.
- Modo didáctico en IA/backend/VPS/seguridad. Español con acentos. "ejecución", nunca
  "corrida". Sin co-autoría de agente en commits.
- Rituales del VPS: si trabajas desde `C:\Users\Marc\Desktop\VPS_HETZNER` sigue su
  `CLAUDE.md` (`sesion-contexto.md` al empezar, `/wrap-up` al cerrar). Aprendizajes en
  `aprendizajes-YYYY-MM-DD.md` en esa carpeta (guion bajo, nunca `VPS-HETZNER`).

## Estado de `kb-seo` (lo que hay que tocar)

- `kb/config.py`: `EMBED_MODEL`, `EMBED_DIM` por `.env`; `OLLAMA_URL`. `kb/embeddings.py`:
  `embed(texts)` contra Ollama con lotes y reintentos. **Este es el punto de inyección**
  del nuevo backend de embeddings.
- `sql/migrate.sql`: tablas `documents` y `chunks` con `embedding VECTOR(1024)` y `tsv`
  (tsvector `simple`). Hay que migrar la dimensión a 384 y reingestar.
- `kb/search.py::search()`: SQL híbrido (CTE `filtered` con filtros de plataforma, fecha
  y fuente **antes** de las ramas; `vec` por `<=>`; `fts` por `plainto_tsquery`; fusión
  RRF con `RRF_K = 60`, `CANDIDATES = 20`). `puntuador(qvec)` y `listar_titulos()`.
  `kb/formatting.py::formatear()` agrupa fragmentos contiguos y recorta por `max_chars`.
  **Portar a SQLite línea a línea**, misma semántica.
- `ingest/cli.py`: subcomandos `all`, `url`, `stats`; `ingest_one(source)`,
  `load_sources()`, `resolve_location()`. `ingest/extractors.py`: `extract(type, location)`
  con `_web` (trafilatura), `_youtube`, `_pdf`, `_local`. `kb/chunking.py`: `chunk_text`,
  `chunk_transcript`, `context_header`.
- `sources.yaml`: 19 fuentes (URLs y cuatro `fuentes/*.md` capturadas a mano con rutas
  relativas). Idempotente por `content_hash`.
- `mcp_server/server.py`: las tres tools; `_error()` no filtra DSN. `app-backend` las
  importa por `mcp_server.server.mcp._tool_manager`, así que **mantener nombres, firmas y
  docstrings** de las tools al cambiar la implementación por debajo.
- Suite: 80 tests (`uv run pytest -q`); 26 necesitan Postgres + `bge-m3`.

## Alcance (informe, sección 2.3 y 2.4)

1. **Backend de embeddings intercambiable** en `kb/embeddings.py`: `ollama` (ingesta en
   el VPS si se prefiere) y `fastembed`/ONNX con `multilingual-e5-small`. Recordar los
   prefijos del modelo e5: `"query: "` para la pregunta y `"passage: "` para los chunks.
   Migrar esquema a 384 dims y reingestar las 19 fuentes.
2. **Exportador `kb-export`** (console script en `kb-seo`): Postgres → SQLite con
   `documents`, `chunks`, tabla `vec0` (`sqlite-vec`) y FTS5 (tokenizador `unicode61`,
   sin stemming, como el `simple` de Postgres). Determinista y atómico (escribir en
   temporal y renombrar). `manifest.json` con versión, fecha, tamaño, SHA-256 y dims.
3. **Búsqueda híbrida en SQLite** (`kb/search_sqlite.py` o backend seleccionable): mismos
   filtros, mismo RRF, mismo formato de salida; `buscar_kb` elige backend por
   configuración (`KB_BACKEND=postgres|sqlite`). Latencia objetivo < 1 s en frío con el
   modelo ONNX cargado.
4. **Firma y verificación**: `minisign` en el VPS; clave pública embebida en el cliente;
   el cliente descarga manifest, compara versión, descarga a temporal, verifica firma y
   hash, sustituye de forma atómica y conserva la versión anterior para rollback.
   Endpoint `POST /kb/update` y estado en `GET /kb/estado` de `app-backend`.
5. **VPS**: systemd timer diario para `ingest all` + `kb-export` + firma; extractor
   `playwright` headless para las 4 páginas renderizadas por JS que hoy están en
   `fuentes/*.md`; Caddy sirviendo `/kb/` solo lectura con TLS automático. Postgres solo
   escucha en loopback del VPS. Ninguna clave privada de firma sale del VPS.
6. **KB privada** en el cliente: mismo esquema SQLite, escritura local, `buscar_kb`
   consulta ambas y marca el origen de cada bloque.
7. **Seguridad transversal**: contenido web = datos (ya en el system prompt de
   `app-backend`); verificación de firma antes de activar cualquier snapshot; rutas del
   snapshot dentro de `APP_BACKEND_DIR`.

## Orden sugerido y verificación

1. Embeddings intercambiables + migración a 384 dims + reingesta local. Suite verde. Commit.
2. `kb-export` + búsqueda SQLite con tests de paridad: misma consulta contra Postgres y
   contra el snapshot debe devolver los mismos documentos en el mismo orden. Commit.
3. `app-backend` con `KB_BACKEND=sqlite` y E2E real del chat contra la KB (el guion de
   la Fase 1: "mejor hora para publicar en TikTok", citas con URL). Commit.
4. Firma/verificación y cliente de actualización, con tests de snapshot manipulado
   (firma inválida → se rechaza y se conserva el anterior). Commit.
5. VPS: timer, Playwright, Caddy. Verificar descargando el snapshot real desde el cliente.
6. KB privada. Commit.
7. Actualizar `INFORME-...`, `kb-seo/README.md`, aprendizajes y memoria
   `producto-exe-decisiones.md`.

## Estado de la máquina (2026-10-11)

- `uv` por winget (ruta larga si el shell es viejo:
  `%LOCALAPPDATA%\Microsoft\WinGet\Packages\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\uv.exe`).
  Venvs sincronizados en los tres paquetes del checkout principal.
- Docker Desktop con `kb_seo_db` (volumen `kb_seo_pgdata`), `kb-seo/.env` con
  contraseñas locales, `bge-m3` en Ollama, corpus ingerido (19 docs, 106 chunks).
- `app-backend/.env.local` con `ANTHROPIC_API_KEY`; OAuth de Google en el Credential
  Manager. El chat E2E contra la KB ya funciona con Postgres: es la referencia de paridad.
- RTX 4060 de 8 GB: `multilingual-e5-small` en ONNX cabe de sobra; no usar modelos de
  embeddings que no quepan enteros en VRAM para medir.

## Hechos verificados que conviene no volver a investigar

- `psycopg.connect` sin `connect_timeout` cuelga la tool si Postgres no está (ya tiene 5 s).
- Ejecutar un servidor MCP con `python -m paquete.server` duplica el registro de tools;
  usar siempre el console script.
- `app-backend` fija variables de entorno **antes** de importar `youtube_mcp.server`
  (`app_backend/__init__.py` importa `config`); `kb.config` carga `kb-seo/.env` al
  importarse, desde la carpeta del paquete instalado en editable.
- La API de Anthropic admite 20 tools `strict` como máximo (resuelto en `registry.py`).
- El test `test_latencia_por_debajo_de_un_segundo` falla en frío al cargar el modelo de
  embeddings y pasa después: medir siempre en caliente, pero el objetivo del cliente es
  que también pase en frío con ONNX.
