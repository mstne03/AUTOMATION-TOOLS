// Ajustes tras la revisión: taskkill con respaldo, tope de timeout, catálogo, listado y modo integrado.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ fake: false, catalogoTimeout: false, spawns: [] as { cmd: string; hijo: any; taskkill?: any }[], powershellCwd: undefined as string | undefined }));

vi.mock("../src/paths.js", async (orig) => {
  const m = await orig<typeof import("../src/paths.js")>();
  return {
    ...m,
    imagenesValidadas: (dir: string) => {
      if (dir.endsWith("video001")) throw new m.ErrorVideo("enlace simbólico sospechoso");
      if (dir.endsWith("video003")) throw new Error("fallo inesperado de disco");
      return m.imagenesValidadas(dir);
    },
  };
});
vi.mock("../src/proceso.js", async (orig) => {
  const m = await orig<typeof import("../src/proceso.js")>();
  return { ...m, ejecutar: vi.fn(async () => ({ code: null, stdout: "", stderr: "", timeout: true })) };
});
vi.mock("node:child_process", async (orig) => {
  const m = await orig<typeof import("node:child_process")>();
  return {
    ...m,
    spawn: (cmd: string, args: string[], o: any) => {
      if (!estado.spawns.length && !estado.fake) return (m.spawn as any)(cmd, args, o);
      const e: any = new EventEmitter();
      e.pid = 4242;
      e.exitCode = null;
      e.stdout = new EventEmitter();
      e.stderr = new EventEmitter();
      e.kill = vi.fn();
      // El barrido tras el timeout lista procesos con PowerShell: responde al momento con uno ajeno.
      if (/powershell\.exe$/i.test(cmd)) {
        estado.powershellCwd = o.cwd;
        process.nextTick(() => {
          e.stdout.emit("data", Buffer.from(JSON.stringify([{ p: 1, f: 0, n: "x.exe", r: "C:\\otro\\x.exe", c: 1 }])));
          e.emit("close", 0);
        });
        return e;
      }
      estado.spawns.push({ cmd, hijo: e });
      return e;
    },
  };
});

import { resolverHyperframesBin } from "../src/musica.js";
import { timeoutPasadaMs } from "../src/render.js";
import { catalogo, estado as estadoVideo, listar } from "../src/herramientas.js";
import { ejecutar, mensajeSinFfmpeg } from "../src/proceso.js";
import type { Config } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
  estado.fake = false;
  estado.spawns.length = 0;
});

describe("timeoutPasadaMs", () => {
  it("recorta al máximo de setTimeout y conserva los valores no válidos como por defecto", () => {
    vi.stubEnv("VIDEO_TIMEOUT_RENDER_S", "99999999999");
    expect(timeoutPasadaMs(50)).toBe(2_147_483_647);
    for (const v of ["0", "-5", "abc", "Infinity"]) {
      vi.stubEnv("VIDEO_TIMEOUT_RENDER_S", v);
      expect(timeoutPasadaMs(50)).toBe(2_300_000);
    }
    vi.stubEnv("VIDEO_TIMEOUT_RENDER_S", "2");
    expect(timeoutPasadaMs(50)).toBe(2000);
  });
});

describe("VIDEO_HYPERFRAMES_BIN", () => {
  it("se respeta en modo independiente y se ignora en modo integrado", () => {
    expect(resolverHyperframesBin({ VIDEO_HYPERFRAMES_BIN: "/falso.mjs" })).toBe("/falso.mjs");
    const empaquetado = resolverHyperframesBin({ VIDEO_HYPERFRAMES_BIN: "/falso.mjs", VIDEO_ENGINE_EMBEDDED: "1" });
    expect(empaquetado).not.toBe("/falso.mjs");
    expect(empaquetado).toContain("hyperframes");
  });
});

describe("catálogo con timeout", () => {
  it("da un error legible en español", async () => {
    const cfg = { ffmpegDir: undefined } as unknown as Config;
    await expect(catalogo(cfg, { consulta: "map" })).rejects.toThrow(/no respondió al buscar en el catálogo \(120 s\)/);
    expect(vi.mocked(ejecutar)).toHaveBeenCalled();
  });
});

