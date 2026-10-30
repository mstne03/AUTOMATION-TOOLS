// Arnés de SEO-111: renderiza dos composiciones con la CLI de HyperFrames (como el motor: `check` antes) y las
// compara fotograma a fotograma con el SSIM de ffmpeg. Falla si UN solo fotograma baja del umbral.
// Uso: node scripts/comparar-fotogramas.mjs <video-engine> <dirRef> <dirCand> <salida> [--umbral 0.99]
// Requiere `npm run build`. Solo desarrollo: no se empaqueta (prepare-video-engine.sh copia dist, plantilla y catalogo).
// Control negativo: que el veredicto detecta un fotograma roto lo cubren los tests de `veredicto` en
// test/arnes.test.ts (un solo fotograma bajo el umbral basta para fallar; sin fotogramas, falla). No hay control con
// vídeo real porque cuesta dos renders; si hiciera falta, comparar una composición con una copia a la que se le quita
// un host: tiene que salir ok: false.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = (f) => import(new URL(`../dist/${f}`, import.meta.url).href);

/** Filas `{ n, ssim }` del stats_file del filtro ssim de ffmpeg. */
export function leerSsim(log) {
  return log
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => ({ n: Number(/n:(\d+)/.exec(l)[1]), ssim: Number(/All:([\d.]+)/.exec(l)[1]) }));
}

/** Veredicto por mínimo (no por media): un fotograma roto basta para fallar. */
export function veredicto(filas, umbral) {
  const peores = [...filas]
    .sort((a, b) => a.ssim - b.ssim)
    .slice(0, 10)
    .map((f) => ({ t: +((f.n - 1) / 30).toFixed(3), ssim: f.ssim }));
  const bajoUmbral = filas.filter((f) => f.ssim < umbral).length;
  return {
    fotogramas: filas.length,
    ssimMin: peores[0]?.ssim ?? 0,
    ssimMedia: filas.length ? +(filas.reduce((s, f) => s + f.ssim, 0) / filas.length).toFixed(6) : 0,
    bajoUmbral,
    peores,
    ok: filas.length > 0 && bajoUmbral === 0,
  };
}

/** Lo mínimo que necesita un proceso en Windows: base del entorno cerrado y entorno del Chrome de la sonda. */
export function entornoMinimo() {
  const sistema = process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows";
  const temp = process.env.TEMP ?? os.tmpdir();
  return { PATH: path.join(sistema, "System32"), SYSTEMROOT: sistema, TEMP: temp, TMP: process.env.TMP ?? temp };
}

/**
 * Entorno de la CLI de HyperFrames por lista blanca (I5) con el modo cerrado (I13): ninguna clave del entorno del
 * desarrollador llega a HyperFrames ni a Chrome.
 */
