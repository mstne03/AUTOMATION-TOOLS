// Pruebas reales (puerta VIDEO_E2E_REAL=1) con el CfT y el ffmpeg LGPL de verdad: modo cerrado (I13),
// sockets de los descendientes (I7, C10), timeout sin procesos vivos (I7), .dll añadida (I4) y que
// HyperFrames no intenta actualizarse (LOW-3).
//   VIDEO_E2E_REAL=1 VIDEO_E2E_NAVEGADOR=<carpeta con chrome-headless-shell-win64> VIDEO_E2E_FFMPEG=<bin LGPL> npx vitest run test/render-real.test.ts
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ACTIVO = process.env.VIDEO_E2E_REAL === "1" && process.platform === "win32";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const base = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video real ")));
  const version = "e2e-cft";
  const raizNav = nodePath.join(base, "video", "navegador", version);
  process.env.VIDEO_STATE_DIR = nodePath.join(base, "video", "estado");
  if (process.env.VIDEO_E2E_FFMPEG) process.env.FFMPEG_DIR = process.env.VIDEO_E2E_FFMPEG;
  process.env.HYPERFRAMES_BROWSER_PATH = nodePath.join(raizNav, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  process.env.VIDEO_NAVEGADOR_MANIFIESTO = nodePath.join(raizNav, "MANIFIESTO-SHA256.json");
  process.env.VIDEO_FORZAR_SIN_GPU = "1";
  delete process.env.VIDEO_HYPERFRAMES_BIN;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  delete process.env.VIDEO_TIMEOUT_RENDER_S;
  return { base, version, raizNav };
});

import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion } from "../src/alineacion.js";
import { extraerFotograma } from "../src/fotograma.js";
import { carpetasDelBundle, ejecutar, herramientasFfmpeg, hfHome, procesosBajo, verificarNavegador } from "../src/proceso.js";
import { encolarRender, esperarJob, HYPERFRAMES_BIN, obtenerJob, type Job } from "../src/render.js";

const RAIZ = path.join(F.base, "videos");
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Medidas: a stderr y, si se pide, a un fichero (VIDEO_E2E_MEDIDAS) para el informe. */
function medida(texto: string): void {
  process.stderr.write(`[medida] ${texto}\n`);
  if (process.env.VIDEO_E2E_MEDIDAS) fs.appendFileSync(process.env.VIDEO_E2E_MEDIDAS, `${new Date().toISOString()} ${texto}\n`);
}

function generarManifiesto(): void {
  const ficheros: Record<string, string> = {};
  const recorrer = (rel: string) => {
    for (const e of fs.readdirSync(path.join(F.raizNav, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) recorrer(r);
      else if (r !== "MANIFIESTO-SHA256.json") ficheros[r] = sha(path.join(F.raizNav, ...r.split("/")));
    }
  };
  recorrer("");
  fs.writeFileSync(process.env.VIDEO_NAVEGADOR_MANIFIESTO!, JSON.stringify({ version: F.version, ficheros }));
}

const GUION = `---
titulo: Real
gancho: Hook line.
---
[1] One two three.
[2] Four five.
[3] Six seven.
[4] Eight.
[5] Nine ten.
[6] Eleven twelve.
`;

async function prepararVideo(id: string) {
  const h = herramientasFfmpeg(process.env.FFMPEG_DIR)!;
  const dir = path.join(RAIZ, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "guion.md"), GUION);
  const ff = async (args: string[]) => {
    const r = await ejecutar(h.ffmpeg, ["-y", "-v", "error", ...args], { timeoutMs: 60000 });
    if (r.code !== 0) throw new Error(r.stderr);
  };
  const colores = ["0x1f5c3a", "0x3a1f5c", "0x5c3a1f", "0x1f3a5c", "0x5c1f3a", "0x3a5c1f"];
  for (let n = 1; n <= 6; n++) await ff(["-f", "lavfi", "-i", `color=c=${colores[n - 1]}:s=1080x1920:d=1`, "-frames:v", "1", path.join(dir, `img${n}.jpg`)]);
  await ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=5", "-c:a", "aac", "-f", "adts", path.join(dir, "voz.mp3")]);
  const guion = parsearGuion(GUION);
  const chars = [...guion.narracion];
  const paso = 4.6 / chars.length;
  const palabras = procesarAlineacion({
    narracion: guion.narracion,
    bloques: guion.bloques,
    alineacion: {
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => 0.2 + i * paso),
      character_end_times_seconds: chars.map((_, i) => 0.2 + (i + 1) * paso),
    },
    duracionAudio: 5,
    hashNarracion: guion.hash,
  });
  fs.writeFileSync(path.join(dir, "palabras.json"), JSON.stringify(palabras));
}

