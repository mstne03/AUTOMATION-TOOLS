# Módulo Vídeo · Fase 0 (integración técnica) — plan de implementación

> **Para agentes:** SUB-SKILL OBLIGATORIA: usa superpowers:subagent-driven-development
> (recomendado) o superpowers:executing-plans para ejecutar este plan tarea a tarea. Los pasos
> usan casillas (`- [ ]`) para el seguimiento.

**Objetivo:** dejar el motor de vídeo (footy generalizado) dentro del repo, arrancado por el
backend como proceso hijo MCP por stdio, empaquetado en el instalador y con los dos riesgos
técnicos (codificación sin `libx264` y preview en WebView2) medidos antes de construir la fase 1.

**Arquitectura:** `video-mcp-server/` (TypeScript, Node 22) es el motor; `app-backend` lo lanza
con el cliente MCP de Python (`mcp` 2.3, `stdio_client` + `ClientSession`) a través de una clase
`MotorVideo` y lo expone solo por rutas REST (D2: el modelo no lo llama). Node, Chrome headless y
ffmpeg LGPL viajan como recursos de Tauri en `video-engine/`.

**Stack:** TypeScript 5.9 + vitest 5 + `@modelcontextprotocol/sdk` 1.32.2 + `hyperframes` 0.8.206
(motor) · Python 3.12 + FastAPI + `mcp` 2.3 + pytest (backend) · Tauri 2 (empaquetado).

**Spec:** [SPEC-video.md](SPEC-video.md) (D1, D2, D7, D10, D11, Seguridad, Fases → Fase 0).

**Alcance:** solo la fase 0. El plan de la fase 1 se escribe con los resultados de los spikes
(tareas 2 y 3), porque deciden el formato intermedio del render y cómo se monta la preview.

## Restricciones globales

- Rama `feat/video-hyperframes` (nunca `claude/…`). Commits en español, imperativo, ≤ 72
  caracteres, autor Marc Serra <mserraitorne@gmail.com>, **sin ninguna atribución**.
- Código, comentarios y textos en español con acentos; «ejecución», nunca «corrida».
- Motor: Node ≥ 22, ESM, `spawn` siempre con `shell: false` y argumentos en array.
- `stdout` del motor reservado al protocolo MCP; logs a `stderr` y a fichero.
- El backend escucha solo en `127.0.0.1`; el motor no abre puertos.
- La clave de ElevenLabs nunca en argumentos de tool, respuestas de la API ni logs.
- Telemetría de HyperFrames desactivada (`HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`).
- ffmpeg del bundle: build **LGPL**. HyperFrames: Apache-2.0 con su aviso.
- Ninguna tool nueva entra en `registry.build()` en esta fase (D2): `test_registry.py` no cambia.
- PowerShell 5.1 para comandos `npm`/`uv`; `pnpm tauri` y los `.sh` solo desde Git Bash.
- Descargar binarios (Node, ffmpeg, Chrome) requiere el visto bueno de Marc en el momento: el
  ejecutor pide permiso indicando URL, versión y tamaño, y fija el SHA-256 en el script.

## Foco de revisión

Fallos que la spec implica y que ningún test de tarea cubriría por sí solo; cada uno tiene su
test en la tarea que posee el código:

1. **Rutas con espacios y acentos** (`C:\Users\José Pérez\AppData\Local\seo-studio`): el motor
   arranca, escribe logs y renderiza. → Tarea 7 (`test_motor_rutas_con_espacios_y_acentos`) y
   tarea 4 (`estado en ruta con acentos`).
2. **El motor muere a mitad de una llamada** (crash, OOM): la ruta responde 503 legible y la
   siguiente llamada lo relanza. → Tarea 7 (`test_motor_muere_y_se_relanza`).
3. **Render colgado que deja Chrome huérfano**: al vencer el timeout no queda ningún proceso
   hijo vivo. → Tarea 5 (`mata el árbol de procesos al vencer el timeout`).
4. **Dos llamadas simultáneas mientras el motor arranca**: un solo proceso hijo. → Tarea 7
   (`test_arranque_concurrente_un_solo_proceso`).
5. **Clave de ElevenLabs inválida o ausente**: error legible sin la clave en el texto, y el
   motor no se lanza con una variable vacía. → Tarea 6 (`test_validar_clave_elevenlabs_mala`) y
   tarea 7 (`test_env_del_motor_sin_clave`).

---

### Tarea 1: Traer footy al repo como `video-mcp-server/`

**Ficheros:**
- Crear: `video-mcp-server/` (copia de `C:\Users\Marc\Downloads\footy-mcp-server\hyper-frames-mcp-server`)
- Crear: `video-mcp-server/.gitignore`
- Modificar: `.gitattributes` (si hace falta para `*.ts`/`*.html` con LF)

