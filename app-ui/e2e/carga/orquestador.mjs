/** Prueba de carga de /video/* (PR #27, SEO-107). Arranca el sidecar REAL en modo desarrollo solo en
 *  127.0.0.1, con un ElevenLabs falso local (VIDEO_PRUEBAS_TTS_URL + VIDEO_E2E=1) y un directorio de estado
 *  temporal; siembra datos; lanza k6 (también contra loopback); valida el disco y lo limpia todo.
 *
 *  Uso (Git Bash o PowerShell, desde app-ui/):  node e2e/carga/orquestador.mjs [--sonda] [--solo=a,b]
 *    --sonda   no lanza k6: imprime una respuesta de cada endpoint (para ajustar el guion).
 *  Fuera de `npm test` y de pytest: no lo recoge ningún runner.
 *  Requisitos: k6 en el PATH, `npm ci` + `npm run build` en video-mcp-server y `uv sync` en app-backend. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, "..", "..", ".."); // raíz del monorepo
const TOKEN = "carga-token-local";
const SONDA = process.argv.includes("--sonda");
const SOLO = (process.argv.find((a) => a.startsWith("--solo=")) ?? "").slice(7);
const N_BANDEJA = 14;
const salida = process.env.CARGA_SALIDA ?? join(raiz, "docs", "video-fase1", "carga-PR27.resumen.json");

const gb = () => {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "[math]::Round((Get-PSDrive C).Free/1GB,2)"], { encoding: "utf8" });
  return r.stdout.trim();
};
const log = (...a) => console.log("[carga]", ...a);

// ---------------------------------------------------------------- ElevenLabs falso (solo loopback)
const BYTES_FOTOGRAMA = 417;
const mp3Mudo = (s) => Buffer.concat(Array.from({ length: Math.max(1, Math.ceil(s / (1152 / 44100))) }, () => Buffer.from([0xff, 0xfb, 0x90, 0x00, ...new Array(BYTES_FOTOGRAMA - 4).fill(0)])));
function arrancarMock() {
  let sintesis = 0, caracteres = 0;
  const server = createServer((req, res) => {
    const json = (e, c) => (res.writeHead(e, { "Content-Type": "application/json" }), res.end(JSON.stringify(c)));
    if (req.method === "GET" && req.url === "/__llamadas") return json(200, { sintesis, caracteres });
    if (req.method === "GET" && /^\/v1\/voices(\?|$)/.test(req.url ?? "")) return json(200, { voices: [{ voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", labels: { language: "es" } }] });
    if (req.method !== "POST" || !/^\/v1\/text-to-speech\/[^/]+\/with-timestamps(\?|$)/.test(req.url ?? "")) return json(404, { detail: "No existe." });
    if (!req.headers["xi-api-key"]) return json(401, { detail: "Falta la clave." });
    let cuerpo = "";
    req.on("data", (d) => { cuerpo += d; if (cuerpo.length > 100_000) req.destroy(); });
    req.on("end", () => {
      let texto = "";
      try { texto = String(JSON.parse(cuerpo).text ?? ""); } catch { return json(422, { detail: "Cuerpo no válido." }); }
      if (!texto) return json(422, { detail: "Texto vacío." });
      sintesis++; caracteres += texto.length;
      const cs = [...texto], P = 0.06;
      json(200, {
        audio_base64: mp3Mudo(cs.length * P).toString("base64"),
        alignment: { characters: cs, character_start_times_seconds: cs.map((_, i) => +(i * P).toFixed(3)), character_end_times_seconds: cs.map((_, i) => +((i + 1) * P).toFixed(3)) },
        normalized_alignment: null,
      });
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${server.address().port}`, llamadas: () => ({ sintesis, caracteres }) })));
}

// ---------------------------------------------------------------- PNG sólido (sin dependencias)
function png(ancho, alto, [r, g, b]) {
  const trozo = (tipo, datos) => {
    const t = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(t) >>> 0);
    const l = Buffer.alloc(4); l.writeUInt32BE(datos.length);
    return Buffer.concat([l, t, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(ancho, 0); ihdr.writeUInt32BE(alto, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const fila = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: ancho }, () => [r, g, b]).flat())]);
  const crudo = Buffer.concat(Array.from({ length: alto }, () => fila));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo("IHDR", ihdr), trozo("IDAT", deflateSync(crudo, { level: 1 })), trozo("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- utilidades REST
let BASE = "";
const api = async (ruta, init = {}) => {
  const r = await fetch(BASE + ruta, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const texto = await r.text();
  let cuerpo; try { cuerpo = JSON.parse(texto); } catch { cuerpo = texto; }
  return { estado: r.status, cuerpo };
};
const exigir = (r, ok, que) => { if (!ok.includes(r.estado)) throw new Error(`${que}: HTTP ${r.estado} ${JSON.stringify(r.cuerpo).slice(0, 400)}`); return r.cuerpo; };

const GUION = {
  version: 1, titulo: "Carga", gancho: "Prueba de carga",
  escenas: [
    { frases: ["Esto es una prueba de carga.", "Solo se mide el tiempo de respuesta."], base: { tipo: "cartel", texto: "Carga", subtexto: "Piloto local" } },
    { frases: ["Tres frases bastan."], base: { tipo: "cifra", valor: 3, prefijo: "", sufijo: " frases", decimales: 0 },
      recurso: { tipo: "foto", que_debe_salir: "Un fondo de color", resolucion_minima: { ancho: 540, alto: 960 } } },
    { frases: ["Y se acabó."], base: { tipo: "cartel", texto: "Fin" } },
  ],
  opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [0] },
};

/** Direcciones en escucha de todos los procesos descendientes del sidecar (uv → python → node). */
function sockets() {
  const ps = `$h=@(${pids[0]}); $n=1; while($n){ $c=Get-CimInstance Win32_Process | Where-Object { $h -contains $_.ParentProcessId -and $h -notcontains $_.ProcessId }; $n=@($c).Count; $h+=@($c).ProcessId }; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $h -contains $_.OwningProcess } | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }`;
  return spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).stdout.trim().split(/\r?\n/).filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- limpieza (siempre)
