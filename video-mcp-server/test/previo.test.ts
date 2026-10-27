// Reglas de validación que dependen de los archivos: imágenes requeridas, túnel y música.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { estado, listar } from "../src/herramientas.js";
import { prepararRender } from "../src/render.js";
import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion } from "../src/alineacion.js";
import { ejecutar, herramientasFfmpeg } from "../src/proceso.js";

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "footy previo "));
afterAll(() => fs.rmSync(RAIZ, { recursive: true, force: true }));
const cfg: Config = {
  elevenApiKey: undefined,
  elevenVoiceId: undefined,
  elevenModelId: "eleven_multilingual_v2",
  footyRoot: RAIZ,
  browserPath: undefined,
  musicaVolumen: 0.12,
  ffmpegDir: undefined,
};
const OPC = { raiz: RAIZ, musica: true, musicaVolumen: 0.12 };
const CUERPO = "[1] One two.\n[2] Three four.\n[3] Five six.\n[4] Seven.\n[5] Eight nine.\n[6] Ten.\n";

function video(id: string, fm: string, imagenes: number[]) {
  const dir = path.join(RAIZ, id);
  fs.mkdirSync(dir, { recursive: true });
  const contenido = `---\ntitulo: T\ngancho: G.\n${fm}\n---\n${CUERPO}`;
  fs.writeFileSync(path.join(dir, "guion.md"), contenido);
  for (const n of imagenes) fs.writeFileSync(path.join(dir, `img${n}.jpg`), "");
  const g = parsearGuion(contenido);
  const chars = [...g.narracion];
  const al = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.1) };
  fs.writeFileSync(path.join(dir, "palabras.json"), JSON.stringify(procesarAlineacion({ narracion: g.narracion, bloques: g.bloques, alineacion: al, hashNarracion: g.hash })));
  fs.writeFileSync(path.join(dir, "voz.mp3"), "");
}

describe("validación con archivos", () => {
  it("imágenes requeridas = bloques sin escena (prepararRender, listar y estado)", async () => {
    video("footy001", "escenas:\n  3:\n    tipo: cifra\n    valor: 3", [1, 2, 4, 5]);
    await expect(prepararRender("footy001", OPC)).rejects.toThrow(/Faltan imágenes.*img6\. Hacen falta 5 .*los bloques 3 llevan escena/);
    expect(listar(cfg).texto).toMatch(/footy001: .*imágenes requeridas 4\/5/);
    const e = await estado(cfg, "footy001");
    expect(e.texto).toMatch(/bloque 3: escena cifra/);
    expect(e.texto).toMatch(/img6 FALTA/);
    fs.writeFileSync(path.join(RAIZ, "footy001", "img6.png"), "");
    await expect(prepararRender("footy001", OPC)).resolves.toBeTruthy();
  });

  it("avisa de las fotos que están en la carpeta con otro nombre", async () => {
    video("footy006", "escenas:\n  2:\n    tipo: cifra\n    valor: 1\n  3:\n    tipo: cifra\n    valor: 2\n  4:\n    tipo: cifra\n    valor: 3\n  5:\n    tipo: cifra\n    valor: 4", []);
    fs.writeFileSync(path.join(RAIZ, "footy006", "Didier_Drogba.jpg"), "");
    await expect(prepararRender("footy006", OPC)).rejects.toThrow(/Faltan imágenes.*img1, img6[\s\S]*fotos con otro nombre que no se usan: Didier_Drogba\.jpg/);
    expect(listar(cfg).texto).toMatch(/footy006: .*imágenes requeridas 0\/2 \(\+1 foto\(s\) con otro nombre/);
    expect((await estado(cfg, "footy006")).texto).toMatch(/no se reconocen porque no se llaman img1…img6: Didier_Drogba\.jpg/);
  });

  it("tunel exige al menos 3 fotos", async () => {
    video("footy002", "escenas:\n  1:\n    tipo: tunel\n  2:\n    tipo: cifra\n    valor: 1\n  3:\n    tipo: cartel\n    texto: Hola\n  4:\n    tipo: titulo3d\n    texto: HOLA", [5, 6]);
    await expect(prepararRender("footy002", OPC)).rejects.toThrow(/tunel usa las fotos del vídeo y necesita al menos 3; ahora hay 2/);
  });

  it("musica tiene que existir dentro de FOOTY_ROOT y musica_desde ser menor que la pista", async () => {
    video("footy003", "musica: _musica/no-existe.mp3", [1, 2, 3, 4, 5, 6]);
    await expect(prepararRender("footy003", OPC)).rejects.toThrow(/No encuentro la música/);
    video("footy004", "musica: ../fuera.mp3", [1, 2, 3, 4, 5, 6]);
    await expect(prepararRender("footy004", OPC)).rejects.toThrow(/fuera de FOOTY_ROOT/);

    const h = herramientasFfmpeg();
    expect(h).toBeTruthy();
    fs.mkdirSync(path.join(RAIZ, "_musica"), { recursive: true });
    await ejecutar(h!.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=duration=3", path.join(RAIZ, "_musica", "corta.mp3")]);
    video("footy005", "musica: _musica/corta.mp3\nmusica_desde: 5", [1, 2, 3, 4, 5, 6]);
    await expect(prepararRender("footy005", OPC)).rejects.toThrow(/musica_desde: 5` es mayor que la duración de la pista \(3\.0 s\)/);
    // Sin música en el render, la pista no se comprueba.
    await expect(prepararRender("footy005", { ...OPC, musica: false })).resolves.toBeTruthy();
  });
});