**Interfaces:**
- Produce: el paquete `video-mcp-server` (`package.json` → `"name": "video-mcp-server"`), con
  `npm test` verde, y `dist/index.js` como punto de entrada stdio.

- [ ] **Paso 1: Copiar sin artefactos ni secretos**

```powershell
robocopy "C:\Users\Marc\Downloads\footy-mcp-server\hyper-frames-mcp-server" video-mcp-server /E /XD node_modules dist logs referencia-v2 .claude "test\salidas" "test\.tmp" /XF .env
```
Esperado: código de salida de robocopy ≤ 3; no existe `video-mcp-server\.env`.
`referencia-v2/` (scripts Python de referencia) y `.claude/skills` no entran: no los usa el
servidor.

- [ ] **Paso 2: Renombrar el paquete y fijar `.gitignore`**

`package.json`: `"name": "video-mcp-server"`, descripción genérica («Motor de vídeo de SEO
Studio: voz con ElevenLabs, composición y render con HyperFrames.»). `.gitignore` con `.env`,
`node_modules/`, `dist/`, `logs/`, `test/.tmp/`, `test/salidas/`.

- [ ] **Paso 3: Instalar y pasar los tests tal cual**

Run: `cd video-mcp-server; npm ci; npm test`
Esperado: todos los tests en verde (los mismos que en el origen).

- [ ] **Paso 4: Commit**

```bash
git add video-mcp-server .gitattributes
git commit -m "Vídeo: importar el motor footy como video-mcp-server"
```

---

### Tarea 2: Spike de codificación en dos pasadas (D11)

Spike: código desechable en `video-mcp-server/spikes/`, sin tests unitarios. Lo que se queda
es el informe.

**Ficheros:**
- Crear: `video-mcp-server/spikes/codificacion.mjs`
- Crear: `video-mcp-server/spikes/INFORME-codificacion.md`

**Interfaces:**
- Consume: la composición de prueba que ya genera `test/e2e-mock.test.ts` (voz sintética, ruta
  con espacios).
- Produce: decisión escrita del **formato intermedio** (`mov`/ProRes o `webm`/VP9), los
  **argumentos de ffmpeg** del segundo paso para `h264_mf` y para GPU, y los tiempos medidos.

- [ ] **Paso 1: Conseguir un ffmpeg LGPL** (pedir permiso a Marc: build `win64-lgpl` de
  BtbN/FFmpeg-Builds, versión fijada, SHA-256 anotado en el informe). Comprobar
  `ffmpeg -hide_banner -encoders` → contiene `h264_mf` y **no** contiene `libx264`.

- [ ] **Paso 2: Escribir `codificacion.mjs`**: para una composición de 50 s, (a) render
  HyperFrames con `--format mov` y con `--format webm` usando el ffmpeg LGPL en el `PATH`;
  (b) segundo paso `ffmpeg -i intermedio -c:v h264_mf -b:v 12M -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart salida.mp4`
  y lo mismo con `h264_nvenc`; (c) `ffprobe` de cada salida; (d) tiempo de cada fase; (e) PNG en
  los segundos 1, 10, 25 y 45 de cada salida y del render directo con GPU de HyperFrames.

- [ ] **Paso 3: Ejecutar y redactar `INFORME-codificacion.md`** con: tabla de tiempos (render
  directo GPU · intermedio mov · intermedio webm · paso 2 mf · paso 2 nvenc), tamaños del
  intermedio, ffprobe de cada MP4 (1080×1920, 30 fps, audio), comparación visual de los PNG y
  la **decisión**: formato intermedio y bitrate.

**Criterio de salida:** el render en modo Compatible termina sin `libx264` y produce un MP4 que
pasa ffprobe (1080×1920, 30 fps, audio presente, duración ± 0,1 s). Si HyperFrames exige
`libx264` también para `mov`/`webm`, el spike falla: se para y se lleva a Marc.

- [ ] **Paso 4: Commit**

```bash
git add video-mcp-server/spikes
git commit -m "Vídeo: spike de codificación en dos pasadas sin libx264"
```

---

### Tarea 3: Spike de preview en WebView2 (D6)

Spike desechable; solo en desarrollo (no entra en el build de producción).

**Ficheros:**
- Crear: `app-ui/src/spikes/PreviewSpike.tsx` y ruta `/#/spike-preview` solo con `import.meta.env.DEV`
- Crear: `app-backend/app_backend/spike_preview.py` (router montado solo si `APP_BACKEND_SPIKES=1`)
- Crear: `video-mcp-server/spikes/INFORME-preview.md`

**Interfaces:**
- Produce: decisión escrita de **cómo se sirve la composición al iframe** y **cómo se controla**
  (seek/play), con las mediciones.

