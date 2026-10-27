// Spike D11 (desechable): codificación en dos pasadas con un ffmpeg LGPL.
// Uso: node spikes/codificacion.mjs <carpeta bin del ffmpeg LGPL>   (requiere `npm run build`)
// Salidas en spikes/salidas/ (ignorada por git): resultados.json, MP4, intermedios y PNG.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SALIDAS = path.join(AQUI, "salidas");
const LGPL = path.resolve(process.argv[2] ?? "");
if (!fs.existsSync(path.join(LGPL, "ffmpeg.exe"))) throw new Error("Pasa la carpeta bin del ffmpeg LGPL como argumento.");

// PATH saneado: solo el ffmpeg LGPL (se quita cualquier otra carpeta con ffmpeg).
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
const FP = path.join(LGPL, "ffprobe.exe");
const DUR_VOZ = 50;
const ID = "footy999";
const RAIZ = path.join(SALIDAS, "raiz con espacios");
const DIR = path.join(RAIZ, ID);
const COMP = path.join(DIR, "_composicion");
fs.mkdirSync(SALIDAS, { recursive: true });

const GUION = `---
titulo: Spike codificacion
gancho: "He scored. From his own box."
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

async function prepararEntrada() {
  fs.rmSync(RAIZ, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "guion.md"), GUION);
  const colores = ["0x1f5c3a", "0x8a1c1c", "0x1c3f8a", "0x7a5a12", "0x4b1c7a", "0x116b6b"];
  for (let n = 1; n <= 6; n++) {
    const base = `color=c=${colores[n - 1]}:s=1080x1920:d=1`;
    const salida = path.join(DIR, `img${n}.jpg`);
    try {
      await ff(["-f", "lavfi", "-i", base, "-vf", `drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${n}':fontsize=700:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`, "-frames:v", "1", salida]);
    } catch {
      await ff(["-f", "lavfi", "-i", base, "-frames:v", "1", salida]);
    }
  }
  await ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${DUR_VOZ}`, "-c:a", "libmp3lame", "-b:a", "128k", path.join(DIR, "voz.mp3")]);
  const guion = parsearGuion(GUION);
  const chars = [...guion.narracion];
  const paso = (DUR_VOZ - 0.4) / chars.length;
  const palabras = procesarAlineacion({
    narracion: guion.narracion,
    bloques: guion.bloques,
    alineacion: {
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => 0.2 + i * paso),
      character_end_times_seconds: chars.map((_, i) => 0.2 + (i + 1) * paso),
    },
    duracionAudio: DUR_VOZ,
    hashNarracion: guion.hash,
  });
  fs.writeFileSync(path.join(DIR, "palabras.json"), JSON.stringify(palabras, null, 2));
  const o = { raiz: RAIZ, musica: false, musicaVolumen: 0.12, ffmpegDir: LGPL };
  const prep = await prepararRender(ID, o);
  return montarComposicion(prep, COMP, o);
}

const resultados = { ffmpeg: FF, fecha: new Date().toISOString(), fases: {} };
function guardar() {
  fs.writeFileSync(path.join(SALIDAS, "resultados.json"), JSON.stringify(resultados, null, 2));
}

async function fase(nombre, comando, args, opciones = {}) {
  const t0 = Date.now();
  const lineas = [];
  const r = await ejecutar(comando, args, { ...opciones, onLinea: (l) => lineas.push(l) });
  const seg = (Date.now() - t0) / 1000;
  resultados.fases[nombre] = {
    segundos: Number(seg.toFixed(1)),
    codigo: r.code,
    cola: lineas.slice(-8).map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")),
  };
  guardar();
  console.error(`[${nombre}] ${seg.toFixed(1)} s, código ${r.code}`);
  return r;
}

const env = entornoConFfmpeg(herramientasFfmpeg(LGPL));
const hf = (nombre, salida, extra) =>
  fase(nombre, process.execPath, [HYPERFRAMES_BIN, "render", COMP, "-o", salida, "--fps", "30", "--quality", "delivery", ...extra], { cwd: COMP, env });

async function ficha(nombre, archivo) {
  if (!fs.existsSync(archivo)) return;
  const tam = fs.statSync(archivo).size;
  const p = await ejecutar(FP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", archivo], { timeoutMs: 30000 });
  const j = JSON.parse(p.stdout);
  resultados.fases[nombre] = {
    ...resultados.fases[nombre],
    MB: Number((tam / 1048576).toFixed(1)),
    duracion: j.format?.duration,
    streams: j.streams?.map((s) => ({ tipo: s.codec_type, codec: s.codec_name, perfil: s.profile, pix: s.pix_fmt, w: s.width, h: s.height, fps: s.r_frame_rate, canales: s.channels, kbps: s.bit_rate ? Math.round(s.bit_rate / 1000) : undefined })),
  };
  guardar();
}

async function pngs(nombre, archivo) {
  if (!fs.existsSync(archivo)) return;
  for (const s of [1, 10, 25, 45]) await ff(["-ss", String(s), "-i", archivo, "-frames:v", "1", path.join(SALIDAS, `${nombre}_${s}s.png`)]);
}

const S = (n) => path.join(SALIDAS, n);
for (const f of fs.readdirSync(SALIDAS)) if (/\.(mp4|mov|webm|png)$/.test(f)) fs.rmSync(S(f));

const montaje = await prepararEntrada();
resultados.composicion = { duracion: montaje.duracion, usaWebgpu: montaje.usaWebgpu };
const gpuArgs = montaje.usaWebgpu ? ["--browser-gpu"] : [];
console.error(`Composición lista: ${montaje.duracion} s, webgpu=${montaje.usaWebgpu}`);

// 0) mp4 directo SIN --gpu (control.mp4): con un ffmpeg sin libx264 HyperFrames cae solo al codificador de GPU, así que es el modo Rápido.
await hf("0_rapido_mp4_sin_gpu_control", S("control.mp4"), ["--format", "mp4", ...gpuArgs]);
// 1) mp4 directo con --gpu explícito (en la ejecución del spike falló; ver INFORME).
await hf("1_mp4_con_gpu_explicito", S("rapido_gpu.mp4"), ["--format", "mp4", "--gpu", ...gpuArgs]);
// 2) Intermedios.
await hf("2_intermedio_mov", S("inter.mov"), ["--format", "mov", ...gpuArgs]);
await hf("3_intermedio_webm", S("inter.webm"), ["--format", "webm", ...gpuArgs]);

// 3) Segunda pasada.
const audio = ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
const paso2 = (codec, inp, out) => ["-y", "-hide_banner", "-i", inp, "-c:v", codec, "-b:v", "12M", "-pix_fmt", "yuv420p", ...audio, out];
for (const [fmt, inter] of [["mov", "inter.mov"], ["webm", "inter.webm"]]) {
  if (!fs.existsSync(S(inter))) continue;
  await fase(`4_${fmt}_h264_mf`, FF, paso2("h264_mf", S(inter), S(`${fmt}_mf.mp4`)), { timeoutMs: 600000 });
  await fase(`5_${fmt}_h264_nvenc`, FF, paso2("h264_nvenc", S(inter), S(`${fmt}_nvenc.mp4`)), { timeoutMs: 600000 });
}

for (const [nombre, archivo] of [["rapido_gpu", "rapido_gpu.mp4"], ["inter_mov", "inter.mov"], ["inter_webm", "inter.webm"], ["mov_mf", "mov_mf.mp4"], ["mov_nvenc", "mov_nvenc.mp4"], ["webm_mf", "webm_mf.mp4"], ["webm_nvenc", "webm_nvenc.mp4"]]) {
  await ficha(nombre, S(archivo));
  await pngs(nombre, S(archivo));
}
guardar();
console.error("Hecho. Ver spikes/salidas/resultados.json");
