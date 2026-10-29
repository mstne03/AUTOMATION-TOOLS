// Spike D6: compara los fotogramas capturados en la preview con los del MP4 en los mismos segundos (SSIM/PSNR).
// Uso: node spikes/preview-comparar.mjs <carpeta bin del ffmpeg LGPL> [aurora] [fresco|trasplay]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const D = path.join(path.dirname(fileURLToPath(import.meta.url)), "salidas", "preview");
const FF = path.join(path.resolve(process.argv[2] ?? ""), "ffmpeg.exe");
const v = process.argv[3] ?? "aurora";
const pre = process.argv[4] ?? "fresco"; // fresco | trasplay (ver app-ui/scripts/spike-preview-medir.mjs)
const run = (args) => spawnSync(FF, ["-hide_banner", "-y", ...args], { encoding: "utf8", shell: false });
const res = {};
for (const t of [1, 10, 25, 45]) {
  const mp4 = path.join(D, `${v}_mp4_${t}s.png`);
  const prev = path.join(D, `${v}_${pre}_${t}s.png`);
  run(["-ss", String(t), "-i", path.join(D, `${v}.mp4`), "-frames:v", "1", mp4]);
  const r = run(["-i", prev, "-i", mp4, "-lavfi", "[0:v][1:v]scale2ref=flags=bicubic[a][b];[a]split[a1][a2];[b]split[b1][b2];[a1][b1]ssim;[a2][b2]psnr", "-f", "null", "-"]);
  const ssim = /SSIM .*All:([\d.]+)/.exec(r.stderr)?.[1];
  const psnr = /PSNR .*average:([\d.inf]+)/.exec(r.stderr)?.[1];
  // Lado a lado (preview | MP4 | diferencia x4) para mirarlo a ojo.
  const l = run(["-i", prev, "-i", mp4, "-lavfi", "[0:v]format=rgb24,split[p1][p2];[1:v]format=rgb24,split[m1][m2];[p1][m1]blend=all_mode=difference,lutrgb=r=val*6:g=val*6:b=val*6[d];[p2][m2][d]hstack=inputs=3,scale=1080:-1", "-frames:v", "1", path.join(D, `${v}_${pre}_lado_${t}s.png`)]);
  if (l.status !== 0) console.error(l.stderr.slice(-300));
  res[t] = { ssim: Number(ssim), psnr: Number(psnr) };
  console.log(t, "s  SSIM", ssim, " PSNR", psnr);
}
fs.writeFileSync(path.join(D, `comparacion_${v}_${pre}.json`), JSON.stringify(res, null, 2));
