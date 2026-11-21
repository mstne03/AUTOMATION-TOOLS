// I5 e I13: el entorno de cada hijo se construye desde cero (lista blanca) y toda invocación de la CLI
// de HyperFrames corre en modo cerrado, con HOME en hf-home, cwd en hf-home y en serie.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video entorno "));
  const script = nodePath.join(dir, "hyperframes-falso.mjs");
  const registro = nodePath.join(dir, "llamadas.jsonl");
  // La CLI falsa apunta argv, entorno y cwd; con "lento" tarda 400 ms (para ver si dos llamadas se solapan).
  nodeFs.writeFileSync(
    script,
    `import fs from "node:fs";
const inicio = Date.now();
const fin = () => fs.appendFileSync(${JSON.stringify(registro)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), inicio, fin: Date.now() }) + "\\n");
if (process.argv[2] === "lento") setTimeout(() => { fin(); process.exit(0); }, 400);
else { fin(); process.exit(0); }
`,
  );
  const navegador = nodePath.join(dir, "nav", "chrome-headless-shell.exe");
  nodeFs.mkdirSync(nodePath.dirname(navegador), { recursive: true });
  nodeFs.writeFileSync(navegador, "exe");
  process.env.VIDEO_HYPERFRAMES_BIN = script;
  process.env.VIDEO_STATE_DIR = nodePath.join(dir, "estado");
  process.env.ELEVENLABS_API_KEY = "sk-secreta";
  process.env.AWS_SECRET_ACCESS_KEY = "x";
  process.env.PRODUCER_FORCE_SCREENSHOT = "false";
  process.env.HYPERFRAMES_BROWSER_PATH = navegador;
  delete process.env.VIDEO_NAVEGADOR_MANIFIESTO;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  return { dir, script, registro, navegador };
});

import { ejecutar, entornoHijo, herramientasFfmpeg, hfHome, system32 } from "../src/proceso.js";

// Literales a propósito: si la lista del código crece, este test tiene que fallar (I5, I13).
const CERRADO = ["CI", "HYPERFRAMES_NO_UPDATE_CHECK", "HYPERFRAMES_NO_AUTO_INSTALL", "HYPERFRAMES_NO_OPTIONAL_INSTALL", "HYPERFRAMES_NO_TELEMETRY", "DO_NOT_TRACK", "HYPERFRAMES_SKIP_SKILLS"];
const LISTA_BLANCA = new Set(["PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", ...CERRADO, "HYPERFRAMES_BROWSER_PATH", "HYPERFRAMES_FFMPEG_PATH", "HYPERFRAMES_FFPROBE_PATH"]);

type Llamada = { argv: string[]; env: Record<string, string>; cwd: string; inicio: number; fin: number };
const leer = (): Llamada[] =>
  fs.existsSync(F.registro)
    ? fs.readFileSync(F.registro, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Llamada)
    : [];
const h = herramientasFfmpeg(process.env.FFMPEG_DIR);
const LIBUV = new Set(["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME", "WINDIR"]);
const SECRETAS = ["ELEVENLABS_API_KEY", "AWS_SECRET_ACCESS_KEY", "PRODUCER_FORCE_SCREENSHOT"];
const mismaRuta = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