- [ ] **Paso 1: Servir una `_composicion/` ya montada** desde el backend en
  `GET /spike/preview/{clave}/{ruta:path}`, donde `clave` es un `secrets.token_urlsafe(32)`
  generado al arrancar (URL de capacidad: el iframe no puede mandar la cabecera Bearer) y la
  ruta se resuelve dentro de la carpeta con `Path.resolve()` + comprobación de prefijo.

- [ ] **Paso 2: Página del spike** con `<iframe sandbox="allow-scripts">` (sin
  `allow-same-origin`: origen opaco, sin acceso a `window.__TAURI__` ni al token) apuntando a
  esa URL; añadir `frame-src http://127.0.0.1:*` solo al `devCsp`. Control por `postMessage`:
  un script inyectado en la composición escucha `{tipo: "seek", t}` / `{tipo: "play"}` /
  `{tipo: "pause"}` y llama a `window.__timelines["main"].seek(t)` / `.play()` / `.pause()`,
  sincronizando los `<audio>`/`<video>` de la composición.

- [ ] **Paso 3: Medir en el portátil de Marc** (RTX 4060) dentro de `pnpm tauri dev` (Git Bash):
  fps de reproducción con fondo `aurora` (WebGPU) y con reserva CSS, contando
  `requestAnimationFrame` durante 10 s; latencia de seek; deriva audio/vídeo tras 50 s; y
  comparación de 4 fotogramas capturados en la preview frente a los del MP4 en los mismos
  segundos.

- [ ] **Paso 4: Redactar `INFORME-preview.md`** con las cifras y la decisión.

**Criterio de salida:** ≥ 30 fps con fondo WebGPU, seek < 200 ms, deriva < 1 fotograma
(33 ms) en 50 s y fotogramas visualmente iguales al MP4. Si no se cumple, se para y se lleva a
Marc antes de planificar la fase 1.

- [ ] **Paso 5: Commit**

```bash
git add app-ui/src/spikes app-ui/src/App.tsx app-ui/src-tauri/tauri.conf.json app-backend/app_backend/spike_preview.py app-backend/app_backend/main.py video-mcp-server/spikes/INFORME-preview.md
git commit -m "Vídeo: spike de preview de la composición en WebView2"
```

---

### Tarea 4: Generalizar el motor (G1) y modo integrado

**Ficheros:**
- Modificar: `video-mcp-server/src/index.ts`, `config.ts`, `paths.ts`, `log.ts`, `capacidades.ts`,
  `musica.ts`, `herramientas.ts`, `formato.ts`, `guion.ts` y las plantillas/textos que nombren
  fútbol o «footy»
- Modificar: los tests existentes que usan `footyNNN` o `FOOTY_*`
- Crear: `video-mcp-server/test/generico.test.ts`
- Crear: `video-mcp-server/src/estado.ts`

