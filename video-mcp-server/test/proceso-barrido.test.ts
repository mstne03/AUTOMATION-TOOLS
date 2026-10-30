// I7: tras un timeout o una CLI que falla, no queda ningún proceso con imagen bajo la carpeta del
// navegador ni ffmpeg/ffprobe del motor, aunque su padre ya haya muerto (taskkill /T no los alcanza).
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video barrido "));
  const nav = nodePath.join(dir, "nav");
  nodeFs.mkdirSync(nav);
  // Un "Chrome" que es una copia de Node: así se puede dejar colgado con -e.
  const exe = nodePath.join(nav, "chrome-headless-shell.exe");
  nodeFs.copyFileSync(process.execPath, exe);
  const script = nodePath.join(dir, "hyperframes-falso.mjs");
  // La CLI falsa lanza A, A lanza B (el "Chrome") desligado, apunta su pid y A sale: B queda huérfano.
  // "snapshot" se cuelga después; "falla" sale con código 1.
  nodeFs.writeFileSync(
    script,
    `import { spawn } from "node:child_process";
const [sub, pidFile] = process.argv.slice(2);
const a = spawn(process.execPath, ["-e", ${JSON.stringify(
      `const { spawn } = require("node:child_process"); const fs = require("node:fs");
       const b = spawn(${JSON.stringify(exe)}, ["-e", "setInterval(()=>{},1e3)"], { detached: true, stdio: "ignore" });
       b.unref(); fs.writeFileSync(process.argv[1], String(b.pid));`,
    )}, pidFile], { stdio: "ignore" });
a.on("close", () => {
  if (sub === "falla") process.exit(1);
  setInterval(() => {}, 1000);
});
`,
  );
  process.env.VIDEO_HYPERFRAMES_BIN = script;
  process.env.VIDEO_STATE_DIR = nodePath.join(dir, "estado");
  process.env.HYPERFRAMES_BROWSER_PATH = exe;
  delete process.env.VIDEO_NAVEGADOR_MANIFIESTO;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  return { dir, nav, exe, script };
});

import { spawn } from "node:child_process";
import { barrerProcesos, carpetasDelBundle, ejecutar, filtrarProcesos, herramientasFfmpeg, matarProcesos, procesosBajo, seleccionarBarrido } from "../src/proceso.js";

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function muere(pid: number): Promise<boolean> {
  for (let i = 0; i < 20 && vivo(pid); i++) await esperar(100);
  return !vivo(pid);
}
const matarSiVive = (pid: number) => {
  try {
    if (pid && vivo(pid)) process.kill(pid, "SIGKILL");
  } catch {
    /* ya muerto */
  }
};

afterAll(() => {
  try {
    fs.rmSync(F.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* temporal del SO */
  }
});

describe.runIf(process.platform === "win32")("barrido real (Windows)", () => {
  it("un huérfano bajo la carpeta del navegador muere tras el timeout de un snapshot", async () => {
    const pidFile = path.join(F.dir, "huerfano1.pid");
    let pid = 0;
    try {
      const r = await ejecutar(process.execPath, [F.script, "snapshot", pidFile], { timeoutMs: 3000 });
      expect(r.timeout).toBe(true);
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(await muere(pid)).toBe(true);
    } finally {
      matarSiVive(pid);
    }
  }, 30000);

  it("una CLI que sale con error también barre sus huérfanos", async () => {
    const pidFile = path.join(F.dir, "huerfano2.pid");
    let pid = 0;
    try {
      const r = await ejecutar(process.execPath, [F.script, "falla", pidFile], {});
      expect(r.code).toBe(1);
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(await muere(pid)).toBe(true);
    } finally {
      matarSiVive(pid);
    }
  }, 30000);

  it("el huérfano muere, pero un trabajo legítimo en curso con la misma imagen sobrevive (MEDIUM-A)", async () => {
    const pidFile = path.join(F.dir, "huerfano3.pid");
    let pid = 0;
    try {
      // Otro trabajo del motor en curso con la imagen del "Chrome" (no es la CLI: corre a la vez y
      // termina solo a los 30 s, mucho después del barrido). Antes, el barrido lo mataba y su promesa daba código ≠ 0.
      const t0 = Date.now();
      // Escribe «fin» al terminar por sí mismo: un proceso matado no lo escribe (el código de salida de
      // un TerminateProcess no es fiable para distinguirlo).
      const otra = ejecutar(F.exe, ["-e", "setTimeout(()=>{ process.stdout.write('fin') },30000)"]).then((r) => ({ ...r, ms: Date.now() - t0 }));
      const r = await ejecutar(process.execPath, [F.script, "render", pidFile], { timeoutMs: 3000 });
      expect(r.timeout).toBe(true);
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(await muere(pid)).toBe(true);
      const ro = await otra;
      expect(ro.timeout).toBeUndefined();
      expect(ro.stdout).toBe("fin");
      expect(ro.ms).toBeGreaterThanOrEqual(29000);
    } finally {
      matarSiVive(pid);
    }
  }, 60000);

  it("matarProcesos mata un proceso cuya ruta lleva ’ y ' (la tabla viaja en JSON)", async () => {
    const dir = path.join(F.dir, "nav ’comilla' x");
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, "chrome-headless-shell.exe");
    fs.copyFileSync(process.execPath, exe);
    const hijo = spawn(exe, ["-e", "setInterval(()=>{},1e3)"], { stdio: "ignore", detached: true });
    hijo.unref();
    const pid = hijo.pid!;
    try {
      await esperar(500);
      const [p] = await procesosBajo({ arboles: [], exactos: [exe] });
      expect(p?.pid).toBe(pid);
      await matarProcesos([p]);
      expect(await muere(pid)).toBe(true);
    } finally {
      matarSiVive(pid);
    }
  }, 30000);
});