afterEach(() => {
  fs.rmSync(F.registro, { force: true });
  process.env.HYPERFRAMES_BROWSER_PATH = F.navegador;
  const home = path.join(process.env.VIDEO_STATE_DIR!, "hf-home");
  for (const n of fs.existsSync(home) ? fs.readdirSync(home) : []) if (n !== ".hyperframes") fs.rmSync(path.join(home, n), { recursive: true, force: true });
});
afterAll(() => {
  try {
    fs.rmSync(F.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* carpeta temporal del SO */
  }
});

describe("entorno de los hijos (I5)", () => {
  it("entornoHijo solo contiene claves de la lista blanca", () => {
    const env = entornoHijo();
    for (const k of Object.keys(env)) expect(LISTA_BLANCA.has(k), k).toBe(true);
    for (const k of SECRETAS) expect(env[k]).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("SYSTEMROOT tiene que ser una carpeta local fuera del perfil y coherente con windir", () => {
    const base = { USERPROFILE: "C:\\Users\\Marc", LOCALAPPDATA: "C:\\Users\\Marc\\AppData\\Local", windir: "C:\\Windows" };
    expect(system32({ ...base, SYSTEMROOT: "C:\\Windows" })).toBe("C:\\Windows\\System32");
    expect(system32({ ...base, SYSTEMROOT: "c:\\windows\\" })).toMatch(/System32$/);
    expect(() => system32({ ...base })).toThrow(/SYSTEMROOT/);
    for (const mala of ["\\\\servidor\\Windows", "Windows", "C:\\Users\\Marc\\falso", "C:\\Users\\Marc\\AppData\\Local\\x", "D:\\Windows"]) {
      expect(() => system32({ ...base, SYSTEMROOT: mala }), mala).toThrow(/SYSTEMROOT/);
    }
  });

  it.runIf(process.platform === "win32")("PATH = ffmpeg del motor + System32 + PowerShell, sin el PATH del usuario", () => {
    const env = entornoHijo();
    const sys = process.env.SYSTEMROOT!;
    expect(env.PATH!.split(path.delimiter)).toEqual([
      ...(h ? [h.dir] : []),
      path.join(sys, "System32"),
      path.join(sys, "System32", "WindowsPowerShell", "v1.0"),
    ]);
    if (h) {
      expect(env.HYPERFRAMES_FFMPEG_PATH).toBe(h.ffmpeg);
      expect(env.HYPERFRAMES_FFPROBE_PATH).toBe(h.ffprobe);
    }
  });

  it("inventario: entornoConFfmpeg, OpcionesEjecutar.env y browserPath ya no existen en src/ (W1.6b T6)", () => {
    const src = path.resolve(import.meta.dirname, "..", "src");
    const quedan = fs.readdirSync(src).filter((n) => n.endsWith(".ts")).flatMap((n) =>
      fs
        .readFileSync(path.join(src, n), "utf8")
        .split("\n")
        .flatMap((l, i) => (/entornoConFfmpeg|browserPath|_browserPath|env: _descartado/.test(l) ? [`${n}:${i + 1}`] : [])),
    );
    expect(quedan).toEqual([]);
  });

  it.runIf(process.platform === "win32")("R0 L4: un `env` pasado por JS no llega al hijo (el spread va antes de entornoHijo)", async () => {
    const opciones = { env: { SECRETA_DE_JS: "x", PATH: "C:\\plantado" }, timeoutMs: 60_000 } as object;
    const r = await ejecutar(path.join(process.env.SYSTEMROOT!, "System32", "cmd.exe"), ["/c", "set"], opciones);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^HOME=/m);
    expect(r.stdout).not.toContain("SECRETA_DE_JS");
    expect(r.stdout).not.toContain("plantado");
  });

  it.skipIf(!h)("ffprobe funciona con el entorno filtrado", async () => {
    const r = await ejecutar(h!.ffprobe, ["-version"], { timeoutMs: 30000 });
    expect(r.code).toBe(0);
  });
});

describe("modo cerrado de la CLI (I13)", () => {
  it("toda invocación de la CLI lleva el modo cerrado aunque el llamador pase otro entorno", async () => {
    const r = await ejecutar(process.execPath, [F.script, "check", F.dir], { timeoutMs: 120_000,
      env: { ...process.env, CI: "0", HYPERFRAMES_NO_TELEMETRY: "0", HOME: "C:\\otro", NODE_OPTIONS: "--require x" },
    });
    expect(r.code).toBe(0);
    const [l] = leer();
    for (const k of CERRADO) expect(l.env[k], k).toBe("1");
    expect(l.env.HOME).toBe(hfHome());
    expect(l.env.USERPROFILE).toBe(hfHome());
    for (const k of Object.keys(l.env)) {
      // libuv copia en Windows estas variables del padre si faltan (required_vars de uv_spawn): no son secretos.
      if (process.platform === "win32" && LIBUV.has(k.toUpperCase())) continue;
      expect(LISTA_BLANCA.has(k), k).toBe(true);
    }
    for (const k of [...SECRETAS, "NODE_OPTIONS"]) expect(l.env[k], k).toBeUndefined();
  });

  it("la CLI corre con cwd en hf-home (sin el .env del proyecto)", async () => {
    const proyecto = path.join(F.dir, "proyecto");
    fs.mkdirSync(proyecto, { recursive: true });
    fs.writeFileSync(path.join(proyecto, ".env"), "PRODUCER_X=1\n");
    await ejecutar(process.execPath, [F.script, "render", proyecto], { timeoutMs: 120_000, cwd: proyecto });
    const [l] = leer();
    expect(mismaRuta(l.cwd, hfHome())).toBe(true);
  });

  it("hf-home cuelga de la carpeta de estado", () => {
    expect(mismaRuta(hfHome(), path.join(process.env.VIDEO_STATE_DIR!, "hf-home"))).toBe(true);
    expect(mismaRuta(hfHome({ VIDEO_ENGINE_EMBEDDED: "1" }), path.resolve(process.env.VIDEO_STATE_DIR!, "..", "hf-home"))).toBe(true);
  });

  it("sin HYPERFRAMES_BROWSER_PATH ninguna CLI se lanza, pero ffmpeg sigue funcionando", async () => {
    delete process.env.HYPERFRAMES_BROWSER_PATH;
    await expect(ejecutar(process.execPath, [F.script, "render", F.dir], { timeoutMs: 120_000 })).rejects.toThrow(/descárgalo en Ajustes/);
    await expect(ejecutar(process.execPath, [F.script, "audio", "x.mp3"], { timeoutMs: 120_000 })).rejects.toThrow(/descárgalo en Ajustes/);
    expect(leer()).toHaveLength(0);
    if (h) expect((await ejecutar(h.ffprobe, ["-version"], { timeoutMs: 30000 })).code).toBe(0);
  });

  it("con HYPERFRAMES_BROWSER_PATH a un fichero que no existe, tampoco", async () => {
    process.env.HYPERFRAMES_BROWSER_PATH = path.join(F.dir, "no-existe.exe");
    await expect(ejecutar(process.execPath, [F.script, "check", F.dir], { timeoutMs: 120_000 })).rejects.toThrow(/descárgalo en Ajustes/);
    expect(leer()).toHaveLength(0);
  });

  it("un Node distinto del del motor no puede lanzar la CLI", async () => {
    await expect(ejecutar("node", [F.script, "render", F.dir], { timeoutMs: 120_000 })).rejects.toThrow(/Node del motor/);
    expect(leer()).toHaveLength(0);
  });

  it("el Node del motor con otros argumentos, o el script con otra escritura de la ruta, también son la CLI", async () => {
    delete process.env.HYPERFRAMES_BROWSER_PATH;
    await expect(ejecutar(process.execPath, ["-e", "1"], { timeoutMs: 120_000 })).rejects.toThrow(/descárgalo en Ajustes/);
    // Una copia de Node con otro nombre sigue siendo la CLI si args[0] es el script, aunque cambie la grafía.
    await expect(ejecutar("C:\\otro\\runtime.exe", [F.script.toUpperCase().replace(/\//g, "\\"), "render"], { timeoutMs: 120_000 })).rejects.toThrow(/Node del motor/);
    expect(leer()).toHaveLength(0);
  });

  it("un .env plantado en hf-home bloquea la CLI", async () => {
    fs.writeFileSync(path.join(hfHome(), ".env"), "PRODUCER_X=1\n");
    await expect(ejecutar(process.execPath, [F.script, "check", F.dir], { timeoutMs: 120_000 })).rejects.toThrow(/hf-home/);
    expect(leer()).toHaveLength(0);
  });

  it("un ejecutable plantado en hf-home bloquea la CLI", async () => {
    fs.writeFileSync(path.join(hfHome(), "ffmpeg.exe"), "x");
    await expect(ejecutar(process.execPath, [F.script, "check", F.dir], { timeoutMs: 120_000 })).rejects.toThrow(/hf-home/);
    expect(leer()).toHaveLength(0);
  });

  it("dos invocaciones de la CLI concurrentes van en serie", async () => {
    await Promise.all([ejecutar(process.execPath, [F.script, "lento"], { timeoutMs: 120_000 }), ejecutar(process.execPath, [F.script, "lento"], { timeoutMs: 120_000 })]);
    const [a, b] = leer().sort((x, y) => x.inicio - y.inicio);
    expect(b.inicio).toBeGreaterThanOrEqual(a.fin);
  });
});

describe("arranque sin navegador", () => {
  it("el motor integrado carga proceso y render sin las variables del navegador", async () => {
    vi.resetModules();
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "1");
    vi.stubEnv("HYPERFRAMES_BROWSER_PATH", "");
    vi.stubEnv("VIDEO_NAVEGADOR_MANIFIESTO", "");
    try {
      await expect(import("../src/proceso.js")).resolves.toBeTruthy();
      await expect(import("../src/render.js")).resolves.toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
