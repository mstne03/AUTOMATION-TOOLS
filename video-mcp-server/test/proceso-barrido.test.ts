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
import { barrerProcesos, carpetasDelBundle, descendientes, ejecutar, filtrarProcesos, herramientasFfmpeg, matarProcesos, procesosBajo, seleccionarBarrido } from "../src/proceso.js";

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
  }, 120000);

  it("una CLI que sale con error también barre sus huérfanos", async () => {
    const pidFile = path.join(F.dir, "huerfano2.pid");
    let pid = 0;
    try {
      const r = await ejecutar(process.execPath, [F.script, "falla", pidFile], { timeoutMs: 120_000 });
      expect(r.code).toBe(1);
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(await muere(pid)).toBe(true);
    } finally {
      matarSiVive(pid);
    }
  }, 120000);

  it("el huérfano muere, pero un trabajo legítimo en curso con la misma imagen sobrevive (MEDIUM-A)", async () => {
    const pidFile = path.join(F.dir, "huerfano3.pid");
    let pid = 0;
    try {
      // Otro trabajo del motor en curso con la imagen del "Chrome" (no es la CLI: corre a la vez y
      // termina solo a los 30 s, mucho después del barrido). Antes, el barrido lo mataba y su promesa daba código ≠ 0.
      const t0 = Date.now();
      // Escribe «fin» al terminar por sí mismo: un proceso matado no lo escribe (el código de salida de
      // un TerminateProcess no es fiable para distinguirlo).
      const otra = ejecutar(F.exe, ["-e", "setTimeout(()=>{ process.stdout.write('fin') },30000)"], { timeoutMs: 120_000 }).then((r) => ({ ...r, ms: Date.now() - t0 }));
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
  }, 180000);

  describe("otro motor vivo (W1.6b T9)", () => {
    // Cadena real de otra instancia: F.exe («Chrome») ← Node del motor B ← backend de B (otro ejecutable, vivo), que no
    // cuelga de este proceso: lo lanza un intermediario que sale. Si la protección falla, F.exe muere y no escribe `fin`.
    const backend = path.join(F.dir, "backend-falso.exe");
    const lanzarOtroMotor = async (nombre: string, msChrome: number) => {
      fs.existsSync(backend) || fs.copyFileSync(process.execPath, backend);
      const pids = path.join(F.dir, `${nombre}.pids`);
      const fin = path.join(F.dir, `${nombre}.fin`);
      const chrome = `require("node:fs").writeFileSync(${JSON.stringify(fin)}, "fin")`;
      const motor = `const { spawn } = require("node:child_process"); const fs = require("node:fs");
        const c = spawn(${JSON.stringify(F.exe)}, ["-e", ${JSON.stringify(`setTimeout(() => { ${chrome} }, ${msChrome})`)}], { detached: true, stdio: "ignore" }); // detached: libuv mataría al hijo con su padre
        fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ chrome: c.pid, motor: process.pid, backend: process.ppid }));
        setInterval(() => {}, 1e3);`;
      const dueño = `const { spawn } = require("node:child_process");
        spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(motor)}], { stdio: "ignore" });
        setInterval(() => {}, 1e3);`;
      const intermediario = `require("node:child_process").spawn(${JSON.stringify(backend)}, ["-e", ${JSON.stringify(dueño)}], { detached: true, stdio: "ignore" }).unref();`;
      spawn(process.execPath, ["-e", intermediario], { stdio: "ignore", windowsHide: true });
      await vi.waitFor(() => expect(fs.existsSync(pids) && fs.statSync(pids).size > 0).toBe(true), { timeout: 15000 });
      await esperar(1500); // que el intermediario haya salido
      return { ...(JSON.parse(fs.readFileSync(pids, "utf8")) as { chrome: number; motor: number; backend: number }), fin };
    };
    const leerFin = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");

    it("Review Focus 2: el timeout de un snapshot no mata el trabajo de otro motor; muerto ese motor, el barrido limpia", async () => {
      const b = await lanzarOtroMotor("motor-b", 30000);
      const pidFile = path.join(F.dir, "propio.pid");
      let propio = 0;
      try {
        const r = await ejecutar(process.execPath, [F.script, "snapshot", pidFile], { timeoutMs: 3000 });
        expect(r.timeout).toBe(true);
        propio = Number(fs.readFileSync(pidFile, "utf8"));
        expect(await muere(propio)).toBe(true); // el barrido corrió de verdad
        await esperar(30000);
        expect(leerFin(b.fin)).toBe("fin");
      } finally {
        matarSiVive(propio);
      }
      // Con el motor B muerto, su trabajo ya es un huérfano: lo limpia el siguiente barrido.
      const c = await lanzarOtroMotor("motor-c", 60000);
      try {
        matarSiVive(c.backend);
        matarSiVive(c.motor);
        await esperar(500);
        expect(vivo(c.chrome)).toBe(true);
        const r = await ejecutar(process.execPath, [F.script, "falla", path.join(F.dir, "propio2.pid")], { timeoutMs: 120_000 });
        expect(r.code).toBe(1);
        expect(await muere(c.chrome)).toBe(true);
      } finally {
        for (const pid of [b.chrome, b.motor, b.backend, c.chrome, c.motor, c.backend]) matarSiVive(pid);
        try {
          matarSiVive(Number(fs.readFileSync(path.join(F.dir, "propio2.pid"), "utf8")));
        } catch {
          /* sin pid */
        }
      }
    }, 120000);
  });

  it("un hijo que sale deja de estar en vuelo aunque un nieto retenga sus tuberías", async () => {
    const pidFile = path.join(F.dir, "salido.pid");
    // El hijo lanza un nieto (Node, fuera del objetivo) que hereda stdout/stderr 10 s y sale al momento:
    // hay `exit`, pero `close` no llega hasta que el nieto suelta las tuberías.
    const codigo = `const fs = require("node:fs"); require("node:child_process")
      .spawn(process.argv[2], ["-e", "setTimeout(()=>{},1e4)"], { detached: true, stdio: ["ignore", 1, 2] }).unref();
      fs.writeFileSync(process.argv[1], String(process.pid)); process.exit(0);`;
    let cerrado = false;
    const trabajo = ejecutar(F.exe, ["-e", codigo, pidFile, process.execPath], { timeoutMs: 120_000 }).finally(() => {
      cerrado = true;
    });
    await vi.waitFor(() => expect(fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0).toBe(true), { timeout: 15000 });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(await muere(pid)).toBe(true);
    await vi.waitFor(() => {
      const sel = seleccionarBarrido([{ pid, ruta: F.exe }], { arboles: [], exactos: [F.exe] });
      expect(sel.matar.map((p) => p.pid)).toEqual([pid]);
    }, { timeout: 3000 });
    expect(cerrado).toBe(false);
    await trabajo;
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
  }, 120000);
});