**Interfaces:**
- Produce (lo que consume la tarea 7):
  - Servidor MCP `name: "video"`. Tools renombradas `footy_<x>` → `video_<x>` (mismas 12:
    `video_listar`, `video_guardar_guion`, `video_estado`, `video_generar_voz`,
    `video_renderizar`, `video_estado_render`, `video_fotograma`, `video_ayuda`,
    `video_capacidades`, `video_vista_previa`, `video_musica`, `video_catalogo`).
  - Ids de proyecto `^video\d{3}$` (la fase 1 los redefine; aquí solo se quita la marca).
  - Variables: `VIDEO_ROOT`, `VIDEO_STATE_DIR`, `VIDEO_MUSICA_VOLUMEN`, `VIDEO_FORZAR_SIN_GPU`,
    `VIDEO_ENGINE_EMBEDDED`; se mantienen `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
    `ELEVENLABS_MODEL_ID`, `HYPERFRAMES_BROWSER_PATH`, `FFMPEG_DIR`.
  - `estado.ts`: `export const STATE_DIR: string` = `VIDEO_STATE_DIR` o `SERVER_ROOT/logs`; ahí
    van `video.log`, `capacidades.json` y `musica-cache.json` (en el producto, `SERVER_ROOT` está
    en la carpeta de instalación y no se puede escribir).

- [ ] **Paso 1: Test de guarda G1 que falla**

`test/generico.test.ts`:
```ts
it("nada del núcleo nombra una temática ni la marca footy", () => {
  const prohibido = /\b(f[uú]tbol\w*|footy\w*|jugador\w*|futbolista\w*|gol(es)?)\b/i;
  const ficheros = [...listar("src", ".ts"), ...listar("plantilla", ".html"), ...listar("plantilla", ".json")];
  const hallazgos = ficheros.flatMap((f) => lineas(f).filter((l) => prohibido.test(l.texto)).map((l) => `${f}:${l.n}`));
  expect(hallazgos).toEqual([]);
});
it("con VIDEO_ENGINE_EMBEDDED=1 no lee .env", () => {
  // .env temporal con ELEVENLABS_VOICE_ID=desde-env junto a SERVER_ROOT simulado
  expect(cargarConfig({ VIDEO_ENGINE_EMBEDDED: "1" }).elevenVoiceId).toBeUndefined();
});
it("logs y cachés van a VIDEO_STATE_DIR", () => { /* importar estado.ts con VIDEO_STATE_DIR=tmp → STATE_DIR === tmp */ });
it("estado en ruta con acentos", () => { /* VIDEO_STATE_DIR="…/José Pérez/estado" → log.info escribe video.log ahí */ });
```
(`listar` y `lineas` son helpers del propio test con `fs.readdirSync` recursivo.)

- [ ] **Paso 2: Ejecutar y ver que falla**

Run: `cd video-mcp-server; npx vitest run test/generico.test.ts`
Esperado: FAIL con la lista de líneas que nombran footy/fútbol.

- [ ] **Paso 3: Renombrar y generalizar.** `config.ts`: `dotenv.config` solo si
  `process.env.VIDEO_ENGINE_EMBEDDED !== "1"`; `cargarConfig` lee `VIDEO_ROOT` (por defecto
  `path.join(os.homedir(), "Videos", "SEO Studio")`). `log.ts`, `capacidades.ts` y `musica.ts`
  usan `STATE_DIR` de `estado.ts`. `paths.ts`: `ID_RE = /^video\d{3}$/`, `ErrorFooty` →
  `ErrorVideo`. Textos de ayuda, descripciones de tools, ejemplos y plantillas sin temática:
  los ejemplos de fútbol se sustituyen por ejemplos neutros (una cifra, una comparación).

- [ ] **Paso 4: Ejecutar toda la batería**

Run: `npm test`
Esperado: PASS, incluidos `generico.test.ts` y `stdio.test.ts` (que ahora lista 12 tools
`video_*`).

- [ ] **Paso 5: Commit**

```bash
git add video-mcp-server
git commit -m "Vídeo: motor sin temática ni marca y con modo integrado"
```

---

### Tarea 5: Huecos de seguridad del motor

**Ficheros:**
- Modificar: `video-mcp-server/src/proceso.ts`, `paths.ts`, `herramientas.ts`, `render.ts`
- Test: `video-mcp-server/test/seguridad.test.ts`

**Interfaces:**
- Produce: `ejecutar(..., { timeoutMs })` mata **el árbol** del proceso al vencer y resuelve con
  `{ code: null, stdout, stderr, timeout: true }` (campo nuevo `timeout?: boolean` en
  `Resultado`). Constantes exportadas en `render.ts`: `TIMEOUT_CHECK_MS = 600_000`,
  `TIMEOUT_RENDER_MS = 3_600_000` (variable `VIDEO_TIMEOUT_RENDER_S` para tests).

- [ ] **Paso 1: Tests que fallan**

```ts
it("mata el árbol de procesos al vencer el timeout", async () => {
  // node -e que lanza un nieto `node -e "setInterval(()=>{},1e3)"` y escribe su pid en un fichero
  const r = await ejecutar(process.execPath, ["-e", SCRIPT_PADRE_CON_NIETO], { timeoutMs: 1500 });
  expect(r.timeout).toBe(true);
  await esperar(500);
  expect(sigueVivo(pidNieto())).toBe(false); // process.kill(pid, 0) lanza ESRCH
});
it("una consulta de catálogo que empieza por -- no se interpreta como opción", async () => {
  const llamadas = espiarEjecutar();
  await catalogo(cfg, { consulta: "--output=C:\\x" }).catch(() => {});
  expect(llamadas[0].args).toContain("--query=--output=C:\\x");
});
it("una imagen que es un enlace simbólico fuera de la carpeta del vídeo se rechaza", () => {
  // symlink img1.jpg -> fuera/secreto.jpg (saltar el test si el SO no permite crear symlinks)
  expect(() => imagenesValidadas(dirVideo)).toThrow(ErrorVideo);
});
it("render que supera VIDEO_TIMEOUT_RENDER_S falla con mensaje legible y la cola sigue", async () => {
  // HYPERFRAMES_BIN sustituido por un script que duerme; VIDEO_TIMEOUT_RENDER_S=2
  const j = await esperarJob((await encolarRender(id, o)).job_id);
  expect(j.estado).toBe("error");
  expect(j.error).toMatch(/superó el tiempo máximo de render/);
  expect((await esperarJob((await encolarRender(id2, o)).job_id)).estado).not.toBe("en_cola");
});
```

- [ ] **Paso 2: Ejecutar y ver que fallan**

Run: `npx vitest run test/seguridad.test.ts`
Esperado: FAIL (sin campo `timeout`, `--query` separado, sin validación de symlinks).

- [ ] **Paso 3: Implementar.** En Windows el árbol se mata con
  `spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true })`
  (`hijo.kill()` solo mata a Node y deja Chrome vivo); en otros SO, `process.kill(-pid)` con
  `detached: true`. `catalogo`: `"--query=" + consulta`. `buscarImagenes` → nueva
  `imagenesValidadas(dir)` que pasa cada ruta por `resolverDentro(dir, nombre)` (realpath).
  `comprobarComposicion` y el render usan `TIMEOUT_CHECK_MS` / `TIMEOUT_RENDER_MS`; con
  `r.timeout` el job falla con «La CLI de HyperFrames superó el tiempo máximo de render (N min)».

- [ ] **Paso 4: Ejecutar toda la batería**

Run: `npm test`
Esperado: PASS.

- [ ] **Paso 5: Commit**

```bash
git add video-mcp-server
git commit -m "Vídeo: timeout con árbol de procesos, catálogo y symlinks"
```

---

### Tarea 6: Clave de ElevenLabs (BYOK) en el backend (D7)

**Ficheros:**
- Modificar: `app-backend/app_backend/config.py`, `app-backend/app_backend/main.py`
- Test: `app-backend/tests/test_elevenlabs.py`

**Interfaces:**
- Produce:
  - `config.ELEVENLABS_KEY = "elevenlabs_api_key"` y
    `config.elevenlabs_api_key(store) -> str | None` (almacén primero, `ELEVENLABS_API_KEY` de
    entorno como respaldo de desarrollo, igual que `anthropic_api_key`).
  - `SettingsIn.elevenlabs_api_key: str | None` (`""` borra) y `settings_out()["has_elevenlabs_key"]`.
  - `POST /settings/validate-elevenlabs-key` con cuerpo `{api_key?: str}` →
    `{"valida": bool, "detalle": str | None}`; llama a `GET https://api.elevenlabs.io/v1/user`
    con cabecera `xi-api-key` (sin coste).
  - `create_app(..., elevenlabs_transport: httpx.AsyncBaseTransport | None = None)` para tests.

