// Integridad del renderer y red cerrada durante un render REAL de HyperFrames parcheado (SEO-109: I3,
// I2b, I7). Pesado y solo Windows: necesita el CfT. Se ejecuta con
//   HYPERFRAMES_BROWSER_PATH=<chrome-headless-shell.exe> FFMPEG_DIR=<carpeta> npm run render:sandbox
// Sin CfT, falla (no se salta). Un vigilante de PowerShell lee la etiqueta de integridad del token de
// cada proceso (lo que impone el kernel, no lo que dicen los flags) y los sockets en escucha.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../src/raiz.js";
import { entornoConFfmpeg, herramientasFfmpeg, sondear, type Herramientas } from "../src/proceso.js";
import {
  MARCADOR,
  accesos,
  chunk,
  cli,
  conEspia,
  copiaSinParche,
  ENTORNO_CERRADO,
  entornoLimpio,
  FLAGS_RED,
  GPU_SIN_SANDBOX,
  ipNoInterna,
  PROXY_NULO,
  sumidero,
  sumideroUdp,
  type Sumidero,
  type SumideroUdp,
} from "./hyperframes-comun.js";

const UNTRUSTED = 0;
const MEDIUM = 8192;

interface Muestra {
  pid: number;
  ppid: number;
  exe: string;
  tipo: string;
  integridad: number;
  cmd: string;
  escucha: string[];
  udp: string[];
  /** Milisegundos (TickCount) de la primera y la última vez que el vigilante vio el proceso. */
  primera: number;
  ultima: number;
}