export function entornoCerrado(motor, home) {
  const ffmpeg = path.join(motor, "ffmpeg");
  const base = entornoMinimo();
  return {
    ...base,
    PATH: ffmpeg + path.delimiter + base.PATH,
    HOME: home,
    USERPROFILE: home,
    FFMPEG_DIR: ffmpeg,
    HYPERFRAMES_BROWSER_PATH: path.join(motor, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    CI: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_NO_AUTO_INSTALL: "1",
    HYPERFRAMES_NO_OPTIONAL_INSTALL: "1",
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    HYPERFRAMES_SKIP_SKILLS: "1",
  };
}

/** Los fondos WebGPU necesitan --browser-gpu (como render.ts con montaje.usaWebgpu). */
export function usaWebgpu(dir) {
  return fs.existsSync(path.join(dir, "assets", "vendor", "shaders.iife.js"));
}

/** `check` (errores bloquean, como en el motor) y render de `dir` a `mp4`. */
export async function renderizar(motor, dir, mp4, home, { comprobar = true, timeoutMs = 600_000 } = {}) {
  const { ejecutar } = await dist("proceso.js");
  const { comprobarComposicion, HYPERFRAMES_BIN } = await dist("render.js");
  fs.mkdirSync(home, { recursive: true });
  const env = entornoCerrado(motor, home);
  const gpu = usaWebgpu(dir);
  let check = { errores: [], avisos: [] };
  if (comprobar) {
    check = await comprobarComposicion(dir, env, gpu);
    if (check.errores.length) throw new Error(`check en ${dir}: ${check.errores.join(" | ")}`);
  }
  const args = [HYPERFRAMES_BIN, "render", dir, "-o", mp4, "--fps", "30", "--format", "mp4", "--quality", "delivery"];
  if (gpu) args.push("--browser-gpu");
  const t0 = Date.now();
  // El preflight de HyperFrames da «encoder unavailable» de forma intermitente con la GPU ocupada, antes de abrir la
  // página: no es un resultado del render (una sonda contaría 0 conexiones sin medir nada). Se reintenta solo eso.
  // ponytail: 3 intentos fijos; lo cierra de verdad el codificador predecible de W1.6.
  let r;
  for (let intento = 1; intento <= 3; intento++) {
    r = await ejecutar(process.execPath, args, { cwd: path.dirname(dir), env, timeoutMs });
    if (!/encoder unavailable/i.test(r.stdout + r.stderr)) break;
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  if (r.timeout) throw new Error(`render de ${dir}: superó ${timeoutMs} ms`);
  if (r.code !== 0 || !fs.existsSync(mp4)) throw new Error(`render de ${dir} (código ${r.code}): ${(r.stderr || r.stdout).slice(-1500)}`);
  return { segundos: Math.round((Date.now() - t0) / 1000), check, salida: r.stdout + r.stderr };
}

async function contarFotogramas(ffprobe, mp4) {
  const { ejecutar } = await dist("proceso.js");
  const r = await ejecutar(ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", mp4], { timeoutMs: 120_000 });
  return Number(r.stdout.trim());
}

export async function comparar(motor, dirRef, dirCand, salida, umbral = 0.99) {
  const { ejecutar } = await dist("proceso.js");
  fs.mkdirSync(salida, { recursive: true });
  const home = path.join(salida, "hf-home");
  const res = {};
  for (const [nombre, dir] of [["referencia", dirRef], ["candidata", dirCand]]) {
    const r = await renderizar(motor, dir, path.join(salida, `${nombre}.mp4`), home);
    res[nombre] = { dir, segundos: r.segundos, avisosCheck: r.check.avisos };
    console.error(`${nombre}: ${r.segundos} s`);
  }
  const ffdir = path.join(motor, "ffmpeg");
  const nRef = await contarFotogramas(path.join(ffdir, "ffprobe.exe"), path.join(salida, "referencia.mp4"));
  const nCand = await contarFotogramas(path.join(ffdir, "ffprobe.exe"), path.join(salida, "candidata.mp4"));
  fs.rmSync(path.join(salida, "ssim.log"), { force: true });
  const r = await ejecutar(
    path.join(ffdir, "ffmpeg.exe"),
    ["-hide_banner", "-v", "error", "-i", "referencia.mp4", "-i", "candidata.mp4", "-lavfi", "[0:v][1:v]ssim=stats_file=ssim.log", "-f", "null", "-"],
    { cwd: salida, timeoutMs: 600_000 },
  );
  if (r.code !== 0) throw new Error(`ssim: ${r.stderr}`);
  const v = veredicto(leerSsim(fs.readFileSync(path.join(salida, "ssim.log"), "utf8")), umbral);
  // Un vídeo más corto que el otro pasaría el SSIM (el filtro se para en el más corto): se exige el mismo número.
  const informe = { umbral, fotogramasReferencia: nRef, fotogramasCandidata: nCand, ...v, ok: v.ok && nRef === nCand, ...res };
  fs.writeFileSync(path.join(salida, "comparacion.json"), JSON.stringify(informe, null, 2));
  return informe;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [motor, ref, cand, salida] = process.argv.slice(2);
  const i = process.argv.indexOf("--umbral");
  const umbral = i > 0 ? Number(process.argv[i + 1]) : 0.99;
  if (!motor || !ref || !cand || !salida || !Number.isFinite(umbral)) {
    console.error("Uso: node scripts/comparar-fotogramas.mjs <video-engine> <dirRef> <dirCand> <salida> [--umbral 0.99]");
    process.exit(2);
  }
  const informe = await comparar(path.resolve(motor), path.resolve(ref), path.resolve(cand), path.resolve(salida), umbral);
  const { referencia, candidata, ...resumen } = informe;
  console.log(JSON.stringify(resumen, null, 2));
  process.exit(informe.ok ? 0 : 1);
}
