// Spike Chromium (desechable): renderiza una composición con el render real de HyperFrames usando tres
// navegadores (Chrome for Testing del motor, snapshot de Chromium y content_shell) y compara cada fotograma
// con el del CfT (SSIM). Escribe salidas/chromium/<nombre>.json.
// Uso: node spikes/chromium/render-navegadores.mjs <carpeta video-engine> <dir composición> <nombre> [--gpu]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const S = path.join(AQUI, "..", "salidas", "chromium");
const [motorArg, compArg, nombre, gpu] = process.argv.slice(2);
const MOTOR = path.resolve(motorArg ?? "");
const COMP = path.resolve(compArg ?? "");
const FFDIR = path.join(MOTOR, "ffmpeg");
const BIN = path.join(AQUI, "..", "..", "node_modules", "hyperframes", "dist", "cli.js");
const NAVEGADORES = {
  cft: path.join(MOTOR, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
  chromium: path.join(S, "x-chrome-win", "chrome-win", "chrome.exe"),
  content_shell: path.join(S, "x-content-shell", "content-shell", "content_shell.exe"),
};

const res = { nombre, gpu: gpu === "--gpu" };
for (const [n, exe] of Object.entries(NAVEGADORES)) {
  const salida = path.join(S, `${nombre}-${n}.mp4`);
  const env = { ...process.env, PATH: [FFDIR, process.env.PATH].join(path.delimiter), FFMPEG_DIR: FFDIR, HYPERFRAMES_BROWSER_PATH: exe, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", CI: "1" };
  // Los navegadores del snapshot no contestan `--version` en Windows: ver version-preload.cjs (solo medición).
  const preload = n === "cft" ? [] : ["--require", path.join(AQUI, "version-preload.cjs")];
  const args = [...preload, BIN, "render", COMP, "-o", salida, "--fps", "30", "--format", "mp4", "--quality", "delivery", res.gpu ? "--browser-gpu" : "--no-browser-gpu"];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { env, encoding: "utf8", cwd: path.dirname(COMP), timeout: 20 * 60 * 1000 });
  const segundos = Math.round((Date.now() - t0) / 1000);
  if (r.status !== 0) {
    res[n] = { ok: false, segundos, error: (r.stderr || r.stdout || String(r.error)).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice(-1200) };
    console.error(`${nombre}/${n}: FALLA en ${segundos} s`);
    continue;
  }
  res[n] = { ok: true, segundos };
  console.error(`${nombre}/${n}: ${segundos} s`);
}

for (const n of ["chromium", "content_shell"]) {
  if (!res.cft?.ok || !res[n]?.ok) continue;
  const log = `ssim-${nombre}-${n}.log`;
  spawnSync(path.join(FFDIR, "ffmpeg.exe"), ["-hide_banner", "-i", `${nombre}-cft.mp4`, "-i", `${nombre}-${n}.mp4`, "-lavfi", `[0:v][1:v]ssim=stats_file=${log}`, "-f", "null", "-"], { cwd: S });
  const filas = fs.readFileSync(path.join(S, log), "utf8").trim().split("\n").map((l) => ({ t: +((Number(/n:(\d+)/.exec(l)[1]) - 1) / 30).toFixed(3), ssim: Number(/All:([\d.]+)/.exec(l)[1]) }));
  const orden = [...filas].sort((a, b) => a.ssim - b.ssim);
  Object.assign(res[n], {
    fotogramas: filas.length,
    ssimMin: orden[0].ssim,
    ssimMedia: +(filas.reduce((s, f) => s + f.ssim, 0) / filas.length).toFixed(6),
    bajo099: filas.filter((f) => f.ssim < 0.99).length,
    identicos: filas.filter((f) => f.ssim >= 0.999999).length,
    peores: orden.slice(0, 5),
  });
}
fs.writeFileSync(path.join(S, `${nombre}.json`), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
