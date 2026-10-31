// I11 (hallazgo C4): el MP4 final se rechaza si no es exactamente lo pedido — 1080×1920, H.264 de un
// codificador admitido, 30 fps, audio y vídeo de la duración del montaje. Nada se da por bueno con un aviso.
// R2-L3: `check` solo pasa con JSON válido, ok === true y código 0, y la GPU de Chrome queda registrada sin dejar que la
// composición la falsifique.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video check "));
  const salida = nodePath.join(dir, "salida.json");
  const cli = nodePath.join(dir, "hyperframes-falso.mjs");
  nodeFs.writeFileSync(
    cli,
    `import fs from "node:fs"; const s = JSON.parse(fs.readFileSync(${JSON.stringify(salida)}, "utf8")); console.log(s.texto); process.exit(s.codigo);`,
  );
  const navegador = nodePath.join(dir, "chrome-headless-shell.exe");
  nodeFs.writeFileSync(navegador, "exe");
  process.env.VIDEO_HYPERFRAMES_BIN = cli;
  process.env.VIDEO_STATE_DIR = nodePath.join(dir, "estado");
  process.env.HYPERFRAMES_BROWSER_PATH = navegador;
  delete process.env.VIDEO_NAVEGADOR_MANIFIESTO;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  return { dir, salida };
});

import { codificadorDeEtiqueta, comprobarComposicion, extraerGpuChrome, verificarMp4 } from "../src/render.js";
import type { InfoMedio } from "../src/proceso.js";

