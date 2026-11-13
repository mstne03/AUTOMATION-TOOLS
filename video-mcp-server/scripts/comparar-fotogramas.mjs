// Arnés de SEO-111: renderiza dos composiciones con la CLI de HyperFrames (como el motor: `check` antes) y las
// compara fotograma a fotograma con el SSIM de ffmpeg. Falla si UN solo fotograma baja del umbral.
// Uso: node scripts/comparar-fotogramas.mjs <video-engine> <dirRef> <dirCand> <salida> [--umbral 0.99] [--png]
// Requiere `npm run build`. Solo desarrollo: no se empaqueta (prepare-video-engine.sh copia dist, plantilla y catalogo).
// Con `--png` (o ssimPng / compararPngContraReferencia) la comparación es por PNG sin pérdida de `--format png-sequence`.
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
 * Entorno cerrado que aplica `montar` a process.env (lista blanca + modo cerrado). `renderizar` solo toma de aquí
 * FFMPEG_DIR y HYPERFRAMES_BROWSER_PATH; el entorno del hijo lo construye entornoHijo(), no se pasa a mano.
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

/**
 * `check` (errores bloquean, como en el motor) y render de `dir` a `mp4`. Como `montar`, fija FFMPEG_DIR,
 * HYPERFRAMES_BROWSER_PATH y VIDEO_STATE_DIR en el entorno del proceso durante la llamada (el entorno del hijo se
 * construye desde ahí con entornoHijo) y los restaura en `finally`.
 */
export async function renderizar(motor, dir, mp4, home, { comprobar = true, timeoutMs = 600_000, png = false } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const cerrado = entornoCerrado(motor, home);
  const claves = ["FFMPEG_DIR", "HYPERFRAMES_BROWSER_PATH", "VIDEO_STATE_DIR"];
  const previo = Object.fromEntries(claves.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { FFMPEG_DIR: cerrado.FFMPEG_DIR, HYPERFRAMES_BROWSER_PATH: cerrado.HYPERFRAMES_BROWSER_PATH, VIDEO_STATE_DIR: path.resolve(home, "..", "estado") });
  try {
    // Después de fijar el entorno: estado.ts lee VIDEO_STATE_DIR al cargarse (la primera ejecución del proceso manda).
    const { ejecutar } = await dist("proceso.js");
    const { comprobarComposicion, HYPERFRAMES_BIN } = await dist("render.js");
    const gpu = usaWebgpu(dir);
    let check = { errores: [], avisos: [] };
    if (comprobar) {
      check = await comprobarComposicion(dir, gpu);
      if (check.errores.length) throw new Error(`check en ${dir}: ${check.errores.join(" | ")}`);
    }
    // `png` (SEO-112): `--format png-sequence` escribe `mp4` como DIRECTORIO de PNG sin pérdida (sin x264 por medio).
    const args = [HYPERFRAMES_BIN, "render", dir, "-o", mp4, "--fps", "30", ...(png ? ["--format", "png-sequence"] : ["--format", "mp4", "--quality", "delivery"])];
    if (gpu) args.push("--browser-gpu");
    const t0 = Date.now();
    // El preflight de HyperFrames da «encoder unavailable» de forma intermitente con la GPU ocupada, antes de abrir la
    // página: no es un resultado del render (una sonda contaría 0 conexiones sin medir nada). Se reintenta solo eso.
    // ponytail: 3 intentos fijos; lo cierra de verdad el codificador predecible de W1.6.
    let r;
    for (let intento = 1; intento <= 3; intento++) {
      r = await ejecutar(process.execPath, args, { cwd: path.dirname(dir), timeoutMs });
      if (!/encoder unavailable/i.test(r.stdout + r.stderr)) break;
      await new Promise((ok) => setTimeout(ok, 5000));
    }
    if (r.timeout) throw new Error(`render de ${dir}: superó ${timeoutMs} ms`);
    if (r.code !== 0 || !fs.existsSync(mp4)) throw new Error(`render de ${dir} (código ${r.code}): ${(r.stderr || r.stdout).slice(-1500)}`);
    return { segundos: Math.round((Date.now() - t0) / 1000), check, salida: r.stdout + r.stderr };
  } finally {
    for (const k of claves) previo[k] === undefined ? delete process.env[k] : (process.env[k] = previo[k]);
  }
}

