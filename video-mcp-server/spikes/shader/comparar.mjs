// W1.1 (SEO-114): SSIM/PSNR de cada captura de un escenario contra la referencia fresca (S1, repetición 1) al
// mismo instante, con el ffmpeg LGPL local. ffmpeg se lanza con spawn, sin shell, con argumentos en array y timeout.
// Uso: node spikes/shader/comparar.mjs --ffmpeg <ffmpeg.exe> --escenario S2[-etiqueta] [--referencia S1[-etiqueta]] [--umbral 0.995]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SALIDAS = path.join(AQUI, "..", "salidas", "shader");
const { values: a } = parseArgs({
  options: { ffmpeg: { type: "string" }, escenario: { type: "string" }, referencia: { type: "string", default: "S1" }, umbral: { type: "string", default: "0.995" } },
});
if (!a.ffmpeg || !fs.existsSync(a.ffmpeg)) throw new Error("--ffmpeg debe ser la ruta del ffmpeg.exe LGPL");
const UMBRAL = Number(a.umbral);

function ffmpeg(args, timeoutMs = 60000) {
  return new Promise((ok, mal) => {
    const p = spawn(a.ffmpeg, args, { shell: false, windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { p.kill(); mal(new Error("ffmpeg: tiempo agotado")); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(t); mal(e); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? ok(err) : mal(new Error(`ffmpeg salió con ${code}: ${err.slice(-500)}`)); });
  });
}

async function medir(png, ref) {
  const err = await ffmpeg(["-hide_banner", "-nostats", "-i", png, "-i", ref, "-filter_complex", "[0:v]split[a0][a1];[1:v]split[b0][b1];[a0][b0]ssim;[a1][b1]psnr", "-f", "null", "-"]);
  const ssim = Number(/SSIM .*All:([\d.]+)/.exec(err)?.[1]);
  const psnr = /PSNR .*average:(inf|[\d.]+)/.exec(err)?.[1];
  return { ssim, psnr: psnr === "inf" ? Infinity : Number(psnr) };
}

const dirEsc = path.join(SALIDAS, a.escenario);
const dirRef = path.join(SALIDAS, a.referencia, "1");
const filas = [];
for (const rep of fs.readdirSync(dirEsc).filter((d) => /^\d+$/.test(d)).sort((x, y) => x - y)) {
  const res = JSON.parse(fs.readFileSync(path.join(dirEsc, rep, "resultado.json"), "utf8"));
  for (const c of res.capturas) {
    const ref = path.join(dirRef, `t${c.t}.png`);
    if (!fs.existsSync(ref) || path.resolve(ref) === path.resolve(c.png)) continue;
    const m = await medir(c.png, ref);
    filas.push({ rep: Number(rep), nombre: c.nombre, t: c.t, ...m, igual: m.ssim >= UMBRAL, sha256: c.sha256.slice(0, 12), msHastaListo: c.msHastaListo != null ? Math.round(c.msHastaListo) : null });
  }
}
fs.writeFileSync(path.join(dirEsc, "comparacion.json"), JSON.stringify({ referencia: a.referencia, umbral: UMBRAL, filas }, null, 2));
console.table(filas.map((f) => ({ ...f, ssim: f.ssim.toFixed(4), psnr: Number.isFinite(f.psnr) ? f.psnr.toFixed(1) : "inf" })));
const malas = filas.filter((f) => !f.igual);
const ms = filas.map((f) => f.msHastaListo).filter((x) => x != null).sort((x, y) => x - y);
console.log(`${a.escenario}: ${filas.length - malas.length}/${filas.length} capturas ≥ ${UMBRAL} contra ${a.referencia}; SSIM mín ${Math.min(...filas.map((f) => f.ssim)).toFixed(4)}; ms hasta listo mediana ${ms[ms.length >> 1]} máx ${ms.at(-1)}`);