const pids = [];
let stateDir = "";
let mock = null;
function matarArbol(pid) { if (pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
function limpiar() {
  for (const p of pids) matarArbol(p);
  try { mock?.server.close(); } catch {}
  if (stateDir && existsSync(stateDir)) {
    // `cmd rmdir` no sigue junctions (regla del repo); el estado no debería tener, pero la regla manda.
    for (let i = 0; i < 6 && existsSync(stateDir); i++) { // los procesos recién muertos tardan en soltar los ficheros
      spawnSync("cmd", ["/c", "rmdir", "/s", "/q", `\\\\?\\${stateDir}`], { stdio: "ignore" });
      if (existsSync(stateDir)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    if (existsSync(stateDir)) log("AVISO: no se pudo borrar", stateDir);
  }
}
process.on("exit", limpiar);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));

// ---------------------------------------------------------------- principal
async function main() {
  // Los puertos de la preview (SEO-127) deben estar libres: si hay algo, es la app instalada.
  const ocup = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 47810,47811,47812,47813 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: "utf8" }).stdout.trim();
  if (ocup !== "0") throw new Error("Hay algo escuchando en 47810–47813: pide a Marc que cierre SEO Studio.");
  const disco0 = gb(); log("Disco libre antes (GB):", disco0);

  stateDir = mkdtempSync(join(tmpdir(), "seo-studio-carga-"));
  mock = await arrancarMock();
  const vivo = await fetch(`${mock.url}/__llamadas`).then((r) => r.ok).catch(() => false);
  if (!vivo) throw new Error("El ElevenLabs falso no responde: se aborta para no llegar a api.elevenlabs.io.");

  const motor = join(raiz, "video-mcp-server", "dist", "index.js");
  if (!existsSync(motor)) throw new Error("Falta video-mcp-server/dist: ejecuta `npm ci && npm run build` en video-mcp-server.");
  const ffmpeg = (() => {
    const w = spawnSync("where", ["ffmpeg"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0]?.trim();
    return w ? dirname(w) : "";
  })();
  // Lista blanca de variables heredadas (como app-ui/e2e/entorno.ts): ninguna clave ni proxy.
  const heredadas = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR"];
  const env = Object.fromEntries(heredadas.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  Object.assign(env, {
    APP_BACKEND_SECRETS: "file", APP_BACKEND_DIR: stateDir, APP_BACKEND_TOKEN: TOKEN, APP_BACKEND_SIN_DOTENV: "1",
    ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", // sin salida: puerto discard cerrado
    // Sin internet: ni el actualizador de la KB (https://kb.mstne.dev, solo se admite http contra 127.0.0.1)
    // ni la descarga del modelo de embeddings de Hugging Face (la sonda vio una petición real sin esto).
    KB_UPDATE_URL: "http://127.0.0.1:9/kb/", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
    ELEVENLABS_API_KEY: "carga-eleven-falsa", ELEVENLABS_VOICE_ID: "voz-carga",
    // INSPECT=<segundos>: el motor abre el inspector de Node en 127.0.0.1:9333 (solo diagnóstico del hallazgo 1).
    APP_BACKEND_VIDEO_CMD: JSON.stringify(process.env.INSPECT ? ["node", "--inspect=127.0.0.1:9333", motor] : ["node", motor]),
    VIDEO_PRUEBAS_TTS_URL: mock.url, VIDEO_E2E: "1",
    ...(ffmpeg ? { FFMPEG_DIR: ffmpeg } : {}),
  });
  let stderr = "";
  const sidecar = spawn("uv", ["run", "--no-sync", "app-backend"], { cwd: join(raiz, "app-backend"), env, stdio: ["ignore", "pipe", "pipe"], shell: false });
  pids.push(sidecar.pid);
  sidecar.stderr.on("data", (d) => { stderr = (stderr + d).slice(-300_000); });
  const puerto = await new Promise((ok, ko) => {
    let buf = "";
    sidecar.stdout.on("data", (d) => { buf += d; const l = buf.split("\n")[0]; if (l.includes('"port"')) ok(JSON.parse(l).port); });
    sidecar.on("exit", (c) => ko(new Error(`El sidecar terminó con código ${c}\n${stderr.slice(-2000)}`)));
    setTimeout(() => ko(new Error("El sidecar no anunció el puerto en 90 s")), 90_000);
  });
  BASE = `http://127.0.0.1:${puerto}`;
  for (let i = 0; i < 120; i++) { // listo cuando /settings responde
    if ((await fetch(`${BASE}/settings`, { headers: { Authorization: `Bearer ${TOKEN}` } }).catch(() => ({ status: 599 }))).status < 500) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  log("Sidecar en", BASE, "(solo loopback)");
  const escuchando = sockets();
  log("Sockets en escucha del árbol del sidecar:", escuchando || "(ninguno)");
  if (!escuchando || /(^|\s)(0\.0\.0\.0|::):/.test(escuchando)) throw new Error("El sidecar no escucha o escucha fuera de loopback: se aborta.");

  // ---------------------------------------------------------------- siembra
  const g = exigir(await api("/video/guiones", { method: "POST", body: JSON.stringify({ guion: GUION }) }), [201], "crear guion");
  const crear = async () => exigir(await api("/video/proyectos", { method: "POST", body: JSON.stringify({ guion_id: g.id, perfil_id: "defecto" }) }), [201], "crear proyecto").id;
  const datos = { guion: g.id, listado: [], guardar: await crear(), recursos: await crear(), voz: await crear(), preview: await crear(), bandeja: [] };
  for (let i = 0; i < 6; i++) datos.listado.push(await crear());
  const bandeja = join(stateDir, "video", "bandeja");
  mkdirSync(bandeja, { recursive: true });
  for (let i = 0; i < N_BANDEJA; i++) {
    const id = Buffer.from(Array.from({ length: 16 }, (_, j) => (i * 16 + j * 7 + 1) & 255)).toString("hex");
    writeFileSync(join(bandeja, `${id}.bin`), png(540, 960, [(i * 20) % 256, 100, 200 - i * 10]));
    datos.bandeja.push(id);
  }
  // La preview exige la voz de todas las frases: se genera aquí (contra el mock) para el proyecto de la preview.
  const cp = exigir(await api(`/video/proyectos/${datos.preview}/voz/coste`, { method: "POST", body: "{}" }), [200], "coste preview");
  exigir(await api(`/video/proyectos/${datos.preview}/voz`, { method: "POST", body: JSON.stringify({ plan_confirmado: cp.plan, caracteres_confirmados: cp.caracteres }) }), [200], "voz preview");
  log("Sembrados:", datos.listado.length + 4, "proyectos y", N_BANDEJA, "archivos de bandeja");

  if (SONDA) {
    const mostrar = (n, r) => log(n, r.estado, JSON.stringify(r.cuerpo).slice(0, 500));
    mostrar("GET proyectos", await api("/video/proyectos"));
    mostrar("GET capacidades", await api("/video/capacidades"));
    const p = exigir(await api(`/video/proyectos/${datos.guardar}`), [200], "leer");
    log("proyecto claves:", Object.keys(p).join(","), "revision", p.revision);
    mostrar("PUT", await api(`/video/proyectos/${datos.guardar}`, { method: "PUT", body: JSON.stringify({ revision: p.revision, proyecto: p }) }));
    mostrar("recursos", await api(`/video/proyectos/${datos.recursos}/recursos`, { method: "POST", body: JSON.stringify({ bandeja_id: datos.bandeja[0], clase: "foto", nombre_original: "a.png" }) }));
    const c = await api(`/video/proyectos/${datos.voz}/voz/coste`, { method: "POST", body: "{}" });
    mostrar("coste", c);
    if (c.estado === 200) mostrar("voz", await api(`/video/proyectos/${datos.voz}/voz`, { method: "POST", body: JSON.stringify({ plan_confirmado: c.cuerpo.plan, caracteres_confirmados: c.cuerpo.caracteres }) }));
    const pv = await api(`/video/proyectos/${datos.preview}/preview`, { method: "POST", body: "{}" });
    mostrar("preview", pv);
    if (pv.estado === 200) { const r = await fetch(pv.cuerpo.url); log("GET preview url", r.status, (await r.text()).length, "bytes"); }
    log("ElevenLabs falso:", JSON.stringify(mock.llamadas()));
    log("stderr sidecar (cola):", stderr.slice(-1500));
    return;
  }

  if (process.argv.includes("--conexion")) { // hallazgo 1: ¿qué respuesta deja inservible una conexión keep-alive?
    const { request, Agent } = await import("node:http");
    const agente = new Agent({ keepAlive: true, maxSockets: 1 });
    const pet = (metodo, ruta, cuerpo, plazo = 15_000) => new Promise((ok) => {
      const t0 = Date.now();
      const datosCuerpo = cuerpo === undefined ? undefined : JSON.stringify(cuerpo);
      const req = request(BASE + ruta, { method: metodo, agent: agente, timeout: plazo, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(datosCuerpo ? { "Content-Length": Buffer.byteLength(datosCuerpo) } : {}) } }, (res) => {
        let t = ""; res.on("data", (d) => (t += d)); res.on("end", () => { let j; try { j = JSON.parse(t); } catch {} ok({ estado: res.statusCode, ms: Date.now() - t0, j }); });
      });
      req.on("timeout", () => { req.destroy(); ok({ estado: "TIMEOUT", ms: Date.now() - t0 }); });
      req.on("error", (e) => ok({ estado: "ERROR " + e.code, ms: Date.now() - t0 }));
      if (datosCuerpo) req.write(datosCuerpo);
      req.end();
    });
    const id = datos.guardar;
    const dosRecursos = (n) => pet("POST", `/video/proyectos/${datos.recursos}/recursos`, { bandeja_id: datos.bandeja[n], clase: "foto", nombre_original: `c${n}.png` });
    const resumen = (r) => `${r.estado}/${r.ms}ms`;
    const leer = async () => (await pet("GET", `/video/proyectos/${id}`)).j;
    let p = await leer();
    log("CONEXION 1 PUT ok →", resumen(await pet("PUT", `/video/proyectos/${id}`, { revision: p.revision, proyecto: p })), "→ importación:", resumen(await dosRecursos(0)));
    p = await leer();
    const vieja = { ...p, revision: p.revision - 1 };
    log("CONEXION 2 PUT 409 →", resumen(await pet("PUT", `/video/proyectos/${id}`, { revision: vieja.revision, proyecto: vieja })), "→ importación:", resumen(await dosRecursos(1)));
    let r409 = [];
    for (let i = 0; i < 300; i++) { p = await leer(); const v = { ...p, revision: p.revision - 1 }; r409.push((await pet("PUT", `/video/proyectos/${id}`, { revision: v.revision, proyecto: v })).estado); }
    log("CONEXION 3 tras 300 PUT 409 seguidos (estados únicos:", [...new Set(r409)].join(","), ") → importación:", resumen(await dosRecursos(2)));
    log("CONEXION 4 coste →", resumen(await pet("POST", `/video/proyectos/${datos.voz}/voz/coste`, {})), " preview →", resumen(await pet("POST", `/video/proyectos/${datos.preview}/preview`, {})));
    for (const [i, espera] of [2, 4.5, 4.95, 5.05, 6].entries()) { // tiempo ocioso de la conexión antes de reutilizarla
      await leer();
      await new Promise((r) => setTimeout(r, espera * 1000));
      log(`CONEXION 5 tras ${espera} s ociosa → importación:`, resumen(await dosRecursos(3 + i)));
    }
    agente.destroy();
    return;
  }

  // ---------------------------------------------------------------- k6 (solo loopback)
  const envK6 = { ...process.env, ...(SOLO ? { SOLO } : {}), BASE, TOKEN, DATOS: JSON.stringify(datos), K6_NO_USAGE_REPORT: "true" };
  const argsK6 = ["run", "--summary-export", salida, join(aqui, "carga.k6.js")];
  let k6;
  if (process.env.INSPECT) { // k6 en paralelo; a los INSPECT segundos se pide al motor su informe de diagnóstico
    const hijoK6 = spawn("k6", argsK6, { env: envK6, stdio: "ignore" });
    pids.push(hijoK6.pid);
    const fin = new Promise((ok) => hijoK6.on("exit", (c) => ok({ status: c })));
    await new Promise((r) => setTimeout(r, Number(process.env.INSPECT) * 1000));
    const arbolHijos = spawnSync("powershell", ["-NoProfile", "-Command", `$h=@(${pids[0]}); $n=1; while($n){ $c=Get-CimInstance Win32_Process | Where-Object { $h -contains $_.ParentProcessId -and $h -notcontains $_.ProcessId }; $n=@($c).Count; $h+=@($c).ProcessId }; Get-CimInstance Win32_Process | Where-Object { $h -contains $_.ProcessId -and $_.Name -notmatch 'uv|app-backend|python|conhost' } | ForEach-Object { $cpu=(Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue); '{0} pid={1} ppid={2} cpu={3} inicio={4} :: {5}' -f $_.Name,$_.ProcessId,$_.ParentProcessId,[math]::Round($cpu.CPU,1),$cpu.StartTime.ToString('HH:mm:ss'),($_.CommandLine -replace '\\s+',' ').Substring(0,[Math]::Min(330,$_.CommandLine.Length)) }`], { encoding: "utf8" }).stdout.trim();
    log("INSPECT hijos del motor en pleno cuelgue:\n" + arbolHijos);
    const detalleFfmpeg = spawnSync("powershell", ["-NoProfile", "-Command", `$p=Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe' OR Name='ffprobe.exe'"; foreach($x in $p){ $g=Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue; 'EDAD={0}s hilos={1} manejadores={2} cpu={3}' -f [math]::Round(((Get-Date)-$g.StartTime).TotalSeconds,1),$g.Threads.Count,$g.HandleCount,$g.CPU; 'ESTADOS HILOS: ' + (($g.Threads | ForEach-Object { [string]$_.ThreadState + '/' + [string]$_.WaitReason }) -join ' '); 'CMD COMPLETA: ' + $x.CommandLine }`], { encoding: "utf8" }).stdout.trim();
    log("INSPECT detalle del ffmpeg/ffprobe vivo:\n" + detalleFfmpeg);
    try {
      const lista = await (await fetch("http://127.0.0.1:9333/json")).json();
      const ws = new WebSocket(lista[0].webSocketDebuggerUrl);
      await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; });
      const informe = await new Promise((ok) => {
        ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id === 1) ok(j); };
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "JSON.stringify(process.report.getReport())", returnByValue: true } }));
      });
      ws.close();
      const rep = JSON.parse(informe.result.result.value);
      const porTipo = {};
      for (const h of rep.libuv) { const k = `${h.type}${h.is_active ? "(activo)" : ""}`; porTipo[k] = (porTipo[k] ?? 0) + 1; }
      log("INSPECT libuv por tipo:", JSON.stringify(porTipo));
      log("INSPECT pila de JS:", (rep.javascriptStack?.stack ?? []).slice(0, 8).join(" | "));
      log("INSPECT hilos del pool de libuv / workers:", JSON.stringify({ uvthreadpool: rep.header?.uvthreadpoolSize, cpu: rep.resourceUsage ?? null }).slice(0, 300));
      writeFileSync(join(raiz, "docs", "video-fase1", "carga-PR27.informe-motor-colgado.json"), JSON.stringify({ libuv: rep.libuv, javascriptStack: rep.javascriptStack, nativeStack: rep.nativeStack?.slice(0, 20), header: { nodeVersion: rep.header?.nodeVersion } }, null, 1));
    } catch (e) { log("INSPECT falló:", e.message); }
    k6 = await fin;
  } else if (process.env.K6_BLOQUEANTE) { // solo para reproducir el artefacto: spawnSync deja de drenar el stderr del sidecar
    k6 = spawnSync("k6", argsK6, { env: envK6, stdio: "inherit" });
  } else {
    // Asíncrono a propósito: con spawnSync el orquestador no lee las tuberías del sidecar durante la ejecución, se llenan
    // (64 KB) y el sidecar se bloquea al escribir logs (falso positivo de «cuelgue» en las primeras ejecuciones).
    const hijoK6 = spawn("k6", argsK6, { env: envK6, stdio: "inherit" });
    pids.push(hijoK6.pid);
    k6 = await new Promise((ok) => hijoK6.on("exit", (c) => ok({ status: c })));
  }
  log("k6 terminó con código", k6.status, "(99 = umbrales incumplidos)");

  if (process.argv.includes("--diag")) { // diagnóstico del hallazgo 1: ¿qué hace el motor mientras la importación está colgada?
    const arbol = () => spawnSync("powershell", ["-NoProfile", "-Command", `$h=@(${pids[0]}); $n=1; while($n){ $c=Get-CimInstance Win32_Process | Where-Object { $h -contains $_.ParentProcessId -and $h -notcontains $_.ProcessId }; $n=@($c).Count; $h+=@($c).ProcessId }; Get-CimInstance Win32_Process | Where-Object { $h -contains $_.ProcessId } | ForEach-Object { $cpu=(Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).CPU; '{0} pid={1} ppid={2} cpu={3} hilos={4} :: {5}' -f $_.Name,$_.ProcessId,$_.ParentProcessId,[math]::Round($cpu,1),$_.ThreadCount,($_.CommandLine -replace '\s+',' ').Substring(0,[Math]::Min(110,$_.CommandLine.Length)) }`], { encoding: "utf8" }).stdout.trim();
    const t0 = Date.now();
    const colgada = fetch(`${BASE}/video/proyectos/${datos.recursos}/recursos`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ bandeja_id: datos.bandeja[13], clase: "foto" }), signal: AbortSignal.timeout(45_000) }).then((r) => `HTTP ${r.status} en ${Date.now() - t0} ms`, (e) => `sin respuesta en ${Date.now() - t0} ms (${e.name})`);
    await new Promise((r) => setTimeout(r, 12_000));
    log("DIAG árbol (12 s tras lanzar la importación):\n" + arbol());
    await new Promise((r) => setTimeout(r, 5_000));
    log("DIAG árbol (17 s):\n" + arbol());
    log("DIAG bandeja:", readdirSync(bandeja).length, "archivos;", "motor responde a GET /proyectos:", await fetch(BASE + "/video/proyectos", { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.status));
    log("DIAG resultado de la importación:", await colgada);
    log("DIAG stderr del sidecar, últimas 8 líneas:\n" + stderr.split("\n").slice(-8).join("\n"));
  }

  // ---------------------------------------------------------------- estado del motor tras la carga
  const medir = async (nombre, ruta, init) => {
    const t0 = Date.now();
    try { const r = await fetch(BASE + ruta, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000) }); await r.text(); return `${nombre}=${r.status}/${Date.now() - t0}ms`; }
    catch { return `${nombre}=SIN_RESPUESTA(15s)`; }
  };
  const tabla = async () => [
    await medir("GET /proyectos", "/video/proyectos"),
    await medir("GET /proyectos/{voz}", `/video/proyectos/${datos.voz}`),
    await medir("coste(voz)", `/video/proyectos/${datos.voz}/voz/coste`, { method: "POST", body: "{}" }),
    await medir("coste(preview)", `/video/proyectos/${datos.preview}/voz/coste`, { method: "POST", body: "{}" }),
    await medir("preview", `/video/proyectos/${datos.preview}/preview`, { method: "POST", body: "{}" }),
  ].join("  ");
  log("Estado del motor justo después de k6:", await tabla());
  await new Promise((r) => setTimeout(r, 25_000));
  log("Estado del motor 25 s más tarde:    ", await tabla());



  // ---------------------------------------------------------------- verificación en disco
  const problemas = [];
  const raizProyectos = join(stateDir, "video", "proyectos");
  const ids = readdirSync(raizProyectos);
  for (const id of ids) {
    const f = join(raizProyectos, id, "proyecto.json");
    try { const j = JSON.parse(readFileSync(f, "utf8")); if (j.id !== id || !Number.isInteger(j.revision)) problemas.push(`${id}: id/revision no válidos`); }
    catch (e) { problemas.push(`${id}: proyecto.json ilegible (${e.message})`); }
    const tmp = readdirSync(join(raizProyectos, id)).filter((n) => /\.tmp|\.partial|~$/.test(n));
    if (tmp.length) problemas.push(`${id}: restos temporales ${tmp.join(",")}`);
  }
  // Y por la API: cada proyecto se lee y valida por el motor (esquema).
  for (const id of ids) { const r = await api(`/video/proyectos/${id}`); if (r.estado !== 200) problemas.push(`${id}: GET devolvió ${r.estado}`); }
  const contar = (d) => readdirSync(d, { withFileTypes: true }).reduce((a, e) => { const p = join(d, e.name); if (e.isDirectory()) { const s = contar(p); return { n: a.n + s.n, b: a.b + s.b }; } return { n: a.n + 1, b: a.b + statSync(p).size }; }, { n: 0, b: 0 });
  const inventario = Object.fromEntries(["guardar", "recursos", "voz", "preview"].map((k) => [k, contar(join(raizProyectos, datos[k]))]));
  log("Inventario de ficheros por proyecto (n, bytes):", JSON.stringify(inventario));
  log("CPU del motor (node) al terminar:", spawnSync("powershell", ["-NoProfile", "-Command", `$h=@(${pids[0]}); $n=1; while($n){ $c=Get-CimInstance Win32_Process | Where-Object { $h -contains $_.ParentProcessId -and $h -notcontains $_.ProcessId }; $n=@($c).Count; $h+=@($c).ProcessId }; Get-Process -Id $h -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName + ':' + [math]::Round($_.CPU,1) + 's' } | Out-String`], { encoding: "utf8" }).stdout.trim().replace(/\r?\n/g, " "));
  const finales = { revision_guardar: JSON.parse(readFileSync(join(raizProyectos, datos.guardar, "proyecto.json"), "utf8")).revision, llamadas_tts: mock.llamadas() };
  log("Verificación del disco:", problemas.length ? `FALLA\n  ${problemas.join("\n  ")}` : `OK (${ids.length} proyectos válidos)`, JSON.stringify(finales));
  if (SOLO || k6.status) log("stderr del sidecar (motor):\n" + stderr.split("\n").filter((l) => /motor|video|Traceback|timeout/i.test(l)).slice(-25).join("\n"));
  log("stderr del sidecar, líneas con 5xx/Traceback:", (stderr.split("\n").filter((l) => /Traceback|500 Internal|ERROR/.test(l)).slice(0, 15).join("\n") || "ninguna"));
  writeFileSync(salida.replace(".resumen.json", ".verificacion.json"), JSON.stringify({ problemas, ...finales, proyectos: ids.length, disco_antes_gb: disco0, k6_codigo: k6.status }, null, 2));
  process.exitCode = problemas.length ? 2 : k6.status ?? 1;
}

try { await main(); } catch (e) { console.error("[carga] ERROR:", e.message); process.exitCode = 1; }
finally { limpiar(); log("Disco libre después (GB):", gb()); }
