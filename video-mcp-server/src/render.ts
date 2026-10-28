// Comprobaciones previas, montaje de la composición, cola de renders (uno a la vez) y estado de cada job.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import { parsearGuion, type Guion } from "./guion.js";
import type { ResultadoAlineacion } from "./alineacion.js";
import { bloquesConFoto } from "./formato.js";
import { cargarTema, escribirPlan, planificarComposicion, urlsDeRed, type Tema } from "./composicion.js";
import { archivosVideo, imagenesValidadas, ErrorVideo, resolverDentro, type ImagenEncontrada } from "./paths.js";
import { ejecutar, entornoConFfmpeg, herramientasFfmpeg, MENSAJE_SIN_FFMPEG, sondear, type Herramientas } from "./proceso.js";
import { ajustarCortes, analizarAudio, automatizacionDucking, HYPERFRAMES_BIN, huecosDeVoz, normalizarVoz, prepararMusica } from "./musica.js";
import { hayWebgpu } from "./capacidades.js";

export { HYPERFRAMES_BIN };

export const TIMEOUT_CHECK_MS = 600_000;
export const TIMEOUT_RENDER_MS = 3_600_000;

/** Timeout del render; VIDEO_TIMEOUT_RENDER_S (segundos) lo sustituye, pensado para tests. */
export function timeoutRenderMs(): number {
  const s = Number(process.env.VIDEO_TIMEOUT_RENDER_S);
  return Number.isFinite(s) && s > 0 ? s * 1000 : TIMEOUT_RENDER_MS;
}

