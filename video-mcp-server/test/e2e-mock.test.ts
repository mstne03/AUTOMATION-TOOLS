// Render completo sin ElevenLabs: imágenes, voz y palabras.json sintéticos (npm run render:mock).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion, type AlineacionCaracteres } from "../src/alineacion.js";
import { encolarRender, esperarJob, ultimasLineasUtiles } from "../src/render.js";
import { ejecutar, herramientasFfmpeg, sondear } from "../src/proceso.js";
import { config } from "../src/config.js";

const DURACION_VOZ = 20;
// Carpeta temporal con espacios en la ruta, a propósito.
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "video e2e "));
const ID = "video999";
const COLORES = ["0x1f5c3a", "0x8a1c1c", "0x1c3f8a", "0x7a5a12", "0x4b1c7a", "0x116b6b"];

const GUION = `---
titulo: Mock render
gancho: "He scored. From his own box."
musica: _musica/mock tone.mp3
---

[1] In 1999, a goalkeeper did something nobody had ever seen.
[2] He picked up the ball in his own box.
[3] He looked up. The other keeper was off his line.
[4] So he kicked it. Ninety metres. Straight down the middle.
[5] It bounced once — and it went in!
[6] And that is why they still sing his name.
`;

afterAll(() => {
  // Solo borra la carpeta temporal que ha creado esta prueba (VIDEO_MOCK_CONSERVAR=1 la deja para revisarla).
  if (process.env.VIDEO_MOCK_CONSERVAR === "1") {
    process.stderr.write(`render:mock conservado en ${RAIZ}\n`);
    return;
  }
  if (RAIZ.startsWith(os.tmpdir()) && path.basename(RAIZ).startsWith("video e2e ")) {
    fs.rmSync(RAIZ, { recursive: true, force: true });
  }
});

async function ff(args: string[]) {
  const h = herramientasFfmpeg(config.ffmpegDir)!;
  const r = await ejecutar(h.ffmpeg, ["-y", "-v", "error", ...args], { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(r.stderr);
}

describe("render:mock", () => {
  it(
    "produce un mp4 1080×1920 H.264 con audio y la duración esperada",
    async () => {
      const h = herramientasFfmpeg(config.ffmpegDir);
      expect(h, "ffmpeg/ffprobe no encontrados").toBeTruthy();
      const dir = path.join(RAIZ, ID);
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(RAIZ, "_musica"));
      fs.writeFileSync(path.join(dir, "guion.md"), GUION);

      const fuente = "C\\:/Windows/Fonts/arial.ttf";
      for (let n = 1; n <= 6; n++) {
        const base = `color=c=${COLORES[n - 1]}:s=1080x1920:d=1`;
        const salida = path.join(dir, n === 3 ? `img${n} portada.png` : `img${n}.jpg`);
        try {
          await ff(["-f", "lavfi", "-i", base, "-vf", `drawtext=fontfile='${fuente}':text='${n}':fontsize=700:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`, "-frames:v", "1", salida]);
        } catch {
          await ff(["-f", "lavfi", "-i", base, "-frames:v", "1", salida]);
        }
      }
      await ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${DURACION_VOZ}`, "-c:a", "libmp3lame", "-b:a", "128k", path.join(dir, "voz.mp3")]);
      await ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "libmp3lame", path.join(RAIZ, "_musica", "mock tone.mp3")]);

      // palabras.json sintético: los caracteres repartidos uniformemente en los 20 s.
      const guion = parsearGuion(GUION);
      const paso = (DURACION_VOZ - 0.4) / guion.narracion.length;
      const chars = [...guion.narracion];
      const alineacion: AlineacionCaracteres = {
        characters: chars,
        character_start_times_seconds: chars.map((_, i) => 0.2 + i * paso),
        character_end_times_seconds: chars.map((_, i) => 0.2 + (i + 1) * paso),
      };
      const palabras = procesarAlineacion({
        narracion: guion.narracion,
        bloques: guion.bloques,
        alineacion,
        duracionAudio: DURACION_VOZ,
        hashNarracion: guion.hash,
      });
      fs.writeFileSync(path.join(dir, "palabras.json"), JSON.stringify(palabras, null, 2));

      const job = await encolarRender(ID, { raiz: RAIZ, musica: true, musicaVolumen: 0.12, ffmpegDir: config.ffmpegDir });
      const fin = await esperarJob(job.job_id, 1000);
      if (fin.estado !== "terminado") {
        throw new Error(`Render fallido: ${fin.error}\n${ultimasLineasUtiles(fin).join("\n")}`);
      }

      if (fin.avisos.length) process.stderr.write(`Avisos del render:\n${fin.avisos.join("\n")}\n`);
      const mp4 = path.join(RAIZ, `${ID}.mp4`);
      expect(fs.existsSync(mp4)).toBe(true);
      expect(fs.existsSync(path.join(RAIZ, `${ID}.renderizando.mp4`))).toBe(false);
      const info = await sondear(h!.ffprobe, mp4);
      expect(info.ancho).toBe(1080);
      expect(info.alto).toBe(1920);
      expect(info.codecVideo).toBe("h264");
      expect(info.tieneAudio).toBe(true);
      expect(Math.abs((info.duracion ?? 0) - (DURACION_VOZ + 0.4))).toBeLessThanOrEqual(0.5);

      // Sin recursos de red en la composición.
      const html = fs.readFileSync(path.join(dir, "_composicion", "index.html"), "utf8");
      expect(html).not.toMatch(/https?:\/\//);
      process.stderr.write(`render:mock OK → ${info.ancho}×${info.alto} ${info.codecVideo}, ${info.duracion?.toFixed(2)} s\n`);
    },
    15 * 60 * 1000,
  );
});