async function contarFotogramas(ffprobe, mp4) {
  const { ejecutar } = await dist("proceso.js");
  const r = await ejecutar(ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", mp4], { timeoutMs: 120_000 });
  return Number(r.stdout.trim());
}

export async function comparar(motor, dirRef, dirCand, salida, umbral = 0.99) {
  fs.mkdirSync(salida, { recursive: true });
  const home = path.join(salida, "hf-home");
  const res = {};
  for (const [nombre, dir] of [["referencia", dirRef], ["candidata", dirCand]]) {
    const r = await renderizar(motor, dir, path.join(salida, `${nombre}.mp4`), home);
    res[nombre] = { dir, segundos: r.segundos, avisosCheck: r.check.avisos };
    console.error(`${nombre}: ${r.segundos} s`);
  }
  return ssimYInforme(motor, salida, umbral, res);
}

/** Renderiza solo la candidata y la compara con un mp4 congelado (referencia GSAP): mismo `Informe` que `comparar`. */
export async function compararContraReferencia(motor, mp4Ref, dirCand, salida, umbral = 0.99) {
  fs.mkdirSync(salida, { recursive: true });
  const r = await renderizar(motor, dirCand, path.join(salida, "candidata.mp4"), path.join(salida, "hf-home"));
  fs.copyFileSync(mp4Ref, path.join(salida, "referencia.mp4"));
  return ssimYInforme(motor, salida, umbral, { candidata: { dir: dirCand, segundos: r.segundos, avisosCheck: r.check.avisos } });
}

/**
 * SSIM por fotograma entre dos directorios de PNG (`frame_%06d.png`, salida de `renderizar(..., { png: true })`): mide
 * la composición sin pasar por x264, que recuantiza el grano ante cualquier cambio de píxel (SEO-112). Mismo informe que
 * `comparar`; exige el mismo número de PNG en los dos lados.
 */
export async function ssimPng(motor, pngRef, pngCand, salida, umbral = 0.99) {
  fs.mkdirSync(salida, { recursive: true });
  const { ejecutar } = await dist("proceso.js");
  const cuenta = (d) => fs.readdirSync(d).filter((f) => /^frame_\d+\.png$/.test(f)).length;
  const [nRef, nCand] = [cuenta(pngRef), cuenta(pngCand)];
  const log = path.join(salida, "ssim.log");
  fs.rmSync(log, { force: true });
  // Rutas absolutas en -i; el stats_file va relativo al cwd (ffmpeg en Windows no admite `C:` dentro de un filtro).
  const r = await ejecutar(
    path.join(motor, "ffmpeg", "ffmpeg.exe"),
    ["-hide_banner", "-v", "error", "-framerate", "30", "-i", path.join(pngRef, "frame_%06d.png"), "-framerate", "30", "-i", path.join(pngCand, "frame_%06d.png"), "-lavfi", "[0:v][1:v]ssim=stats_file=ssim.log", "-f", "null", "-"],
    { cwd: salida, timeoutMs: 1_800_000 },
  );
  if (r.code !== 0) throw new Error(`ssim png: ${r.stderr}`);
  const v = veredicto(leerSsim(fs.readFileSync(log, "utf8")), umbral);
  const informe = { umbral, fotogramasReferencia: nRef, fotogramasCandidata: nCand, ...v, ok: v.ok && nRef === nCand };
  fs.writeFileSync(path.join(salida, "comparacion.json"), JSON.stringify(informe, null, 2));
  return informe;
}

/** Renderiza las dos composiciones a PNG y las compara (modo `--png` de la CLI). */
export async function compararPng(motor, dirRef, dirCand, salida, umbral = 0.99) {
  const pngRef = path.join(salida, "png-referencia");
  fs.rmSync(pngRef, { recursive: true, force: true });
  await renderizar(motor, dirRef, pngRef, path.join(salida, "hf-home"), { png: true });
  try {
    return await compararPngContraReferencia(motor, pngRef, dirCand, salida, umbral);
  } finally {
    fs.rmSync(pngRef, { recursive: true, force: true });
  }
}

/** Renderiza `dirCand` a PNG y lo compara con un directorio de PNG de referencia ya renderizado (`renderizar` con `png`). */
export async function compararPngContraReferencia(motor, pngRef, dirCand, salida, umbral = 0.99) {
  fs.mkdirSync(salida, { recursive: true });
  const pngCand = path.join(salida, "png-candidata");
  fs.rmSync(pngCand, { recursive: true, force: true });
  const r = await renderizar(motor, dirCand, pngCand, path.join(salida, "hf-home"), { png: true });
  try {
    return { ...(await ssimPng(motor, pngRef, pngCand, salida, umbral)), candidata: { dir: dirCand, segundos: r.segundos, avisosCheck: r.check.avisos } };
  } finally {
    fs.rmSync(pngCand, { recursive: true, force: true });
  }
}

async function ssimYInforme(motor, salida, umbral, res) {
  const { ejecutar } = await dist("proceso.js");
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
    console.error("Uso: node scripts/comparar-fotogramas.mjs <video-engine> <dirRef> <dirCand> <salida> [--umbral 0.99] [--png]");
    process.exit(2);
  }
  const comparador = process.argv.includes("--png") ? compararPng : comparar;
  const informe = await comparador(path.resolve(motor), path.resolve(ref), path.resolve(cand), path.resolve(salida), umbral);
  const { referencia, candidata, ...resumen } = informe;
  console.log(JSON.stringify(resumen, null, 2));
  process.exit(informe.ok ? 0 : 1);
}
