// T2: el audio interno es WAV (pcm_s16le, 44,1 kHz) y el motor no nombra libmp3lame (I12, ffmpeg LGPL).
// Va aparte de ajustes7a.test.ts: aquel fichero sustituye `proceso.js` por un doble y aquí hace falta ffmpeg de verdad.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cargarTema, desdeGuionV2, planificarComposicion } from "../src/composicion.js";
import { procesarAlineacion } from "../src/alineacion.js";
import { parsearGuion } from "../src/guion.js";
import { normalizarVoz, prepararMusica } from "../src/musica.js";
import { ejecutar, herramientasFfmpeg } from "../src/proceso.js";
import { CUERPO } from "./ayudas-plan.js";

const SRC = path.join(__dirname, "..", "src");
const h = herramientasFfmpeg(undefined);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "audio wav "));
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

/** Cabecera `fmt ` de un WAV: formato (1 = PCM), frecuencia y bits. Lanza si no es RIFF/WAVE. */
function fmtWav(ruta: string) {
  const b = fs.readFileSync(ruta);
  expect(b.toString("latin1", 0, 4)).toBe("RIFF");
  expect(b.toString("latin1", 8, 12)).toBe("WAVE");
  expect(b.toString("latin1", 12, 16)).toBe("fmt ");
  return { formato: b.readUInt16LE(20), canales: b.readUInt16LE(22), hz: b.readUInt32LE(24), bits: b.readUInt16LE(34) };
}

describe("sin_lame", () => {
  it("ningún fichero de src/ nombra libmp3lame", () => {
    const con = fs.readdirSync(SRC).filter((n) => n.endsWith(".ts") && fs.readFileSync(path.join(SRC, n), "utf8").includes("libmp3lame"));
    expect(con).toEqual([]);
  });
});

describe.skipIf(!h)("audio interno en WAV con ffmpeg real", () => {
  const fuente = path.join(DIR, "fuente.m4a");
  beforeAll(async () => {
    // AAC en .m4a: lo trae cualquier ffmpeg, también el LGPL (sin LAME).
    const r = await ejecutar(h!.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "aac", fuente], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr);
  }, 60_000);

  it("voz_normalizada_es_wav", async () => {
    const destino = path.join(DIR, "voz.wav");
    await normalizarVoz(h!, fuente, destino);
    expect(fmtWav(destino)).toEqual({ formato: 1, canales: expect.any(Number), hz: 44100, bits: 16 });
  }, 60_000);

  it("la música preparada es WAV y dura lo pedido (bucle)", async () => {
    const destino = path.join(DIR, "musica.wav");
    await prepararMusica(h!, fuente, destino, 0, 3);
    expect(fmtWav(destino)).toMatchObject({ formato: 1, hz: 44100, bits: 16 });
    const r = await ejecutar(h!.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", destino], { timeoutMs: 30_000 });
    expect(Math.abs(Number(r.stdout.trim()) - 3)).toBeLessThan(0.1);
  }, 60_000);
});

describe("composicion_referencia_wav", () => {
  it("la composición referencia assets/voz.wav y assets/musica.wav, y ningún .mp3", () => {
    const g = parsearGuion(`---\ntitulo: T\ngancho: Only five nations matter.\n---\n${CUERPO}`);
    const chars = [...g.narracion];
    const al = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.06), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.06) };
    const palabras = procesarAlineacion({ narracion: g.narracion, bloques: g.bloques, alineacion: al, hashNarracion: g.hash });
    const imagenes = [1, 2, 3, 4, 5, 6].map((n) => ({ n, nombre: `img${n}.jpg`, ruta: `C:\\x\\img${n}.jpg`, extension: ".jpg" as const }));
    const p = planificarComposicion({
      ...desdeGuionV2(g, imagenes),
      palabras,
      tema: cargarTema(),
      gpu: true,
      musica: { volumen: 0.12, automatizacion: "[]" },
    });
    const html = Object.values(p.archivos).join("\n");
    expect(html).toContain('src="assets/voz.wav"');
    expect(html).toContain('src="assets/musica.wav"');
    expect(html).not.toMatch(/assets\/(voz|musica)\.mp3/);
  });
});
