# Handoff: Fase 5, errores encontrados al usar la app instalada (2026-10-12)

Pega este documento entero como primer mensaje de una sesión nueva abierta en
`C:\Users\Marc\Documents\PROJECTS\AUTOMATION TOOLS` (monorepo git; rama de partida: `main` una
vez mergeada la PR mstne03/AUTOMATION-TOOLS#1 de la Fase 4, o la rama
`claude/handoff-fase4-implementation-a44781` si aún no se ha mergeado).

---

## Contexto en tres líneas

Fases 0-4 hechas: `app-backend/` (sidecar FastAPI congelado con PyInstaller), `app-ui/` (Tauri 2 +
React), instalador NSIS con updater firmado. Marc instaló la 0.1.0 en su máquina el 2026-10-12 y
probó los flujos con credenciales reales: **fallan los cuatro** que se listan abajo. Las causas ya
están localizadas (sección "Diagnóstico"); esta fase las corrige y repite las pruebas reales. Lee
`HANDOFF-fase4.md` (estado de la máquina, contrato Tauri ↔ sidecar) y los READMEs de
`app-backend/`, `app-ui/` y `youtube-mcp-server/`.

## Decisiones ya tomadas (no reabrir)

- Las de `HANDOFF-fase4.md`: PyInstaller `--onedir`, `externalBin`, Job Object, updater con
  minisign propia, NSIS con `zlib`, sin firma de código, `HF_HUB_OFFLINE` solo para fastembed.
- El WebView solo tiene `core:default`: cualquier diálogo nativo (explorador de ficheros) se abre
  desde **Rust** con un comando `invoke`, no desde JS con permisos de plugin.
- Solo las tools `write`/`destructive` van con `strict: true` (la API admite 20). Modo didáctico en
  IA/empaquetado; frontend a ritmo normal. Español con acentos. "ejecución", nunca "corrida".

## Los cuatro errores, con diagnóstico

### E1. Transcribir: Whisper no puede descargar su modelo

Mensaje en la app: `Could not load the Whisper model 'small'. The first call downloads it from
Hugging Face... LocalEntryNotFoundError: ... outgoing traffic has been disabled. To enable repo
look-ups and downloads online, set 'HF_HUB_OFFLINE=0'`.

**Causa (regresión de la Fase 4):** `app-backend/app_backend/config.py` hace
`os.environ.setdefault("HF_HUB_OFFLINE", "1")` cuando `sys.frozen`, pensado para que `fastembed`
no toque la red. Pero `faster-whisper` usa el mismo `huggingface_hub` para bajar el modelo
`small` (~480 MB) en el primer uso, y esa variable lo bloquea. El modelo de embeddings ya se carga
con `EMBED_MODEL_PATH` (`specific_model_path`), que no pasa por la red de todos modos.

**Arreglo:** quitar esa línea. Si se quiere mantener la garantía "los embeddings nunca salen a la
red", hacerlo en `kb/embeddings.py` solo alrededor de la carga del modelo (no como variable
global del proceso). Verificar con el binario congelado: `scripts/smoke_test.py` sigue pasando
(la búsqueda offline no depende de la variable) y una transcripción real descarga el modelo.
Añadir al smoke test una comprobación de que `HF_HUB_OFFLINE` no está en el entorno del hijo.

Mientras se arregla, el modelo también se puede dejar ya descargado en
`%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-small` desde un Python
normal (`from faster_whisper import WhisperModel; WhisperModel("small")`): el binario lo
encuentra ahí aunque esté en modo offline.

### E2. Chat y "Generar borrador": la API de Anthropic rechaza los esquemas

Mensaje: `BadRequestError 400: Schemas contains too many parameters with union types (18
parameters with type arrays or anyOf)... (limit: 16 parameters with unions)`. Sale en **cualquier**
turno del agente (chat "analiza mi canal", botón "Generar borrador con el agente"), porque las 44
tools viajan en todas las peticiones.