function duracionLegible(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export type EstadoJob = "en_cola" | "renderizando" | "terminado" | "error";

export interface Job {
  job_id: string;
  id: string;
  estado: EstadoJob;
  fase?: string;
  progreso?: number;
  mp4: string;
  duracion?: number;
  creado: string;
  terminado?: string;
  error?: string;
  avisos: string[];
  lineas: string[];
}

export interface Preparado {
  id: string;
  guion: Guion;
  palabras: ResultadoAlineacion;
  /** Índice n-1. undefined en los bloques con escena (si no hay foto). */
  imagenes: (ImagenEncontrada | undefined)[];
  voz: string;
  musica?: { ruta: string; volumen: number; desde: number };
  rutas: ReturnType<typeof archivosVideo>;
  herramientas: Herramientas;
  avisos: string[];
}

export interface OpcionesRender {
  raiz: string;
  musica: boolean;
  musicaVolumen: number;
  ffmpegDir?: string;
  browserPath?: string;
  tema?: Tema;
}

/** Valida todo antes de crear el job. Lanza ErrorVideo con un mensaje accionable si falta algo. */
export async function prepararRender(id: string, o: OpcionesRender): Promise<Preparado> {
  const rutas = archivosVideo(o.raiz, id);
  const herramientas = herramientasFfmpeg(o.ffmpegDir);
  if (!herramientas) throw new ErrorVideo(MENSAJE_SIN_FFMPEG);
  if (!fs.existsSync(rutas.dir)) throw new ErrorVideo(`No existe la carpeta ${rutas.dir}. Crea el guion primero con video_guardar_guion.`);
  if (!fs.existsSync(rutas.guion)) throw new ErrorVideo(`Falta ${rutas.guion}. Guárdalo con video_guardar_guion.`);
  const guion = parsearGuion(fs.readFileSync(rutas.guion, "utf8"));
  const avisos = [...guion.avisos];

  const { imagenes, avisos: avisosImg, ignoradas } = imagenesValidadas(rutas.dir);
  avisos.push(...avisosImg);
  const requeridas = bloquesConFoto(guion.opciones.escenas);
  const faltan = requeridas.filter((n) => !imagenes[n - 1]).map((n) => `img${n}`);
  if (faltan.length) {
    const conEscena = [1, 2, 3, 4, 5, 6].filter((n) => !requeridas.includes(n));
    throw new ErrorVideo(
      `Faltan imágenes en ${rutas.dir}: ${faltan.join(", ")}. Hacen falta ${requeridas.length} (img${requeridas.join(", img")})` +
        (conEscena.length ? `; los bloques ${conEscena.join(", ")} llevan escena y no necesitan foto.` : ", jpg, png o webp.") +
        (ignoradas.length ? ` En la carpeta hay fotos con otro nombre que no se usan: ${ignoradas.join(", ")}. Renómbralas a imgN.` : ""),
    );
  }
  const hayTunel = Object.values(guion.opciones.escenas).some((e) => e?.tipo === "tunel");
  const fotos = imagenes.filter(Boolean).length;
  if (hayTunel && fotos < 3) {
    throw new ErrorVideo(`La escena tunel usa las fotos del vídeo y necesita al menos 3; ahora hay ${fotos}. Añade más imgN a ${rutas.dir}.`);
  }
  if (!fs.existsSync(rutas.voz) || !fs.existsSync(rutas.palabras)) {
    throw new ErrorVideo(`Falta voz.mp3 o palabras.json en ${rutas.dir}. Genera la voz con video_generar_voz.`);
  }
  let palabras: ResultadoAlineacion;
  try {
    palabras = JSON.parse(fs.readFileSync(rutas.palabras, "utf8")) as ResultadoAlineacion;
  } catch {
    throw new ErrorVideo(`palabras.json está dañado. Regenera la voz con video_generar_voz(forzar=true).`);
  }
  if (palabras.hashNarracion !== guion.hash) {
    throw new ErrorVideo(
      "El guion ha cambiado desde que se generó la voz (el hash de la narración no coincide). Regenera la voz con video_generar_voz(forzar=true).",
    );
  }
  if (palabras.segmentos?.length !== 6 || !palabras.frases?.length) {
    throw new ErrorVideo("palabras.json no tiene 6 segmentos y frases. Regenera la voz con video_generar_voz(forzar=true).");
  }

  let musica: Preparado["musica"];
  if (o.musica && guion.musica) {
    let ruta: string;
    try {
      ruta = resolverDentro(o.raiz, guion.musica);
    } catch {
      throw new ErrorVideo(`La música "${guion.musica}" está fuera de VIDEO_ROOT. Ponla en ${path.join(o.raiz, "_musica")}.`);
    }
    if (!fs.existsSync(ruta)) {
      throw new ErrorVideo(`No encuentro la música ${ruta}. Cópiala ahí, corrige \`musica\` en el guion o renderiza con musica=false.`);
    }
    const desde = guion.opciones.musicaDesde;
    if (desde > 0) {
      const dur = (await sondear(herramientas.ffprobe, ruta)).duracion;
      if (dur !== undefined && desde >= dur) {
        throw new ErrorVideo(`\`musica_desde: ${desde}\` es mayor que la duración de la pista (${dur.toFixed(1)} s). Pon un valor menor.`);
      }
    }
    musica = { ruta, volumen: guion.opciones.musicaVolumen ?? o.musicaVolumen, desde };
  }

  return { id, guion, palabras, imagenes, voz: rutas.voz, musica, rutas, herramientas, avisos };
}

export interface Montaje {
  duracion: number;
  usaWebgpu: boolean;
  avisos: string[];
}

/** Prepara el audio y escribe la composición completa en `destino`. */
export async function montarComposicion(prep: Preparado, destino: string, o: OpcionesRender): Promise<Montaje> {
  const h = prep.herramientas;
  const avisos: string[] = [];
  const tmp = `${destino}.audio-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await normalizarVoz(h, prep.voz, path.join(tmp, "voz.mp3"));
    const D = prep.palabras.duracionAudio + 0.4;
    let musicaPlan: { volumen: number; automatizacion: string } | undefined;
    let cortes: number[] | undefined;
    if (prep.musica) {
      await prepararMusica(h, prep.musica.ruta, path.join(tmp, "musica.mp3"), prep.musica.desde, D);
      musicaPlan = { volumen: prep.musica.volumen, automatizacion: automatizacionDucking(huecosDeVoz(prep.palabras.palabras, D)) };
      if (prep.guion.opciones.cortesAlRitmo) {
        const a = await analizarAudio(h, path.join(tmp, "musica.mp3"));
        const r = ajustarCortes(prep.palabras.segmentos, prep.palabras.palabras, a.beats);
        cortes = r.desde;
        avisos.push(
          `Cortes al ritmo: ${r.movidos} de 5 cambios de imagen movidos al beat${a.bpm ? ` (${Math.round(a.bpm)} BPM)` : ""}.` +
            (a.beats.length ? "" : " No se detectaron beats en la pista."),
        );
      }
    }
    const gpu = await hayWebgpu(h, o.browserPath);
    const plan = planificarComposicion({
      guion: prep.guion,
      palabras: prep.palabras,
      imagenes: prep.imagenes,
      tema: o.tema ?? cargarTema(),
      musica: musicaPlan,
      cortes,
      gpu,
    });
    escribirPlan(destino, plan);
    fs.copyFileSync(path.join(tmp, "voz.mp3"), path.join(destino, "assets", "voz.mp3"));
    if (musicaPlan) fs.copyFileSync(path.join(tmp, "musica.mp3"), path.join(destino, "assets", "musica.mp3"));
    avisos.push(...plan.avisos);
    const red = urlsDeRed(destino);
    if (red.length) throw new Error(`La composición tiene recursos de red y el render tiene que ser local: ${red.slice(0, 5).join("; ")}`);
    return { duracion: plan.duracion, usaWebgpu: plan.usaWebgpu, avisos };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- Cola ----------

const jobs = new Map<string, Job>();
const cola: { job: Job; prep: Preparado; o: OpcionesRender }[] = [];
let ocupado = false;

// Avisos de `check` que no aportan nada aquí: contraste sobre fotos (el texto lleva contorno) y
// avisos de organización del Studio.
const AVISOS_ESPERADOS = /contrast|wcag|nested_structure_needs_subcomposition|timeline_track_too_dense|composition_file_too_large|console_warning|static/i;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MAX_LINEAS = 400;

function anotar(job: Job, linea: string): void {
  const limpia = linea.replace(ANSI_RE, "").replace(/[⠀-⣿]/g, "").trim();
  if (!limpia) return;
  job.lineas.push(limpia);
  if (job.lineas.length > MAX_LINEAS) job.lineas.splice(0, job.lineas.length - MAX_LINEAS);
  const pct = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(limpia);
  if (pct && job.fase === "render") {
    const v = Number(pct[1]);
    if (v >= 0 && v <= 100) job.progreso = v;
  }
}

export function ultimasLineasUtiles(job: Job, n = 30): string[] {
  const vistas = new Set<string>();
  const utiles: string[] = [];
  for (let i = job.lineas.length - 1; i >= 0 && utiles.length < n; i--) {
    const l = job.lineas[i];
    const clave = l.replace(/\d+/g, "#");
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    utiles.unshift(l);
  }
  return utiles;
}

export async function encolarRender(id: string, o: OpcionesRender): Promise<Job> {
  const prep = await prepararRender(id, o);
  const job: Job = {
    job_id: `render-${id}-${crypto.randomBytes(3).toString("hex")}`,
    id,
    estado: "en_cola",
    mp4: prep.rutas.mp4,
    creado: new Date().toISOString(),
    avisos: [...prep.avisos],
    lineas: [],
  };
  jobs.set(job.job_id, job);
  cola.push({ job, prep, o });
  log.info(`Job ${job.job_id} encolado (${cola.length} en cola).`);
  void siguiente();
  return job;
}

export function obtenerJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function listarJobs(): Job[] {
  return [...jobs.values()];
}

export function posicionEnCola(jobId: string): number {
  return cola.findIndex((c) => c.job.job_id === jobId) + 1;
}

/** Promesa que se resuelve cuando el job termina (para tests y scripts). */
export async function esperarJob(jobId: string, intervaloMs = 500): Promise<Job> {
  for (;;) {
    const j = jobs.get(jobId);
    if (!j) throw new Error(`No existe el job ${jobId}`);
    if (j.estado === "terminado" || j.estado === "error") return j;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
}

async function siguiente(): Promise<void> {
  if (ocupado) return;
  const item = cola.shift();
  if (!item) return;
  ocupado = true;
  try {
    await ejecutarJob(item.job, item.prep, item.o);
  } catch (e) {
    item.job.estado = "error";
    item.job.error = (e as Error).message;
    log.error(`Job ${item.job.job_id} falló:`, e);
  } finally {
    item.job.terminado = new Date().toISOString();
    ocupado = false;
    void siguiente();
  }
}

export interface ResultadoCheck {
  errores: string[];
  avisos: string[];
}

/** `hyperframes check --json`: los errores paran el render; los avisos se agrupan por regla. */
export async function comprobarComposicion(dir: string, env: NodeJS.ProcessEnv, gpu: boolean, alLinea?: (l: string) => void): Promise<ResultadoCheck> {
  const args = [HYPERFRAMES_BIN, "check", dir, "--json", "--no-contrast"];
  if (gpu) args.push("--browser-gpu");
  // CI=1: sin esto `check` deja un proceso "caliente" 5 minutos con la carpeta abierta, y en Windows eso
  // impide regenerar _composicion\ en el siguiente render. El cwd va fuera de la composición por lo mismo.
  const r = await ejecutar(process.execPath, args, { cwd: path.dirname(dir), env: { ...env, CI: "1" }, timeoutMs: TIMEOUT_CHECK_MS });
  if (r.timeout) {
    return { errores: [`La CLI de HyperFrames superó el tiempo máximo de comprobación (${duracionLegible(TIMEOUT_CHECK_MS)}).`], avisos: [] };
  }
  const errores: string[] = [];
  const porCodigo = new Map<string, { n: number; ejemplo: string }>();
  try {
    type Hallazgo = { severity?: string; code?: string; message?: string; sourceFile?: string; time?: number };
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as Record<string, unknown> & { ok?: boolean };
    // Secciones: lint, runtime, layout, motion, contrast… cada una con su lista de findings.
    const hallazgos: Hallazgo[] = [];
    for (const v of Object.values(j)) {
      if (v && typeof v === "object" && Array.isArray((v as { findings?: unknown }).findings)) hallazgos.push(...((v as { findings: Hallazgo[] }).findings));
    }
    for (const f of hallazgos) {
      const donde = f.sourceFile ? ` [${path.basename(f.sourceFile)}${f.time ? ` @${f.time}s` : ""}]` : "";
      const linea = `${f.severity ?? ""} ${f.code ?? ""}: ${f.message ?? ""}${donde}`.trim();
      alLinea?.(`check ${linea}`);
      if (f.severity === "error") errores.push(linea);
      else if (f.severity === "warning" && f.code && !AVISOS_ESPERADOS.test(f.code)) {
        const p = porCodigo.get(f.code);
        porCodigo.set(f.code, { n: (p?.n ?? 0) + 1, ejemplo: p?.ejemplo ?? f.message ?? "" });
      }
    }
    if (j.ok === false && !errores.length && r.code !== 0) errores.push("check terminó con errores sin detalle.");
  } catch {
    for (const l of (r.stdout + "\n" + r.stderr).split(/\r?\n/)) alLinea?.(l);
    if (r.code !== 0) errores.push(`check terminó con código ${r.code}.`);
  }
  return { errores, avisos: [...porCodigo].map(([c, { n, ejemplo }]) => `check ${c} (×${n}): ${ejemplo}`) };
}

async function ejecutarJob(job: Job, prep: Preparado, o: OpcionesRender): Promise<void> {
  job.estado = "renderizando";
  job.fase = "composicion";
  const h = prep.herramientas;
  const env = entornoConFfmpeg(h, o.browserPath ? { HYPERFRAMES_BROWSER_PATH: o.browserPath } : {});

  const montaje = await montarComposicion(prep, prep.rutas.composicion, o);
  job.avisos.push(...montaje.avisos);

  job.fase = "check";
  const check = await comprobarComposicion(prep.rutas.composicion, env, montaje.usaWebgpu, (l) => anotar(job, l));
  job.avisos.push(...check.avisos);
  if (check.errores.length) {
    throw new Error(`hyperframes check encontró ${check.errores.length} error(es): ${check.errores.slice(0, 5).join(" | ")}`);
  }

  // Render a un archivo temporal y renombrado al final: un fallo no deja un mp4 a medias donde lo busca la subida.
  job.fase = "render";
  job.progreso = 0;
  const temporal = path.join(path.dirname(prep.rutas.mp4), `${prep.id}.renderizando.mp4`);
  fs.rmSync(temporal, { force: true });
  const args = [HYPERFRAMES_BIN, "render", prep.rutas.composicion, "-o", temporal, "--fps", "30", "--format", "mp4", "--quality", "delivery"];
  if (montaje.usaWebgpu) args.push("--browser-gpu");
  const r = await ejecutar(process.execPath, args, { cwd: prep.rutas.composicion, env, onLinea: (l) => anotar(job, l), timeoutMs: timeoutRenderMs() });
  if (r.timeout) {
    fs.rmSync(temporal, { force: true });
    throw new Error(`La CLI de HyperFrames superó el tiempo máximo de render (${duracionLegible(timeoutRenderMs())}).`);
  }
  if (r.code !== 0 || !fs.existsSync(temporal)) {
    fs.rmSync(temporal, { force: true });
    throw new Error(`La CLI de HyperFrames terminó con código ${r.code}.`);
  }

  job.fase = "verificacion";
  const info = await sondear(h.ffprobe, temporal);
  if (info.ancho !== 1080 || info.alto !== 1920) {
    throw new Error(`El mp4 salió de ${info.ancho}×${info.alto} y tenía que ser 1080×1920.`);
  }
  if (!info.tieneAudio) job.avisos.push("El mp4 no tiene pista de audio.");
  fs.rmSync(prep.rutas.mp4, { force: true });
  fs.renameSync(temporal, prep.rutas.mp4);
  job.duracion = info.duracion;
  job.progreso = 100;
  job.fase = undefined;
  job.estado = "terminado";
  log.info(`Job ${job.job_id} terminado: ${prep.rutas.mp4} (${info.duracion?.toFixed(2)} s).`);
}
