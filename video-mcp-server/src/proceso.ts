// Lanzar procesos sin shell, con entorno por lista blanca, y localizar ffmpeg/ffprobe.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./log.js";
import { STATE_DIR } from "./estado.js";
// Ciclo de imports con musica.ts: HYPERFRAMES_BIN solo se lee dentro de ejecutar(), nunca al cargar.
import { HYPERFRAMES_BIN } from "./musica.js";

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

// ---------- Entorno de los hijos (I5) y modo cerrado de HyperFrames (I13) ----------

/** Variables de I13: sin comprobación de actualizaciones, instalaciones, telemetría ni skills. */
export const VARIABLES_CERRADO: Readonly<Record<string, "1">> = Object.freeze({
  CI: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  HYPERFRAMES_NO_AUTO_INSTALL: "1",
  HYPERFRAMES_NO_OPTIONAL_INSTALL: "1",
  HYPERFRAMES_NO_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
  HYPERFRAMES_SKIP_SKILLS: "1",
});

/**
 * Lista blanca del entorno de los hijos (I5). HYPERFRAMES_FFMPEG_PATH/FFPROBE_PATH fijan por ruta el
 * ffmpeg del bundle: sin ellas HyperFrames buscaría primero en su cwd y en el PATH (I4).
 * Defensa en profundidad frente a fugas; no es frontera frente a un hijo sin sandbox comprometido.
 */
export const CLAVES_PERMITIDAS: ReadonlySet<string> = new Set([
  "PATH",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  ...Object.keys(VARIABLES_CERRADO),
  "HYPERFRAMES_BROWSER_PATH",
  "HYPERFRAMES_FFMPEG_PATH",
  "HYPERFRAMES_FFPROBE_PATH",
]);

/** `<SYSTEMROOT>\System32`; sin SYSTEMROOT en Windows no se lanza nada (no se adivina la carpeta). */
function system32(): string {
  const raiz = process.env.SYSTEMROOT?.trim();
  if (!raiz) throw new Error("Falta la variable SYSTEMROOT: no puedo localizar las herramientas de Windows.");
  return path.join(raiz, "System32");
}

const mismaRuta = (a: string, b: string): boolean =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/**
 * HOME de los hijos: `<estado>/video/hf-home` integrado (VIDEO_STATE_DIR = `<estado>/video/estado`), o
 * `<STATE_DIR>/hf-home` en desarrollo. La crea y falla si es un enlace o una unión, o si en su raíz hay
 * un .env (la CLI lo aplicaría) o un ejecutable (HyperFrames busca ffmpeg en su cwd).
 */
export function hfHome(env: NodeJS.ProcessEnv = process.env): string {
  const dir = esIntegrado(env) ? path.resolve(STATE_DIR, "..", "hf-home") : path.join(STATE_DIR, "hf-home");
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink() || !mismaRuta(fs.realpathSync.native(dir), dir)) {
    throw new Error(`La carpeta hf-home del motor (${dir}) es un enlace: no la uso.`);
  }
  const sobra = fs.readdirSync(dir).find((n) => n.toLowerCase() === ".env" || /\.(exe|com|bat|cmd)$/i.test(n));
  if (sobra) throw new Error(`La carpeta hf-home del motor (${dir}) contiene ${sobra}, que no debería estar ahí: bórralo.`);
  return dir;
}

/**
 * Entorno de todo hijo del motor, construido desde cero: nunca copia process.env (hallazgo C2). Lleva
 * las variables de I13, HOME/USERPROFILE en hf-home y un PATH mínimo.
 */