**Causa:** la API limita a 16 los parámetros con `anyOf`/`type: [..]` **en el conjunto de tools
estrictas**. `registry.strict_schema()` convierte cada parámetro opcional en
`{"anyOf": [tipo, {"type": "null"}]}` (es lo que `strict: true` exige para los opcionales), y
las 7 tools estrictas suman exactamente 18:

| tool estricta | parámetros con unión |
|---|---|
| `youtube_update_video` | 6 |
| `youtube_upload_video` | 5 |
| `youtube_create_playlist` | 2 |
| `guardar_en_kb_privada` | 2 |
| `youtube_add_to_playlist` | 1 |
| `youtube_delete_video` | 1 |
| `youtube_reporting_create_job` | 1 |

(Contado con `registry.build()`; las tools `read`, no estrictas, suman 44 uniones más pero no
cuentan para el límite.) El límite no existía o no se alcanzaba cuando la Fase 1 pasó los E2E
reales el 2026-10-11; `guardar_en_kb_privada` (Fase 2) añadió 2 y los E2E de la UI usan un
Anthropic falso, así que nadie lo vio hasta la prueba real.

**Arreglo (elegir uno, recomendado el primero):**

1. Reducir uniones en las estrictas por debajo de 16 sin perder funcionalidad: en
   `youtube_upload_video` y `youtube_update_video` los opcionales de texto (`description`,
   `tags`, `category_id`, `publish_at`, `thumbnail_path`...) pueden ser `string` obligatorio con
   `""` = "sin cambio" (la función ya trata `None`; añadir `or None`), y los booleanos opcionales
   pasar a obligatorios con default explícito en la descripción. Con quitar 3 basta; mejor dejar
   margen (≤ 12) para tools futuras.
2. Quitar `strict` a las dos tools con más uniones (siguen pasando por el gate de aprobación, que
   es la defensa real; `strict` solo garantiza la forma del JSON).

Añadir un **test** en `app-backend/tests/test_registry.py` que cuente las uniones de las tools
estrictas y falle por encima de 16 (y otro ya existe para el máximo de 20 estrictas: comprobar).
Después, repetir el E2E real de la Fase 1 desde la app instalada (pregunta a la KB, análisis de
canal, publicación con rechazo/subida/borrado).

### E3. "Pedir al agente que lo suba" aparece deshabilitado

No es un fallo aparte: el botón exige ruta válida **y** un título en el borrador
(`disabled={!pathOk || !borrador.title.trim() || chat.enStream}` en `PublicarScreen.tsx`), y el
borrador nunca llegó a rellenarse por E2. Se resuelve con E2. Mejora pequeña y conveniente:
mostrar bajo el botón por qué está deshabilitado ("falta el título del borrador"), igual que ya
hace el gate destructivo con el ID.

### E4. Publicar vídeo: elegir el fichero con el explorador, no pegando la ruta

Hoy `publicar-path` es un `input` de texto y el contrato de `app-ui/docs/pantallas.md` lo
documenta así ("el sidecar no lista carpetas"). Marc quiere un botón **"Elegir vídeo…"** que abra
el explorador de Windows **ya situado en la primera carpeta permitida** (`allowed_dirs[0]` de
`GET /settings`) y filtrado a vídeo (`mp4, mov, mkv, webm, avi`), y que rellene la ruta.

**Diseño:** comando Rust `elegir_video(dir_inicial: String) -> Option<String>` en
`app-ui/src-tauri/src/lib.rs` usando `tauri-plugin-dialog` **desde Rust** (`app.dialog().file()
.set_directory(..).add_filter("Vídeo", &[...]).blocking_pick_file()`), para no añadir permisos
al WebView (misma regla que el updater). La UI mantiene el `input` como campo editable de solo
lectura visual (sigue sirviendo a los E2E, que no pueden abrir diálogos nativos: fuera de Tauri,
`elegirVideo()` devuelve `null` y el campo se escribe a mano, como `updater.ts`). Validar en el
sidecar como hasta ahora (`resolve_allowed`): el diálogo es comodidad, no control de acceso.
Actualizar `docs/pantallas.md`, un test unitario con el módulo simulado y el E2E de Publicar.

