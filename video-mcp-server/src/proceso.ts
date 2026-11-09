// Lanzar procesos sin shell, con entorno por lista blanca, y localizar ffmpeg/ffprobe.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./log.js";
import { STATE_DIR } from "./estado.js";
import { SERVER_ROOT } from "./raiz.js";
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
  /** Solo con `salidaBinaria`: la salida estándar tal cual, sin pasar por UTF-8. */
  salida?: Buffer;
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

const normalizarRuta = (p: string): string => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
const mismaRuta = (a: string, b: string): boolean => normalizarRuta(a) === normalizarRuta(b);

/**
 * ¿Algún tramo de la ruta (ella o un padre) es un enlace o una junction? No se compara con realpath: da el
 * nombre largo, y una ruta 8.3 (`C:\Users\RUNNER~1\…`, habitual en %TEMP%) parecería un enlace sin serlo.
 * En cada tramo se mira lstat y, además, su entrada en el listado del padre: lstat no marca las junctions a
 * `\??\Volume{GUID}\…` (las crea `mklink /J` sin privilegios), y el Dirent sí, porque mira el atributo de
 * reparse point (revisión post-R2, H1). Un tramo 8.3 no aparece por su nombre en el listado: se busca su
 * entrada larga por identificador de fichero, y si no aparece, falla cerrado. Solo rutas locales con letra de
 * unidad: se exige la forma buena en vez de buscar las malas, porque UNC, dispositivo, `\?\Volume{…}` o
 * `GLOBALROOT` admiten barras de los dos tipos (revisión post-R2, Low-2). Las carpetas del motor siempre son locales.
 */
export function pasaPorEnlace(ruta: string): boolean {
  const sinPrefijo = sinPrefijoLargo(ruta);
  const inicio = path.resolve(sinPrefijo);
  // Con prefijo \\?\, lo que queda tiene que llevar letra de unidad (\\?\GLOBALROOT\… quedaría relativa).
  const conPrefijo = sinPrefijo !== ruta;
  if (/^[\\/]/.test(sinPrefijo) || (conPrefijo && !/^[A-Za-z]:[\\/]/.test(sinPrefijo)) || !/^[A-Za-z]:\\/.test(inicio)) {
    throw new Error(`Ruta de red o de dispositivo, no la uso: ${ruta}`);
  }
  for (let d = inicio; ; ) {
    if (fs.lstatSync(d).isSymbolicLink()) return true;
    const padre = path.dirname(d);
    if (padre === d) return false;
    const nombre = path.basename(d).toLowerCase();
    const entradas = fs.readdirSync(padre, { withFileTypes: true });
    const entrada = entradas.find((e) => e.name.toLowerCase() === nombre);
    if (!entrada) {
      const id = fs.lstatSync(d, { bigint: true }).ino;
      const mismoId = (e: fs.Dirent) => {
        try {
          return fs.lstatSync(path.join(padre, e.name), { bigint: true }).ino === id;
        } catch {
          return false; // ilegible (p. ej. un fichero del sistema bloqueado): no es el tramo buscado
        }
      };
      // Todas las que comparten identificador, no la primera: lstat atraviesa una junction a Volume{GUID}, así
      // que la junction y su destino (si está en la misma carpeta) dan el mismo; basta con que una sea enlace.
      const iguales = entradas.filter(mismoId);
      if (!iguales.length) throw new Error(`No encuentro ${d} en el listado de su carpeta: no puedo comprobar si es un enlace.`);
      if (iguales.some((e) => e.isSymbolicLink())) return true;
    } else if (entrada.isSymbolicLink()) return true;
    d = padre;
  }
}
const dentroDe = (p: string, base?: string): boolean =>
  !!base?.trim() && (mismaRuta(p, base) || normalizarRuta(p).startsWith(normalizarRuta(base).replace(/[\\/]+$/, "") + path.sep));

/**
 * `<SYSTEMROOT>\System32`, del que salen taskkill y PowerShell. SYSTEMROOT tiene que ser una ruta
 * absoluta local (con letra de unidad, no UNC), fuera del perfil del usuario y coherente con `windir`;
 * si no, no se lanza nada (no se adivina la carpeta ni se ejecuta un taskkill plantado).
 */
export function system32(env: NodeJS.ProcessEnv = process.env): string {
  const raiz = env.SYSTEMROOT?.trim();
  if (!raiz) throw new Error("Falta la variable SYSTEMROOT: no puedo localizar las herramientas de Windows.");
  const valida =
    /^[A-Za-z]:[\\/]/.test(raiz) &&
    !dentroDe(raiz, env.USERPROFILE) &&
    !dentroDe(raiz, env.LOCALAPPDATA) &&
    (!env.windir?.trim() || mismaRuta(env.windir, raiz));
  if (!valida) throw new Error(`SYSTEMROOT no es una carpeta de Windows válida (${raiz}): no lanzo herramientas del sistema.`);
  return path.join(path.resolve(raiz), "System32");
}

/**
 * HOME de los hijos: `<estado>/video/hf-home` integrado (VIDEO_STATE_DIR = `<estado>/video/estado`), o
 * `<STATE_DIR>/hf-home` en desarrollo. La crea y falla si es un enlace o una unión, o si en su raíz hay
 * un .env (la CLI lo aplicaría) o un ejecutable (HyperFrames busca ffmpeg en su cwd).
 */
