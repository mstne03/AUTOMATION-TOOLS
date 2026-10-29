// Spike D6 (desechable): monta dos composiciones de 50 s (fondo aurora/WebGPU y reserva CSS) para medir la preview.
// Uso: node spikes/preview-montar.mjs <carpeta bin del ffmpeg LGPL>   (requiere `npm run build`)
// Salidas en spikes/salidas/preview/{aurora,css}/footy999/_composicion (ignorada por git). No llama a ElevenLabs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SALIDAS = path.join(AQUI, "salidas", "preview");
const LGPL = path.resolve(process.argv[2] ?? "");
if (!fs.existsSync(path.join(LGPL, "ffmpeg.exe"))) throw new Error("Pasa la carpeta bin del ffmpeg LGPL como argumento.");

const sep = path.delimiter;
const limpio = (process.env.PATH ?? "").split(sep).filter((p) => p && !fs.existsSync(path.join(p, "ffmpeg.exe")));
process.env.PATH = [LGPL, ...limpio].join(sep);
process.env.HYPERFRAMES_NO_TELEMETRY = "1";
process.env.DO_NOT_TRACK = "1";
process.env.FFMPEG_DIR = LGPL;

const dist = (f) => import(new URL(`../dist/${f}`, import.meta.url).href);
const { parsearGuion } = await dist("guion.js");
const { procesarAlineacion } = await dist("alineacion.js");
const { prepararRender, montarComposicion, HYPERFRAMES_BIN } = await dist("render.js");
const { ejecutar, herramientasFfmpeg, entornoConFfmpeg } = await dist("proceso.js");

const FF = path.join(LGPL, "ffmpeg.exe");
const DUR_VOZ = 50;
const ID = "footy999";

const guion = (fondo) => `---
titulo: Spike preview
gancho: "He scored. From his own box."
fondo: ${fondo}
escenas:
  2:
    tipo: cartel
    texto: Nobody had seen it
  3:
    tipo: cartel
    texto: Ninety metres
  4:
    tipo: cartel
    texto: Straight down the middle
  5:
    tipo: cartel
    texto: The stadium exploded
---

[1] In 1999, a goalkeeper did something nobody had ever seen. He walked out of the tunnel in front of forty thousand people.
[2] He picked up the ball in his own box. The crowd went quiet, because nobody knew what he was about to do.
[3] He looked up. The other keeper was off his line, a long way from the posts, chatting with his defenders.
[4] So he kicked it. Ninety metres. Straight down the middle, with the wind behind it, higher than the floodlights.
[5] It bounced once, and it went in! The stadium exploded, and the commentator simply forgot how to speak.
[6] And that is why they still sing his name. Every season, every match, each time the ball goes long.
`;

async function ff(args) {
  const r = await ejecutar(FF, ["-y", "-v", "error", ...args], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(r.stderr);
}

async function montar(nombre, fondo) {
  const raiz = path.join(SALIDAS, nombre);
  const dir = path.join(raiz, ID);
  const comp = path.join(dir, "_composicion");
  fs.rmSync(raiz, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const texto = guion(fondo);
  fs.writeFileSync(path.join(dir, "guion.md"), texto);
  const colores = ["0x1f5c3a", "0x8a1c1c", "0x1c3f8a", "0x7a5a12", "0x4b1c7a", "0x116b6b"];
  for (let n = 1; n <= 6; n++) {
    const base = `color=c=${colores[n - 1]}:s=1080x1920:d=1`;
    const salida = path.join(dir, `img${n}.jpg`);
    try {
      await ff(["-f", "lavfi", "-i", base, "-vf", `drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='${n}':fontsize=700:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`, "-frames:v", "1", salida]);
    } catch {
      await ff(["-f", "lavfi", "-i", base, "-frames:v", "1", salida]);
    }
  }
  // Voz sintética (tono de 220 Hz): nunca se llama a ElevenLabs.
  await ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${DUR_VOZ}`, "-c:a", "libmp3lame", "-b:a", "128k", path.join(dir, "voz.mp3")]);
  const g = parsearGuion(texto);
  const chars = [...g.narracion];
  const paso = (DUR_VOZ - 0.4) / chars.length;
  const palabras = procesarAlineacion({
    narracion: g.narracion,
    bloques: g.bloques,
    alineacion: {
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => 0.2 + i * paso),
      character_end_times_seconds: chars.map((_, i) => 0.2 + (i + 1) * paso),
    },
    duracionAudio: DUR_VOZ,
    hashNarracion: g.hash,
  });
  fs.writeFileSync(path.join(dir, "palabras.json"), JSON.stringify(palabras, null, 2));
  const o = { raiz, musica: false, musicaVolumen: 0.12, ffmpegDir: LGPL };
  const prep = await prepararRender(ID, o);
  const m = await montarComposicion(prep, comp, o);
  console.error(`${nombre}: ${m.duracion} s, webgpu=${m.usaWebgpu}, avisos=${JSON.stringify(m.avisos)}`);
  return { comp, ...m };
}

const r = { aurora: await montar("aurora", "aurora"), css: await montar("css", "gradiente") };
fs.writeFileSync(path.join(SALIDAS, "montaje.json"), JSON.stringify(r, null, 2));