const o = (modo?: "auto" | "rapido" | "compatible") => ({ raiz: RAIZ, musica: false, musicaVolumen: 0.12, modo });

/** Estado de las cachés del usuario que HyperFrames/puppeteer tocarían con HOME sin redirigir. */
function huellaCaches(): Record<string, number | null> {
  const r: Record<string, number | null> = {};
  for (const rel of [".cache/hyperframes", ".hyperframes", ".cache/puppeteer"]) {
    const p = path.join(os.homedir(), rel);
    r[rel] = fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
  }
  return r;
}

type Muestra = {
  t: number;
  tcp: { a: string; pid: number }[];
  udp: { a: string; pid: number }[];
  cmd: string[];
  /** Pids de los descendientes de este proceso. */
  desc: number[];
  /** Pids de los chrome-headless-shell.exe descendientes (por ParentProcessId, no por ruta). */
  chrome: number[];
  /** Ficheros de ~/.hyperframes/running del usuario (HyperFrames apunta ahí el pid de cada CLI viva). */
  run: string[];
  /** CLI de HyperFrames de otras sesiones (no descendientes): tocan ~/.hyperframes por su cuenta. */
  ajenos: number;
};

/**
 * PowerShell en bucle: sockets en escucha de los descendientes de este proceso, sus líneas de órdenes y
 * sus Chrome. Pide 250 ms entre muestras, pero cada vuelta de WMI y de los cmdlets de red tarda ~2 s: un
 * servidor que viva menos que eso puede escaparse.
 */