afterAll(() => {
  fs.rmSync(F.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe("comprobarComposicion", () => {
  const check = async (texto: string, codigo: number) => {
    fs.writeFileSync(F.salida, JSON.stringify({ texto, codigo }));
    return comprobarComposicion(path.join(F.dir, "comp"), false);
  };

  it("{ok:true} y código 0: sin errores", async () => {
    expect((await check(`{"ok":true}`, 0)).errores).toEqual([]);
  });

  it.each<[string, string, number, RegExp]>([
    ["ok:false con error: conserva el motivo", `{"ok":false,"error":"motivo"}`, 1, /motivo/],
    ["hallazgo de error: línea legible (Review Focus 3)", `{"ok":false,"runtime":{"findings":[{"severity":"error","code":"x","message":"y"}]}}`, 1, /^error x: y$/],
    ["ok:false sin nada", `{"ok":false}`, 1, /^check terminó con errores sin detalle\.$/],
    ["ok:true con código 3", `{"ok":true}`, 3, /código 3/],
    ["sin JSON y código 0", "nada que ver", 0, /sin JSON válido/],
    ["sin JSON y código 1", "nada que ver", 1, /código 1/],
    ["JSON sin ok y código 0", `{"lint":{"findings":[]}}`, 0, /código 0/],
  ])("%s", async (_n, texto, codigo, re) => {
    const { errores } = await check(texto, codigo);
    expect(errores).toHaveLength(1);
    expect(errores[0]).toMatch(re);
  });
});

describe("extraerGpuChrome", () => {
  const REAL =
    '[hyperframes] browserGpuMode probe → hardware (WebGL renderer vendor="Google Inc. (NVIDIA)" renderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028A0) Direct3D11 vs_5_0 ps_5_0, D3D11)")';

  it("saca el renderer de la línea real", () => {
    expect(extraerGpuChrome(REAL)).toBe("ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028A0) Direct3D11 vs_5_0 ps_5_0, D3D11)");
  });

  it("otra línea: undefined", () => {
    expect(extraerGpuChrome("[hyperframes] rendering frame 12")).toBeUndefined();
  });

  it("R0 L2: un hallazgo de check con el mismo texto no la falsifica", () => {
    expect(extraerGpuChrome(`check warning x: ${REAL}`)).toBeUndefined();
    expect(extraerGpuChrome(` ${REAL}`)).toBeUndefined();
  });

  it("quita lo que no es de la lista de caracteres y corta a 120", () => {
    const con = (r: string) => `[hyperframes] browserGpuMode probe → hardware (WebGL renderer vendor="x" renderer="${r}")`;
    expect(extraerGpuChrome(con("AN\u0007GLE <b>\u001b[31m"))).toBe("ANGLE b31m");
    expect(extraerGpuChrome(con("a".repeat(300)))).toHaveLength(120);
    expect(extraerGpuChrome(con(""))).toBeUndefined();
  });

  it("(probe failed …): undefined", () => {
    expect(extraerGpuChrome("[hyperframes] browserGpuMode probe → software (probe failed: timeout)")).toBeUndefined();
  });
});

const base: InfoMedio = {
  ancho: 1080,
  alto: 1920,
  codecVideo: "h264",
  codificador: "Lavc61.19.101 h264_nvenc",
  fps: 30,
  fpsMedio: 30,
  tieneAudio: true,
  duracion: 50.41,
  duracionVideo: 50.4,
  duracionAudio: 50.43,
  nbFrames: 1512,
  nbPaquetes: 1512,
  pistasVideo: 1,
  pistasAudio: 1,
};
const ESPERADA = 50.4;
const con = (cambios: Partial<InfoMedio>): InfoMedio => ({ ...base, ...cambios });

describe("verificarMp4", () => {
  it("un MP4 correcto pasa", () => {
    expect(() => verificarMp4(base, ESPERADA)).not.toThrow();
  });

  it.each<[string, Partial<InfoMedio>, RegExp]>([
    ["sin audio", { tieneAudio: false, pistasAudio: 0, duracionAudio: undefined }, /audio/],
    ["dos pistas de audio", { pistasAudio: 2 }, /pistas/],
    ["dos pistas de vídeo", { pistasVideo: 2 }, /pistas/],
    ["paquetes que no cuadran con nb_frames", { nbPaquetes: 1500 }, /íntegro/],
    ["sin nb_read_packets", { nbPaquetes: undefined }, /íntegro/],
    ["sin nb_frames", { nbFrames: undefined }, /íntegro/],
    ["25 fps", { fps: 25, fpsMedio: 25 }, /fps/],
    ["fps ausente", { fps: undefined }, /fps/],
    ["avg_frame_rate 29,5", { fpsMedio: 29.5 }, /fps/],
    ["avg_frame_rate ausente", { fpsMedio: undefined }, /fps/],
    ["vídeo de 50,6 s", { duracionVideo: 50.6 }, /duración del vídeo/],
    ["duración del vídeo ausente", { duracionVideo: undefined }, /duración del vídeo/],
    ["vídeo de 25 s con audio de 50 s", { duracionVideo: 25, nbFrames: 750, nbPaquetes: 750 }, /duración del vídeo/],
    ["audio de 25 s", { duracionAudio: 25 }, /duración del audio/],
    ["duración del audio ausente", { duracionAudio: undefined }, /duración del audio/],
    ["fotogramas de menos", { nbFrames: 1500, nbPaquetes: 1500 }, /fotogramas/],
    ["hevc", { codecVideo: "hevc" }, /h264/],
    ["1920×1080", { ancho: 1920, alto: 1080 }, /1080×1920/],
    ["etiqueta Lavc… libx264", { codificador: "Lavc61.19.101 libx264" }, /codificador/],
    ["etiqueta libopenh264", { codificador: "Lavc61.19.101 libopenh264" }, /codificador/],
    ["sin etiqueta de codificador", { codificador: undefined }, /codificador/],
  ])("%s: falla", (_n, cambios, re) => {
    expect(() => verificarMp4(con(cambios), ESPERADA)).toThrow(re);
  });

  it("si se pasa el codificador esperado, tiene que ser ese", () => {
    expect(() => verificarMp4(base, ESPERADA, "h264_nvenc")).not.toThrow();
    expect(() => verificarMp4(base, ESPERADA, "h264_mf")).toThrow(/codificador/);
  });
});

describe("codificadorDeEtiqueta", () => {
  it("saca el codificador de la etiqueta encoder", () => {
    expect(codificadorDeEtiqueta("Lavc61.19.101 h264_nvenc")).toBe("h264_nvenc");
    expect(codificadorDeEtiqueta("Lavc61.19.101 libx264")).toBe("libx264");
    expect(codificadorDeEtiqueta(undefined)).toBeUndefined();
    expect(codificadorDeEtiqueta("Lavf61.7.100")).toBeUndefined();
  });
});
