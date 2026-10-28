// Spike D6: renderiza el MP4 de referencia de la composición montada por preview-montar.mjs.
// Uso: node spikes/preview-render.mjs <carpeta bin del ffmpeg LGPL> [aurora|css]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const LGPL = path.resolve(process.argv[2] ?? "");
const nombre = process.argv[3] ?? "aurora";
const sep = path.delimiter;
const limpio = (process.env.PATH ?? "").split(sep).filter((p) => p && !fs.existsSync(path.join(p, "ffmpeg.exe")));
process.env.PATH = [LGPL, ...limpio].join(sep);
process.env.HYPERFRAMES_NO_TELEMETRY = "1";
process.env.DO_NOT_TRACK = "1";
process.env.FFMPEG_DIR = LGPL;

const dist = (f) => import(new URL(`../dist/${f}`, import.meta.url).href);
const { HYPERFRAMES_BIN } = await dist("render.js");
const { ejecutar, herramientasFfmpeg, entornoConFfmpeg } = await dist("proceso.js");

const comp = path.join(AQUI, "salidas", "preview", nombre, "footy999", "_composicion");
const salida = path.join(AQUI, "salidas", "preview", `${nombre}.mp4`);
const env = entornoConFfmpeg(herramientasFfmpeg(LGPL));
const args = [HYPERFRAMES_BIN, "render", comp, "-o", salida, "--fps", "30", "--format", "mp4", "--quality", "delivery"];
if (nombre === "aurora") args.push("--browser-gpu");
const t0 = Date.now();
const r = await ejecutar(process.execPath, args, { cwd: comp, env, onLinea: (l) => console.error(l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim().slice(0, 160)) });
console.error(`código ${r.code} en ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${salida}`);