export function entornoHijo(): NodeJS.ProcessEnv {
  const h = herramientasFfmpeg(process.env.FFMPEG_DIR);
  const home = hfHome();
  const env: NodeJS.ProcessEnv = { ...VARIABLES_CERRADO, HOME: home, USERPROFILE: home };
  for (const k of ["TEMP", "TMP"] as const) if (process.env[k]) env[k] = process.env[k];
  if (process.platform === "win32") {
    const sys = system32();
    env.SYSTEMROOT = path.dirname(sys);
    // PowerShell en el PATH: el vigilante de Chrome de HyperFrames lanza `powershell.exe` por nombre.
    env.PATH = [h?.dir, sys, path.join(sys, "WindowsPowerShell", "v1.0")].filter(Boolean).join(path.delimiter);
  } else {
    env.PATH = [h?.dir, "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter);
  }
  if (h) {
    env.HYPERFRAMES_FFMPEG_PATH = h.ffmpeg;
    env.HYPERFRAMES_FFPROBE_PATH = h.ffprobe;
  }
  const navegador = process.env.HYPERFRAMES_BROWSER_PATH?.trim();
  if (navegador) env.HYPERFRAMES_BROWSER_PATH = navegador;
  return env;
}

// ponytail: se conserva la firma para capacidades.ts, herramientas.ts y musica.ts; `ejecutar` descarta
// cualquier env, así que lo que devuelve esto solo sirve de referencia.
export function entornoConFfmpeg(_h?: Herramientas | null, _extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return entornoHijo();
}

// ---------- Navegador del motor (I4, parte motor) ----------

export class ErrorNavegador extends Error {}

export const FALTA_NAVEGADOR = "Falta el navegador del motor de vídeo: descárgalo en Ajustes.";

/** Antes de cada invocación de la CLI (nunca al arrancar: el motor arranca sin CfT descargado). */
export async function verificarNavegador(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const navegador = env.HYPERFRAMES_BROWSER_PATH?.trim();
  if (!navegador || !existe(navegador)) throw new ErrorNavegador(FALTA_NAVEGADOR);
}

// ---------- Lanzar procesos ----------

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
      // Si taskkill falla, no se puede dejar vivo ni a Node (y con él a Chrome): se mata al menos al hijo directo.
      const respaldo = () => {
        if (hijo.exitCode === null) hijo.kill();
      };
      let t: ChildProcess;
      try {
        // Por ruta absoluta: nunca un taskkill.exe del cwd o del PATH.
        t = spawn(path.join(system32(), "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
          env: entornoHijo(),
        });
      } catch (e) {
        log.warn(`No pude lanzar taskkill para el pid ${pid}: ${(e as Error).message}`);
        respaldo();
        resolve();
        return;
      }
      // Un taskkill colgado no debe colgar el trabajo.
      const corte = setTimeout(() => {
        log.warn(`taskkill no terminó a tiempo para el pid ${pid}.`);
        t.kill();
        respaldo();
        resolve();
      }, TIMEOUT_TASKKILL_MS);
      t.on("error", (e) => {
        clearTimeout(corte);
        log.warn(`taskkill falló para el pid ${pid}: ${e.message}`);
        respaldo();
        resolve();
      });
      t.on("close", (code) => {
        clearTimeout(corte);
        // 128 = "proceso no encontrado": ya estaba muerto.
        if (code !== 0 && code !== 128) respaldo();
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

export type OpcionesEjecutar = Omit<SpawnOptions, "env" | "shell" | "stdio" | "detached"> & {
  onLinea?: (linea: string) => void;
  timeoutMs?: number;
  /** Se acepta por compatibilidad y se descarta: el entorno de todo hijo es entornoHijo() (I5, I13). */
  env?: NodeJS.ProcessEnv;
};

/** true si la llamada es la CLI de HyperFrames: el script empaquetado o cualquier Node como comando. */
function esLlamadaCli(comando: string, args: string[]): boolean {
  return args[0] === HYPERFRAMES_BIN || /^node(\.exe)?$/i.test(path.basename(comando));
}

// Candado en memoria: las invocaciones de la CLI de HyperFrames van de una en una dentro del proceso.
let colaCli: Promise<unknown> = Promise.resolve();

/**
 * Único punto por el que el motor lanza procesos: sin shell, argumentos en array y con el entorno
 * construido desde cero (I5). Si es la CLI de HyperFrames, además: solo con el Node del motor, modo
 * cerrado y HOME/cwd en hf-home (I13), navegador comprobado antes de lanzar (I4) y en serie.
 */
export function ejecutar(comando: string, args: string[], opciones: OpcionesEjecutar = {}): Promise<Resultado> {
  if (!esLlamadaCli(comando, args)) return lanzar(comando, args, opciones);
  if (!mismaRuta(comando, process.execPath)) {
    return Promise.reject(new Error(`La CLI de HyperFrames solo se lanza con el Node del motor (${process.execPath}), no con ${comando}.`));
  }
  const turno = colaCli.then(async () => {
    await verificarNavegador();
    // cwd fijo: la CLI aplica el .env de su cwd a su entorno (cli.js), y busca ffmpeg en él.
    return lanzar(comando, args, { ...opciones, cwd: hfHome() });
  });
  colaCli = turno.catch(() => undefined);
  return turno;
}

function lanzar(comando: string, args: string[], opciones: OpcionesEjecutar): Promise<Resultado> {
  const { onLinea, timeoutMs, env: _descartado, ...spawnOpts } = opciones;
  return new Promise((resolve, reject) => {
    // detached (solo fuera de Windows): el hijo lidera su grupo y se puede matar todo el árbol con process.kill(-pid).
    const hijo = spawn(comando, args, {
      ...spawnOpts,
      env: entornoHijo(),
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

// ---------- ffmpeg ----------

const EXE = process.platform === "win32" ? ".exe" : "";

function existe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Busca la carpeta que contiene ffmpeg y ffprobe: FFMPEG_DIR, PATH y, en Windows, la instalación de winget.
 * Integrado, solo FFMPEG_DIR (el ffmpeg LGPL del bundle): uno del usuario podría ser GPL (libx264).
 */
export function localizarFfmpegDir(ffmpegDir?: string): string | undefined {
  const candidatos: string[] = [];
  if (ffmpegDir) candidatos.push(ffmpegDir);
  if (!esIntegrado()) for (const p of (process.env.PATH ?? "").split(path.delimiter)) if (p) candidatos.push(p);
  if (process.platform === "win32" && !esIntegrado()) {
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
