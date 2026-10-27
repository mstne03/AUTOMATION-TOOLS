// Spike D11 (desechable): mediciones posteriores sobre spikes/salidas/ (no renderiza con HyperFrames).
// Uso: node spikes/medidas.mjs <carpeta bin del ffmpeg LGPL> <referencia: inter.mov | inter.webm>
// Hace: ffprobe y PNG de control.mp4 (Rápido), pruebas de bitrate/control de tasa de la segunda pasada
// y SSIM/PSNR de cada MP4 frente a la referencia. Escribe spikes/salidas/medidas.json.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "salidas");
const LGPL = path.resolve(process.argv[2] ?? "");
const REF = path.join(SAL, process.argv[3] ?? "inter.mov");
const FF = path.join(LGPL, "ffmpeg.exe");
const FP = path.join(LGPL, "ffprobe.exe");
const run = (exe, args) => spawnSync(exe, args, { encoding: "utf8", shell: false, maxBuffer: 1 << 26 });
const S = (n) => path.join(SAL, n);
const out = { referencia: REF, variantes: {}, calidad: {} };

// 1) ficha y PNG de control.mp4 (modo Rápido, sin --gpu)
out.control = JSON.parse(run(FP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", S("control.mp4")]).stdout);
for (const s of [1, 10, 25, 45]) run(FF, ["-y", "-v", "error", "-ss", String(s), "-i", S("control.mp4"), "-frames:v", "1", S(`rapido_gpu_${s}s.png`)]);

// 2) pruebas de control de tasa sobre la referencia
const audio = ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
const V = {
  mf_b12: ["-c:v", "h264_mf", "-b:v", "12M"],
  mf_cbr12: ["-c:v", "h264_mf", "-rate_control", "cbr", "-b:v", "12M"],
  mf_pcvbr12: ["-c:v", "h264_mf", "-rate_control", "pc_vbr", "-b:v", "12M"],
  mf_q100: ["-c:v", "h264_mf", "-rate_control", "quality", "-quality", "100"],
  mf_hw: ["-c:v", "h264_mf", "-hw_encoding", "1", "-rate_control", "cbr", "-b:v", "12M"],
  nv_vbr12: ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-b:v", "12M", "-maxrate", "16M", "-profile:v", "high"],
  nv_cbr12: ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "cbr", "-b:v", "12M", "-profile:v", "high"],
  nv_cq19: ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-profile:v", "high"],
};
for (const [n, a] of Object.entries(V)) {
  const t0 = Date.now();
  const r = run(FF, ["-y", "-v", "error", "-i", REF, ...a, "-pix_fmt", "yuv420p", ...audio, S(`v_${n}.mp4`)]);
  out.variantes[n] = { codigo: r.status, segundos: (Date.now() - t0) / 1000, MB: fs.existsSync(S(`v_${n}.mp4`)) ? +(fs.statSync(S(`v_${n}.mp4`)).size / 1048576).toFixed(1) : null, stderr: r.status ? r.stderr.slice(0, 200) : "" };
}

// 3) SSIM y PSNR frente a la referencia
const ssimPsnr = (f) => {
  const r = run(FF, ["-hide_banner", "-i", S(f), "-i", REF, "-lavfi", "[0:v]format=yuv420p,split[a1][a2];[1:v]format=yuv420p,split[b1][b2];[a1][b1]ssim;[a2][b2]psnr", "-f", "null", "-"]);
  return { ssim: /SSIM.*All:([0-9.]+)/.exec(r.stderr)?.[1], psnr: /PSNR.*average:([0-9.]+)/.exec(r.stderr)?.[1] };
};
for (const f of fs.readdirSync(SAL).filter((f) => /^(control|mov_.*|webm_.*|v_.*)\.mp4$/.test(f))) out.calidad[f] = ssimPsnr(f);
fs.writeFileSync(S("medidas.json"), JSON.stringify(out, null, 2));
console.error("Hecho: spikes/salidas/medidas.json");