export function hfHome(env: NodeJS.ProcessEnv = process.env): string {
  const dir = esIntegrado(env) ? path.resolve(STATE_DIR, "..", "hf-home") : path.join(STATE_DIR, "hf-home");
  fs.mkdirSync(dir, { recursive: true });
  if (pasaPorEnlace(dir)) {
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

// ---------- Navegador del motor (I4, parte motor) ----------

export class ErrorNavegador extends Error {}

export const FALTA_NAVEGADOR = "Falta el navegador del motor de vídeo: descárgalo en Ajustes.";

const NOMBRE_MANIFIESTO = "MANIFIESTO-SHA256.json";
const EXE_NAVEGADOR = "chrome-headless-shell-win64/chrome-headless-shell.exe";
/**
 * Chrome escribe este log junto a su exe en cada ejecución (medido en el render real): es la única
 * excepción al «exactamente el manifiesto», solo en esa ruta y solo si es un fichero normal (recorrer()
 * ya rechaza enlaces). No es código: nadie lo carga.
 */
const LOG_CHROME = "chrome-headless-shell-win64/debug.log";

/** Quita el prefijo `\\?\` de Windows (rutas largas) para poder comparar rutas. */
const sinPrefijoLargo = (p: string): string => p.replace(/^\\\\\?\\/, "");

/** Clave de comparación de una ruta relativa del manifiesto (NTFS no distingue mayúsculas). */
const claveRel = (rel: string): string => (process.platform === "win32" ? rel.toLowerCase() : rel);

const rutaRelativaValida = (rel: string): boolean =>
  !!rel && !rel.includes("\\") && !rel.includes(":") && !rel.startsWith("/") && !rel.split("/").some((p) => p === ".." || p === "." || p === "");

function sha256(fichero: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(fichero)
      .on("error", reject)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Ficheros regulares bajo `raiz` (rutas relativas con `/`); lanza ante enlaces, uniones u otros tipos. */
function recorrer(raiz: string, rel = ""): string[] {
  const salida: string[] = [];
  for (const e of fs.readdirSync(path.join(raiz, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    // En Windows las uniones (junctions) también se ven como enlaces simbólicos.
    if (e.isSymbolicLink()) throw new Error(`${r} es un enlace`);
    if (e.isDirectory()) salida.push(...recorrer(raiz, r));
    else if (e.isFile()) salida.push(r);
    else throw new Error(`${r} no es un fichero normal`);
  }
  return salida;
}

/**
 * I4 (parte motor), antes de cada invocación de la CLI y nunca al arrancar (el motor arranca sin CfT
 * descargado). Integrado exige HYPERFRAMES_BROWSER_PATH y VIDEO_NAVEGADOR_MANIFIESTO (interfaz fijada
 * con el backend). Con manifiesto, el conjunto de ficheros bajo su carpeta tiene que ser exactamente
 * el del manifiesto y cada SHA-256 coincidir; sin enlaces y en la ruta fija. En desarrollo sin
 * manifiesto, basta con que el navegador exista.
 */
export async function verificarNavegador(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const navegador = env.HYPERFRAMES_BROWSER_PATH?.trim();
  const manifiesto = env.VIDEO_NAVEGADOR_MANIFIESTO?.trim();
  if (!navegador || !existe(navegador) || (esIntegrado(env) && !manifiesto)) throw new ErrorNavegador(FALTA_NAVEGADOR);
  if (!manifiesto) return;
  if (!existe(manifiesto)) throw new ErrorNavegador(FALTA_NAVEGADOR);
  const fallo = (motivo: string) =>
    new ErrorNavegador(`El navegador del motor de vídeo no supera la comprobación (${motivo}): vuelve a descargarlo en Ajustes.`);

  let m: { version?: unknown; ficheros?: unknown };
  try {
    m = JSON.parse(fs.readFileSync(manifiesto, "utf8")) as typeof m;
  } catch {
    throw fallo("el manifiesto no es JSON válido");
  }
  if (typeof m.version !== "string" || !m.version.trim()) throw fallo("el manifiesto no tiene versión");
  if (!m.ficheros || typeof m.ficheros !== "object" || Array.isArray(m.ficheros) || !Object.keys(m.ficheros).length) {
    throw fallo("el manifiesto no lista ficheros");
  }
  const esperados = new Map<string, { rel: string; hash: string }>();
  for (const [rel, hash] of Object.entries(m.ficheros as Record<string, unknown>)) {
    if (!rutaRelativaValida(rel)) throw fallo(`ruta no válida en el manifiesto: ${rel}`);
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw fallo(`hash no válido para ${rel}`);
    if (esperados.has(claveRel(rel))) throw fallo(`${rel} aparece dos veces en el manifiesto`);
    esperados.set(claveRel(rel), { rel, hash });
  }

  // Ruta fija: sin enlaces en el camino, en <estado>/video/navegador/<versión> (integrado) y con el
  // exe exactamente en su sitio.
  const raiz = path.dirname(path.resolve(manifiesto));
  let enlace: boolean;
  try {
    enlace = pasaPorEnlace(raiz);
  } catch {
    throw fallo("no puedo resolver la carpeta del navegador");
  }
  if (enlace) throw fallo("la carpeta del navegador pasa por un enlace");
  if (esIntegrado(env) && !mismaRuta(path.dirname(raiz), path.resolve(STATE_DIR, "..", "navegador"))) {
    throw fallo("la carpeta del navegador no está donde la instala SEO Studio");
  }
  if (path.basename(raiz) !== m.version) throw fallo(`la carpeta no corresponde a la versión ${m.version}`);
  const relExe = path.relative(raiz, path.resolve(navegador)).split(path.sep).join("/");
  if (relExe !== EXE_NAVEGADOR) throw fallo("el ejecutable del navegador no está en su sitio");

  if (esperados.has(claveRel(LOG_CHROME))) throw fallo("el manifiesto lista el log de Chrome");
  let encontrados: string[];
  try {
    const todos = recorrer(raiz);
    const log = todos.find((r) => claveRel(r) === claveRel(LOG_CHROME));
    // Sin hash: un enlace duro dejaría cambiarlo desde fuera (como en el backend, I6).
    if (log && fs.lstatSync(path.join(raiz, ...log.split("/"))).nlink !== 1) throw new Error(`${LOG_CHROME} tiene otro enlace duro`);
    encontrados = todos.filter((r) => r !== NOMBRE_MANIFIESTO && r !== log);
  } catch (e) {
    throw fallo((e as Error).message);
  }
  const vistos = new Set<string>();
  for (const rel of encontrados) {
    const esperado = esperados.get(claveRel(rel));
    if (!esperado) throw fallo(`${rel} no está en el manifiesto`);
    vistos.add(claveRel(rel));
  }
  for (const [clave, { rel }] of esperados) if (!vistos.has(clave)) throw fallo(`falta ${rel}`);
  for (const rel of encontrados) {
    const { hash } = esperados.get(claveRel(rel))!;
    if ((await sha256(path.join(raiz, ...rel.split("/")))) !== hash) throw fallo(`${rel} no coincide con el manifiesto`);
  }
}

const HASHES_DIST = ["patches", "hyperframes+0.8.206.sha256.json"];
/** Sin estos, el JSON no prueba nada aunque cuadre: la entrada, el marcador de Chrome y el cierre de red (R0 M1). */
const OBLIGATORIOS_DIST = ["bin/hyperframes.mjs", "dist/cli.js", "dist/seo-studio-cierre.js", "dist/chunk-K4MJX7SR.js"];

/**
 * R2-M3: los ficheros parcheados de HyperFrames y su bin, contra los SHA-256 fijados, antes de cada CLI y también en
 * desarrollo. Detecta un bundle sin parche, una instalación rota, un antivirus y una versión cambiada. Es integridad,
 * no autenticidad: el JSON vive junto al dist y lo puede escribir cualquier proceso del usuario. Residual: los otros
 * 319 ficheros de dist/ y node_modules quedan sin hash, y entre comprobar y lanzar hay una ventana (aceptada, como I4).
 */
export async function verificarDist(raiz: string = SERVER_ROOT): Promise<void> {
  const fallo = (motivo: string) => new ErrorNavegador(`La instalación del motor de vídeo está incompleta (${motivo}): reinstala SEO Studio.`);
  const hf = path.join(raiz, "node_modules", "hyperframes");
  let version: unknown;
  let m: { version?: unknown; ficheros?: unknown; sinParche?: unknown };
  try {
    version = (JSON.parse(fs.readFileSync(path.join(hf, "package.json"), "utf8")) as { version?: unknown }).version;
    m = JSON.parse(fs.readFileSync(path.join(raiz, ...HASHES_DIST), "utf8")) as typeof m;
  } catch {
    throw fallo("no puedo leer la versión o los hashes del parche");
  }
  if (typeof m.version !== "string" || m.version !== version) throw fallo(`hyperframes ${String(version)} y los hashes de ${String(m.version)}`);
  const listas = [m.ficheros, m.sinParche];
  if (!listas.every((l) => !!l && typeof l === "object" && !Array.isArray(l) && Object.keys(l).length)) throw fallo("el JSON no lista ficheros");
  const esperados = Object.entries({ ...(m.ficheros as object), ...(m.sinParche as object) }) as [string, unknown][];
  for (const [rel, hash] of esperados) {
    if (!rutaRelativaValida(rel)) throw fallo(`ruta no válida: ${rel}`);
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw fallo(`hash no válido para ${rel}`);
  }
  for (const rel of OBLIGATORIOS_DIST) if (!esperados.some(([r]) => r === rel)) throw fallo(`el JSON no fija ${rel}`);
  for (const [rel, hash] of esperados) {
    const fichero = path.join(hf, ...rel.split("/"));
    if (!existe(fichero)) throw fallo(`falta ${rel}`);
    if ((await sha256(fichero)) !== hash) throw fallo(`${rel} no coincide`);
  }
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
  return matarArbolPosix(pid);
}

/** Pid de todos los descendientes de `pid` según la tabla (por `padre`). Pura; tolera ciclos y un pid desconocido. */
export function descendientes(pid: number, tabla: { pid: number; padre?: number }[]): number[] {
  const hijos = new Map<number, number[]>();
  for (const p of tabla) {
    if (p.padre === undefined) continue;
    hijos.set(p.padre, [...(hijos.get(p.padre) ?? []), p.pid]);
  }
  const vistos = new Set<number>([pid]);
  const cola = [pid];
  const salida: number[] = [];
  for (let actual = cola.shift(); actual !== undefined; actual = cola.shift()) {
    for (const h of hijos.get(actual) ?? []) {
      if (vistos.has(h)) continue;
      vistos.add(h);
      salida.push(h);
      cola.push(h);
    }
  }
  return salida;
}

/**
 * POSIX: Puppeteer lanza Chrome en su propio grupo, así que `kill(-pid)` no lo alcanza. Se lista el árbol antes de
 * matar (los huérfanos pasan a pid 1 y se perdería la relación), después el grupo y cada descendiente.
 */
async function matarArbolPosix(pid: number): Promise<void> {
  let desc: number[] = [];
  try {
    desc = descendientes(pid, await listarProcesos());
  } catch (e) {
    log.warn(`No pude listar los descendientes del pid ${pid}: ${(e as Error).message}`);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    log.warn(`No pude matar el grupo de procesos ${pid}: ${(e as Error).message}`);
  }
  for (const d of desc) {
    try {
      process.kill(d, "SIGKILL");
    } catch {
      /* ya muerto */
    }
  }
}

export type OpcionesEjecutar = Omit<SpawnOptions, "env" | "shell" | "stdio" | "detached"> & {
  onLinea?: (linea: string) => void;
  /** Obligatorio (I7): sin plazo, un nieto que retiene las tuberías bloquea la llamada para siempre. */
  timeoutMs: number;
  /** Guarda la salida estándar como bytes en `Resultado.salida` (p. ej. un WAV por tubería), hasta este tope; `stdout` queda vacío. */
  salidaBinaria?: { maxBytes: number };
};

const plazoValido = (t: unknown): t is number => typeof t === "number" && Number.isFinite(t) && t > 0;

/** true si la llamada es la CLI de HyperFrames: el script empaquetado, el Node del motor o cualquier `node`. */
function esLlamadaCli(comando: string, args: string[]): boolean {
  return (
    (args[0] !== undefined && mismaRuta(args[0], HYPERFRAMES_BIN)) ||
    mismaRuta(comando, process.execPath) ||
    /^node(\.exe)?$/i.test(path.basename(comando))
  );
}

/** Hijos vivos lanzados por `ejecutar` (pid → momento del lanzamiento): el barrido nunca los toca. */
const enVuelo = new Map<number, number>();

// Candado en memoria: las invocaciones de la CLI de HyperFrames van de una en una dentro del proceso.
let colaCli: Promise<unknown> = Promise.resolve();

/**
 * Único punto por el que el motor lanza procesos: sin shell, argumentos en array y con el entorno
 * construido desde cero (I5). Si es la CLI de HyperFrames, además: solo con el Node del motor, modo
 * cerrado y HOME/cwd en hf-home (I13), dist y navegador comprobados antes de lanzar (R2-M3, I4) y en serie.
 */
export function ejecutar(comando: string, args: string[], opciones: OpcionesEjecutar): Promise<Resultado> {
  // Los .mjs y los tests no pasan por el tipo: se exige también en ejecución (0, NaN o ausente no valen).
  if (!plazoValido(opciones?.timeoutMs)) return Promise.reject(new Error("ejecutar exige un timeoutMs finito y mayor que 0."));
  if (!esLlamadaCli(comando, args)) return lanzar(comando, args, opciones, false);
  if (!mismaRuta(comando, process.execPath)) {
    return Promise.reject(new Error(`La CLI de HyperFrames solo se lanza con el Node del motor (${process.execPath}), no con ${comando}.`));
  }
  const turno = colaCli.then(async () => {
    await verificarDist();
    await verificarNavegador();
    // cwd fijo: la CLI aplica el .env de su cwd a su entorno (cli.js), y busca ffmpeg en él.
    return lanzar(comando, args, { ...opciones, cwd: hfHome() }, true);
  });
  colaCli = turno.catch(() => undefined);
  return turno;
}

/**
 * Lanza y, si venció el timeout (cualquier comando) o la CLI terminó mal, barre los procesos que
 * hayan quedado bajo el navegador o el ffmpeg del motor (I7). Nadie puede desactivar el barrido desde
 * fuera: solo lo evitan las llamadas internas del propio barrido.
 */
async function lanzar(comando: string, args: string[], opciones: OpcionesEjecutar, cli: boolean, barrer = true): Promise<Resultado> {
  const r = await lanzarUno(comando, args, opciones);
  if (barrer && (r.timeout || (cli && r.code !== 0))) await barridoAlArrancar(undefined, undefined, true);
  return r;
}

function lanzarUno(comando: string, args: string[], opciones: OpcionesEjecutar): Promise<Resultado> {
  const { onLinea, timeoutMs, salidaBinaria, ...spawnOpts } = opciones;
  return new Promise((resolve, reject) => {
    // detached (solo fuera de Windows): el hijo lidera su grupo y se puede matar todo el árbol con process.kill(-pid).
    const hijo = spawn(comando, args, {
      ...spawnOpts,
      // Después del spread: un `env` llegado de un .mjs se pisa (I5).
      env: entornoHijo(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = hijo.pid;
    if (pid) enVuelo.set(pid, Date.now());
    // Sale de «en vuelo» en cuanto termina (o se da por muerto tras el timeout), antes de cualquier barrido.
    const fuera = () => {
      if (pid) enVuelo.delete(pid);
    };
    let terminado = false;
    let vencido = false;
    let stdout = "";
    let stderr = "";
    let resto = "";
    const trozos: Buffer[] = [];
    let bytes = 0;
    let truncada = false;
    const trocear = (texto: string) => {
      if (!onLinea) return;
      const partes = (resto + texto).split(/\r?\n|\r/);
      resto = partes.pop() ?? "";
      for (const p of partes) if (p.trim()) onLinea(p);
    };
    hijo.stdout?.on("data", (d: Buffer) => {
      if (salidaBinaria) {
        // Sin decodificar como texto: un WAV no sobrevive a UTF-8. Pasado el tope se sigue leyendo, para no bloquear al hijo, y se descarta.
        if (bytes + d.length > salidaBinaria.maxBytes) truncada = true;
        else {
          trozos.push(d);
          bytes += d.length;
        }
        return;
      }
      const t = d.toString("utf8");
      stdout += t;
      trocear(t);
    });
    hijo.stderr?.on("data", (d: Buffer) => {
      const t = d.toString("utf8");
      stderr += t;
      trocear(t);
    });
    const temporizador = setTimeout(() => {
      vencido = true;
      // Se resuelve solo cuando el árbol ya está muerto: así el llamador no sigue con Chrome vivo.
      void matarArbol(hijo).then(() => {
        fuera();
        if (terminado) return;
        terminado = true;
        if (onLinea && resto.trim()) onLinea(resto);
        resolve({ code: null, stdout, stderr, timeout: true });
      });
    }, timeoutMs);
    hijo.on("error", (e) => {
      fuera();
      if (temporizador) clearTimeout(temporizador);
      if (terminado) return;
      terminado = true;
      reject(e);
    });
    // `close` espera a las tuberías, que un nieto huérfano puede retener: mientras, el barrido lo protegería.
    hijo.on("exit", fuera);
    hijo.on("close", (code) => {
      fuera();
      // Si venció el timeout, resuelve el temporizador cuando taskkill/kill haya terminado (el código de salida sería el de la muerte forzada).
      if (vencido) return;
      if (temporizador) clearTimeout(temporizador);
      if (terminado) return;
      terminado = true;
      if (onLinea && resto.trim()) onLinea(resto);
      // Una salida que pasó del tope no se entrega a medias: el llamador la ve como fallo.
      resolve({ code: truncada ? (code === 0 ? 1 : code) : code, stdout, stderr: truncada ? `${stderr}\nLa salida pasa de ${salidaBinaria?.maxBytes} bytes.` : stderr, ...(salidaBinaria ? { salida: Buffer.concat(trozos) } : {}) });
    });
  });
}

// ---------- Barrido de procesos por ruta de imagen (I7) ----------

/** Qué se barre: carpetas enteras (navegador con manifiesto) y ejecutables exactos (ffmpeg, ffprobe). */
export interface ObjetivoBarrido {
  arboles: string[];
  exactos: string[];
}

export interface ProcesoVivo {
  pid: number;
  /** ExecutablePath; vacío si el sistema no la da (otro usuario, proceso protegido). */
  ruta: string;
  /** Nombre de la imagen (Name de WMI). */
  nombre?: string;
  /** CommandLine, solo si no hay ruta: permite descartar procesos ajenos con el mismo nombre. */
  linea?: string;
  padre?: number;
  /** Fecha de creación (ms desde 1970): distingue un padre de verdad de un pid reutilizado. */
  creado?: number;
}

const TIMEOUT_LISTAR_MS = 30_000;

const normalizar = (p: string): string => {
  const r = path.resolve(sinPrefijoLargo(p));
  return process.platform === "win32" ? r.toLowerCase() : r;
};

function realOResuelta(p: string): string {
  try {
    return sinPrefijoLargo(fs.realpathSync.native(p));
  } catch {
    return path.resolve(p);
  }
}

/**
 * Lo que pertenece al motor: ffmpeg y ffprobe exactos (su carpeta puede tener otras cosas; en ruta
 * real y sin resolver) y, del navegador, la carpeta entera de la versión si hay manifiesto o, si no
 * (desarrollo), solo su exe: nunca la carpeta de un Chrome del usuario. En desarrollo, ffmpeg solo si
 * FFMPEG_DIR está fijado: el de PATH o winget puede estar trabajando para otro programa.
 */
export function carpetasDelBundle(h: Herramientas | null, env: NodeJS.ProcessEnv = process.env): ObjetivoBarrido {
  const conFfmpeg = h && (esIntegrado(env) || !!env.FFMPEG_DIR?.trim());
  const exactos = conFfmpeg ? [...new Set([h.ffmpeg, h.ffprobe, realOResuelta(h.ffmpeg), realOResuelta(h.ffprobe)])] : [];
  // Las dos formas de cada ruta: Win32_Process da la imagen tal como se lanzó, que puede ser la 8.3
  // (C:\Users\RUNNER~1\…), y realpath da la larga. Con una sola, el barrido no reconocería a los suyos.
  const ambas = (p: string) => [...new Set([path.resolve(p), realOResuelta(p)])];
  const arboles: string[] = [];
  const manifiesto = env.VIDEO_NAVEGADOR_MANIFIESTO?.trim();
  const navegador = env.HYPERFRAMES_BROWSER_PATH?.trim();
  if (manifiesto) arboles.push(...ambas(path.dirname(path.resolve(manifiesto))));
  else if (navegador) exactos.push(...ambas(navegador));
  return { arboles, exactos: [...new Set(exactos)] };
}

/** Filtra una lista de procesos por ruta de imagen (sin distinguir mayúsculas en Windows y sin `\\?\`). */
export function filtrarProcesos(lista: ProcesoVivo[], o: ObjetivoBarrido): ProcesoVivo[] {
  const arboles = o.arboles.map((c) => normalizar(c).replace(/[\\/]+$/, "") + path.sep);
  const exactos = new Set(o.exactos.map(normalizar));
  return lista.filter((p) => {
    if (!p.ruta) return false;
    const r = normalizar(p.ruta);
    return exactos.has(r) || arboles.some((a) => r.startsWith(a));
  });
}

/**
 * Literal de comillas simples de PowerShell: se dobla cualquier comilla que lo cerraría, también las tipográficas
 * ‘ ’ ‚ ‛, que PowerShell acepta igual (revisión post-R2, L1 y Low-1: con ’ se inyectaba código).
 */
export const literalPowerShell = (s: string): string => `'${s.replace(/['‘’‚‛]/g, "$&$&")}'`;

/**
 * Módulos que usan los scripts de `powershell()`: ConvertTo/From-Json, Stop-Process y Get-CimInstance. Utility va
 * primero: al cargarse, CimCmdlets llama a Set-Alias, que está en Utility (sin autocarga no lo encontraría).
 */
const MODULOS_PS = ["Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Management", "CimCmdlets"];

/**
 * PowerShell por ruta fija, con el script codificado (sin comillas que escapar) y salida en UTF-8.
 * Sin autocarga y con cada módulo importado por su ruta en System32: con el entorno de I5 (sin
 * PSModuleAnalysisCachePath) PowerShell analiza en cada arranque todos los módulos de PSModulePath, y en un
 * equipo con muchos (el runner de CI) el listado pasaba de 0,3 s a 13-30 s y agotaba TIMEOUT_LISTAR_MS. Así
 * tampoco carga ningún módulo plantado en otra carpeta de PSModulePath.
 */
function powershell(script: string): Promise<Resultado> {
  const raiz = path.join(system32(), "WindowsPowerShell", "v1.0");
  const exe = path.join(raiz, "powershell.exe");
  const imports = MODULOS_PS.map((m) => `Import-Module ${literalPowerShell(path.join(raiz, "Modules", m, `${m}.psd1`))} -ErrorAction Stop`).join("\n");
  const prologo = `$ErrorActionPreference = 'Stop'\n$PSModuleAutoloadingPreference = 'None'\n${imports}\n$ErrorActionPreference = 'Continue'`;
  const codificado = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${prologo}\n${script}`, "utf16le").toString("base64");
  // cwd fijo: sin LOCALAPPDATA (I5), PowerShell escribe su ModuleAnalysisCache relativa al cwd.
  return lanzar(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", codificado], { timeoutMs: TIMEOUT_LISTAR_MS, cwd: hfHome() }, false, false);
}

/** Todos los procesos (en Windows con padre y fecha de creación). Lanza si no se puede listar (código, timeout o salida ilegible). */
export async function listarProcesos(): Promise<ProcesoVivo[]> {
  const todos: ProcesoVivo[] = [];
  if (process.platform === "win32") {
    const r = await powershell(
      "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; f = [int]$_.ParentProcessId; " +
        "n = [string]$_.Name; r = [string]$_.ExecutablePath; l = $(if ($_.ExecutablePath) { '' } else { [string]$_.CommandLine }); " +
        "c = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } } | ConvertTo-Json -Compress",
    );
    if (r.timeout || r.code !== 0) throw new Error(`No pude listar los procesos (código ${r.code}${r.timeout ? ", timeout" : ""}).`);
    let lista: unknown;
    try {
      lista = JSON.parse(r.stdout);
    } catch {
      throw new Error(`Salida ilegible al listar procesos: ${r.stdout.slice(0, 100)}`);
    }
    if (!Array.isArray(lista) || !lista.length) throw new Error("La lista de procesos salió vacía o ilegible.");
    for (const x of lista as { p?: unknown; f?: unknown; n?: unknown; r?: unknown; l?: unknown; c?: unknown }[]) {
      if (typeof x?.p !== "number") throw new Error("Salida ilegible al listar procesos.");
      todos.push({
        pid: x.p,
        padre: typeof x.f === "number" ? x.f : undefined,
        nombre: typeof x.n === "string" ? x.n : undefined,
        ruta: typeof x.r === "string" ? x.r.trim() : "",
        linea: typeof x.l === "string" && x.l ? x.l : undefined,
        creado: typeof x.c === "number" && x.c > 0 ? x.c : undefined,
      });
    }
  } else if (process.platform === "linux") {
    // Sin fecha de creación: la protección por cadena de padres de seleccionarBarrido no se activa (no es objetivo de la fase 1).
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        // El nombre (comm) puede llevar espacios y paréntesis: el padre es el segundo campo tras el ÚLTIMO ")".
        const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
        const padre = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        let ruta = "";
        try {
          ruta = fs.readlinkSync(`/proc/${d}/exe`);
        } catch {
          /* proceso ajeno: sin ruta, pero su pid y su padre sirven para recorrer el árbol */
        }
        todos.push({ pid: Number(d), ruta, padre: Number.isInteger(padre) ? padre : undefined });
      } catch {
        /* ya muerto */
      }
    }
  } else {
    // I11: sin árbol de procesos no se puede matar ni barrer con seguridad. Fallo visible, no una lista vacía.
    throw new Error(`El motor de vídeo no puede listar procesos en ${process.platform}: solo Windows y Linux.`);
  }
  return todos;
}

/** Procesos vivos cuya imagen es del motor (sin mirar quién los lanzó). */
export async function procesosBajo(o: ObjetivoBarrido): Promise<ProcesoVivo[]> {
  return filtrarProcesos(await listarProcesos(), o);
}

/**
 * Qué barrer: procesos con imagen del motor salvo los que cuelgan de un hijo vivo de `ejecutar` o de otro
 * motor vivo (por la cadena de ParentProcessId, con un padre creado antes que el hijo para no seguir un
 * pid reutilizado): un timeout no mata la segunda pasada de otro trabajo ni el render del otro canal.
 * Lo que cuelga de nuestro propio pid y no está en vuelo se barre, aunque pase por un Node: es una CLI
 * nuestra que sobrevivió al taskkill. Otro motor exige evidencia positiva (R0 M4): el Node más alto de la
 * cadena tiene que tener un padre vivo; si no, es trabajo de un motor muerto (huérfano). En desarrollo el
 * Node es el de todos, así que un Chrome colgado de cualquier Node queda protegido; en integrado es el
 * del bundle. `noVerificables`: procesos con el nombre de un
 * ejecutable del motor cuya ruta el sistema no da; no se pueden matar con seguridad (falla cerrado).
 * WMI deja sin ruta también a procesos ajenos (medido: un ffmpeg y varios Chrome de otra sesión), así
 * que antes se mira el ejecutable de su CommandLine: si es absoluto y de otro sitio, no son del motor.
 */
export function seleccionarBarrido(
  todos: ProcesoVivo[],
  o: ObjetivoBarrido,
  vuelo: ReadonlyMap<number, number> = enVuelo,
  propio: { pid: number; node: string } = { pid: process.pid, node: process.execPath },
): { matar: ProcesoVivo[]; noVerificables: ProcesoVivo[] } {
  const porPid = new Map(todos.map((p) => [p.pid, p]));
  const nodeMotor = normalizar(propio.node);
  const protegido = (p: ProcesoVivo): boolean => {
    let actual: ProcesoVivo | undefined = p;
    let nodeMasAlto: ProcesoVivo | undefined;
    for (let i = 0; actual && i < 64; i++) {
      const lanzado = vuelo.get(actual.pid);
      // Margen de 5 s entre el spawn medido en Node y la fecha de creación del sistema.
      if (lanzado !== undefined && (actual.creado === undefined || actual.creado >= lanzado - 5000)) return true;
      if (actual.pid === propio.pid) return false;
      if (actual.ruta && normalizar(actual.ruta) === nodeMotor) nodeMasAlto = actual;
      const padre: ProcesoVivo | undefined = actual.padre !== undefined ? porPid.get(actual.padre) : undefined;
      // Fin de la cadena: otro motor solo si por encima de su Node más alto aún hay un padre vivo.
      if (!padre || padre.creado === undefined || actual.creado === undefined || padre.creado > actual.creado) return !!nodeMasAlto && nodeMasAlto !== actual;
      actual = padre;
    }
    return false;
  };
  const candidatos = todos.filter((p) => p.pid !== process.pid && !protegido(p));
  const nombres = new Set([...o.exactos.map((e) => path.basename(e).toLowerCase()), ...(o.arboles.length ? ["chrome-headless-shell.exe"] : [])]);
  const ajeno = (p: ProcesoVivo): boolean => {
    const exe = /^\s*(?:"([^"]+)"|(\S+))/.exec(p.linea ?? "");
    const ruta = exe?.[1] ?? exe?.[2];
    // Sin comillas, una ruta con espacios sale cortada (C:\Users\Marc): solo vale si acaba en su propio exe.
    if (ruta && path.isAbsolute(ruta) && path.basename(ruta).toLowerCase() === p.nombre?.toLowerCase()) return !filtrarProcesos([{ pid: p.pid, ruta }], o).length;
    // Renderer con sandbox: WMI no lee nada de él, pero su padre es un Chrome con ruta legible.
    const padre = p.padre !== undefined ? porPid.get(p.padre) : undefined;
    const esSuPadre = padre && padre.creado !== undefined && p.creado !== undefined && padre.creado <= p.creado;
    return !!esSuPadre && !!padre.ruta && padre.nombre?.toLowerCase() === p.nombre?.toLowerCase() && !filtrarProcesos([padre], o).length;
  };
  return {
    matar: filtrarProcesos(candidatos, o),
    noVerificables: candidatos.filter((p) => !p.ruta && !!p.nombre && nombres.has(p.nombre.toLowerCase()) && !ajeno(p)),
  };
}

/** Mata filtrando otra vez por pid Y ruta: un pid reutilizado por otro programa no se toca. */
export async function matarProcesos(vivos: ProcesoVivo[]): Promise<void> {
  if (!vivos.length) return;
  if (process.platform === "win32") {
    // La tabla viaja como JSON en base64: ninguna ruta (con ' o ’) puede romper el script.
    const tabla = Buffer.from(JSON.stringify(vivos.map((p) => ({ pid: p.pid, ruta: p.ruta }))), "utf8").toString("base64");
    await powershell(
      `$o = @{}; foreach ($x in ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${tabla}')) | ConvertFrom-Json)) { $o[[int]$x.pid] = [string]$x.ruta }\n` +
        "Get-CimInstance Win32_Process | Where-Object { $o.ContainsKey([int]$_.ProcessId) -and $_.ExecutablePath -eq $o[[int]$_.ProcessId] } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    );
    return;
  }
  for (const p of vivos) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      /* ya muerto */
    }
  }
}

export interface DepsBarrido {
  /** Todos los procesos; la selección la hace seleccionarBarrido. */
  listar: () => Promise<ProcesoVivo[]>;
  matar: (vivos: ProcesoVivo[]) => Promise<void>;
  /** Si quedan procesos que no se pueden matar: el backend relanza el motor en la siguiente llamada. */
  reiniciar: () => void;
}

const DEPS_BARRIDO: DepsBarrido = {
  listar: listarProcesos,
  matar: matarProcesos,
  reiniciar: () => {
    log.error("Reinicio el motor de vídeo: quedan procesos del navegador o de ffmpeg que no puedo matar.");
    process.exit(70);
  },
};

/**
 * Tras un timeout, taskkill /T no alcanza a los procesos cuyo padre ya murió (Chrome relanzado,
 * vigilantes desligados). Se buscan por ruta de imagen (sin tocar lo que cuelga de un hijo en vuelo),
 * se matan y se comprueba; si no se puede listar, verificar o matar, se reinicia el motor antes que
 * dejarlos vivos.
 */
export async function barrerProcesos(o: ObjetivoBarrido, deps: DepsBarrido = DEPS_BARRIDO, vuelo: ReadonlyMap<number, number> = enVuelo): Promise<void> {
  if (!o.arboles.length && !o.exactos.length) return;
  try {
    const observar = async () => {
      let actual = seleccionarBarrido(await deps.listar(), o, vuelo);
      for (let intento = 0; actual.matar.length && intento < 3; intento++) {
        log.warn(`Barrido: mato ${actual.matar.length} proceso(s) del motor que seguían vivos (pids ${actual.matar.map((p) => p.pid).join(", ")}).`);
        await deps.matar(actual.matar);
        await new Promise((r) => setTimeout(r, 200));
        actual = seleccionarBarrido(await deps.listar(), o, vuelo);
      }
      return actual;
    };
    let sel = await observar();
    // WMI también deja sin ruta a un proceso que está arrancando o saliendo (medido con otras sesiones):
    // solo cuenta el que sigue sin verificar en cada observación. El que gana la ruta del motor sale de
    // dudosos, pero `observar` lo mata, y si no puede queda en sel.matar.
    let dudosos = sel.noVerificables;
    for (let intento = 0; dudosos.length && intento < 3; intento++) {
      await new Promise((r) => setTimeout(r, 500));
      sel = await observar();
      const ahora = new Set(sel.noVerificables.map((p) => p.pid));
      dudosos = dudosos.filter((p) => ahora.has(p.pid));
    }
    const restos = [...sel.matar, ...dudosos];
    if (restos.length) {
      log.error(
        `Barrido: no pude matar o verificar los pids ${restos.map((p) => `${p.pid}${p.ruta ? "" : ` (${p.nombre}, sin ruta)`}`).join(", ")}.`,
      );
      deps.reiniciar();
    }
  } catch (e) {
    log.error(`Barrido: ${(e as Error).message}`);
    deps.reiniciar();
  }
}

/**
 * Barrido de lo que pertenece al motor (R0-6, I7): al arrancar (recoge lo que dejó un motor muerto: Chrome y ffmpeg
 * cuelgan del Job Object del sidecar y no mueren con él) y a petición del backend tras una cancelación o un reinicio.
 * No toca lo que cuelga de un hijo en vuelo ni de otro motor vivo (`seleccionarBarrido`). Sin navegador ni ffmpeg del
 * motor identificables no lista nada.
 */
export function barridoAlArrancar(deps: DepsBarrido = DEPS_BARRIDO, env: NodeJS.ProcessEnv = process.env, reiniciar = false): Promise<void> {
  // Al arrancar o a petición, lo que no se puede matar ni verificar se registra y se deja: reiniciar cortaría una llamada
  // en curso (una voz ya cobrada) y podría entrar en bucle con un proceso ajeno elevado (auditoría T6, M-1).
  const d = reiniciar ? deps : { ...deps, reiniciar: () => log.error("Barrido: quedan procesos que no puedo matar ni verificar; se dejan.") };
  return barrerProcesos(carpetasDelBundle(herramientasFfmpeg(env.FFMPEG_DIR), env), d);
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
  /** r_frame_rate del vídeo. */
  fps?: number;
  /** avg_frame_rate del vídeo. */
  fpsMedio?: number;
  /** Etiqueta `encoder` del vídeo tal cual (p. ej. "Lavc61.19.101 h264_amf"). */
  codificador?: string;
  duracionVideo?: number;
  duracionAudio?: number;
  nbFrames?: number;
  /** Solo con `soloMp4`: paquetes de vídeo leídos de verdad (nb_read_packets). */
  nbPaquetes?: number;
  pistasVideo?: number;
  pistasAudio?: number;
}

const numero = (v?: string): number | undefined => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const fraccion = (v?: string): number | undefined => {
  const [a, b] = (v ?? "").split("/").map(Number);
  return a && b ? a / b : undefined;
};

/** Demuxer de cada extensión admitida (I15). Son nombres de `-f`; componentes.conf lista sus `image_*_pipe`. */
const DEMUXERS: Readonly<Record<string, string>> = {
  ".png": "png_pipe",
  ".jpg": "jpeg_pipe",
  ".jpeg": "jpeg_pipe",
  ".webp": "webp_pipe",
  ".mp3": "mp3",
  // La lista de concatenación del motor (T5) NO está aquí: quien la abre pasa `demuxer = "concat"` expreso.
  ".wav": "wav",
  ".flac": "flac",
  ".ogg": "ogg",
  ".m4a": "mov",
  ".mp4": "mov",
  ".mov": "mov",
  ".webm": "matroska",
  ".mkv": "matroska",
};

/**
 * Opciones de entrada de todo fichero que abren ffmpeg o ffprobe: solo el protocolo `file`, con el demuxer fijado
 * por la extensión y sin sondear otro. Fallo cerrado: una ruta UNC es DNS y SMB (captura de NTLM), otro esquema abre
 * un protocolo, y un nombre sin extensión conocida no se abre. No sustituye a la normalización al importar (I15).
 */
export function argsEntrada(archivo: string, demuxer = DEMUXERS[path.extname(archivo).toLowerCase()], internos: readonly string[] = []): string[] {
  const unc = /^[\\/]{2}/.test(archivo) || path.win32.resolve(archivo).startsWith("\\\\");
  if (unc || /^[a-z][a-z0-9+.-]+:/i.test(archivo)) throw new Error(`El motor solo abre medios por ruta local: ${path.basename(archivo)}.`);
  if (!demuxer) throw new Error(`El motor no admite este formato de medio: ${path.basename(archivo)}.`);
  // `internos`: formatos que el demuxer abre por dentro (el de `concat` abre los mp3 de su lista); nunca los elige quien llama con texto ajeno.
  return ["-protocol_whitelist", "file", "-format_whitelist", [demuxer, ...internos].join(","), "-f", demuxer];
}

/**
 * ffprobe de un medio. Con `soloMp4` (el MP4 propio): demuxer mp4, cuenta los paquetes y cualquier error de ffprobe,
 * aunque salga con 0, es un fallo.
 */
export async function sondear(ffprobe: string, archivo: string, { soloMp4 = false } = {}): Promise<InfoMedio> {
  const previos = soloMp4 ? [...argsEntrada(archivo, "mp4"), "-count_packets"] : argsEntrada(archivo);
  const r = await ejecutar(ffprobe, ["-v", "error", ...previos, "-print_format", "json", "-show_format", "-show_streams", archivo], { timeoutMs: 30000 });
  if (r.code !== 0 || (soloMp4 && r.stderr.trim())) throw new Error(`ffprobe no puede leer ${path.basename(archivo)}: ${r.stderr.trim().slice(0, 300)}`);
  type Pista = {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    duration?: string;
    nb_frames?: string;
    nb_read_packets?: string;
    tags?: { encoder?: string };
  };
  const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Pista[] };
  const video = j.streams?.find((s) => s.codec_type === "video");
  const audio = j.streams?.find((s) => s.codec_type === "audio");
  return {
    duracion: numero(j.format?.duration),
    ancho: video?.width,
    alto: video?.height,
    codecVideo: video?.codec_name,
    tieneAudio: !!audio,
    fps: fraccion(video?.r_frame_rate),
    fpsMedio: fraccion(video?.avg_frame_rate),
    codificador: video?.tags?.encoder,
    duracionVideo: numero(video?.duration),
    duracionAudio: numero(audio?.duration),
    nbFrames: numero(video?.nb_frames),
    nbPaquetes: numero(video?.nb_read_packets),
    pistasVideo: j.streams?.filter((s) => s.codec_type === "video").length ?? 0,
    pistasAudio: j.streams?.filter((s) => s.codec_type === "audio").length ?? 0,
  };
}
