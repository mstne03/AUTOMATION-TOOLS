// W1.1 (SEO-114): conductor de los escenarios S0–S9 del fallo de fase del fondo shader en la preview.
// Uso: node spikes/shader/repro.mjs --navegador <exe> --escenario S2 [--repeticiones 3] [--variantes a,b]
//        [--arreglo ninguno|reseek|calentamiento|cola] [--modo directo|iframe] [--csp ninguna|producto]
//        [--esperar-seek si|no] [--instantes 1,10,25,45] [--play 50.4] [--etiqueta x] [--headless shell|new|no]
// Antes: node spikes/shader/montar.mjs. Salidas en spikes/salidas/shader/<escenario><etiqueta>/ (ignorada por git).
// Seguridad (I2, R0): CDP por pipe (sin puerto), sandbox por defecto, banderas prohibidas → aborta, cierre de red
// por proxy y host-resolver-rules con control positivo en cada lanzamiento, lista blanca de peticiones.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { servir } from "./servir.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SALIDAS = path.join(AQUI, "..", "salidas", "shader");
const { values: a } = parseArgs({
  options: {
    navegador: { type: "string" },
    escenario: { type: "string", default: "S0" },
    "esperar-seek": { type: "string", default: "si" }, // si (plan: tras __hfWaitForSeekCompletion) | no (como la preview)
    repeticiones: { type: "string", default: "1" },
    variantes: { type: "string", default: "" },
    arreglo: { type: "string", default: "ninguno" },
    modo: { type: "string", default: "directo" },
    csp: { type: "string", default: "ninguna" },
    instantes: { type: "string", default: "1,10,25,45" },
    play: { type: "string", default: "50.4" },
    etiqueta: { type: "string", default: "" },
    comp: { type: "string", default: path.join(SALIDAS, "comp") },
    headless: { type: "string", default: "shell" }, // shell (CfT headless-shell) | new (Chrome de sistema) | no (con ventana)
  },
});
if (!a.navegador || !fs.existsSync(a.navegador)) throw new Error("--navegador debe ser la ruta de un ejecutable existente");
if (!["ninguno", "reseek", "calentamiento", "cola"].includes(a.arreglo)) throw new Error("--arreglo no válido");
if (!["directo", "iframe"].includes(a.modo)) throw new Error("--modo no válido");
if (!["ninguna", "producto"].includes(a.csp)) throw new Error("--csp no válida");
if (!["si", "no"].includes(a["esperar-seek"])) throw new Error("--esperar-seek no válido");
const variantes = a.variantes ? a.variantes.split(",") : [];
if (a.arreglo === "cola" && !variantes.includes("instrumentarShaders")) variantes.push("instrumentarShaders");
const INSTANTES = a.instantes.split(",").map(Number);
const PLAY = Number(a.play);
const N = Number(a.repeticiones);
const DIR_NAV = path.dirname(path.resolve(a.navegador));
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

const RESOLVER = "MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1";
const ARGS = [
  "--enable-unsafe-webgpu",
  "--disable-dawn-features=use_dxc",
  "--use-gl=angle",
  "--use-angle=d3d11",
  "--enable-gpu-rasterization",
  "--ignore-gpu-blocklist",
  "--autoplay-policy=no-user-gesture-required",
  "--proxy-server=127.0.0.1:1",
  `--host-resolver-rules=${RESOLVER}`,
];
const PROHIBIDAS = ["--no-sandbox", "--single-process", "--in-process-gpu", "--disable-web-security", "--use-webgpu-adapter=swiftshader"];