- [ ] **Paso 1: Tests que fallan**

```python
def test_guardar_y_borrar_clave_elevenlabs(client):
    r = client.put("/settings", json={"elevenlabs_api_key": "xi-buena"}, headers=AUTH)
    assert r.json()["has_elevenlabs_key"] is True
    assert "xi-buena" not in r.text
    r = client.put("/settings", json={"elevenlabs_api_key": ""}, headers=AUTH)
    assert r.json()["has_elevenlabs_key"] is False

def test_validar_clave_elevenlabs_buena(client_con_transporte):  # MockTransport: 200 en /v1/user
    r = client_con_transporte.post("/settings/validate-elevenlabs-key", json={"api_key": "xi-buena"}, headers=AUTH)
    assert r.json() == {"valida": True, "detalle": None}

def test_validar_clave_elevenlabs_mala(client_con_transporte):  # 401
    r = client_con_transporte.post("/settings/validate-elevenlabs-key", json={"api_key": "xi-mala"}, headers=AUTH)
    assert r.json() == {"valida": False, "detalle": "ElevenLabs no reconoce esta clave."}
    assert "xi-mala" not in r.text

def test_validar_sin_clave_400(client):
    assert client.post("/settings/validate-elevenlabs-key", json={}, headers=AUTH).status_code == 400

def test_sin_conexion_502(client_con_transporte_que_falla):
    r = client_con_transporte_que_falla.post("/settings/validate-elevenlabs-key", json={"api_key": "xi"}, headers=AUTH)
    assert r.status_code == 502 and "ElevenLabs" in r.json()["detail"]
```
(Fixtures `client` y `AUTH` como en `tests/test_api.py`.)

- [ ] **Paso 2: Ejecutar y ver que fallan**

Run: `cd app-backend; uv run pytest -q tests/test_elevenlabs.py`
Esperado: FAIL (`has_elevenlabs_key` no existe / 404 en la ruta).

- [ ] **Paso 3: Implementar** siguiendo el patrón de `anthropic_api_key` y `validate_key`
  (`main.py`). Mensajes: 401/403 → «ElevenLabs no reconoce esta clave.»; error de red → 502
  «No se pudo conectar con ElevenLabs: comprueba tu conexión.»; otro estado → 502
  «ElevenLabs respondió con un error (N).».

- [ ] **Paso 4: Ejecutar la batería del backend**