describe("barrerProcesos", () => {
  const objetivo = { arboles: ["C:\\nav"], exactos: [] };

  it("si no se puede matar, pide reiniciar el motor una vez", async () => {
    const reiniciar = vi.fn();
    await barrerProcesos(objetivo, {
      listar: async () => [{ pid: 999999, ruta: "C:\\nav\\chrome.exe" }],
      matar: async () => {},
      reiniciar,
    });
    expect(reiniciar).toHaveBeenCalledTimes(1);
  });

  it("si no se puede listar, pide reiniciar el motor", async () => {
    const reiniciar = vi.fn();
    await barrerProcesos(objetivo, {
      listar: async () => {
        throw new Error("powershell no respondió");
      },
      matar: async () => {},
      reiniciar,
    });
    expect(reiniciar).toHaveBeenCalledTimes(1);
  });

  it("sin nada vivo no mata ni reinicia", async () => {
    const matar = vi.fn();
    const reiniciar = vi.fn();
    await barrerProcesos(objetivo, { listar: async () => [], matar, reiniciar });
    expect(matar).not.toHaveBeenCalled();
    expect(reiniciar).not.toHaveBeenCalled();
  });

  it("nunca se mata a sí mismo", async () => {
    const matar = vi.fn();
    await barrerProcesos(objetivo, { listar: async () => [{ pid: process.pid, ruta: "C:\\nav\\x.exe" }], matar, reiniciar: vi.fn() });
    expect(matar).not.toHaveBeenCalled();
  });

  it("un proceso con nombre del motor y sin ruta no es verificable: reinicia (falla cerrado)", async () => {
    const matar = vi.fn();
    const reiniciar = vi.fn();
    await barrerProcesos(objetivo, { listar: async () => [{ pid: 4242, ruta: "", nombre: "Chrome-Headless-Shell.exe" }], matar, reiniciar });
    expect(reiniciar).toHaveBeenCalledTimes(1);
    expect(matar).not.toHaveBeenCalled();
    // Con un nombre ajeno al motor, sin ruta, no pasa nada.
    const r2 = vi.fn();
    await barrerProcesos(objetivo, { listar: async () => [{ pid: 4243, ruta: "", nombre: "svchost.exe" }], matar, reiniciar: r2 });
    expect(r2).not.toHaveBeenCalled();
  });

  it("sin ruta, la línea de órdenes decide: de otro sitio se ignora; del motor o relativa, reinicia", async () => {
    const con = async (linea: string) => {
      const reiniciar = vi.fn();
      await barrerProcesos(objetivo, { listar: async () => [{ pid: 4244, ruta: "", nombre: "chrome-headless-shell.exe", linea }], matar: vi.fn(), reiniciar });
      return reiniciar.mock.calls.length;
    };
    expect(await con('"C:\\otra sesion\\chrome-headless-shell.exe" --type=renderer')).toBe(0);
    expect(await con('"C:\\nav\\chrome-headless-shell.exe" --type=renderer')).toBe(1);
    expect(await con("chrome-headless-shell.exe --type=renderer")).toBe(1);
  });
});

