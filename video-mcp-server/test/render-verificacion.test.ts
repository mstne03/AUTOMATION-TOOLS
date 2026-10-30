// I11 (hallazgo C4): el MP4 final se rechaza si no es exactamente lo pedido — 1080×1920, H.264 de un
// codificador admitido, 30 fps, audio y vídeo de la duración del montaje. Nada se da por bueno con un aviso.
import { describe, expect, it } from "vitest";
import { codificadorDeEtiqueta, verificarMp4 } from "../src/render.js";
import type { InfoMedio } from "../src/proceso.js";

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