Run: `uv run pytest -q`
Esperado: PASS (incluido `test_registry.py` sin cambios).

- [ ] **Paso 5: Commit**

```bash
git add app-backend/app_backend/config.py app-backend/app_backend/main.py app-backend/tests/test_elevenlabs.py
git commit -m "Ajustes: clave de ElevenLabs en el almacén de secretos"
```

---

### Tarea 7: `MotorVideo`, el cliente del motor por stdio (D1)

**Ficheros:**
- Crear: `app-backend/app_backend/video.py`
- Modificar: `app-backend/app_backend/config.py` (rutas del motor), `app-backend/app_backend/main.py`
  (ciclo de vida y `GET /video/capacidades`)
- Crear: `app-backend/tests/motor_falso.py` (servidor MCP de prueba en Python)
- Test: `app-backend/tests/test_video.py`

**Interfaces:**
- Consume: las tools `video_*` de la tarea 4; `config.elevenlabs_api_key` de la tarea 6.
- Produce (lo que usa la fase 1):

```python
class MotorError(Exception): ...          # mensaje legible para la UI, nunca con la clave
class MotorNoDisponible(MotorError): ...  # el motor no arranca o murió

@dataclass(frozen=True)
class RespuestaMotor:
    texto: str
    datos: dict | list | None
    imagen: tuple[str, str] | None        # (mime, base64)

class MotorVideo:
    def __init__(self, comando: list[str], cwd: Path, env: Callable[[], dict[str, str]],
                 timeout_llamada: float = 120.0): ...
    async def llamar(self, tool: str, args: dict | None = None,
                     timeout: float | None = None) -> RespuestaMotor: ...
    async def cerrar(self) -> None: ...
    @property
    def pid(self) -> int | None: ...

def comando_motor() -> tuple[list[str], Path]   # (argv, cwd) según config.FROZEN
def entorno_motor(store) -> dict[str, str]      # env del hijo, se recalcula en cada arranque
```

- `config.VIDEO_ENGINE_DIR`: congelado → `Path(sys.executable).parent / "video-engine"`;
  desarrollo → `<repo>/video-mcp-server`. `comando_motor()`: congelado →
  `[VIDEO_ENGINE_DIR/"node"/"node.exe", VIDEO_ENGINE_DIR/"app"/"dist"/"index.js"]`; desarrollo →
  `["node", <repo>/video-mcp-server/dist/index.js]`. Variable `APP_BACKEND_VIDEO_CMD` (JSON con
  la lista) para que los tests usen `motor_falso.py`.
- `entorno_motor(store)`: `VIDEO_ENGINE_EMBEDDED=1`, `VIDEO_ROOT=STATE_DIR/"video"/"proyectos"`,
  `VIDEO_STATE_DIR=STATE_DIR/"video"/"estado"`, `HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`,
  `FFMPEG_DIR` y `HYPERFRAMES_BROWSER_PATH` del bundle si existen, y `ELEVENLABS_API_KEY`
  **solo si hay clave** (nunca vacía).
- `RespuestaMotor` se construye del `CallToolResult`: primer bloque de texto → `texto`, último
  bloque de texto parseado como JSON → `datos`, bloque imagen → `imagen`; `isError` →
  `MotorError(texto)`.
- Ruta `GET /video/capacidades` (protegida) → `video_capacidades` con `{"reprobar": false}`;
  `MotorNoDisponible` → 503, `MotorError` → 502, con `detail` = mensaje.
- `lifespan`: crea `app.state.motor` (sin arrancar el proceso) y llama a `cerrar()` al salir.
  El hijo hereda el Job Object del sidecar (Windows asigna los hijos al job del padre), así que
  muere con la app; no hace falta otro job.

- [ ] **Paso 1: `motor_falso.py`** con `MCPServer("motor-falso")` y tools `eco(texto) -> str`,
  `dormir(segundos: float) -> str`, `morir() -> str` (`os._exit(1)`), `pid() -> int`,
  `entorno(nombre: str) -> str` (devuelve `os.environ.get(nombre, "<ausente>")`), con
  `mcp.run()` por stdio.

- [ ] **Paso 2: Tests que fallan** (`tests/test_video.py`, todos con el motor falso salvo el
  último):

