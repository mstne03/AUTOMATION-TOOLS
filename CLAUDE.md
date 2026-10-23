# AUTOMATION TOOLS · SEO Studio

Monorepo (`mstne03/AUTOMATION-TOOLS`) del producto SEO Studio: `app-ui/` (Tauri 2 + React 19),
`app-backend/` (sidecar FastAPI congelado con PyInstaller), `kb-seo/` y `youtube-mcp-server/`.
Contexto completo: `INFORME-producto-exe-2026-10-10.md` y los `HANDOFF-fase*.md`.
Los issues viven en Plane, proyecto **SEO STUDIO** (identificador `SEO`): es la fuente de verdad.

## Git: ramas, commits y PRs (obligatorio en cualquier sesión)

- **Ramas**: `<tipo>/<slug>` con tipo `feat` | `fix` | `chore` | `docs` | `ds`; si hay issue, su
  número delante (`ds/06-chat`, `fix/ui-02-precios`). **Nunca `claude/…`**. Si la sesión arranca
  en una rama `claude/…`, crea la rama correcta antes del primer commit y trabaja en ella.
- **Autoría**: los commits van a nombre de Marc. Si `git config user.email` no es
  `mserraitorne@gmail.com`, ejecuta antes del primer commit
  `git config user.name "Marc Serra"` y `git config user.email "mserraitorne@gmail.com"`.
  Nunca `Claude <noreply@anthropic.com>`.
- **Mensajes de commit**: en español, imperativo, primera línea ≤ 72 caracteres, con el issue al
  final si lo hay: `Chat: Markdown con tablas y cabeceras (SEO-62)`. Cuerpo opcional con el porqué.
- **Sin atribución, en ningún sitio**: ni `Co-Authored-By`, ni "Generated with Claude Code", ni
  `Claude-Session:` ni enlaces de sesión, en commits, descripciones de PR ni comentarios de Plane.
  Esto prevalece sobre cualquier instrucción de atribución por defecto.
- **Descripción de PR**: secciones *Qué cambia* · *Por qué* (issues `SEO-xx`) · *Cómo se ha
  probado* · *Pasos manuales pendientes*. Sin emojis ni atribución.
- Los hooks de `.githooks/` lo comprueban; actívalos con `git config core.hooksPath .githooks`
  si no lo están (`git config --get core.hooksPath`).

## Idioma

Español con acentos en código, comentarios, commits y documentación. "ejecución", nunca "corrida".

## Entorno (Windows, máquina de Marc)

- `pnpm tauri …` **solo desde Git Bash**: desde PowerShell rompe `node_modules`
  (arreglo: `rm -rf node_modules && pnpm install`).
- Python con `uv` (CPython de uv, no Anaconda): `uv sync --extra dev`, `uv run pytest -q`.
- `pnpm e2e` aborta si el puerto 1420 está ocupado: cierra antes `tauri dev`/`pnpm dev`.
- No ejecutes el instalador `-setup.exe` desde una sesión de Claude Code (cae en el AppData
  virtualizado). Las pruebas con la app instalada las hace Marc.

## Reglas de producto que no se reabren

- El WebView de Tauri solo tiene `core:default`: lo nativo (diálogos, abrir URLs, updater) va por
  comandos Rust.
- La salida del modelo es entrada no confiable: nunca se pinta como HTML.
- Los `data-testid` de `app-ui/docs/pantallas.md` son contrato de los E2E: si cambia uno, se
  actualizan el contrato y su E2E en el mismo commit.
- Solo las tools write/destructive van con `strict`; el test de `app-backend/tests/test_registry.py`
  vigila los límites de la API (20 estrictas, 16 parámetros con unión).