function muestreador(): { muestras: Muestra[]; parar: () => Promise<void> } {
  const ps = path.join(process.env.SYSTEMROOT!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$raiz = ${process.pid}
while ($true) {
  $p = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine, Name
  $hijos = @{}; foreach ($x in $p) { if (-not $hijos.ContainsKey([int]$x.ParentProcessId)) { $hijos[[int]$x.ParentProcessId] = @() }; $hijos[[int]$x.ParentProcessId] += [int]$x.ProcessId }
  $desc = New-Object 'System.Collections.Generic.HashSet[int]'; $cola = @($raiz)
  while ($cola.Count) { $n = $cola[0]; $cola = @($cola | Select-Object -Skip 1); if ($hijos.ContainsKey($n)) { foreach ($c in $hijos[$n]) { if ($desc.Add($c)) { $cola += $c } } } }
  $tcp = @(Get-NetTCPConnection -State Listen | Where-Object { $desc.Contains([int]$_.OwningProcess) } | ForEach-Object { @{ a = $_.LocalAddress; pid = [int]$_.OwningProcess } })
  $udp = @(Get-NetUDPEndpoint | Where-Object { $desc.Contains([int]$_.OwningProcess) } | ForEach-Object { @{ a = $_.LocalAddress; pid = [int]$_.OwningProcess } })
  $cmd = @($p | Where-Object { $desc.Contains([int]$_.ProcessId) -and $_.CommandLine -match 'backgroundChecksWorker|autoUpdate' } | ForEach-Object { $_.CommandLine })
  $run = @(Get-ChildItem -Name (Join-Path $env:USERPROFILE '.hyperframes\\running'))
  $ajenos = @($p | Where-Object { -not $desc.Contains([int]$_.ProcessId) -and $_.CommandLine -match 'hyperframes\\.mjs' -and $_.CommandLine -notmatch 'Get-CimInstance' }).Count
  $chrome = @($p | Where-Object { $desc.Contains([int]$_.ProcessId) -and $_.Name -eq 'chrome-headless-shell.exe' } | ForEach-Object { [int]$_.ProcessId })
  @{ t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); tcp = $tcp; udp = $udp; cmd = $cmd; desc = @($desc); chrome = $chrome; run = $run; ajenos = $ajenos } | ConvertTo-Json -Compress -Depth 4
  Start-Sleep -Milliseconds 250
}`;
  const hijo: ChildProcess = spawn(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const muestras: Muestra[] = [];
  let buf = "";
  hijo.stdout!.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    const lineas = buf.split(/\r?\n/);
    buf = lineas.pop() ?? "";
    for (const l of lineas) {
      try {
        const m = JSON.parse(l) as Muestra;
        const lista = <T,>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
        muestras.push({
          t: m.t,
          tcp: lista(m.tcp),
          udp: lista(m.udp),
          cmd: lista(m.cmd),
          desc: lista(m.desc),
          chrome: lista(m.chrome),
          run: lista(m.run).map(String),
          ajenos: m.ajenos ?? 0,
        });
      } catch {
        /* línea incompleta */
      }
    }
  });
  return {
    muestras,
    parar: async () => {
      hijo.kill();
      await esperar(300);
    },
  };
}

/** Fase del job en cada momento (para cruzarla con las muestras). */
function seguirFases(jobId: string): { tramos: { fase: string; t: number }[]; parar: () => void } {
  const tramos: { fase: string; t: number }[] = [];
  const i = setInterval(() => {
    const f = obtenerJob(jobId)?.fase ?? "";
    if (tramos.at(-1)?.fase !== f) tramos.push({ fase: f, t: Date.now() });
  }, 50);
  return { tramos, parar: () => clearInterval(i) };
}
const faseEn = (tramos: { fase: string; t: number }[], t: number) => [...tramos].reverse().find((x) => x.t <= t)?.fase ?? "";

const datos: { job?: Job; muestras: { fase: string; m: Muestra }[]; huellaAntes?: Record<string, number | null>; controlPid?: number } = { muestras: [] };

const FFMPEG_PROHIBIDO =
  ACTIVO &&
  /^\s*\S+\s+(libx264|libx264rgb|libx265|libopenh264)\s/m.test(
    spawnSync(path.join(process.env.VIDEO_E2E_FFMPEG ?? "", "ffmpeg.exe"), ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "",
  );

/** Sin esto, un muestreador que no arrancó haría pasar en vacío las comprobaciones sobre `datos`. */
function exigirMuestras(): void {
  expect(datos.muestras.length, "el muestreador no dio ninguna muestra: el test «render completo» no llegó a ejecutarlo").toBeGreaterThan(0);
}

function sigueVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe.runIf(ACTIVO)("render real con CfT y ffmpeg LGPL", () => {
  beforeAll(async () => {
    const origen = path.join(process.env.VIDEO_E2E_NAVEGADOR!, "chrome-headless-shell-win64");
    // debug.log es un rastro de ejecuciones anteriores de ese Chrome, no parte del zip.
    fs.cpSync(origen, path.join(F.raizNav, "chrome-headless-shell-win64"), { recursive: true, filter: (s) => path.basename(s) !== "debug.log" });
    generarManifiesto();
    for (const id of ["video030", "video031", "video032", "video033", "video034"]) await prepararVideo(id);
  }, 300000);
  afterAll(() => {
    try {
      fs.rmSync(F.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      /* temporal del SO */
    }
  });

  it("verificarNavegador con el CfT real (tiempo)", async () => {
    const t0 = performance.now();
    await verificarNavegador();
    const ms = performance.now() - t0;
    medida(`verificarNavegador con el CfT real: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(10000);
  });

  // En integrado el navegador tiene que estar en <estado>/video/navegador: ya lo está. Van antes que el
  // resto: el sondeo se cachea en el proceso y la comprobación del ffmpeg solo corre la primera vez.
  async function renderIntegrado(): Promise<Job> {
    process.env.VIDEO_ENGINE_EMBEDDED = "1";
    try {
      const j = await esperarJob((await encolarRender("video034", o())).job_id, 500);
      medida(`integrado: estado=${j.estado} error=${j.error ?? "-"} codificador=${j.codificador ?? "-"}`);
      return j;
    } finally {
      delete process.env.VIDEO_ENGINE_EMBEDDED;
    }
  }

  it.runIf(FFMPEG_PROHIBIDO)("integrado con un ffmpeg que trae codificadores prohibidos: el render falla", async () => {
    const j = await renderIntegrado();
    expect(j.estado).toBe("error");
    expect(j.error).toMatch(/LGPL del bundle/);
  }, 900000);

  it.skipIf(FFMPEG_PROHIBIDO)("integrado con el ffmpeg LGPL propio: el render termina", async () => {
    const j = await renderIntegrado();
    expect(j.error).toBeUndefined();
    expect(j.estado).toBe("terminado");
  }, 900000);

  it("render completo (Compatible) con HOME redirigido: no toca las cachés del usuario (I13)", async () => {
    datos.huellaAntes = huellaCaches();
    // Control del oráculo: un servidor conocido, descendiente de este proceso, que el muestreo tiene que ver.
    const control = spawn(process.execPath, ["-e", 'require("net").createServer().listen(0,"127.0.0.1");setTimeout(()=>process.exit(0),3e5)'], { stdio: "ignore" });
    datos.controlPid = control.pid;
    const s = muestreador();
    try {
      const t0 = performance.now();
      const job = await encolarRender("video030", o());
      const fases = seguirFases(job.job_id);
      const j = await esperarJob(job.job_id, 500);
      fases.parar();
      // snapshot sobre la misma composición, también muestreado.
      fases.tramos.push({ fase: "snapshot", t: Date.now() });
      const fotos = path.join(F.base, "snap");
      const rs = await ejecutar(process.execPath, [HYPERFRAMES_BIN, "snapshot", path.join(RAIZ, "video030", "_composicion"), "--at", "1", "--no-end", "-o", fotos], {
        timeoutMs: 300000,
      });
      fases.tramos.push({ fase: "fin", t: Date.now() });
      await s.parar();
      datos.job = j;
      datos.muestras = s.muestras.map((m) => ({ fase: faseEn(fases.tramos, m.t), m }));
      medida(`render Compatible de ${j.duracion?.toFixed(2)} s en ${((performance.now() - t0) / 1000).toFixed(1)} s · ${j.avisos.find((a) => a.startsWith("Codificador:"))}`);
      medida(`muestras de sockets: ${s.muestras.length}; fases: ${fases.tramos.map((x) => x.fase || "-").join(" → ")}; snapshot código ${rs.code}`);
      expect(j.error).toBeUndefined();
      expect(j.estado).toBe("terminado");
      expect(j.codificador).toMatch(/^h264_(nvenc|qsv|amf|mf)$/);
      expect(j.avisos.some((a) => a.startsWith("Codificador:"))).toBe(true);
      exigirMuestras();
      // HOME redirigido: el estado de HyperFrames de nuestras CLI está en hf-home…
      expect(fs.existsSync(path.join(hfHome(), ".hyperframes"))).toBe(true);
      // …y ninguna de ellas se apuntó en ~/.hyperframes/running del usuario.
      const nuestros = new Set(datos.muestras.flatMap(({ m }) => m.desc.map(String)));
      expect(datos.muestras.flatMap(({ m }) => m.run).filter((r) => nuestros.has(r))).toEqual([]);
      // Las cachés del usuario no cambian, salvo que otra sesión de HyperFrames (no nuestra) corriera a la vez.
      const ajenos = Math.max(0, ...datos.muestras.map(({ m }) => m.ajenos));
      medida(`CLI de HyperFrames ajenas durante el render: ${ajenos}; pids propios vistos: ${nuestros.size}`);
      if (!ajenos) expect(huellaCaches()).toEqual(datos.huellaAntes);
      const png = await extraerFotograma(herramientasFfmpeg(process.env.FFMPEG_DIR)!, j.mp4, 1);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      // El navegador sigue cuadrando con el manifiesto tras usarlo (Chrome solo escribe su debug.log).
      await expect(verificarNavegador()).resolves.toBeUndefined();
    } finally {
      await s.parar();
      control.kill();
    }
  }, 900000);

  it("HyperFrames no intenta actualizarse ni comprobar nada en segundo plano (LOW-3)", () => {
    exigirMuestras();
    const config = path.join(hfHome(), ".hyperframes", "config.json");
    const texto = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "";
    for (const clave of ["lastUpdateAttemptAt", "lastSkillsAttemptAt", "pendingUpdate"]) expect(texto, clave).not.toContain(clave);
    expect(datos.muestras.flatMap(({ m }) => m.cmd)).toEqual([]);
  });

  it("los sockets en escucha de los descendientes están en 127.0.0.1 en check, render y snapshot (I7, C10)", () => {
    exigirMuestras();
    const todos = datos.muestras.flatMap(({ m }) => [...m.tcp, ...m.udp]);
    expect(todos.some((s) => s.pid === datos.controlPid), "el oráculo de sockets no ve ni el servidor de control: la tabla de escuchas no es fiable en este entorno").toBe(true);
    const vistos = (fase: string) => datos.muestras.filter((x) => x.fase === fase).flatMap(({ m }) => [...m.tcp, ...m.udp]).filter((s) => s.pid !== datos.controlPid);
    const resumen = Object.fromEntries(["check", "render", "codificacion", "snapshot"].map((f) => [f, [...new Set(vistos(f).map((s) => s.a))]]));
    medida(`direcciones en escucha por fase: ${JSON.stringify(resumen)}`);
    // En positivo: el muestreo vio servidores en las tres fases (si no, el test no prueba nada).
    expect(vistos("check").length).toBeGreaterThan(0);
    expect(vistos("render").length).toBeGreaterThan(0);
    expect(vistos("snapshot").length).toBeGreaterThan(0);
    const fuera = [...new Set(datos.muestras.flatMap(({ m }) => [...m.tcp, ...m.udp]).map((s) => s.a))].filter((a) => a !== "127.0.0.1");
    // Conjunto conocido fuera de loopback: ninguno (W1.3 fija check/snapshot/render en 127.0.0.1).
    expect(fuera).toEqual([]);
  });

  it("Rápido real: el codificador que elige HyperFrames queda registrado", async () => {
    const j = await esperarJob((await encolarRender("video031", o("rapido"))).job_id, 500);
    medida(`Rápido: estado=${j.estado} modo=${j.modo} codificador=${j.codificador} reserva=${j.reserva ?? "-"} avisos=${j.avisos.filter((a) => /Codificador|eligió|Rápido/.test(a)).join(" | ")}`);
    expect(j.estado).toBe("terminado");
    expect(j.codificador).toMatch(/^h264_(nvenc|qsv|amf|mf)$/);
  }, 900000);

  it("render con timeout no deja procesos bajo el CfT ni el ffmpeg (I7)", async () => {
    process.env.VIDEO_TIMEOUT_RENDER_S = "15";
    const s = muestreador();
    try {
      const j = await esperarJob((await encolarRender("video032", o())).job_id, 500);
      await s.parar();
      expect(j.estado).toBe("error");
      expect(j.error).toMatch(/tiempo máximo/);
      expect(await procesosBajo(carpetasDelBundle(herramientasFfmpeg(process.env.FFMPEG_DIR)))).toEqual([]);
      // Oráculo independiente del barrido: los Chrome vistos por ParentProcessId, comprobados por pid.
      const chromes = [...new Set(s.muestras.flatMap((m) => m.chrome))];
      medida(`timeout: ${chromes.length} Chrome descendientes vistos en ${s.muestras.length} muestras`);
      expect(chromes.length, "el muestreador no vio ningún Chrome del motor").toBeGreaterThan(0);
      expect(chromes.filter(sigueVivo)).toEqual([]);
    } finally {
      await s.parar();
      delete process.env.VIDEO_TIMEOUT_RENDER_S;
    }
  }, 900000);

  it("CfT con una .dll añadida tras el manifiesto: el render falla antes de lanzar Chrome (I4)", async () => {
    const dll = path.join(F.raizNav, "chrome-headless-shell-win64", "plantada.dll");
    fs.copyFileSync(path.join(F.raizNav, "chrome-headless-shell-win64", "libEGL.dll"), dll);
    try {
      let visto = false;
      const vigilancia = (async () => {
        for (let i = 0; i < 20; i++) {
          if ((await procesosBajo({ arboles: [F.raizNav], exactos: [] })).length) visto = true;
          await esperar(250);
        }
      })();
      const j = await esperarJob((await encolarRender("video033", o())).job_id, 200);
      await vigilancia;
      expect(j.estado).toBe("error");
      expect(j.error).toMatch(/no está en el manifiesto/);
      expect(visto).toBe(false);
    } finally {
      fs.rmSync(dll, { force: true });
    }
  }, 900000);
});

it.skipIf(ACTIVO)("render real: se salta sin VIDEO_E2E_REAL=1", () => {
  expect(ACTIVO).toBe(false);
});
