// Lanzar procesos sin shell y localizar ffmpeg/ffprobe.
import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./log.js";

export interface Resultado {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function ejecutar(
  comando: string,
  args: string[],
  opciones: SpawnOptions & { onLinea?: (linea: string) => void; timeoutMs?: number } = {},
): Promise<Resultado> {
  const { onLinea, timeoutMs, ...spawnOpts } = opciones;
  return new Promise((resolve, reject) => {
    const hijo = spawn(comando, args, { ...spawnOpts, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    if (timeoutMs) temporizador = setTimeout(() => hijo.kill(), timeoutMs);
    hijo.on("error", (e) => {
      if (temporizador) clearTimeout(temporizador);
      reject(e);
    });
    hijo.on("close", (code) => {
      if (temporizador) clearTimeout(temporizador);
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

export const MENSAJE_SIN_FFMPEG =
  "No encuentro ffmpeg ni ffprobe. Instálalos con `winget install --id Gyan.FFmpeg -e` y reinicia Claude Desktop, " +
  "o pon en .env FFMPEG_DIR=<carpeta bin de ffmpeg>.";

export function requerirFfmpeg(ffmpegDir?: string): Herramientas {
  const h = herramientasFfmpeg(ffmpegDir);
  if (!h) throw new Error(MENSAJE_SIN_FFMPEG);
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
