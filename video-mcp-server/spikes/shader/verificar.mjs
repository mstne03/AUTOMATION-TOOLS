// W1.1 (SEO-114), ronda 1: automatiza las comprobaciones L3 y L4 de la R0 para que W2.6 las repita.
//   L4: SHA-256 del runtime de HyperFrames, de shaders.iife.js, versión de puppeteer-core frente al lock, y SHA-256
//       del chrome-headless-shell.exe y del ffmpeg.exe frente a los de referencia.
//   L3: procesos restantes cuyo ejecutable cuelga de la carpeta del CfT o del ffmpeg, o que llevan nuestro perfil
//       temporal (salidas/shader/perfil-tmp) en la línea de órdenes. Debe ser 0.
// Uso: node spikes/shader/verificar.mjs [--motor-video <carpeta video-engine>]   (sale con 1 si algo no cuadra)
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MOTOR = path.join(AQUI, "..", "..");
const { values: a } = parseArgs({
  options: {
    "motor-video": {
      type: "string",
      default: path.join(MOTOR, "..", "..", "hyperframes-elevenlabs-integration-ccba9b", "app-ui", "src-tauri", "binaries", "video-engine"),
    },
  },
});
const VE = path.resolve(a["motor-video"]);

// Referencias. El runtime: SHA-256 del worktree de origen del node_modules (lock idéntico). Los dos .exe: SHA-256 del
// ejecutable dentro de los zips de prepare-video-engine.sh (CHROME_SHA256 5d7df999…275e, FFMPEG_SHA256 b7c1c846…4fc0),
// comprobado en W1.1 con `unzip -p <zip> <exe> | sha256sum`. shaders.iife.js: el de catalogo/hyperframes.lock.json.
const REF = {
  runtime: "cafd7cc9ef6867d0e08910ef27d471ebcb38127c2bc68b1e5c8950a513ac607e",
  cft: "909fa4a0d2866f5b5b6cabd0a3b3545edeaf84db361148dbc8e992e25e61e7e6",
  ffmpeg: "3e79ae0855dce679f3911069df641e9da7dc82aec76807205607338218cd956f",
  shaders: JSON.parse(fs.readFileSync(path.join(MOTOR, "catalogo", "hyperframes.lock.json"), "utf8"))["compositions/lib/shaders.iife.js"],
  puppeteer: JSON.parse(fs.readFileSync(path.join(MOTOR, "package-lock.json"), "utf8")).packages["node_modules/puppeteer-core"].version,
};
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const filas = [
  ["L4 runtime", sha(path.join(MOTOR, "node_modules", "hyperframes", "dist", "hyperframe.runtime.iife.js")), REF.runtime],
  ["L4 shaders.iife.js", sha(path.join(MOTOR, "plantilla", "vendor", "shaders.iife.js")), REF.shaders],
  ["L4 puppeteer-core", JSON.parse(fs.readFileSync(path.join(MOTOR, "node_modules", "puppeteer-core", "package.json"), "utf8")).version, REF.puppeteer],
  ["L4 chrome-headless-shell.exe", sha(path.join(VE, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe")), REF.cft],
  ["L4 ffmpeg.exe", sha(path.join(VE, "ffmpeg", "ffmpeg.exe")), REF.ffmpeg],
];

const esc = (s) => s.replace(/'/g, "''");
const out = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `@(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and ($_.ExecutablePath -like '${esc(path.join(VE, "browser"))}\\*' -or $_.ExecutablePath -like '${esc(path.join(VE, "ffmpeg"))}\\*')) -or ($_.CommandLine -like '*${esc(path.join("shader", "perfil-tmp"))}*' -and $_.ProcessId -ne $PID) } | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress`,
  ],
  { encoding: "utf8", timeout: 60000 },
).trim();
const restos = out ? [].concat(JSON.parse(out)) : [];
filas.push(["L3 procesos restantes", String(restos.length), "0"]);

let mal = 0;
for (const [que, real, ref] of filas) {
  const ok = real === ref;
  mal += ok ? 0 : 1;
  console.log(`${ok ? "ok " : "MAL"} ${que}: ${real.slice(0, 16)}${real.length > 16 ? "…" : ""}${ok ? "" : ` (esperado ${ref})`}`);
}
if (restos.length) console.log(JSON.stringify(restos));
process.exitCode = mal ? 1 : 0;