## Orden sugerido y verificación

1. E1 (una línea) + test en el smoke test. Commit.
2. E2 (esquemas) + test de uniones. `uv run pytest -q` (34+), tests de `youtube-mcp-server`
   (163). Commit.
3. E4 (diálogo) + E3 (motivo del botón). `pnpm test`, `pnpm e2e` (20+). Commit.
4. Regenerar el instalador (`app-backend/README.md` → empaquetado; `app-ui/README.md` →
   instalador), instalarlo encima de la 0.1.0 y repetir **con credenciales reales** desde la app:
   transcripción de `C:\Users\Marc\Videos\demo cs finance.mp4`, borrador, subida privada con
   aprobación, borrado con ID, análisis de canal en el chat. Esta es la verificación que la Fase 4
   no hizo.
5. Docs: informe (`INFORME-producto-exe-2026-10-10.md`, sección 6 "Fase 5"), READMEs,
   aprendizajes en `C:\Users\Marc\Desktop\VPS_HETZNER\aprendizajes-YYYY-MM-DD.md` (guion bajo) y
   la memoria `producto-exe-decisiones.md`.

## Estado de la máquina (2026-10-12)

- SEO Studio 0.1.0 instalada en `%LOCALAPPDATA%\SEO Studio` (build del 2026-10-12 13:01, con
  el arreglo de OAuth: `POST /youtube/auth` da 400 y la UI lo muestra). Estado en
  `%LOCALAPPDATA%\seo-studio`. Instalar encima no requiere desinstalar.
- Credential Manager (servicio `youtube-mcp`): clave de Anthropic real; el `client_secret` era el
  **falso de los E2E** (`id-e2e...`, rastro del incidente de la Fase 3) hasta que Marc importe el
  real desde Onboarding → "Proyecto de Google Cloud" (pendiente de confirmar). Token del perfil
  `default` = canal Candisito; Marc quiere autorizar **otra cuenta** (Ajustes → "Volver a
  autorizar", o un perfil nuevo).
- Repo en GitHub: `mstne03/AUTOMATION-TOOLS`. PR mstne03/AUTOMATION-TOOLS#1 abierta con la Fase 4
  (fast-forward limpio sobre `main`). Secreto `TAURI_SIGNING_PRIVATE_KEY` pendiente de crear
  (solo ese; no existe el de contraseña). Clave privada en `C:\Users\Marc\.tauri\seo-studio.key`.
- Venv de `app-backend` con el CPython de uv (3.12.15); PyInstaller tarda ~5 min, `pnpm tauri
  build` ~7 min (zlib). Smoke test: `uv run python scripts/smoke_test.py`.
- Todo desde Git Bash (`pnpm tauri …` rompe `node_modules` desde PowerShell). Para ejecutar el
  instalador en silencio desde Git Bash: `MSYS_NO_PATHCONV=1 ./…-setup.exe /S`. No ejecutar el
  instalador desde una sesión de Claude Code: cae en el AppData virtualizado del paquete MSIX.
- Los E2E (`pnpm e2e`) abortan si el 1420 está ocupado; cierra `tauri dev` y la app instalada no
  interfiere (puerto aleatorio).

## Hechos verificados que conviene no volver a investigar

- `fastembed` carga el modelo embebido con `specific_model_path` sin tocar la red; no necesita
  `HF_HUB_OFFLINE`.
- El Job Object funciona en dev y en release (cierre forzoso de la app mata al sidecar).
- El hash del `app-backend.exe` instalado coincide con `dist/` y con `target/release` (sin
  sidecar cacheado).
- `youtube_auth` del Onboarding reutiliza un token válido sin abrir el navegador: es correcto;
  para cambiar de cuenta hay que usar "Volver a autorizar" (`reauthorize: true`).
- Los E2E de UI usan un Anthropic falso: **no** detectan errores de la API real (como E2). Si se
  quiere cubrir, un test de `app-backend` que valide los esquemas contra las reglas conocidas (20
  estrictas, 16 uniones) es la red de seguridad barata.