// Constante: rutas y PID llegan por variables de entorno, nada se interpola en el script.
const VIGILANTE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Integridad {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool h, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr i, int l, out int r);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr s, uint n);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr s);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p, int c, IntPtr i, int l, out int r);
  // Línea de comandos con el permiso limitado: CIM a veces no la da de un proceso naciendo o Untrusted.
  public static string Cmd(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    try {
      int r; NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out r);
      if (r <= 0) return "";
      IntPtr b = Marshal.AllocHGlobal(r);
      try {
        if (NtQueryInformationProcess(h, 60, b, r, out r) != 0) return "";
        return Marshal.PtrToStringUni(Marshal.ReadIntPtr(b, IntPtr.Size), (Marshal.ReadInt16(b) & 0xffff) / 2);
      } finally { Marshal.FreeHGlobal(b); }
    } finally { CloseHandle(h); }
  }
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr t, ref int s, bool o, int af, int c, int r);
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedUdpTable(IntPtr t, ref int s, bool o, int af, int c, int r);
  static string Dir(IntPtr fila, int desp, int bytes, int despPuerto) {
    byte[] a = new byte[bytes];
    Marshal.Copy(IntPtr.Add(fila, desp), a, 0, bytes);
    int p = (Marshal.ReadByte(fila, despPuerto) << 8) | Marshal.ReadByte(fila, despPuerto + 1);
    string ip = new System.Net.IPAddress(a).ToString();
    return (bytes == 16 ? "[" + ip + "]" : ip) + ":" + p;
  }
  // Tablas del sistema con el PID dueño: mucho más rápidas que Get-NetTCPConnection y sin lanzar netstat.
  // Cada línea es "T|dirección:puerto|pid" (TCP en escucha) o "U|dirección:puerto|pid".
  public static string[] Sockets() {
    var r = new System.Collections.Generic.List<string>();
    foreach (int af in new[] { 2, 23 }) {
      for (int udp = 0; udp < 2; udp++) {
        int s = 0;
        // TCP_TABLE_OWNER_PID_LISTENER = 3, UDP_TABLE_OWNER_PID = 1.
        if (udp == 0) GetExtendedTcpTable(IntPtr.Zero, ref s, false, af, 3, 0); else GetExtendedUdpTable(IntPtr.Zero, ref s, false, af, 1, 0);
        IntPtr b = Marshal.AllocHGlobal(s + 4096); s += 4096;
        try {
          uint e = udp == 0 ? GetExtendedTcpTable(b, ref s, false, af, 3, 0) : GetExtendedUdpTable(b, ref s, false, af, 1, 0);
          if (e != 0) continue;
          int n = Marshal.ReadInt32(b);
          for (int i = 0; i < n; i++) {
            string d; int pid;
            if (udp == 0 && af == 2) { IntPtr f = IntPtr.Add(b, 4 + i * 24); d = Dir(f, 4, 4, 8); pid = Marshal.ReadInt32(f, 20); }
            else if (udp == 0) { IntPtr f = IntPtr.Add(b, 4 + i * 56); d = Dir(f, 0, 16, 20); pid = Marshal.ReadInt32(f, 52); }
            else if (af == 2) { IntPtr f = IntPtr.Add(b, 4 + i * 12); d = Dir(f, 0, 4, 4); pid = Marshal.ReadInt32(f, 8); }
            else { IntPtr f = IntPtr.Add(b, 4 + i * 28); d = Dir(f, 0, 16, 20); pid = Marshal.ReadInt32(f, 24); }
            r.Add((udp == 0 ? "T|" : "U|") + d + "|" + pid);
          }
        } finally { Marshal.FreeHGlobal(b); }
      }
    }
    return r.ToArray();
  }
  public static int Nivel(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    // -1: el proceso ya no existe (87, ERROR_INVALID_PARAMETER); -4: existe pero no se puede abrir.
    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? -1 : -4;
    IntPtr t;
    if (!OpenProcessToken(h, 0x8, out t)) { CloseHandle(h); return -2; }
    int r; GetTokenInformation(t, 25, IntPtr.Zero, 0, out r);
    IntPtr b = Marshal.AllocHGlobal(r);
    try {
      if (!GetTokenInformation(t, 25, b, r, out r)) return -3;
      IntPtr sid = Marshal.ReadIntPtr(b);
      int n = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(n - 1)));
    } finally { Marshal.FreeHGlobal(b); CloseHandle(t); CloseHandle(h); }
  }
}
"@
$exe = $env:VIGIA_EXE
$marca = $env:VIGIA_MARCA
$parada = $env:VIGIA_PARADA
$desde = (Get-Date).AddSeconds(-2)
$tope = (Get-Date).AddMinutes(15)
$vistos = @{}
[Console]::Out.WriteLine('LISTO')
[Console]::Out.Flush()
while (-not (Test-Path -LiteralPath $parada) -and (Get-Date) -lt $tope) {
  $todos = @(Get-CimInstance Win32_Process -Filter "Name='chrome-headless-shell.exe' OR Name='node.exe'")
  $nuestros = @{}
  # Raíces: los procesos cuya línea de comandos lleva la marca (la carpeta de la composición o el
  # perfil del control). Así no se cuelan los Chrome de otras sesiones con el mismo CfT.
  foreach ($p in $todos) {
    if ($p.CommandLine -and $p.CommandLine.Contains($marca) -and $p.CreationDate -ge $desde) { $nuestros[[int]$p.ProcessId] = $p }
  }
  # Descendientes (workers de node de la CLI, Chrome y sus hijos): cierre transitivo por ParentProcessId.
  do {
    $antes = $nuestros.Count
    foreach ($p in $todos) {
      if (-not $nuestros.ContainsKey([int]$p.ProcessId) -and $nuestros.ContainsKey([int]$p.ParentProcessId) -and $p.CreationDate -ge $desde) {
        $nuestros[[int]$p.ProcessId] = $p
      }
    }
  } while ($nuestros.Count -ne $antes)
  foreach ($id in $nuestros.Keys) {
    $p = $nuestros[$id]
    if (-not $vistos.ContainsKey($id)) {
      $vistos[$id] = [ordered]@{ pid = $id; ppid = [int]$p.ParentProcessId; exe = [string]$p.ExecutablePath; tipo = '?'; integridad = -9; cmd = ''; escucha = @(); udp = @(); primera = [Environment]::TickCount; ultima = 0 }
    }
    $v = $vistos[$id]
    # El tipo sale de la línea de comandos: hasta tenerla, el proceso queda como '?' y se reintenta.
    if ($v.tipo -eq '?') {
      $linea = [string]$p.CommandLine
      if (-not $linea) { $linea = [Integridad]::Cmd($id) }
      # Por nombre de imagen: CIM no siempre da ExecutablePath de un proceso Untrusted.
      if ($p.Name -ieq 'node.exe') { $v.tipo = 'node'; $v.cmd = $linea }
      elseif ($linea) {
        $tipo = 'browser'
        if ($linea -match '--type=([\w-]+)') { $tipo = $Matches[1] }
        if ($linea -match '--utility-sub-type=([\w.]+)') { $tipo += '/' + $Matches[1] }
        # El preflight de HyperFrames (chrome --version) no pasa por el marcador ni abre nada.
        if ($linea -match '\s--version(\s|$)') { $tipo = 'version' }
        $v.tipo = $tipo; $v.cmd = $linea
      }
    }
    $v.ultima = [Environment]::TickCount
    # Se relee en cada vuelta y vale la última lectura: el sandbox arranca el proceso con un token
    # inicial (Low) y lo baja a Untrusted al terminar de inicializarse (LowerToken).
    $n = [Integridad]::Nivel($id)
    if ($n -ge 0 -or $v.integridad -lt 0) { $v.integridad = $n }
  }
  # Sockets: CIM tarda cerca de 1 s con carga y los servidores viven poco, así que entre dos consultas
  # CIM se leen las tablas del sistema varias veces, con los PID ya conocidos.
  for ($i = 0; $i -lt 20; $i++) {
    foreach ($s in [Integridad]::Sockets()) {
      $c = $s.Split('|')
      $id = [int]$c[2]
      if (-not $vistos.ContainsKey($id) -or -not $nuestros.ContainsKey($id)) { continue }
      $v = $vistos[$id]
      if ($c[0] -eq 'T' -and $v.escucha -notcontains $c[1]) { $v.escucha += $c[1] }
      if ($c[0] -eq 'U' -and $v.udp -notcontains $c[1]) { $v.udp += $c[1] }
    }
    Start-Sleep -Milliseconds 25
  }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @($vistos.Values) -Depth 4 -Compress))