```python
async def test_llamada_devuelve_texto(motor):
    assert (await motor.llamar("eco", {"texto": "hola"})).texto == "hola"

async def test_arranque_perezoso(motor):
    assert motor.pid is None
    await motor.llamar("eco", {"texto": "x"})
    assert motor.pid is not None

async def test_arranque_concurrente_un_solo_proceso(motor):
    pids = await asyncio.gather(*(motor.llamar("pid") for _ in range(5)))
    assert len({p.texto for p in pids}) == 1

async def test_motor_muere_y_se_relanza(motor):
    antes = (await motor.llamar("pid")).texto
    with pytest.raises(MotorNoDisponible):
        await motor.llamar("morir")
    assert (await motor.llamar("pid")).texto != antes

async def test_timeout_de_llamada(motor):
    with pytest.raises(MotorError, match="no respondió en 1 s"):
        await motor.llamar("dormir", {"segundos": 5}, timeout=1)
    assert (await motor.llamar("eco", {"texto": "sigue"})).texto == "sigue"

async def test_env_del_motor_sin_clave(motor_con_store_vacio):
    assert (await motor_con_store_vacio.llamar("entorno", {"nombre": "ELEVENLABS_API_KEY"})).texto == "<ausente>"

async def test_cerrar_mata_el_proceso(motor):
    await motor.llamar("eco", {"texto": "x"}); pid = motor.pid
    await motor.cerrar()
    assert not psutil_pid_vivo(pid)   # helper con os.kill(pid, 0) / OpenProcess

async def test_motor_rutas_con_espacios_y_acentos(tmp_path):
    estado = tmp_path / "José Pérez" / "seo studio"
    # motor falso lanzado con cwd y VIDEO_STATE_DIR en esa ruta: responde y crea la carpeta

def test_ruta_capacidades_503_si_no_arranca(client_con_motor_roto):
    r = client_con_motor_roto.get("/video/capacidades", headers=AUTH)
    assert r.status_code == 503

@pytest.mark.skipif(not MOTOR_REAL_COMPILADO, reason="npm run build en video-mcp-server")
async def test_motor_real_lista_las_12_tools(motor_real):
    caps = await motor_real.llamar("video_capacidades", {"reprobar": False})
    assert caps.datos["hyperframes"] == "0.8.206"
```

- [ ] **Paso 3: Ejecutar y ver que fallan**

Run: `uv run pytest -q tests/test_video.py`
Esperado: FAIL con `ModuleNotFoundError: app_backend.video`.

- [ ] **Paso 4: Implementar `video.py`.** Una tarea `asyncio` propietaria mantiene el
  `AsyncExitStack` con `stdio_client(StdioServerParameters(command, args, env, cwd))` y
  `ClientSession(...).initialize()`; `llamar` toma un `asyncio.Lock` solo para el arranque, y
  envuelve `session.call_tool` en `asyncio.wait_for(timeout)`. Si la sesión se rompe
  (`anyio.ClosedResourceError`, `EOFError`, proceso terminado) → se descarta y se lanza
  `MotorNoDisponible("El motor de vídeo se ha detenido; se relanzará en la siguiente acción.")`.
  Timeout → `MotorError("El motor de vídeo no respondió en {n} s.")` y el proceso se reinicia
  (una llamada colgada puede dejar la sesión en mal estado). El `stderr` del hijo va al logger
  `app_backend.video` con la clave ocultada.

- [ ] **Paso 5: Ejecutar la batería**

Run: `uv run pytest -q`
Esperado: PASS; `test_motor_real_lista_las_12_tools` pasa si `video-mcp-server/dist` existe.

- [ ] **Paso 6: Commit**

```bash
git add app-backend/app_backend/video.py app-backend/app_backend/config.py app-backend/app_backend/main.py app-backend/tests/motor_falso.py app-backend/tests/test_video.py
git commit -m "Vídeo: cliente MCP del motor por stdio con relanzado y timeout"
```

---

### Tarea 8: Empaquetado del motor en el instalador (D10)

**Ficheros:**
- Crear: `app-ui/scripts/prepare-video-engine.sh`
- Modificar: `app-ui/src-tauri/tauri.conf.json` (`bundle.resources`)
- Modificar: `app-backend/scripts/smoke_test.py`
- Modificar: `.github/workflows/release.yml`
- Modificar: `.gitignore` (raíz: `app-ui/src-tauri/binaries/video-engine/`)

**Interfaces:**
- Consume: `comando_motor()` / `entorno_motor()` de la tarea 7 (layout congelado).
- Produce: en la carpeta de instalación, `video-engine/` con:
  `node/node.exe` · `app/` (`dist/`, `node_modules/` de producción, `plantilla/`, `catalogo/`,
  `package.json`) · `browser/` (Chrome headless de HyperFrames) · `ffmpeg/` (`ffmpeg.exe`,
  `ffprobe.exe`, LGPL) · `LICENSES/` (avisos de cada pieza).

