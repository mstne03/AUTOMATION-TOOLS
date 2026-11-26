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
  (arreglo: borrarlo como dice la regla 4 de abajo y `pnpm install`).
- Python con `uv` (CPython de uv, no Anaconda): `uv sync --extra dev`, `uv run pytest -q`.
- `pnpm e2e` aborta si el puerto 1420 está ocupado: cierra antes `tauri dev`/`pnpm dev`.
- No ejecutes el instalador `-setup.exe` desde una sesión de Claude Code (cae en el AppData
  virtualizado). Las pruebas con la app instalada las hace Marc.

## Ficheros y disco (obligatorio; incidente del 2026-11-10, detalle en `docs/ERROR_LEDGER.md`)

Un `robocopy /E` de un `node_modules` entre worktrees siguió las junctions de pnpm, entró en bucle
y escribió más de 200 GB hasta llenar C:. Por eso:

1. **Nunca copies `node_modules`** entre worktrees ni a ningún sitio. En un worktree nuevo:
   `pnpm install --frozen-lockfile`. Si no se puede descargar, prueba `pnpm install --offline`, que usa
   el almacén local. Si falla, para y pregunta a Marc; no busques otra manera de copiar.
2. Si tienes que copiar un árbol con Robocopy, usa siempre **`/XJ`** (o `/XJD`). Nunca juntes todos los
   modificadores silenciosos (`/NFL /NDL /NJH /NJS /NP`) y nunca la lances en segundo plano sin límite.
3. **No dejes procesos de copia, borrado o instalación vivos** al terminar un turno. Compruébalo con
   `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'AUTOMATION TOOLS' }`.
4. Para borrar un `node_modules` de pnpm en Windows, usa `cmd /c rmdir /s /q "\\?\<ruta>"`.
   **Nunca `Remove-Item -Recurse`**: en PowerShell 5.1 puede seguir las junctions y borrar el almacén real.
5. Antes de cualquier operación masiva sobre ficheros, mide el espacio libre con
   `(Get-PSDrive C).Free/1GB`. Si la operación puede escribir más de unos GB, avisa antes a Marc.
6. Los tests que crean directorios temporales los crean **fuera de `node_modules`** (en `os.tmpdir()`
   o en una carpeta de test) y los borran en `afterAll`/`finally`. Una junction nunca apunta a una
   carpeta que la contenga.

## Reglas de producto que no se reabren

- El WebView de Tauri solo tiene `core:default`: lo nativo (diálogos, abrir URLs, updater) va por
  comandos Rust.
- La salida del modelo es entrada no confiable: nunca se pinta como HTML.
- Los `data-testid` de `app-ui/docs/pantallas.md` son contrato de los E2E: si cambia uno, se
  actualizan el contrato y su E2E en el mismo commit.
- Solo las tools write/destructive van con `strict`; el test de `app-backend/tests/test_registry.py`
  vigila los límites de la API (20 estrictas, 16 parámetros con unión).
