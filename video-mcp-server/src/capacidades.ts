// Prueba de GPU/WebGPU (cacheada en STATE_DIR/capacidades.json) y versiones de las herramientas.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SERVER_ROOT } from "./raiz.js";
import { STATE_DIR } from "./estado.js";
import { log } from "./log.js";
import { ejecutar, entornoConFfmpeg, type Herramientas } from "./proceso.js";
import { HYPERFRAMES_BIN } from "./musica.js";
import { FONDOS, FONDOS_WEBGPU } from "./formato.js";

const CACHE = path.join(STATE_DIR, "capacidades.json");
const SHADERS_JS = path.join(SERVER_ROOT, "plantilla", "vendor", "shaders.iife.js");
const GSAP_JS = path.join(SERVER_ROOT, "node_modules", "gsap", "dist", "gsap.min.js");

export interface PruebaGpu {
  webgpu: boolean;
  fecha: string;
  luminancia?: number;
  detalle: string;
}

export function gpuForzadaApagada(): boolean {
  return process.env.VIDEO_FORZAR_SIN_GPU === "1";
}

export function leerPruebaGpu(): PruebaGpu | undefined {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8")) as PruebaGpu;
  } catch {
    return undefined;
  }
}

// Última prueba fallida de este proceso (no se guarda en disco): evita que cada render repita los
// 240 s de una prueba que falla siempre; el siguiente arranque del motor (o reprobar) la reintenta.
let fallidaEnEsteProceso: PruebaGpu | undefined;

/** ¿Se pueden usar fondos WebGPU? Usa la prueba cacheada; si no hay, la hace. */
export async function hayWebgpu(h: Herramientas, browserPath?: string): Promise<boolean> {
  if (gpuForzadaApagada()) return false;
  const p = leerPruebaGpu() ?? fallidaEnEsteProceso ?? (await probarGpu(h, browserPath));
  return p.webgpu;
}

/**
 * Renderiza 1 s de `aurora` con --browser-gpu en una carpeta temporal y mira el fotograma del medio:
 * hay WebGPU si el render termina y la imagen no es negra (luminancia media > 8).
 */
export async function probarGpu(h: Herramientas, browserPath?: string): Promise<PruebaGpu> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-gpu-"));
  const fecha = new Date().toISOString();
  let resultado: PruebaGpu;
  try {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(dir, "compositions"), { recursive: true });
    fs.copyFileSync(GSAP_JS, path.join(dir, "assets", "gsap.min.js"));
    fs.copyFileSync(SHADERS_JS, path.join(dir, "assets", "shaders.iife.js"));
    fs.writeFileSync(
      path.join(dir, "compositions", "fondo.html"),
      `<!doctype html><html><head><meta charset="utf-8" /><style>[data-composition-id="fondo"] canvas{position:absolute;inset:0;width:540px;height:960px;display:block;background:#000}</style></head><body>
<div id="fondo" data-composition-id="fondo" data-start="0" data-duration="1" data-width="540" data-height="960" data-requires-webgpu data-no-timeline style="position:relative;width:540px;height:960px;overflow:hidden;background:#000">
<canvas data-shader="Aurora" width="540" height="960"></canvas></div><script src="assets/shaders.iife.js"></script></body></html>`,
    );
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><script src="assets/gsap.min.js"></script>
<style>*{margin:0;padding:0}html,body{width:540px;height:960px;overflow:hidden;background:#000}#root{position:relative;width:540px;height:960px;overflow:hidden}</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="540" data-height="960">
<div id="h-fondo" data-composition-id="fondo" data-composition-src="compositions/fondo.html" data-start="0" data-duration="1" data-track-index="1" data-no-timeline data-width="540" data-height="960" style="position:absolute;inset:0"></div>
</div><script>window.__timelines=window.__timelines||{};window.__timelines["main"]=gsap.timeline({paused:true});</script></body></html>`,
    );
    const env = entornoConFfmpeg(h, browserPath ? { HYPERFRAMES_BROWSER_PATH: browserPath } : {});
    const salida = path.join(dir, "gpu.mp4");
    const r = await ejecutar(process.execPath, [HYPERFRAMES_BIN, "render", dir, "-o", salida, "--browser-gpu", "--quiet"], { cwd: dir, env, timeoutMs: 240000 });
    if (r.code !== 0 || !fs.existsSync(salida)) {
      const motivo = (r.stderr + r.stdout).replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).filter((l) => /webgpu|gpu|failed|error/i.test(l)).slice(0, 3).join(" ");
      resultado = { webgpu: false, fecha, detalle: `El render de prueba con --browser-gpu falló. ${motivo}`.trim() };
    } else {
      const f = await ejecutar(h.ffmpeg, ["-v", "error", "-ss", "0.5", "-i", salida, "-frames:v", "1", "-vf", "scale=1:1,format=gray", "-f", "rawvideo", "pipe:1"], {
        timeoutMs: 30000,
      });
      if (f.code !== 0 || !f.stdout.length) {
        resultado = { webgpu: false, fecha, detalle: `No se pudo leer el fotograma del render de prueba. ${f.stderr.trim().slice(0, 200)}`.trim() };
      } else {
        const lum = f.stdout.charCodeAt(0);
        resultado = {
          webgpu: lum > 8,
          fecha,
          luminancia: lum,
          detalle: lum > 8 ? "El shader de prueba (aurora) se pintó con la GPU." : "El render de prueba salió negro: WebGPU no pinta en esta máquina.",
        };
      }
    }
  } catch (e) {
    resultado = { webgpu: false, fecha, detalle: `No se pudo hacer la prueba: ${(e as Error).message}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log.info(`Prueba de GPU: webgpu=${resultado.webgpu} (${resultado.detalle})`);
  // Solo se guarda un resultado medido (con luminancia). Un fallo (render roto, timeout, fotograma
  // ilegible) puede ser pasajero: guardar webgpu=false apagaría los fondos WebGPU para siempre.
  if (resultado.luminancia === undefined) {
    fallidaEnEsteProceso = resultado;
    return resultado;
  }
  fallidaEnEsteProceso = undefined;
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(resultado, null, 2));
  } catch {
    /* sin caché */
  }
  return resultado;
}