`;

interface Vigilante {
  parar(): Promise<Muestra[]>;
}

async function vigilar(exe: string, marca: string): Promise<Vigilante> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video vigia "));
  const parada = path.join(dir, "parar");
  const script = path.join(dir, "vigilante.ps1");
  fs.writeFileSync(script, `﻿${VIGILANTE}`); // con BOM: PowerShell 5.1 lee el .ps1 como UTF-8
  const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
    env: { ...process.env, VIGIA_EXE: path.resolve(exe), VIGIA_MARCA: marca, VIGIA_PARADA: parada },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  ps.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
  ps.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
  const fin = new Promise<void>((ok) => ps.on("close", () => ok()));
  const t0 = Date.now();
  while (!out.includes("LISTO")) {
    if (ps.exitCode !== null || Date.now() - t0 > 60000) throw new Error(`el vigilante no arrancó: ${err}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    async parar() {
      fs.writeFileSync(parada, "");
      await fin;
      fs.rmSync(dir, { recursive: true, force: true });
      const json = out.split(/\r?\n/).filter((l) => l.startsWith("[") || l.startsWith("{")).at(-1);
      if (!json) throw new Error(`el vigilante no devolvió muestras: ${err}`);
      const v = JSON.parse(json) as Muestra | Muestra[];
      return (Array.isArray(v) ? v : [v]).map((m) => ({ ...m, escucha: [m.escucha ?? []].flat(), udp: [m.udp ?? []].flat() }));
    },
  };
}

const esLoopback = (dir: string) => dir.startsWith("127.0.0.1:");
const resumen = (ms: Muestra[]) => ms.map((m) => `${m.tipo}#${m.pid}<${m.ppid} il=${m.integridad} tcp=[${m.escucha}] udp=[${m.udp}]${m.tipo === "browser" ? ` cmd=${m.cmd}` : ""}`).join("\n");

/** Mata el árbol del Chrome de un control (c.kill() solo mata el proceso browser y sus hijos siguen). */
const matar = (c: ChildProcess) => spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
/** Mata el árbol y deja pasar los paquetes en vuelo, para no atribuirlos al paso siguiente. */
const matarYAsentar = async (c: ChildProcess) => {
  matar(c);
  await new Promise((r) => setTimeout(r, 1000));
};

/** Espera a que se cumpla `cond` (tope en ms). */
async function hasta(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return true;
}

const CFT = process.env.HYPERFRAMES_BROWSER_PATH;

/**
 * Mata (con su árbol) los procesos de esta ejecución que sigan vivos: los que llevan `raiz` en la línea de
 * comandos (los Chrome de los controles, la CLI y sus hijos). El cierre en el motor es I7/W1.6.
 */
function limpiar(raiz: string) {
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:VIGIA_RAIZ) -and $_.ProcessId -ne $PID } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }",
    ],
    { env: { ...process.env, VIGIA_RAIZ: raiz }, windowsHide: true },
  );
}

/**
 * Composición mínima (540×960, 2 s, GSAP local) SIN CSP —simula que la CSP falla— con intentos de fuga.
 * `fugas`: "js" (lo que ejecuta Chrome: <img>, fetch, WebSocket, WebRTC, WebTransport) o "no" (composición
 * limpia, sin red ni WebRTC). Un <img src="http…"> escrito en el HTML ya no llega a Chrome: aborta en Node.
 */
function componer(dir: string, ip: string, tcp: number, tcp2: number, udp: number, udpWt: number, fugas: "js" | "no") {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.copyFileSync(path.join(SERVER_ROOT, "node_modules", "gsap", "dist", "gsap.min.js"), path.join(dir, "assets", "gsap.min.js"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><script src="assets/gsap.min.js"></script>
<style>*{margin:0;padding:0}html,body{width:540px;height:960px;overflow:hidden;background:#123}#root{position:relative;width:540px;height:960px;overflow:hidden}</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="540" data-height="960">
<p style="color:#fff;font:48px sans-serif">fuga</p>
</div><script>
window.__timelines=window.__timelines||{};window.__timelines["main"]=gsap.timeline({paused:true});
${fugas !== "no" ? FUGAS_JS(ip, tcp, tcp2, udp, udpWt) : ""}
</script></body></html>`,
  );
}

/** Intentos de salida de la spec y los observables en los sumideros. */
// `externos`: destinos que saldrían del equipo sin proxy nulo (DNS de ejemplo.test, 203.0.113.1). Solo con los
// flags del marcador puestos; los controles sin flags los omiten y usan solo sumideros propios.
const FUGAS_JS = (ip: string, tcp: number, tcp2: number, udp: number, udpWt: number, externos = true) => `
const nada = () => {};
try { document.body.append(Object.assign(document.createElement("img"), { src: "http://${ip}:${tcp}/x.png" })); } catch (e) {}
${externos ? `try { fetch("http://203.0.113.1/").catch(nada); } catch (e) {}
try { new WebSocket("ws://ejemplo.test/w"); } catch (e) {}
try { new Image().src = "//ejemplo.test/x.png"; } catch (e) {}` : ""}
try { fetch("http://${ip}:${tcp}/f").catch(nada); } catch (e) {}
try { new WebSocket("ws://${ip}:${tcp}/w"); } catch (e) {}
try { fetch("http://127.0.0.2:${tcp2}/f").catch(nada); } catch (e) {}
try { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:${ip}:${udp}" }] }); pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(nada); } catch (e) {}
try { new WebTransport("https://${ip}:${udpWt}/").ready.catch(nada); } catch (e) {}
${especulacion(`http://127.0.0.2:${tcp2}`)}
`;

/** JS que inserta reglas de especulación (prefetch y prerender) hacia `base` (no las frena la CSP). */
const especulacion = (base: string) => `
try { const s = document.createElement("script"); s.type = "speculationrules";
  s.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: ["${base}/prefetch"] }], prerender: [{ source: "list", urls: ["${base}/prerender"] }] });
  document.head.append(s); } catch (e) {}
`;

/** Sirve `html` en 127.0.0.1 (la página de los controles). */
function servir(html: string): Promise<{ url: string; cerrar(): Promise<void> }> {
  const s = http.createServer((_q, r) => {
    r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    r.end(html);
  });
  return new Promise((ok) =>
    s.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}/`, cerrar: () => new Promise((r) => s.close(() => r())) }),
    ),
  );
}