// Rutas C:/ de Windows: en otro SO path.resolve las convierte en relativas y nada coincide.
describe.runIf(process.platform === "win32")("barrerProcesos", () => {
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

  it("sin ruta y transitorio (arrancando o saliendo): no reinicia", async () => {
    const reiniciar = vi.fn();
    const listar = vi.fn(async () => [] as { pid: number; ruta: string; nombre: string }[]);
    listar.mockResolvedValueOnce([{ pid: 4245, ruta: "", nombre: "chrome-headless-shell.exe" }]);
    await barrerProcesos(objetivo, { listar, matar: vi.fn(), reiniciar });
    expect(reiniciar).not.toHaveBeenCalled();
  });

  it("renderer sin ruta ni línea de órdenes, hijo de un Chrome ajeno: se ignora; huérfano: reinicia", async () => {
    const hijo = { pid: 4247, ruta: "", nombre: "chrome-headless-shell.exe", padre: 4246, creado: 200 };
    const padre = { pid: 4246, ruta: "C:\\otra sesion\\chrome-headless-shell.exe", nombre: "chrome-headless-shell.exe", padre: 1, creado: 100 };
    const r1 = vi.fn();
    await barrerProcesos(objetivo, { listar: async () => [padre, hijo], matar: vi.fn(), reiniciar: r1 });
    expect(r1).not.toHaveBeenCalled();
    const r2 = vi.fn();
    await barrerProcesos(objetivo, { listar: async () => [hijo], matar: vi.fn(), reiniciar: r2 });
    expect(r2).toHaveBeenCalledTimes(1);
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

  it("una línea de órdenes sin comillas con espacios no descarta un proceso del motor", async () => {
    const o = { arboles: ["C:\\Users\\Marc Serra\\nav"], exactos: [] };
    const linea = "C:\\Users\\Marc Serra\\nav\\chrome-headless-shell.exe --type=renderer";
    const reiniciar = vi.fn();
    await barrerProcesos(o, { listar: async () => [{ pid: 4248, ruta: "", nombre: "chrome-headless-shell.exe", linea }], matar: vi.fn(), reiniciar });
    expect(reiniciar).toHaveBeenCalledTimes(1);
    // Sin comillas pero entera (sin espacios) y de otro sitio: sigue siendo ajeno.
    const r2 = vi.fn();
    await barrerProcesos(o, {
      listar: async () => [{ pid: 4249, ruta: "", nombre: "Chrome-Headless-Shell.exe", linea: "C:\\otra\\chrome-headless-shell.exe --type=renderer" }],
      matar: vi.fn(),
      reiniciar: r2,
    });
    expect(r2).not.toHaveBeenCalled();
  });

  it("un dudoso que gana la ruta del motor al reobservarlo se mata, no se olvida", async () => {
    const sinRuta = { pid: 4250, ruta: "", nombre: "chrome-headless-shell.exe" };
    const conRuta = { ...sinRuta, ruta: "C:\\nav\\chrome-headless-shell.exe" };
    const matar = vi.fn();
    const reiniciar = vi.fn();
    const listar = vi.fn(async () => [] as (typeof sinRuta)[]);
    listar.mockResolvedValueOnce([sinRuta]).mockResolvedValueOnce([conRuta]);
    await barrerProcesos(objetivo, { listar, matar, reiniciar });
    expect(matar).toHaveBeenCalledWith([conRuta]);
    expect(reiniciar).not.toHaveBeenCalled();
  });

  it("un dudoso que gana la ruta del motor y no se deja matar reinicia", async () => {
    const sinRuta = { pid: 4251, ruta: "", nombre: "chrome-headless-shell.exe" };
    const conRuta = { ...sinRuta, ruta: "C:\\nav\\chrome-headless-shell.exe" };
    const reiniciar = vi.fn();
    const listar = vi.fn(async () => [conRuta]);
    listar.mockResolvedValueOnce([sinRuta]);
    await barrerProcesos(objetivo, { listar, matar: vi.fn(), reiniciar });
    expect(reiniciar).toHaveBeenCalledTimes(1);
  });
});

// Rutas C:/ de Windows: en otro SO path.resolve las convierte en relativas y nada coincide.
describe.runIf(process.platform === "win32")("seleccionarBarrido: hijos en vuelo (MEDIUM-A)", () => {
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

// Rutas C:/ de Windows: en otro SO path.resolve las convierte en relativas y nada coincide.
describe.runIf(process.platform === "win32")("seleccionarBarrido: entre instancias (W1.6b T9, R0 M4)", () => {
  const NODE = "C:\\motor\\node.exe";
  const CHROME = "C:\\nav\\chrome-headless-shell.exe";
  const o = { arboles: ["C:\\nav"], exactos: [] };
  const propio = { pid: 100, node: NODE };
  const T = 1_000_000;
  const barre = (lista: { pid: number; ruta: string; padre?: number; creado?: number; nombre?: string }[], vuelo = new Map<number, number>()) => {
    const s = seleccionarBarrido(lista, o, vuelo, propio);
    return { matar: s.matar.map((p) => p.pid).sort(), dudosos: s.noVerificables.map((p) => p.pid) };
  };
  const backend = { pid: 5, ruta: "C:\\app\\backend.exe", padre: 1, creado: T };
  const otroMotor = { pid: 200, ruta: NODE, padre: 5, creado: T + 10 };
  const motorPropio = { pid: 100, ruta: NODE, padre: 5, creado: T + 10 };
  const cli = (padre: number) => ({ pid: 300, ruta: NODE, padre, creado: T + 20 });
  const chrome = { pid: 400, ruta: CHROME, padre: 300, creado: T + 30 };

  it("Chrome → CLI → otro motor vivo: protegido", () => {
    expect(barre([backend, otroMotor, cli(200), chrome]).matar).toEqual([]);
  });

  it("Chrome → CLI → motor propio, con la CLI fuera de vuelo: se barre", () => {
    expect(barre([backend, motorPropio, cli(100), chrome]).matar).toEqual([400]);
  });

  it("Chrome → CLI → motor propio, con la CLI en vuelo: protegido", () => {
    expect(barre([backend, motorPropio, cli(100), chrome], new Map([[300, T + 20]])).matar).toEqual([]);
  });

  it("Chrome con padre muerto: se barre", () => {
    expect(barre([chrome]).matar).toEqual([400]);
  });

  it("pid de padre reutilizado (padre.creado > hijo.creado): se barre", () => {
    expect(barre([backend, { ...otroMotor, pid: 300, creado: T + 40 }, chrome]).matar).toEqual([400]);
  });

  it("R0 M4: Chrome → CLI → motor muerto: la cadena se corta en un Node sin padre vivo y se barre", () => {
    expect(barre([cli(200), chrome]).matar).toEqual([400]);
  });

  it("R0 M4: el padre del Node más alto es un pid reutilizado: se barre", () => {
    expect(barre([{ ...backend, creado: T + 500 }, otroMotor, cli(200), chrome]).matar).toEqual([400]);
  });

  it("proceso sin ruta bajo otro motor: ni matar ni noVerificables", () => {
    const sinRuta = { pid: 401, ruta: "", nombre: "chrome-headless-shell.exe", padre: 300, creado: T + 30 };
    expect(barre([backend, otroMotor, cli(200), sinRuta])).toEqual({ matar: [], dudosos: [] });
  });

  it("control: el mismo proceso sin ruta, de un motor muerto, sigue dudoso", () => {
    const sinRuta = { pid: 401, ruta: "", nombre: "chrome-headless-shell.exe", padre: 300, creado: T + 30 };
    expect(barre([cli(200), sinRuta])).toEqual({ matar: [], dudosos: [401] });
  });

  it("un padre vivo que no es del motor no protege", () => {
    expect(barre([backend, { ...chrome, padre: 5 }]).matar).toEqual([400]);
  });

  it("una cadena más larga que el tope no protege", () => {
    const lista = Array.from({ length: 70 }, (_, i) => ({ pid: 1000 + i, ruta: i === 0 ? CHROME : NODE, padre: 1001 + i, creado: T + 1000 - i }));
    expect(barre(lista).matar).toEqual([1000]);
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

describe("descendientes", () => {
  it("recorre un árbol de tres niveles y no incluye al propio pid", () => {
    const tabla = [
      { pid: 1 },
      { pid: 10, padre: 1 },
      { pid: 20, padre: 10 },
      { pid: 21, padre: 10 },
      { pid: 30, padre: 20 },
      { pid: 99, padre: 98 },
    ];
    expect(descendientes(10, tabla).sort((a, b) => a - b)).toEqual([20, 21, 30]);
    expect(descendientes(30, tabla)).toEqual([]);
  });
  it("tolera ciclos (pid reutilizado) y un pid desconocido", () => {
    const tabla = [
      { pid: 10, padre: 30 },
      { pid: 20, padre: 10 },
      { pid: 30, padre: 20 },
    ];
    expect(descendientes(10, tabla).sort((a, b) => a - b)).toEqual([20, 30]);
    expect(descendientes(777, tabla)).toEqual([]);
  });
});

describe("timeoutMs obligatorio (I7)", () => {
  it("ejecutar rechaza una llamada sin plazo, con 0 o con un valor no finito", async () => {
    // @ts-expect-error timeoutMs es obligatorio en el tipo
    await expect(ejecutar("x", [])).rejects.toThrow(/timeoutMs/);
    for (const timeoutMs of [0, -1, NaN, Infinity]) {
      await expect(ejecutar("x", [], { timeoutMs })).rejects.toThrow(/timeoutMs/);
    }
  });
});

describe.runIf(process.platform === "linux")("árbol de procesos en POSIX", () => {
  it("un nieto en su propio grupo muere al vencer el timeout", async () => {
    const pidFile = path.join(F.dir, "nieto-posix.pid");
    // El padre (copia de Node del motor, así el barrido por imagen no ve al nieto) lanza un nieto desligado en otro grupo.
    const codigo = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
      const n = spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(()=>{},1e3)'], { detached: true, stdio: 'ignore' });
      n.unref(); fs.writeFileSync(process.argv[1], String(n.pid)); setInterval(()=>{},1e3);`;
    let nieto = 0;
    try {
      const r = await ejecutar(F.exe, ["-e", codigo, pidFile], { timeoutMs: 2000 });
      expect(r.timeout).toBe(true);
      nieto = Number(fs.readFileSync(pidFile, "utf8"));
      expect(nieto).toBeGreaterThan(0);
      expect(await muere(nieto)).toBe(true);
    } finally {
      matarSiVive(nieto);
    }
  }, 30000);
});
