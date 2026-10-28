// Lanzar procesos sin shell y localizar ffmpeg/ffprobe.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./log.js";

const TIMEOUT_TASKKILL_MS = 10_000;

/** true si el motor corre integrado como hijo del backend de SEO Studio (la configuración viene de la aplicación, no de un .env). */
export const esIntegrado = (env: NodeJS.ProcessEnv = process.env): boolean => env.VIDEO_ENGINE_EMBEDDED === "1";

export interface Resultado {
  code: number | null;
  stdout: string;
  stderr: string;
  /** true si el proceso se mató (con todo su árbol) por superar `timeoutMs`; entonces `code` es null. */
  timeout?: boolean;
}

/**
 * Mata el proceso y todos sus descendientes (el CLI de HyperFrames lanza Chrome, y `hijo.kill()` solo
 * mata a Node). Resuelve cuando el intento de matar ha terminado.
 * Windows: `taskkill /T /F`. Otros SO: el hijo es líder de su grupo (detached) y se señala al grupo entero.
 */
function matarArbol(hijo: ChildProcess): Promise<void> {
  const pid = hijo.pid;
  if (!pid) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const t = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      t.on("error", (e) => {
        log.warn(`taskkill falló para el pid ${pid}: ${e.message}`);
        resolve();
      });
      // Un taskkill colgado no debe colgar el trabajo.
      const corte = setTimeout(() => {
        log.warn(`taskkill no terminó a tiempo para el pid ${pid}.`);
        t.kill();
      }, TIMEOUT_TASKKILL_MS);
      t.on("close", (code) => {
        clearTimeout(corte);
        // 128 = "proceso no encontrado": ya estaba muerto. Cualquier otro fallo con el hijo vivo: matar al menos a Node.
        if (code !== 0 && code !== 128 && hijo && hijo.exitCode === null) hijo.kill();
        resolve();
      });
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    log.warn(`No pude matar el grupo de procesos ${pid}: ${(e as Error).message}`);
  }
  return Promise.resolve();
}