describe("seleccionarBarrido: hijos en vuelo (MEDIUM-A)", () => {
  const o = { arboles: ["C:\\nav"], exactos: ["C:\\ff\\ffmpeg.exe"] };
  const T = 1_000_000;
  const lista = [
    { pid: 10, ruta: "C:\\motor\\node.exe", padre: 1, creado: T }, // el motor
    { pid: 20, ruta: "C:\\ff\\ffmpeg.exe", padre: 10, creado: T + 100 }, // segunda pasada en vuelo
    { pid: 30, ruta: "C:\\motor\\node.exe", padre: 10, creado: T + 200 }, // otra CLI en vuelo
    { pid: 31, ruta: "C:\\nav\\chrome-headless-shell.exe", padre: 30, creado: T + 300 }, // su Chrome
    { pid: 40, ruta: "C:\\nav\\chrome-headless-shell.exe", padre: 99, creado: T + 400 }, // huérfano (padre muerto)
    { pid: 50, ruta: "C:\\nav\\chrome-headless-shell.exe", padre: 30, creado: T + 50 }, // pid 30 reutilizado: creado antes que su "padre"
  ];
  const vuelo = new Map([
    [20, T + 100],
    [30, T + 200],
  ]);

  it("protege el hijo en vuelo y sus descendientes; barre huérfanos y padres reutilizados", () => {
    expect(seleccionarBarrido(lista, o, vuelo).matar.map((p) => p.pid).sort()).toEqual([40, 50]);
  });

  it("sin nada en vuelo, barre todo lo del motor", () => {
    expect(seleccionarBarrido(lista, o, new Map()).matar.map((p) => p.pid).sort()).toEqual([20, 31, 40, 50]);
  });
});

describe.runIf(process.platform === "win32")("filtrarProcesos (Windows)", () => {
  const lista = [
    { pid: 1, ruta: "C:\\Nav\\chrome-headless-shell.exe" },
    { pid: 2, ruta: "\\\\?\\C:\\nav\\sub\\crashpad.exe" },
    { pid: 3, ruta: "C:\\nav-2\\x.exe" },
    { pid: 4, ruta: "C:\\ff\\ffmpeg.exe" },
    { pid: 5, ruta: "C:\\ff\\ffplay.exe" },
    { pid: 6, ruta: "" },
  ];

  it("el árbol entero del navegador, sin confundir prefijos, y con rutas \\\\?\\", () => {
    const pids = filtrarProcesos(lista, { arboles: ["C:\\nav"], exactos: [] }).map((p) => p.pid);
    expect(pids).toEqual([1, 2]);
  });

  it("en la carpeta de ffmpeg, solo ffmpeg.exe y ffprobe.exe exactos", () => {
    const pids = filtrarProcesos(lista, { arboles: [], exactos: ["C:\\ff\\ffmpeg.exe", "C:\\ff\\ffprobe.exe"] }).map((p) => p.pid);
    expect(pids).toEqual([4]);
  });
});

describe("carpetasDelBundle", () => {
  const h = herramientasFfmpeg(process.env.FFMPEG_DIR);
  it.skipIf(!h)("con FFMPEG_DIR, ffmpeg y ffprobe exactos; sin manifiesto, el exe del navegador exacto", () => {
    const o = carpetasDelBundle(h, { HYPERFRAMES_BROWSER_PATH: F.exe, FFMPEG_DIR: h!.dir });
    expect(o.arboles).toEqual([]);
    expect([...new Set(o.exactos.map((p) => path.basename(p).toLowerCase()))].sort()).toEqual(["chrome-headless-shell.exe", "ffmpeg.exe", "ffprobe.exe"]);
    expect(o.exactos).toContain(h!.ffmpeg);
  });
  it.skipIf(!h)("en desarrollo sin FFMPEG_DIR no barre ffmpeg (el de PATH o winget puede ser de otro programa)", () => {
    const o = carpetasDelBundle(h, { HYPERFRAMES_BROWSER_PATH: F.exe });
    expect(o.exactos.map((p) => path.basename(p).toLowerCase())).toEqual(["chrome-headless-shell.exe"]);
    expect(carpetasDelBundle(h, { VIDEO_ENGINE_EMBEDDED: "1" }).exactos.length).toBeGreaterThan(0);
  });
  it.skipIf(!h)("con manifiesto, la carpeta entera de la versión", () => {
    const man = path.join(F.nav, "MANIFIESTO-SHA256.json");
    const o = carpetasDelBundle(h, { HYPERFRAMES_BROWSER_PATH: F.exe, VIDEO_NAVEGADOR_MANIFIESTO: man });
    expect(o.arboles).toHaveLength(1);
    expect(path.resolve(o.arboles[0]).toLowerCase()).toBe(path.resolve(F.nav).toLowerCase());
  });
});