describe("listar con imágenes ilegibles", () => {
  it("avisa del vídeo afectado y sigue listando los demás", () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "video listar "));
    try {
      for (const d of ["video001", "video002"]) fs.mkdirSync(path.join(raiz, d));
      const cfg = { videoRoot: raiz } as unknown as Config;
      const r = listar(cfg);
      expect(r.texto).toContain("AVISO: no he podido leer las imágenes de video001");
      expect(r.texto).toContain("- video002:");
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });
});

describe("estado con imágenes ilegibles", () => {
  const conCarpeta = async (id: string, f: (cfg: Config) => Promise<void>) => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "video estado "));
    try {
      fs.mkdirSync(path.join(raiz, id));
      await f({ videoRoot: raiz, ffmpegDir: undefined } as unknown as Config);
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  };
  it("un recurso rechazado (ErrorVideo) sale como aviso, no como excepción", async () => {
    await conCarpeta("video001", async (cfg) => {
      const r = await estadoVideo(cfg, "video001");
      expect(r.texto).toContain("enlace simbólico sospechoso");
    });
  });
  it("un error que no es ErrorVideo se propaga", async () => {
    await conCarpeta("video003", async (cfg) => {
      await expect(estadoVideo(cfg, "video003")).rejects.toThrow(/fallo inesperado de disco/);
    });
  });
});

describe("mensajes según el modo", () => {
  it("ffmpeg: integrado remite a SEO Studio; independiente mantiene el .env", () => {
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "1");
    expect(mensajeSinFfmpeg()).toBe("Falta ffmpeg en la instalación de SEO Studio; reinstala la aplicación.");
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "");
    expect(mensajeSinFfmpeg()).toContain(".env");
  });
});

describe.runIf(process.platform === "win32")("PowerShell del barrido", () => {
  it("corre en hf-home: sin LOCALAPPDATA escribe su ModuleAnalysisCache relativa al cwd", async () => {
    estado.fake = true;
    try {
      const real = await vi.importActual<typeof import("../src/proceso.js")>("../src/proceso.js");
      await real.listarProcesos();
      expect(estado.powershellCwd?.toLowerCase()).toBe(real.hfHome().toLowerCase());
    } finally {
      estado.fake = false;
    }
  });
});

describe("taskkill", () => {
  const plataforma = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => Object.defineProperty(process, "platform", plataforma));

  async function vencer(codigoTaskkill: number) {
    Object.defineProperty(process, "platform", { value: "win32" });
    estado.fake = true;
    const real = await vi.importActual<typeof import("../src/proceso.js")>("../src/proceso.js");
    const p = real.ejecutar("x", [], { timeoutMs: 10 });
    await vi.waitFor(() => expect(estado.spawns.some((s) => path.basename(s.cmd).toLowerCase() === "taskkill.exe")).toBe(true));
    const tk = estado.spawns.find((s) => path.basename(s.cmd).toLowerCase() === "taskkill.exe")!;
    tk.hijo.emit("close", codigoTaskkill);
    const res = await p;
    return { res, hijo: estado.spawns[0].hijo };
  }

  it("si taskkill falla y el hijo sigue vivo, lo mata con kill()", async () => {
    const { res, hijo } = await vencer(1);
    expect(res.timeout).toBe(true);
    expect(hijo.kill).toHaveBeenCalled();
  });
  it("si taskkill no se puede lanzar (error), mata al hijo y limpia el temporizador", async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      estado.fake = true;
      const real = await vi.importActual<typeof import("../src/proceso.js")>("../src/proceso.js");
      const p = real.ejecutar("x", [], { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      estado.spawns.find((s) => path.basename(s.cmd).toLowerCase() === "taskkill.exe")!.hijo.emit("error", new Error("ENOENT"));
      expect((await p).timeout).toBe(true);
      expect(estado.spawns[0].hijo.kill).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("si taskkill se cuelga más de 10 s, mata al hijo y resuelve", async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      estado.fake = true;
      const real = await vi.importActual<typeof import("../src/proceso.js")>("../src/proceso.js");
      const p = real.ejecutar("x", [], { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(estado.spawns.some((s) => path.basename(s.cmd).toLowerCase() === "taskkill.exe")).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await p).timeout).toBe(true);
      expect(estado.spawns.find((s) => path.basename(s.cmd).toLowerCase() === "taskkill.exe")!.hijo.kill).toHaveBeenCalled();
      expect(estado.spawns[0].hijo.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("con código 128 (proceso inexistente) no hace nada más", async () => {
    const { hijo } = await vencer(128);
    expect(hijo.kill).not.toHaveBeenCalled();
  });
});