async function primeraLinea(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const r = await ejecutar(cmd, args, { env, timeoutMs: 60000 });
    return (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

export interface Capacidades {
  gpu: PruebaGpu | undefined;
  gpuForzadaApagada: boolean;
  hyperframes?: string;
  ffmpeg?: string;
  chrome?: string;
  telemetria?: string;
  fondos: { disponibles: string[]; conWebgpu: string[]; usaranFallback: string[] };
}

export async function capacidades(h: Herramientas | null, reprobar: boolean, browserPath?: string): Promise<Capacidades> {
  let gpu = leerPruebaGpu();
  if (h && (reprobar || !gpu)) gpu = await probarGpu(h, browserPath);
  const env = entornoConFfmpeg(h);
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, "node_modules", "hyperframes", "package.json"), "utf8")) as { version: string };
  // Las tres sondas de versión van en paralelo: su peor caso es 60 s y no 180 s (lo cubre
  // TIMEOUT_CAPACIDADES del backend junto con los 270 s de probarGpu).
  // `telemetry status` imprime "Status: disabled" y "Source: config|HYPERFRAMES_NO_TELEMETRY|…".
  const [chromeRuta, tel, ffmpeg] = await Promise.all([
    primeraLinea(process.execPath, [HYPERFRAMES_BIN, "browser", "path"], env),
    ejecutar(process.execPath, [HYPERFRAMES_BIN, "telemetry", "status"], { env, timeoutMs: 60000 }).catch(() => undefined),
    h ? primeraLinea(h.ffmpeg, ["-version"]) : Promise.resolve(undefined),
  ]);
  const salidaTel = tel?.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const estadoTel = /Status:\s*(\S+)/.exec(salidaTel ?? "")?.[1];
  const origenTel = /Source:\s*(\S+)/.exec(salidaTel ?? "")?.[1];
  const telemetria = estadoTel ? `${estadoTel === "disabled" ? "desactivada" : estadoTel}${origenTel ? ` (${origenTel})` : ""}` : undefined;
  const conGpu = !!gpu?.webgpu && !gpuForzadaApagada();
  return {
    gpu,
    gpuForzadaApagada: gpuForzadaApagada(),
    hyperframes: pkg.version,
    ffmpeg,
    chrome: chromeRuta,
    telemetria: telemetria ? `${telemetria}${process.env.HYPERFRAMES_NO_TELEMETRY === "1" ? " · y HYPERFRAMES_NO_TELEMETRY=1 en el servidor" : ""}` : undefined,
    fondos: {
      disponibles: [...FONDOS],
      conWebgpu: [...FONDOS_WEBGPU],
      usaranFallback: conGpu ? [] : [...FONDOS_WEBGPU],
    },
  };
}