describe.runIf(process.platform === "win32")("I3 e I2b durante un render real", () => {
  const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "video sandbox "));
  let h: Herramientas;
  let ip: string;
  let marcador: (a: string[]) => string[];
  let tcp: Sumidero;
  let tcp2: Sumidero;
  let udp: SumideroUdp;
  let udpWt: SumideroUdp;
  let entorno: NodeJS.ProcessEnv;
  const hijos: ChildProcess[] = [];

  beforeAll(async () => {
    if (!CFT || !fs.statSync(CFT, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("Define HYPERFRAMES_BROWSER_PATH con el chrome-headless-shell.exe del CfT (152 o 156)");
    }
    const hf = herramientasFfmpeg(process.env.FFMPEG_DIR);
    if (!hf) throw new Error("Define FFMPEG_DIR con la carpeta de ffmpeg.exe y ffprobe.exe");
    h = hf;
    ip = ipNoInterna();
    marcador = ((await import(chunk("chunk-K4MJX7SR.js"))) as { withHyperframesBrowserMarker: (a: string[]) => string[] }).withHyperframesBrowserMarker;
    entorno = entornoLimpio(entornoConFfmpeg(h, {}), { ...ENTORNO_CERRADO, HYPERFRAMES_BROWSER_PATH: CFT });
  });

  afterEach(async () => {
    for (const c of hijos.splice(0)) c.kill();
    await Promise.all([tcp?.cerrar(), tcp2?.cerrar(), udp?.cerrar(), udpWt?.cerrar()]);
    limpiar(RAIZ);
  });

  afterAll(() => {
    // Ningún warmCheck.js (proceso desacoplado de HyperFrames) puede quedar vivo tras los comandos.
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($env:VIGIA_WARM) }).Count",
      ],
      { env: { ...process.env, VIGIA_WARM: path.join(SERVER_ROOT, "node_modules", "hyperframes", "dist", "warmCheck.js") }, encoding: "utf8", windowsHide: true },
    );
    if (RAIZ.startsWith(os.tmpdir()) && process.env.VIDEO_SANDBOX_CONSERVAR !== "1") fs.rmSync(RAIZ, { recursive: true, force: true });
    expect(r.stdout.trim(), `procesos warmCheck.js vivos: ${r.stderr}`).toBe("0");
  });

  const abrirSumideros = async () => {
    tcp = await sumidero(ip);
    tcp2 = await sumidero("127.0.0.2");
    udp = await sumideroUdp(ip);
    udpWt = await sumideroUdp(ip); // solo WebTransport (QUIC): sin compartirlo con el STUN
  };

  /** Tamaño y fecha de `debug.log` junto al exe del CfT ("no existe" si no está). No se borra: puede ser compartido. */
  const estadoDebugLog = (): string => {
    const st = fs.statSync(path.join(path.dirname(CFT!), "debug.log"), { throwIfNoEntry: false });
    return st ? `${st.size}@${st.mtimeMs}` : "no existe";
  };

  it(
    "reglas de especulación: a 127.0.0.2 no llegan; a 127.0.0.1/localhost SÍ (residual medido, sin bandera que lo corte)",
    async () => {
      // Control positivo y medición del residual: ninguna bandera probada (Prerender2,
      // SpeculationRulesPrefetchProxy, Prefetch, PrefetchPrerenderIntegration, PreloadingConfig,
      // --disable-blink-features=SpeculationRules) corta el prefetch/prerender en CfT 152 ni 156.
      // Lo que no es localhost/127.0.0.1 va al proxy nulo; el loopback exento (el servidor del render)
      // sí se alcanza. Cuando una bandera lo corte, este test fallará: invertir la última aserción.
      const lo = await sumidero("127.0.0.1");
      const lo2 = await sumidero("127.0.0.2");
      const pagina = await servir(
        `<!doctype html><html><body><p>x</p><script>${especulacion(`http://127.0.0.2:${lo2.puerto}`)}${especulacion(`http://localhost:${lo.puerto}`)}</script></body></html>`,
      );
      try {
        const dd = path.join(RAIZ, `dd-espec-${Date.now()}`);
        const c = spawn(CFT!, [...marcador(["--headless", "--no-sandbox"]), `--user-data-dir=${dd}`, pagina.url], { windowsHide: true, stdio: "ignore" });
        hijos.push(c);
        const llego = await hasta(() => lo.peticiones().length > 0, 15000);
        await new Promise((r) => setTimeout(r, 2000));
        await matarYAsentar(c);
        expect(lo2.conexiones(), lo2.peticiones().join("\n")).toBe(0);
        expect(llego, "control positivo: la regla hacia localhost debería llegar").toBe(true);
        expect(lo.peticiones().every((p) => /Sec-Purpose: prefetch/i.test(p)), lo.peticiones().join("\n")).toBe(true);
      } finally {
        await Promise.all([pagina.cerrar(), lo.cerrar(), lo2.cerrar()]);
      }
    },
    60000,
  );

  it(
    "[::1]: no se alcanza con los flags del marcador; sin ellos, sí",
    async () => {
      // Las reglas de resolución también mapean literales IP y solo exceptúan localhost y 127.0.0.1.
      const seis = await sumidero("::1");
      const pagina = await servir(`<!doctype html><html><body><script>fetch("http://[::1]:${seis.puerto}/f", { mode: "no-cors" }).catch(() => {});</script></body></html>`);
      try {
        const lanzar = (args: string[]) => {
          const c = spawn(CFT!, ["--headless", `--user-data-dir=${path.join(RAIZ, `dd-seis-${Date.now()}`)}`, ...args, pagina.url], { windowsHide: true, stdio: "ignore" });
          hijos.push(c);
          return c;
        };
        let c = lanzar(marcador(["--no-sandbox"]));
        await new Promise((r) => setTimeout(r, 8000));
        await matarYAsentar(c);
        expect(seis.conexiones()).toBe(0);
        c = lanzar(["--no-proxy-server"]);
        expect(await hasta(() => seis.conexiones() > 0, 15000), "control positivo: sin flags [::1] debería alcanzarse").toBe(true);
        await matarYAsentar(c);
      } finally {
        await Promise.all([pagina.cerrar(), seis.cerrar()]);
      }
    },
    60000,
  );

  it(
    "control: el vigilante ve Medium con --no-sandbox y Untrusted sin él",
    async () => {
      for (const [flags, esperado] of [[["--no-sandbox"], MEDIUM], [[], UNTRUSTED]] as [string[], number][]) {
        const marca = `vigia-control-${Date.now()}`;
        const v = await vigilar(CFT!, marca);
        const dd = path.join(RAIZ, marca);
        const c = spawn(CFT!, ["--headless", `--user-data-dir=${dd}`, ...flags, "data:text/html,<p>hola</p>"], { windowsHide: true, stdio: "ignore" });
        hijos.push(c);
        await new Promise((r) => setTimeout(r, 8000)); // con el equipo cargado el renderer tarda en nacer
        const ms = await v.parar();
        matar(c);
        const renderers = ms.filter((m) => m.tipo === "renderer");
        expect(renderers.length, resumen(ms)).toBeGreaterThan(0);
        for (const r of renderers) expect(r.integridad, `${flags}: ${resumen(ms)}`).toBe(esperado);
      }
    },
    60000,
  );

  it(
    "control: sin los flags la fuga llega a los sumideros (TCP, 127.0.0.2 y STUN por UDP); con los del marcador, no",
    async () => {
      await abrirSumideros();
      const pagina = await servir(`<!doctype html><html><body><img src="http://${ip}:${tcp.puerto}/x.png"><script>${FUGAS_JS(ip, tcp.puerto, tcp2.puerto, udp.puerto, udpWt.puerto, false)}</script></body></html>`);
      try {
        const lanzar = (args: string[]) => {
          const dd = path.join(RAIZ, `dd-${Date.now()}`);
          const c = spawn(CFT!, ["--headless", `--user-data-dir=${dd}`, ...args, pagina.url], { windowsHide: true, stdio: "ignore" });
          hijos.push(c);
          return c;
        };
        // 1. Sin nada (se anula el proxy del sistema): llegan TCP, STUN y WebTransport (QUIC).
        // Medido: --disable-quic NO frena a WebTransport (solo con esa bandera llegan paquetes); lo frenan
        // el proxy nulo y las reglas de resolución. La bandera queda por HTTP/3, sin control propio aquí.
        let c = lanzar(["--no-proxy-server"]);
        expect(
          await hasta(() => tcp.conexiones() > 0 && udp.paquetes() > 0 && udpWt.paquetes() > 0, 15000),
          `tcp=${tcp.conexiones()} udp=${udp.paquetes()} webtransport=${udpWt.paquetes()}`,
        ).toBe(true);
        await matarYAsentar(c);
        // 2. Proxy nulo SIN el bypass explícito: 127.0.0.2 entra por el bypass implícito de loopback (MEDIUM-1).
        const antes2 = tcp2.conexiones();
        c = lanzar([PROXY_NULO]);
        expect(await hasta(() => tcp2.conexiones() > antes2, 15000), "sin --proxy-bypass-list el loopback 127.0.0.2 debería alcanzarse").toBe(true);
        await matarYAsentar(c);
        // 3. Proxy nulo y reglas de resolución SIN el flag de WebRTC: el STUN a una IP literal sale.
        const antesUdp = udp.paquetes();
        c = lanzar(marcador(["--no-sandbox"]).filter((a) => !a.startsWith("--force-webrtc-ip-handling-policy=")));
        expect(await hasta(() => udp.paquetes() > antesUdp, 15000), "sin el flag de WebRTC el STUN debería llegar").toBe(true);
        await matarYAsentar(c);
        // 4. Con los flags del marcador: nada en 10 s.
        const [t1, t2, u, w] = [tcp.conexiones(), tcp2.conexiones(), udp.paquetes(), udpWt.paquetes()];
        c = lanzar(marcador(["--no-sandbox"]));
        await new Promise((r) => setTimeout(r, 10000));
        await matarYAsentar(c);
        expect([tcp.conexiones() - t1, tcp2.conexiones() - t2, udp.paquetes() - u, udpWt.paquetes() - w]).toEqual([0, 0, 0, 0]);
      } finally {
        await pagina.cerrar();
      }
    },
    120000,
  );

  /** Render real con el vigilante, y todas las aserciones de la tarea 4. */
  async function renderVigilado(nombre: string, extra: string[], fugas: "js" | "no" = "js") {
    await abrirSumideros();
    const comp = path.join(RAIZ, `comp-${nombre}`);
    componer(comp, ip, tcp.puerto, tcp2.puerto, udp.puerto, udpWt.puerto, fugas);
    // WebM (VP9 por software) y no MP4: con el ffmpeg LGPL, HyperFrames elige el codificador H.264 por
    // GPU según una sonda que falla con la GPU ocupada y entonces pide libx264 (no existe). Elegir el
    // codificador es W1.6; aquí solo importa la captura con Chrome, que es la misma en los dos formatos.
    const salida = path.join(RAIZ, `${nombre}.webm`);
    const log0 = estadoDebugLog();
    const v = await vigilar(CFT!, comp);
    const r = await cli(["render", comp, "-o", salida, "--fps", "30", "--format", "webm", "--quality", "delivery", ...extra], { cwd: comp, env: entorno, timeoutMs: 300000 });
    const ms = await v.parar();
    const log = `${resumen(ms)}\n--- salida ---\n${(r.stdout + r.stderr).slice(-3000)}`;
    // 1. Render correcto.
    expect(r.code, log).toBe(0);
    const info = await sondear(h.ffprobe, salida);
    expect([info.ancho, info.alto]).toEqual([540, 960]);
    comprobarProcesos(ms, log, fugas !== "no");
    // 4. Ninguna salida: ni TCP fuera de loopback, ni a 127.0.0.2, ni UDP (STUN, QUIC).
    expect([tcp.conexiones(), tcp2.conexiones(), udp.paquetes(), udpWt.paquetes()], log).toEqual([0, 0, 0, 0]);
    // 7. Medición (riesgo residual, sin aserción): el proceso de GPU escribe debug.log junto al exe del
    // CfT (errores de media\gpu\windows\mf_video_encoder_util). --disable-logging, --log-level=3,
    // --log-file=NUL, --enable-logging=stderr y --enable-logging --log-file=NUL no lo evitan en CfT 156
    // (medido en este mismo render); W1.6 tolera esa ruta exacta en su manifiesto.
    const log1 = estadoDebugLog();
    if (log1 !== log0) process.stderr.write(`RESIDUAL debug.log en la carpeta del navegador: ${log0} -> ${log1}\n`);
    return ms;
  }

  /**
   * Aserciones 2, 3, 5 y 6 (y HIGH-1) sobre las muestras del vigilante. `conWebRtc`: la composición abre
   * una RTCPeerConnection (los intentos de fuga), que hace que el servicio de red abra UDP (ver abajo).
   */
  function comprobarProcesos(ms: Muestra[], log: string, conWebRtc: boolean) {
    const renderers = ms.filter((m) => m.tipo === "renderer");
    const browsers = ms.filter((m) => m.tipo === "browser");
    // 2. Todo renderer medido, en Untrusted. -1 = el renderer ya había salido cuando se fue a leer (el
    // about:blank inicial que Chrome cambia al navegar): no hay token que leer, se registra y no cuenta.
    // Cualquier otro valor (Medium, Low, -2, -3, -4: existe y no se puede leer) es fallo.
    expect(renderers.length, log).toBeGreaterThan(0);
    for (const m of renderers) expect([UNTRUSTED, -1], log).toContain(m.integridad);
    // Al menos uno medido de verdad: si todos fueran -1, el bucle anterior no probaría nada.
    expect(renderers.some((r) => r.integridad === UNTRUSTED), log).toBe(true);
    const salidos = renderers.filter((m) => m.integridad === -1).length;
    if (salidos) process.stderr.write(`${salidos} renderer(s) salieron antes de leer su token\n`);
    // Procesos de Chrome sin línea de comandos legible ('?', suele ser el preflight --version naciendo):
    // se admiten si están en Untrusted, ya habían salido o vivieron menos de 2 s (se registra). Uno
    // sin identificar que siga vivo en Medium es fallo.
    for (const m of ms.filter((x) => x.tipo === "?")) {
      if ([UNTRUSTED, -1].includes(m.integridad)) continue;
      const vida = m.ultima - m.primera;
      expect(vida, `proceso sin identificar #${m.pid} il=${m.integridad}\n${log}`).toBeLessThan(2000);
      process.stderr.write(`proceso #${m.pid} sin identificar (il=${m.integridad}, ${vida} ms)\n`);
    }
    // 3. Flags del proceso browser, y HIGH-1: ninguno de un solo proceso y cada uno con un renderer Untrusted.
    expect(browsers.length, log).toBeGreaterThan(0);
    for (const b of browsers) {
      for (const f of [GPU_SIN_SANDBOX, ...FLAGS_RED, MARCADOR]) expect(b.cmd, `${f} en browser#${b.pid}\n${log}`).toContain(f);
      expect(b.cmd).not.toMatch(/--no-sandbox|--single-process|--in-process-gpu/);
      // Un browser de vida corta (la sonda de GPU de HyperFrames) puede cerrar antes de que el vigilante
      // vea su renderer; uno que vive 2 s o más sin renderer Untrusted es fallo (un solo proceso, HIGH-1).
      const vida = b.ultima - b.primera;
      const conRenderer = renderers.some((r) => r.ppid === b.pid && r.integridad === UNTRUSTED);
      if (!conRenderer && vida < 2000) {
        process.stderr.write(`browser ${b.pid} de vida corta (${vida} ms) sin renderer observado\n`);
        continue;
      }
      expect(conRenderer, `browser ${b.pid} (vivo ${vida} ms) sin renderer Untrusted\n${log}`).toBe(true);
    }
    // 5. Sockets en escucha (TCP) de Chrome y de la CLI: solo 127.0.0.1. UDP: solo loopback, salvo el
    // riesgo residual medido (LOW-3): con WebRTC en la página, el servicio de red abre sockets UDP
    // efímeros en 0.0.0.0/:: aunque ningún paquete llegue a los sumideros (aserción 4). Se admite solo en
    // ese proceso y solo si la composición usa WebRTC; el render limpio lo exige a cero. El respondedor
    // mDNS (5353) está cerrado por WebRtcHideLocalIpsWithMdns.
    for (const m of ms) {
      expect(m.escucha.filter((e) => !esLoopback(e)), `${m.tipo}#${m.pid}\n${log}`).toEqual([]);
      const udpFuera = m.udp.filter((e) => !esLoopback(e));
      if (conWebRtc && m.tipo === "utility/network.mojom.NetworkService") {
        expect(udpFuera.filter((e) => e.endsWith(":5353")), `${m.tipo}#${m.pid}\n${log}`).toEqual([]);
        if (udpFuera.length) process.stderr.write(`RESIDUAL UDP (WebRTC) ${m.tipo}#${m.pid}: ${udpFuera.join(" ")}\n`);
        continue;
      }
      expect(udpFuera, `${m.tipo}#${m.pid}\n${log}`).toEqual([]);
    }
    // 6. Residual aceptado: el proceso de GPU sin sandbox; solo se registra.
    for (const g of ms.filter((m) => m.tipo === "gpu-process")) process.stderr.write(`gpu-process ${g.pid}: integridad ${g.integridad}\n`);
  }

  it("render real: renderer Untrusted, red cerrada y sockets en loopback", async () => {
    await renderVigilado("cpu", []);
  }, 360000);

  it("render real de una composición limpia: ningún socket UDP ni TCP fuera de loopback", async () => {
    await renderVigilado("limpio", [], "no");
  }, 360000);

  it("render real con --browser-gpu", async (ctx) => {
    if (process.env.VIDEO_SANDBOX_SIN_GPU === "1") {
      process.stderr.write("AVISO: VIDEO_SANDBOX_SIN_GPU=1, se salta el render con --browser-gpu (decisión explícita).\n");
      ctx.skip();
    }
    await renderVigilado("gpu", ["--browser-gpu"]);
  }, 360000);

  it("check y snapshot: sockets solo en 127.0.0.1 y renderer Untrusted", async () => {
    await abrirSumideros();
    const comp = path.join(RAIZ, "comp-check");
    componer(comp, ip, tcp.puerto, tcp2.puerto, udp.puerto, udpWt.puerto, "js");
    const log0 = estadoDebugLog();
    for (const args of [["check", comp, "--json", "--no-contrast"], ["snapshot", comp, "--frames", "1", "--no-end"]]) {
      const v = await vigilar(CFT!, comp);
      const r = await cli(args, { cwd: comp, env: entorno, timeoutMs: 180000 });
      const ms = await v.parar();
      const log = `${args[0]}\n${resumen(ms)}\n--- salida ---\n${(r.stdout + r.stderr).slice(-2000)}`;
      expect(r.timeout, log).toBeFalsy();
      expect(ms.some((m) => m.escucha.length > 0), `servidor no observado\n${log}`).toBe(true);
      comprobarProcesos(ms, log, true);
    }
    expect([tcp.conexiones(), tcp2.conexiones(), udp.paquetes(), udpWt.paquetes()], tcp.peticiones().join("\n")).toEqual([0, 0, 0, 0]);
    // Medición de debug.log (ver la aserción 7 del render).
    const log1 = estadoDebugLog();
    if (log1 !== log0) process.stderr.write(`RESIDUAL debug.log en la carpeta del navegador: ${log0} -> ${log1}\n`);
  }, 420000);

  // Salidas de Node (I14), fuera del proxy nulo y de la CSP. Los controles usan una copia de HyperFrames
  // sin el parche: demuestran que sin los hunks la salida existe y que el sumidero la vería.
  describe("I14: salidas de red de Node", () => {
    let sinParche: { bin: string; borrar(): void };
    beforeAll(() => {
      sinParche = copiaSinParche();
    }, 60000);
    afterAll(() => sinParche?.borrar());

    /** Composición de un segundo con `cuerpo` en el #root y `cabeza` en el <head>. */
    const proyecto = (nombre: string, cuerpo: string, cabeza = "") => {
      const comp = path.join(RAIZ, `comp-${nombre}`);
      fs.mkdirSync(comp, { recursive: true });
      fs.writeFileSync(
        path.join(comp, "index.html"),
        `<!doctype html><html lang="en"><head><meta charset="UTF-8" />${cabeza}</head><body><div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="540" data-height="960" style="width:540px;height:960px;background:#123">${cuerpo}</div><script>window.__timelines={};</script></body></html>`,
      );
      return comp;
    };
    const render = (comp: string, bin?: string) =>
      cli(["render", comp, "-o", path.join(comp, "salida.webm"), "--fps", "30", "--format", "webm", "--quality", "delivery"], { cwd: comp, env: entorno, timeoutMs: 180000, bin });
    const check = (comp: string, bin?: string) => cli(["check", comp, "--json", "--no-contrast"], { cwd: comp, env: entorno, timeoutMs: 180000, bin });
    const CERRADO = "HyperFrames no descarga recursos remotos en modo cerrado (I14)";

    it("<script src> externo: el render falla sin conectar; sin el parche, Node lo descarga", async () => {
      tcp = await sumidero("127.0.0.1");
      const comp = proyecto("script", "", `<script src="http://127.0.0.1:${tcp.puerto}/x.js"></script>`);
      const r = await render(comp);
      expect(r.timeout).toBe(false);
      expect(r.code, r.stdout + r.stderr).not.toBe(0);
      expect(r.stdout + r.stderr).toContain(CERRADO);
      expect(tcp.conexiones()).toBe(0);
      const control = await render(comp, sinParche.bin);
      expect(control.timeout).toBe(false);
      expect(tcp.conexiones(), "control positivo: sin el parche el sumidero debería ver la descarga").toBeGreaterThan(0);
    }, 420000);

    it("texto background:url(HTTPS://…) en la composición: el render falla con el error nuevo", async () => {
      const comp = proyecto("texto", `<p>background:url(HTTPS://example.invalid/x.png)</p>`);
      const r = await render(comp);
      expect(r.timeout).toBe(false);
      expect(r.code, r.stdout + r.stderr).not.toBe(0);
      expect(r.stdout + r.stderr).toContain(CERRADO);
    }, 240000);

    // Render real por la CLI con el espía. Sin control aquí: sin parche Chrome resolvería el host. El control
    // de la misma ruta, sin hijos reales, está en parche-hyperframes.test.ts.
    it.each([
      ["video", `<video id="v" src="//h.invalid/s/x.mp4" data-start="0" data-duration="1"></video>`, ""],
      ["video-inv", String.raw`<video id="v" src="\\h.invalid\s\x.mp4" data-start="0" data-duration="1"></video>`, ""],
      ["audio-inv", String.raw`<audio id="a" src="\\h.invalid\s\x.mp3" data-start="0" data-duration="1"></audio>`, ""],
      ["img-inv", String.raw`<img src="\\h.invalid\s\x.png" alt="">`, ""],
      ["css-inv", "", String.raw`<style>#root{background:url(\\h.invalid\s\x.png)}</style>`],
    ])("UNC %s: render, check y snapshot, 0 accesos; el render falla con I14", async (nombre, cuerpo, cabeza) => {
      const comp = proyecto(`unc-${nombre}`, cuerpo, cabeza);
      const log = path.join(RAIZ, `espia-${nombre}.log`);
      const env = { ...conEspia(entorno, log), ESPIA_HIJOS: "1" };
      const r = await cli(["render", comp, "-o", path.join(comp, "salida.webm"), "--fps", "30", "--format", "webm", "--quality", "delivery"], { cwd: comp, env, timeoutMs: 180000 });
      expect(r.timeout).toBe(false);
      expect(r.code, r.stdout + r.stderr).not.toBe(0);
      expect(r.stdout + r.stderr).toContain("(I14)");
      expect(accesos(log)).toEqual([]);
      const c = await cli(["check", comp, "--json", "--no-contrast"], { cwd: comp, env, timeoutMs: 180000 });
      expect(c.timeout).toBe(false);
      expect(accesos(log), c.stdout + c.stderr).toEqual([]);
      const s = await cli(["snapshot", comp, "--frames", "1", "--no-end"], { cwd: comp, env, timeoutMs: 180000 });
      expect(s.timeout).toBe(false);
      expect(accesos(log), s.stdout + s.stderr).toEqual([]);
    }, 560000);

    it("snapshot: <video> con URL no llega a ffprobe (ruta sin urlInputArgs); sin el parche, GET de Lavf", async () => {
      tcp = await sumidero("127.0.0.1");
      const comp = proyecto("snapshot-url", `<video id="v" src="http://127.0.0.1:${tcp.puerto}/x.mp4" data-start="0" data-duration="1"></video>`);
      const snapshot = (bin?: string) => cli(["snapshot", comp, "--frames", "1", "--no-end"], { cwd: comp, env: entorno, timeoutMs: 180000, bin });
      const r = await snapshot();
      expect(r.timeout).toBe(false);
      expect(tcp.peticiones().filter((p) => /User-Agent: Lavf\//i.test(p)), r.stdout + r.stderr).toEqual([]);
      expect(r.code, r.stdout + r.stderr).not.toBe(0);
      expect(r.stdout + r.stderr).toContain("(I14)");
      const control = await snapshot(sinParche.bin);
      expect(control.timeout).toBe(false);
      expect(await hasta(() => tcp.peticiones().some((p) => /User-Agent: Lavf\//i.test(p)), 5000), tcp.peticiones().join("\n")).toBe(true);
    }, 420000);

    it("check: <img>, <video> y <audio> con URL no llegan a ffprobe; sin el parche, GET de Lavf", async () => {
      await abrirSumideros();
      const url = `http://${ip}:${tcp.puerto}`;
      const comp = proyecto("ffprobe", `<img src="${url}/x.png" alt=""><video id="v" src="${url}/x.mp4" data-start="0" data-duration="1"></video><audio id="a" src="${url}/x.mp3" data-start="0" data-duration="1"></audio>`);
      const r = await check(comp);
      expect(r.timeout).toBe(false);
      await new Promise((ok) => setTimeout(ok, 1000));
      expect(tcp.peticiones(), r.stdout + r.stderr).toEqual([]);
      expect(tcp.conexiones()).toBe(0);
      const control = await check(comp, sinParche.bin);
      expect(control.timeout).toBe(false);
      expect(await hasta(() => tcp.peticiones().some((p) => /User-Agent: Lavf\//i.test(p)), 5000), tcp.peticiones().join("\n")).toBe(true);
    }, 420000);
  });
});
