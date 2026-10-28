// Ajustes tras la revisión: taskkill con respaldo, tope de timeout, catálogo, listado y modo integrado.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ catalogoTimeout: false, spawns: [] as { cmd: string; hijo: any; taskkill?: any }[] }));

vi.mock("../src/paths.js", async (orig) => {
  const m = await orig<typeof import("../src/paths.js")>();
  return {
    ...m,
    imagenesValidadas: (dir: string) => {
      if (dir.endsWith("video001")) throw new m.ErrorVideo("enlace simbólico sospechoso");
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
      if (!estado.spawns.length && !(globalThis as any).__fake) return (m.spawn as any)(cmd, args, o);
      const e: any = new EventEmitter();
      e.pid = 4242;
      e.exitCode = null;
      e.stdout = new EventEmitter();
      e.stderr = new EventEmitter();
      e.kill = vi.fn();
      estado.spawns.push({ cmd, hijo: e });
      return e;
    },
  };
});

import { resolverHyperframesBin } from "../src/musica.js";
import { timeoutRenderMs } from "../src/render.js";
import { catalogo, listar } from "../src/herramientas.js";
import { ejecutar, mensajeSinFfmpeg } from "../src/proceso.js";
import type { Config } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as any).__fake;
  estado.spawns.length = 0;
});

describe("timeoutRenderMs", () => {
  it("recorta al máximo de setTimeout y conserva los valores no válidos como por defecto", () => {
    vi.stubEnv("VIDEO_TIMEOUT_RENDER_S", "99999999999");
    expect(timeoutRenderMs()).toBe(2_147_483_647);
    for (const v of ["0", "-5", "abc", "Infinity"]) {
      vi.stubEnv("VIDEO_TIMEOUT_RENDER_S", v);
      expect(timeoutRenderMs()).toBe(3_600_000);
    }
    vi.stubEnv("VIDEO_TIMEOUT_RENDER_S", "2");
    expect(timeoutRenderMs()).toBe(2000);
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

describe("mensajes según el modo", () => {
  it("ffmpeg: integrado remite a SEO Studio; independiente mantiene el .env", () => {
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "1");
    expect(mensajeSinFfmpeg()).toBe("Falta ffmpeg en la instalación de SEO Studio; reinstala la aplicación.");
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "");
    expect(mensajeSinFfmpeg()).toContain(".env");
  });
});

describe("taskkill", () => {
  const plataforma = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => Object.defineProperty(process, "platform", plataforma));

  async function vencer(codigoTaskkill: number) {
    Object.defineProperty(process, "platform", { value: "win32" });
    (globalThis as any).__fake = true;
    const real = await vi.importActual<typeof import("../src/proceso.js")>("../src/proceso.js");
    const p = real.ejecutar("x", [], { timeoutMs: 10 });
    await vi.waitFor(() => expect(estado.spawns.some((s) => s.cmd === "taskkill")).toBe(true));
    const tk = estado.spawns.find((s) => s.cmd === "taskkill")!;
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
      (globalThis as any).__fake = true;
      const real = await vi.importActual<typeof import("../src/proceso.js")>("../src/proceso.js");
      const p = real.ejecutar("x", [], { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      estado.spawns.find((s) => s.cmd === "taskkill")!.hijo.emit("error", new Error("ENOENT"));
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
      (globalThis as any).__fake = true;
      const real = await vi.importActual<typeof import("../src/proceso.js")>("../src/proceso.js");
      const p = real.ejecutar("x", [], { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(estado.spawns.some((s) => s.cmd === "taskkill")).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await p).timeout).toBe(true);
      expect(estado.spawns.find((s) => s.cmd === "taskkill")!.hijo.kill).toHaveBeenCalled();
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
