// Prueba de GPU: solo se cachea un resultado medido; un fallo pasajero se reintenta.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/proceso.js", async (orig) => {
  const m = await orig<typeof import("../src/proceso.js")>();
  return { ...m, ejecutar: vi.fn() };
});

const H = { dir: "x", ffmpeg: "ffmpeg", ffprobe: "ffprobe" };
let dir: string;

async function cargar() {
  vi.resetModules();
  vi.stubEnv("VIDEO_STATE_DIR", dir);
  const cap = await import("../src/capacidades.js");
  const { ejecutar } = await import("../src/proceso.js");
  return { ...cap, ejecutar: vi.mocked(ejecutar) };
}

/** El render "escribe" el mp4 (argumento tras -o) y ffmpeg devuelve un píxel con esa luminancia. */
function renderOk(lum: number) {
  return async (cmd: string, args: string[]) => {
    if (cmd === "ffmpeg") return { code: 0, stdout: String.fromCharCode(lum), stderr: "" };
    fs.writeFileSync(args[args.indexOf("-o") + 1], "mp4");
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("probarGpu", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "video capacidades "));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("un render fallido no se cachea y la siguiente vez se reintenta", async () => {
    const { probarGpu, leerPruebaGpu, hayWebgpu, ejecutar } = await cargar();
    ejecutar.mockResolvedValue({ code: 1, stdout: "", stderr: "Error: GPU process crashed" });
    const p = await probarGpu(H);
    expect(p.webgpu).toBe(false);
    expect(p.luminancia).toBeUndefined();
    expect(leerPruebaGpu()).toBeUndefined();
    // En este proceso los renders no repiten la prueba fallida…
    ejecutar.mockClear();
    expect(await hayWebgpu(H)).toBe(false);
    expect(ejecutar).not.toHaveBeenCalled();
    // …pero una prueba nueva que sí mide se guarda y sustituye al fallo.
    ejecutar.mockImplementation(renderOk(200));
    expect((await probarGpu(H)).webgpu).toBe(true);
    expect(leerPruebaGpu()?.webgpu).toBe(true);
  });

  it("un fotograma ilegible tampoco se cachea", async () => {
    const { probarGpu, leerPruebaGpu, ejecutar } = await cargar();
    ejecutar.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "ffmpeg") return { code: 1, stdout: "", stderr: "Invalid data" };
      fs.writeFileSync(args[args.indexOf("-o") + 1], "mp4");
      return { code: 0, stdout: "", stderr: "" };
    });
    expect((await probarGpu(H)).webgpu).toBe(false);
    expect(leerPruebaGpu()).toBeUndefined();
  });

  it("un render negro sí se cachea como webgpu=false", async () => {
    const { probarGpu, leerPruebaGpu, ejecutar } = await cargar();
    ejecutar.mockImplementation(renderOk(0));
    expect((await probarGpu(H)).webgpu).toBe(false);
    expect(leerPruebaGpu()).toMatchObject({ webgpu: false, luminancia: 0 });
  });
});