// ---- Procesos y puertos (L3 y M1) ----
// Con el CfT cuenta todo lo que cuelga de su carpeta; con el Chrome del sistema (que Marc usa a diario) solo los
// procesos con nuestro perfil temporal en la línea de órdenes, para no contar ni tocar su navegador.
const ES_CFT = path.basename(a.navegador).toLowerCase() === "chrome-headless-shell.exe";
function procesosBajo(...dirs) {
  const filtro = dirs.map((d) => `$_.ExecutablePath -like '${path.resolve(d).replace(/'/g, "''")}\\*'`).join(" -or ");
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and (${filtro}) } | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress`],
    { encoding: "utf8", timeout: 60000 },
  ).trim();
  const v = out ? JSON.parse(out) : [];
  return (Array.isArray(v) ? v : [v]).filter((p) => ES_CFT || (p.CommandLine ?? "").includes(path.join("shader", "perfil-tmp")));
}
// Sin `-p`: TCP y UDP, IPv4 e IPv6. TCP solo en LISTENING; UDP no tiene estado (columna 4 = PID).
function escuchas() {
  const out = execFileSync("netstat.exe", ["-ano"], { encoding: "utf8", timeout: 60000 });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => (c[0] === "TCP" && c[3] === "LISTENING") || c[0] === "UDP")
    .map((c) => ({ proto: c[0], local: c[1], pid: Number(c[0] === "TCP" ? c[4] : c[3]) }));
}

// ---- Lanzamiento ----
async function lanzar(dirEsc) {
  const perfil = path.join(SALIDAS, "perfil-tmp", crypto.randomUUID());
  fs.mkdirSync(perfil, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: a.navegador,
    headless: a.headless === "no" ? false : a.headless === "new" ? true : "shell",
    pipe: true, // CDP por pipe: el navegador no abre puerto de depuración (R0 M1)
    userDataDir: perfil, // perfil nuevo, nunca el real (R0 L1)
    args: ARGS,
    defaultViewport: { width: 1080, height: 1920, deviceScaleFactor: 1 },
    protocolTimeout: 300000,
  });
  const spawnargs = browser.process()?.spawnargs ?? [];
  fs.writeFileSync(path.join(dirEsc, "lanzamiento.json"), JSON.stringify({ navegador: a.navegador, version: await browser.version(), pid: browser.process()?.pid, spawnargs }, null, 2));
  const malas = spawnargs.filter((x) => PROHIBIDAS.some((p) => x === p || x.startsWith(p + "=")));
  const faltan = ["--proxy-server=127.0.0.1:1", `--host-resolver-rules=${RESOLVER}`].filter((x) => !spawnargs.includes(x));
  const cierre = async () => { await browser.close().catch(() => {}); fs.rmSync(perfil, { recursive: true, force: true }); };
  if (malas.length || faltan.length) {
    await cierre();
    throw new Error(`banderas no permitidas ${JSON.stringify(malas)} o ausentes ${JSON.stringify(faltan)}: aborto`);
  }
  return { browser, cierre };
}

// ---- Control positivo de red (R0 M4), en página sin CSP ----
async function controlRed(page, base) {
  await page.goto(base + "__vacio.html");
  const r = await page.evaluate(async () => {
    const intento = async (f) => { try { await f(); return "ok"; } catch (e) { return "falló: " + (e && e.message); } };
    const ip = await intento(() => fetch("http://203.0.113.1/", { mode: "no-cors", cache: "no-store" }));
    const dns = await intento(() => fetch("http://ejemplo.test/", { mode: "no-cors", cache: "no-store" }));
    const ws = await new Promise((ok) => {
      const w = new WebSocket("ws://203.0.113.1/");
      const t = setTimeout(() => ok("timeout"), 15000);
      w.onopen = () => { clearTimeout(t); w.close(); ok("ok"); };
      w.onerror = () => { clearTimeout(t); ok("falló"); };
    });
    return { ip, dns, ws };
  });
  if (![r.ip, r.dns, r.ws].every((x) => x.startsWith("falló"))) throw new Error(`control positivo de red: algo NO falló ${JSON.stringify(r)}: aborto`);
  return r;
}

async function sondaGpu(page) {
  return page.evaluate(async () => {
    if (!navigator.gpu) return { gpu: false };
    const ad = await navigator.gpu.requestAdapter();
    if (!ad) return { gpu: true, adaptador: null };
    const i = ad.info || {};
    return { gpu: true, adaptador: { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, isFallbackAdapter: i.isFallbackAdapter ?? ad.isFallbackAdapter ?? null } };
  });
}

// ---- Diagnóstico en la página (lectura) ----
const DIAG = () => {
  const d = window.__dbgShader;
  let anim = null;
  if (d) {
    anim = {};
    for (const [id, n] of d.Ji.getNodeRegistry().nodes) { for (const k of Object.keys(n._liveHandles || {})) if (k.startsWith("_anim")) anim[id + "." + k] = n._liveHandles[k].value; if (n.uniforms && n.uniforms.speed) anim[id + ".speed"] = n.uniforms.speed.value; }
  }
  const f = d ? d.diag() : null;
  const q = d ? { encolados: d.q.encolados, resueltos: d.q.resueltos, rechazados: d.q.rechazados, ultimoPedido: d.q.ultimoPedido, vaciado: d.q.vaciado } : null;
  return { ahora: performance.now(), player: window.__player.getTime(), typegpu: window.__hfTypegpuTime, Pe: f ? f.globalElapsedTime : null, animating: f ? f.animating : null, anim, q, nSeeks: window.__traza.seeks.length, ultimoSeek: window.__traza.seeks.at(-1) ?? null, csp: window.__traza.csp.length };
};

// ---- Una sesión: página cargada y lista, con helpers de seek/captura/play ----
async function sesion(browser, srv, dirRep, extra) {
  const page = await browser.newPage();
  const externas = (extra.externas = []);
  let enControl = false;
  const permitida = (u) => u.startsWith(`http://127.0.0.1:${srv.puerto}/`) || u.startsWith("data:") || u.startsWith("blob:");
  page.on("request", (r) => { if (!permitida(r.url())) externas.push({ url: r.url(), control: enControl }); });
  const consola = (extra.consola = []);
  page.on("console", (m) => consola.length < 500 && consola.push(`${m.type()}: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => consola.push(`pageerror: ${e.message}`));
  await page.evaluateOnNewDocument(fs.readFileSync(path.join(AQUI, "sonda.js"), "utf8"));

  enControl = true;
  const red = (extra.controlRed = await controlRed(page, srv.url));
  enControl = false;
  const gpu = (extra.gpu = await sondaGpu(page));

  if (a.modo === "directo") await page.goto(srv.url);
  else {
    await page.goto(srv.url + "__host.html");
    await page.waitForFunction(() => window.__listo, { timeout: 60000 });
  }
  const marco = () => (a.modo === "directo" ? page.mainFrame() : page.frames().find((f) => f.url() === srv.url));
  const f = marco();
  if (!f) throw new Error("no encuentro el marco de la composición");
  await f.waitForFunction(() => !!(window.__player && window.__hf && window.__hf.buildReady && window.__hf.buildReady.shaders), { timeout: 60000 });
  await f.evaluate(() => window.__hf.buildReady.shaders);
  await f.waitForFunction(() => document.querySelector("canvas[data-shader]"), { timeout: 60000 });
  await esperar(1000);
  const capturas = [];
  const instrumentado = variantes.includes("instrumentarShaders") || variantes.includes("shadersUltimoGana");
  const diag = () => f.evaluate(DIAG);

  const esperarCola = async (tope = 120000) => {
    const t0 = Date.now();
    await f.waitForFunction(() => { const q = window.__dbgShader.q; return q.resueltos + q.rechazados === q.encolados; }, { timeout: tope, polling: 20 });
    return Date.now() - t0;
  };

  // Seek "crudo" por la ruta de la preview: __player.seek (directo) o postMessage {tipo:"seek"} (iframe).
  const seekCrudo = async (t) => {
    if (a.modo === "directo") {
      await f.evaluate((t, reseek) => { window.__player.seek(t); if (reseek) window.__hfReseekGpu(t); }, t, a.arreglo === "reseek");
      return null;
    }
    const r = await page.evaluate((t) => window.__enviar({ tipo: "seek", t }, true), t);
    if (!r || r.tipo !== "seek-hecho") throw new Error(`respuesta inesperada del iframe: ${JSON.stringify(r)}`);
    return r;
  };
  const seek = async (t) => {
    const t0 = performance.now();
    if (a.arreglo === "calentamiento") {
      await seekCrudo(t + 0.5 <= PLAY ? t + 0.5 : t - 0.5);
      if (a["esperar-seek"] === "si") await f.evaluate(() => window.__hfWaitForSeekCompletion && window.__hfWaitForSeekCompletion());
      else await f.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    }
    const resp = await seekCrudo(t);
    // --esperar-seek no reproduce la preview real: CONTROL_JS responde tras seek + dos rAF, sin esperar al shader.
    if (a["esperar-seek"] === "si") await f.evaluate(() => window.__hfWaitForSeekCompletion && window.__hfWaitForSeekCompletion());
    let msCola = null;
    if (a.arreglo === "cola") msCola = await esperarCola();
    await f.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    return { msHastaListo: performance.now() - t0, resp, msCola };
  };
  const capturar = async (nombre, extra = {}) => {
    const el = a.modo === "directo" ? await page.$("canvas[data-shader]") : await page.$("#f");
    const png = path.join(dirRep, `${nombre}.png`);
    await el.screenshot({ path: png });
    const c = { nombre, png, sha256: crypto.createHash("sha256").update(fs.readFileSync(png)).digest("hex"), ...extra };
    if (instrumentado) c.diag = await diag();
    capturas.push(c);
    return c;
  };
  const seekYCapturar = async (t, { retardo = 1500, etiqueta = "" } = {}) => {
    const s = await seek(t);
    await esperar(retardo);
    return capturar(`t${t}${etiqueta}`, { t, retardo, ...s });
  };
  const play = async (s) => {
    if (a.modo === "directo") await f.evaluate(() => window.__player.play());
    else await page.evaluate(() => window.__enviar({ tipo: "play" }));
    await esperar(s * 1000);
    if (a.modo === "directo") await f.evaluate(() => window.__player.pause());
    else await page.evaluate(() => window.__enviar({ tipo: "pause" }));
    const alPausar = instrumentado ? await diag() : await f.evaluate(() => ({ player: window.__player.getTime(), typegpu: window.__hfTypegpuTime, nSeeks: window.__traza.seeks.length }));
    await esperar(300); // deja disparar el intervalo de 250 ms del adaptador typegpu (escenario real de la preview)
    return alPausar;
  };
  const traza = () => f.evaluate(() => ({ seeks: window.__traza.seeks, escrituras: window.__traza.escrituras, csp: window.__traza.csp, deltas: window.__dbgShader ? window.__dbgShader.q.deltas : null }));
  return { page, f, red, gpu, externas, consola, capturas, seek, seekYCapturar, capturar, play, diag, esperarCola, traza };
}

// ---- Escenarios ----
const ESCENARIOS = {
  async S0(s, extra) {
    extra.puertos = await comprobarPuertos(s);
    await s.seekYCapturar(1);
  },
  async S1(s) { for (const t of INSTANTES) await s.seekYCapturar(t); },
  async S2(s, extra) {
    extra.alPausar = await s.play(PLAY);
    for (const t of INSTANTES) await s.seekYCapturar(t);
  },
  async S4(s) {
    for (const t of INSTANTES) {
      await s.seek(50);
      await esperar(300);
      await s.seekYCapturar(t);
    }
  },
  async S5(s, extra) {
    extra.alPausar = await s.play(PLAY);
    extra.trasEspera = await s.diag();
    for (const t of INSTANTES) await s.seekYCapturar(t);
    extra.traza = await s.traza();
  },
  async S6(s, extra) {
    extra.alPausar = await s.play(PLAY);
    extra.msVaciarCola = await s.esperarCola();
    await esperar(30000);
    extra.trasEspera = await s.diag();
    for (const t of INSTANTES) await s.seekYCapturar(t);
  },
  async S7(s, extra) {
    extra.alPausar = await s.play(PLAY);
    for (const t of INSTANTES) {
      await s.seek(t);
      let previo = 0;
      for (const r of [200, 1500, 4000, 10000]) {
        await esperar(r - previo);
        previo = r;
        await s.capturar(`t${t}_d${r}`, { t, retardo: r });
      }
    }
  },
  // S9: cobertura con el arreglo elegido (--arreglo). Subescenario con --etiqueta y --instantes.
  async S9barrido(s, extra) {
    extra.alPausar = await s.play(PLAY);
    for (let t = 0; t <= Math.floor(PLAY); t++) await s.seekYCapturar(t, { retardo: 300 });
  },
  async S9tresPlays(s, extra) {
    extra.alPausar = [];
    for (let i = 0; i < 3; i++) {
      await s.seek(0);
      extra.alPausar.push(await s.play(PLAY));
    }
    for (const t of INSTANTES) await s.seekYCapturar(t);
  },
  async S9mitad(s, extra) {
    extra.alPausar = await s.play(20);
    for (const t of INSTANTES) await s.seekYCapturar(t);
  },
  // Barrido rápido (R0 §6.6): 60 seeks en ~1 s tras el play; la cola debe quedar acotada y vaciarse.
  async S9rapido(s, extra) {
    extra.alPausar = await s.play(PLAY);
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      await s.seek(Math.round(((i * 37) % 50) * 10) / 10);
      await esperar(Math.max(0, (i + 1) * 16 - (Date.now() - t0)));
    }
    extra.msBarrido = Date.now() - t0;
    if (variantes.includes("instrumentarShaders") || variantes.includes("shadersUltimoGana")) extra.msVaciarCola = await s.esperarCola(30000);
    extra.trasBarrido = await s.diag();
    for (const t of INSTANTES) await s.seekYCapturar(t);
  },
};
ESCENARIOS.S3 = ESCENARIOS.S2; // con --play 4
ESCENARIOS.S8 = ESCENARIOS.S2; // con --arreglo / --variantes / --modo iframe

async function comprobarPuertos(s) {
  const pids = new Set(procesosBajo(DIR_NAV).map((p) => p.ProcessId));
  const todas = escuchas();
  const delNavegador = todas.filter((e) => pids.has(e.pid));
  const delSpike = todas.filter((e) => e.pid === process.pid);
  const r = { pidsNavegador: [...pids], escuchasNavegador: delNavegador, escuchasSpike: delSpike };
  if (delNavegador.length) throw new Error(`el navegador escucha en puertos TCP/UDP: ${JSON.stringify(delNavegador)}`);
  if (delSpike.length !== 1 || delSpike[0].proto !== "TCP" || !delSpike[0].local.startsWith("127.0.0.1:")) throw new Error(`escuchas del spike inesperadas: ${JSON.stringify(delSpike)}`);
  return r;
}

const esc = ESCENARIOS[a.escenario];
if (!esc) throw new Error(`escenario desconocido: ${a.escenario}`);
if (!/^[\w-]*$/.test(a.etiqueta)) throw new Error("--etiqueta solo admite letras, dígitos, _ y -");
const dirEsc = path.resolve(SALIDAS, a.escenario + (a.etiqueta ? `-${a.etiqueta}` : ""));
if (path.dirname(dirEsc) !== path.resolve(SALIDAS)) throw new Error("la carpeta de salida no queda bajo spikes/salidas/shader");
fs.rmSync(dirEsc, { recursive: true, force: true });
fs.mkdirSync(dirEsc, { recursive: true });
const resumen = [];
for (let n = 1; n <= N; n++) {
  const dirRep = path.join(dirEsc, String(n));
  fs.mkdirSync(dirRep, { recursive: true });
  const srv = await servir({ dir: a.comp, variantes, csp: a.csp, reseek: a.modo === "iframe" && a.arreglo === "reseek" });
  const { browser, cierre } = await lanzar(dirEsc);
  const extra = {};
  let s, error;
  try {
    s = await sesion(browser, srv, dirRep, extra);
    await esc(s, extra);
  } catch (e) {
    error = e;
  }
  const externas = extra.externas ?? [];
  const csp = s ? await s.f.evaluate(() => window.__traza.csp).catch(() => null) : null;
  await cierre();
  await srv.cerrar();
  await esperar(500);
  const restos = procesosBajo(DIR_NAV);
  const r = {
    escenario: a.escenario, repeticion: n, variantes, arreglo: a.arreglo, modo: a.modo, csp: a.csp, play: PLAY,
    esperarSeek: a["esperar-seek"], error: error ? String(error.message) : null, capturas: s?.capturas ?? [], ...extra, externas: undefined,
    peticionesServidor: srv.peticiones.length,
    peticionesNoLocalesServidor: srv.peticiones.filter((p) => p.host !== `127.0.0.1:${srv.puerto}`).length,
    externasFueraDeControl: externas.filter((e) => !e.control), externasDelControl: externas.filter((e) => e.control).map((e) => e.url),
    violacionesCsp: csp, procesosRestantes: restos.length,
  };
  fs.writeFileSync(path.join(dirRep, "resultado.json"), JSON.stringify(r, null, 2));
  resumen.push({ n, error: r.error, gpu: r.gpu?.adaptador ? `${r.gpu.adaptador.vendor}/${r.gpu.adaptador.architecture}` : null, externas: r.externasFueraDeControl.length, csp: csp?.length ?? null, restos: restos.length, capturas: r.capturas.map((c) => `${c.nombre}:${c.sha256.slice(0, 8)}`) });
  if (error) throw error;
  if (r.externasFueraDeControl.length) throw new Error(`peticiones fuera de la lista blanca: ${JSON.stringify(r.externasFueraDeControl)}`);
  if (restos.length) throw new Error(`quedan ${restos.length} procesos del navegador tras cerrar`);
}
console.log(JSON.stringify(resumen, null, 1));