export function ejecutar(
  comando: string,
  args: string[],
  opciones: SpawnOptions & { onLinea?: (linea: string) => void; timeoutMs?: number } = {},
): Promise<Resultado> {
  const { onLinea, timeoutMs, ...spawnOpts } = opciones;
  return new Promise((resolve, reject) => {
    // detached (solo fuera de Windows): el hijo lidera su grupo y se puede matar todo el árbol con process.kill(-pid).
    const hijo = spawn(comando, args, {
      ...spawnOpts,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let terminado = false;
    let vencido = false;
    let stdout = "";
    let stderr = "";
    let resto = "";
    const trocear = (texto: string) => {
      if (!onLinea) return;
      const partes = (resto + texto).split(/\r?\n|\r/);
      resto = partes.pop() ?? "";
      for (const p of partes) if (p.trim()) onLinea(p);
    };
    hijo.stdout?.on("data", (d: Buffer) => {
      const t = d.toString("utf8");
      stdout += t;
      trocear(t);
    });
    hijo.stderr?.on("data", (d: Buffer) => {
      const t = d.toString("utf8");
      stderr += t;
      trocear(t);
    });
    let temporizador: NodeJS.Timeout | undefined;
    if (timeoutMs) {
      temporizador = setTimeout(() => {
        vencido = true;
        // Se resuelve solo cuando el árbol ya está muerto: así el llamador no sigue con Chrome vivo.
        void matarArbol(hijo).then(() => {
          if (terminado) return;
          terminado = true;
          if (onLinea && resto.trim()) onLinea(resto);
          resolve({ code: null, stdout, stderr, timeout: true });
        });
      }, timeoutMs);
    }
    hijo.on("error", (e) => {
      if (temporizador) clearTimeout(temporizador);
      if (terminado) return;
      terminado = true;
      reject(e);
    });
    hijo.on("close", (code) => {
      // Si venció el timeout, resuelve el temporizador cuando taskkill/kill haya terminado (el código de salida sería el de la muerte forzada).
      if (vencido) return;
      if (temporizador) clearTimeout(temporizador);
      if (terminado) return;
      terminado = true;
      if (onLinea && resto.trim()) onLinea(resto);
      resolve({ code, stdout, stderr });
    });
  });
}

const EXE = process.platform === "win32" ? ".exe" : "";

function existe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Busca la carpeta que contiene ffmpeg y ffprobe: FFMPEG_DIR, PATH y, en Windows, la instalación de winget. */
export function localizarFfmpegDir(ffmpegDir?: string): string | undefined {
  const candidatos: string[] = [];
  if (ffmpegDir) candidatos.push(ffmpegDir);
  for (const p of (process.env.PATH ?? "").split(path.delimiter)) if (p) candidatos.push(p);
  if (process.platform === "win32") {
    const paquetes = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Microsoft", "WinGet", "Packages");
    try {
      for (const d of fs.readdirSync(paquetes)) {
        if (!/ffmpeg/i.test(d)) continue;
        const base = path.join(paquetes, d);
        for (const sub of fs.readdirSync(base)) candidatos.push(path.join(base, sub, "bin"));
      }
    } catch {
      /* sin winget */
    }
  }
  return candidatos.find((d) => existe(path.join(d, `ffmpeg${EXE}`)) && existe(path.join(d, `ffprobe${EXE}`)));
}

export interface Herramientas {
  ffmpeg: string;
  ffprobe: string;
  dir: string;
}

let cache: Herramientas | null | undefined;

export function herramientasFfmpeg(ffmpegDir?: string): Herramientas | null {
  if (cache !== undefined) return cache;
  const dir = localizarFfmpegDir(ffmpegDir);
  cache = dir ? { dir, ffmpeg: path.join(dir, `ffmpeg${EXE}`), ffprobe: path.join(dir, `ffprobe${EXE}`) } : null;
  if (cache) log.info(`ffmpeg encontrado en ${dir}`);
  else log.warn("No encuentro ffmpeg/ffprobe (ni en FFMPEG_DIR, ni en el PATH, ni en winget). El render y video_fotograma no funcionarán.");
  return cache;
}

export function mensajeSinFfmpeg(): string {
  return esIntegrado()
    ? "Falta ffmpeg en la instalación de SEO Studio; reinstala la aplicación."
    : "No encuentro ffmpeg ni ffprobe. Instálalos con `winget install --id Gyan.FFmpeg -e` y reinicia Claude Desktop, " +
        "o pon en .env FFMPEG_DIR=<carpeta bin de ffmpeg>.";
}

export function requerirFfmpeg(ffmpegDir?: string): Herramientas {
  const h = herramientasFfmpeg(ffmpegDir);
  if (!h) throw new Error(mensajeSinFfmpeg());
  return h;
}

/** Entorno para procesos hijos con ffmpeg al principio del PATH. */
export function entornoConFfmpeg(h: Herramientas | null, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (h) {
    const clave = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[clave] = `${h.dir}${path.delimiter}${env[clave] ?? ""}`;
  }
  return env;
}

export interface InfoMedio {
  duracion?: number;
  ancho?: number;
  alto?: number;
  codecVideo?: string;
  tieneAudio: boolean;
  fps?: number;
}

export async function sondear(ffprobe: string, archivo: string): Promise<InfoMedio> {
  const r = await ejecutar(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", archivo], { timeoutMs: 30000 });
  if (r.code !== 0) throw new Error(`ffprobe no puede leer ${path.basename(archivo)}: ${r.stderr.trim().slice(0, 300)}`);
  const j = JSON.parse(r.stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const video = j.streams?.find((s) => s.codec_type === "video");
  let fps: number | undefined;
  if (video?.r_frame_rate) {
    const [a, b] = video.r_frame_rate.split("/").map(Number);
    if (a && b) fps = a / b;
  }
  const dur = j.format?.duration ? Number(j.format.duration) : undefined;
  return {
    duracion: dur !== undefined && Number.isFinite(dur) ? dur : undefined,
    ancho: video?.width,
    alto: video?.height,
    codecVideo: video?.codec_name,
    tieneAudio: !!j.streams?.some((s) => s.codec_type === "audio"),
    fps,
  };
}
