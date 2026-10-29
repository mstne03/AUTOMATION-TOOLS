// Spike GSAP → WAAPI: renderiza las dos variantes (render real de HyperFrames, como el motor) y compara
// fotograma a fotograma (SSIM y PSNR por fotograma con ffmpeg). Escribe salidas/waapi/render.json.
// Uso: node spikes/waapi/render-comparar.mjs <carpeta video-engine>   (usa su ffmpeg LGPL y su navegador)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const S = path.join(AQUI, "..", "salidas", "waapi");
const MOTOR = path.resolve(process.argv[2] ?? "");
const FFDIR = path.join(MOTOR, "ffmpeg");
const FF = path.join(FFDIR, "ffmpeg.exe");
const BIN = path.join(AQUI, "..", "..", "node_modules", "hyperframes", "dist", "cli.js");
const env = {
  ...process.env,
  PATH: [FFDIR, process.env.PATH].join(path.delimiter),
  FFMPEG_DIR: FFDIR,
  HYPERFRAMES_BROWSER_PATH: path.join(MOTOR, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
  HYPERFRAMES_NO_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
};

const res = {};
for (const v of ["gsap", "waapi"]) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [BIN, "render", path.join(S, v), "-o", path.join(S, `${v}.mp4`), "--fps", "30", "--format", "mp4", "--quality", "delivery", "--no-browser-gpu"], { env, encoding: "utf8", cwd: path.join(S, v) });
  if (r.status !== 0) throw new Error(`${v}: ${(r.stderr || r.stdout).slice(-1500)}`);
  res[v] = { segundos: Math.round((Date.now() - t0) / 1000) };
  console.error(`${v}: ${res[v].segundos} s`);
}

const stats = path.join(S, "ssim.log");
spawnSync(FF, ["-hide_banner", "-i", path.join(S, "gsap.mp4"), "-i", path.join(S, "waapi.mp4"), "-lavfi", `[0:v][1:v]ssim=stats_file=${path.basename(stats)}`, "-f", "null", "-"], { cwd: S });
const filas = fs.readFileSync(stats, "utf8").trim().split("\n").map((l) => ({ n: Number(/n:(\d+)/.exec(l)[1]), ssim: Number(/All:([\d.]+)/.exec(l)[1]) }));
const peores = [...filas].sort((a, b) => a.ssim - b.ssim).slice(0, 10).map((f) => ({ t: +((f.n - 1) / 30).toFixed(3), ssim: f.ssim }));
res.fotogramas = filas.length;
res.ssimMin = peores[0].ssim;
res.ssimMedia = +(filas.reduce((s, f) => s + f.ssim, 0) / filas.length).toFixed(6);
res.bajo099 = filas.filter((f) => f.ssim < 0.99).length;
res.peores = peores;
fs.writeFileSync(path.join(S, "render.json"), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
