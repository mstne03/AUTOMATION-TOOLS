# app-ui

Interfaz de escritorio del producto: **Tauri 2** (shell nativo, Rust mínimo) + **React 19 +
TypeScript + Vite**, con TanStack Query para las llamadas y un stream SSE para el chat.
Habla con el sidecar `app-backend` por HTTP en `127.0.0.1:<puerto aleatorio>` con un token
por arranque.

## Requisitos

- Node 22 + pnpm 9.
- Rust (`winget install Rustlang.Rustup`) y Visual Studio Build Tools 2022 con la carga
  "Desarrollo de escritorio con C++" (`Microsoft.VisualStudio.Workload.VCTools`). WebView2 ya
  viene con Windows 11.
- `uv` y el venv de `app-backend` sincronizado (`uv sync --extra dev` en `../app-backend`).

## Arrancar

```bash
pnpm install
pnpm tauri dev
```

Lánzalo desde **Git Bash**, no desde PowerShell: con el shim `pnpm.ps1` la CLI de Tauri
intenta reinstalar dependencias y deja `node_modules` a medias (`ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`).

Lo que hace el shell Rust (`src-tauri/src/lib.rs`):

1. Genera un token aleatorio de 32 bytes.
2. Lanza `uv run app-backend` con `cwd=../app-backend` y `APP_BACKEND_TOKEN=<token>`
   (`tauri-plugin-shell` desde Rust; el WebView **no** tiene permiso de shell).
3. Lee la primera línea de stdout `{"port": N, "token": "..."}` y la guarda en memoria. Esa
   línea no se registra en ningún sitio; el resto de la salida del sidecar va a stderr con
   prefijo `[sidecar]`.
4. Expone `{port, token}` a la UI con el comando `sidecar_info` (espera hasta 60 s).
5. Mata el sidecar en `RunEvent::Exit`. `uv` usa un Job Object, así que matar `uv.exe` mata
   también el `python.exe` hijo. Un cierre forzoso (`taskkill /F`) de la app no pasa por
   este evento y deja el sidecar huérfano; la Fase 4 debería atar el hijo a un Job Object.

### Sin Tauri (solo navegador)

Para desarrollar la UI o para los E2E, la app también corre en un navegador normal. Fuera de
Tauri lee el sidecar de variables de desarrollo (nunca en producción):

```bash
# en app-backend: APP_BACKEND_TOKEN=mi-token uv run app-backend  → anota el puerto
# en app-ui: crea .env.local (ignorado por git)
VITE_SIDECAR_PORT=12345
VITE_SIDECAR_TOKEN=mi-token
pnpm dev
```

El sidecar solo admite CORS desde `http://tauri.localhost`, `https://tauri.localhost` y
`http://localhost:1420`, así que Vite debe ir en el 1420.

## Estructura

| Ruta | Qué es |
|---|---|
| `src/sidecar.ts` | Obtiene `{port, token}`: `invoke("sidecar_info")` en Tauri, `VITE_*` fuera. |
| `src/api/types.ts` | Contrato del sidecar a mano (eventos SSE, aprobaciones, jobs, ajustes…). |
| `src/api/client.ts` | Cliente HTTP tipado; `chat()` es un `AsyncGenerator<ChatEvent>`. |
| `src/api/sse.ts` | Parser `text/event-stream` sobre `fetch` (EventSource no admite `Authorization`). |
| `src/chat/turno.ts` | Reducer puro que reconstruye un turno a partir de los eventos; `costeUsd`. |
| `src/chat/useChat.ts` | Hook: mensajes, envío, aprobaciones, sondeo de progreso de jobs. |
| `src/chat/*.tsx` | Pantalla de chat, bloque de tool, tarjeta de aprobación, Markdown seguro. |
| `src/screens/*.tsx` | Ajustes, Onboarding, Publicar, Panel de canal, Base de conocimiento. |
| `docs/pantallas.md` | **Contrato de layout y estados** que exigen los E2E (no hay Figma). |
| `e2e/` | Playwright: sidecar real en modo `file` + Anthropic falso (`anthropic-mock.ts`). |

## Seguridad

- El token vive en memoria de Rust y del WebView; no se escribe en disco ni en logs.
- CSP (`src-tauri/tauri.conf.json`): `connect-src` solo `ipc:` y `http://127.0.0.1:*`; sin
  scripts externos. `capabilities/default.json` solo concede `core:default`.
- La clave de Anthropic se envía una vez con `PUT /settings` y la API nunca la devuelve;
  los campos de clave son `type=password` y se vacían tras guardar.
- La salida del modelo es entrada no confiable: el Markdown se renderiza como elementos
  React (sin `innerHTML`), toda escritura pasa por la tarjeta de aprobación y las
  destructivas exigen teclear el `video_id` exacto.

## Tests

```bash
pnpm test        # vitest: parser SSE, cliente, reducer de turno, hook, Markdown
pnpm e2e         # Playwright contra el sidecar real (cierra antes tauri dev / pnpm dev)
pnpm typecheck
```

Los E2E arrancan en `globalSetup` un sidecar con `APP_BACKEND_SECRETS=file` en un
directorio temporal, un Anthropic falso (`ANTHROPIC_BASE_URL`) con guiones elegidos por una
marca en el mensaje (`E2E-TEXTO`, `E2E-RECHAZO`, `E2E-BORRAR`) y Vite en el 1420. El setup
aborta si el 1420 ya está ocupado: de lo contrario los tests hablarían con otro sidecar,
quizá el real con credenciales de verdad.

## E2E real (2026-10-11)

Con el sidecar real (Credential Manager, canal Candisito, `claude-opus-5-5`), desde el chat:
rechazo de la propuesta de subida (el modelo lo recibe como resultado normal; 13.861 tokens de
caché por turno), aprobación con subida real por la cola de jobs mostrando la ruta resuelta
`C:\Users\Marc\Videos\demo cs finance.mp4`, y borrado destructivo con confirmación del ID
(botón bloqueado con un ID incorrecto). Coste del flujo completo: ≈ $0,15.