- [ ] **Paso 1: `prepare-video-engine.sh`** (Git Bash, desde `app-ui/`): borra
  `src-tauri/binaries/video-engine`; `npm ci && npm run build` en `../video-mcp-server`; copia
  `dist`, `plantilla`, `catalogo`, `package.json` y ejecuta `npm ci --omit=dev` en el destino;
  descarga Node **v22.x win-x64** (versión y SHA-256 fijados en el script; aborta si el hash no
  coincide); obtiene el navegador con la CLI de HyperFrames (`hyperframes browser path` tras
  asegurarlo) y lo copia; copia el ffmpeg LGPL elegido en la tarea 2 (versión y SHA-256 fijados;
  aborta si `ffmpeg -encoders` lista `libx264`); copia licencias (`LICENSE` de hyperframes, gsap,
  three, fuentes OFL, ffmpeg, Node, navegador) a `LICENSES/`; imprime el tamaño total.

- [ ] **Paso 2: `tauri.conf.json`**: `"binaries/video-engine/": "video-engine/"` en
  `bundle.resources`.

- [ ] **Paso 3: Smoke test que falla.** En `smoke_test.py`, si existe
  `<exe>.parent/"video-engine"` (o el argumento `--video-engine RUTA`): `GET /video/capacidades`
  → 200, `hyperframes == "0.8.206"`, `telemetria` empieza por «desactivada» y `ffmpeg` no
  contiene `--enable-libx264`.

Run (Git Bash): `cd app-backend && uv run python scripts/smoke_test.py --video-engine ../app-ui/src-tauri/binaries/video-engine`
Esperado antes del paso 1: FAIL (no existe la carpeta / 503).

- [ ] **Paso 4: Construir y pasar el smoke test**

Run (Git Bash): `cd app-ui && bash scripts/prepare-video-engine.sh && cd ../app-backend && uv run python scripts/smoke_test.py --video-engine ../app-ui/src-tauri/binaries/video-engine`
Esperado: PASS e informe de tamaño (≈ 300 MB).

- [ ] **Paso 5: CI.** En `release.yml`, antes de «Tauri build»: paso «Motor de vídeo — tests y
  empaquetado» con `npm ci && npm test` en `video-mcp-server` y `bash scripts/prepare-video-engine.sh`
  en `app-ui`; el paso de smoke test pasa `--video-engine`.

- [ ] **Paso 6: Commit**

```bash
git add app-ui/scripts/prepare-video-engine.sh app-ui/src-tauri/tauri.conf.json app-backend/scripts/smoke_test.py .github/workflows/release.yml .gitignore
git commit -m "Empaquetado: motor de vídeo con Node, navegador y ffmpeg LGPL"
```

Verificación con la app instalada: la hace Marc (CLAUDE.md: no ejecutar el `-setup.exe` desde
una sesión). Paso manual pendiente en la PR: instalar, abrir Ajustes y comprobar
`GET /video/capacidades` desde la app.

---

### Tarea 9: Puerta de licencias y cierre de la fase 0

**Ficheros:**
- Crear: `video-mcp-server/LICENCIAS.md`
- Modificar: `SPEC-video.md` (D10/D11 con los resultados) y `HANDOFF-video-fase0.md` (nuevo)

**Interfaces:**
- Produce: el veredicto de redistribución de cada pieza y el resumen que alimenta el plan de la
  fase 1.

- [ ] **Paso 1: Leer los textos de licencia reales** en `node_modules` y en las descargas, y
  escribir en `LICENCIAS.md` una fila por pieza: nombre · versión · licencia · ¿se puede
  redistribuir en un .exe cerrado? · condiciones (aviso, atribución) · fuente del texto.
  Piezas: hyperframes, gsap (comprobar en su `LICENSE`/`README` si restringe herramientas que
  compitan con Webflow y si un editor de vídeo con línea de tiempo cae ahí), three, d3-geo,
  topojson, world-atlas/es-atlas, fuentes (OFL), shaders vendorizados
  (`plantilla/vendor/shaders.THIRD-PARTY-LICENSES.txt`), Node, ffmpeg LGPL, navegador.

- [ ] **Paso 2: Veredicto.** Si alguna pieza no se puede redistribuir o su licencia es dudosa,
  se marca como **bloqueante** y se lleva a Marc con la alternativa (p. ej. Chromium BSD o Edge
  del sistema para el navegador); no se avanza a la fase 1 con un bloqueante abierto.

- [ ] **Paso 3: Actualizar `SPEC-video.md`** (D11: formato intermedio y bitrate elegidos; D6:
  mecanismo de preview elegido) y escribir `HANDOFF-video-fase0.md` con lo hecho, las cifras de
  los spikes y lo que queda para la fase 1.

- [ ] **Paso 4: Commit**

```bash
git add video-mcp-server/LICENCIAS.md SPEC-video.md HANDOFF-video-fase0.md
git commit -m "Vídeo: licencias revisadas y cierre de la fase 0"
```
