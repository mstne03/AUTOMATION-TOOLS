// Comprobaciones previas, montaje de la composición, cola de renders (uno a la vez) y estado de cada job.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import { parsearGuion, type Guion } from "./guion.js";
import type { ResultadoAlineacion } from "./alineacion.js";
import { bloquesConFoto } from "./formato.js";
import { cargarTema, escribirPlan, planificarComposicion, urlsDeRed, type Tema } from "./composicion.js";
import { archivosVideo, comprobarRecurso, imagenesValidadas, ErrorVideo, resolverDentro, type ImagenEncontrada } from "./paths.js";
import { argsEntrada, ejecutar, ErrorNavegador, esIntegrado, herramientasFfmpeg, mensajeSinFfmpeg, sondear, type Herramientas, type InfoMedio, type Resultado } from "./proceso.js";
import { ajustarCortes, analizarAudio, automatizacionDucking, HYPERFRAMES_BIN, huecosDeVoz, normalizarVoz, prepararMusica } from "./musica.js";
import { hayWebgpu } from "./capacidades.js";

export { HYPERFRAMES_BIN };

export const TIMEOUT_CHECK_MS = 600_000;
const MAX_SETTIMEOUT_MS = 2_147_483_647;

/**
 * Timeout de cada ejecución de la CLI (y de la segunda pasada): 5 min + 40 s por segundo de vídeo
 * (50 s → 38 min; el spike midió 8,6–13,8 min). VIDEO_TIMEOUT_RENDER_S lo sustituye solo fuera del
 * integrado (pruebas). setTimeout dispara al instante por encima de 2^31-1 ms: se recorta a ese máximo.
 */
export function timeoutPasadaMs(duracionS: number, env: NodeJS.ProcessEnv = process.env): number {
  const s = Number(env.VIDEO_TIMEOUT_RENDER_S);
  const ms = !esIntegrado(env) && Number.isFinite(s) && s > 0 ? s * 1000 : 300_000 + duracionS * 40_000;
  return Math.min(ms, MAX_SETTIMEOUT_MS);
}

/** Error de tiempo máximo: no dispara la reserva Rápido→Compatible (repetirlo costaría otra media hora). */
export class ErrorTiempo extends Error {}

// ---------- Codificadores (D11) ----------

/** Codificadores H.264 que el motor admite en el MP4 final (todos LGPL; nunca libx264 ni libopenh264). */
export type CodificadorH264 = "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_mf";
export const CODIFICADORES: readonly CodificadorH264[] = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"];

/** Modo de Automático: Compatible (codificador predecible) hasta que un parche fije el de Rápido. */
export const MODO_AUTOMATICO: "rapido" | "compatible" = "compatible";

/** Argumentos provisionales de la segunda pasada (INFORME-codificacion.md); pendientes de medir con fotos reales. */
export const ARGS_CODIFICADOR: Record<CodificadorH264, string[]> = {
  h264_nvenc: ["-preset", "p5", "-rc", "vbr", "-b:v", "12M", "-maxrate", "16M", "-profile:v", "high"],
  h264_qsv: ["-preset", "medium", "-b:v", "12M", "-maxrate", "16M"],
  h264_amf: ["-rc", "vbr_peak", "-b:v", "12M", "-maxrate", "16M"],
  h264_mf: ["-b:v", "12M"],
};

export const FABRICANTE: Record<CodificadorH264, string> = {
  h264_nvenc: "NVIDIA",
  h264_qsv: "Intel",
  h264_amf: "AMD",
  h264_mf: "Media Foundation (Windows)",
};

/** Si el ffmpeg los trae, no es el LGPL del bundle (I4, I11). */
const PROHIBIDOS = ["libx264", "libx264rgb", "libx265", "libopenh264"];

/**
 * Lee `ffmpeg -encoders`: qué codificadores admitidos trae y cuáles prohibidos. Integrado, uno
 * prohibido es error (alguien cambió el ffmpeg); en desarrollo, aviso.
 */
export function revisarEncoders(listado: string, integrado: boolean): { presentes: CodificadorH264[]; prohibidos: string[] } {
  const tiene = (c: string) => new RegExp(`^\\s*\\S+\\s+${c}\\s`, "m").test(listado);
  const presentes = CODIFICADORES.filter(tiene);
  const prohibidos = PROHIBIDOS.filter(tiene);
  if (prohibidos.length) {
    const texto = `El ffmpeg del motor no es el LGPL del bundle (trae ${prohibidos.join(", ")}).`;
    if (integrado) throw new ErrorVideo(`${texto} Reinstala SEO Studio.`);
    log.warn(`${texto} En desarrollo se tolera; el MP4 nunca sale con ellos.`);
  }
  return { presentes, prohibidos };
}

let sondeo: Promise<CodificadorH264[]> | undefined;

/**
 * Codificadores H.264 que funcionan en esta máquina, en orden nvenc, qsv, amf, mf: cada uno codifica
 * un fotograma, en serie (en paralelo se pisan, que es lo que rompe la sonda de HyperFrames). Caché
 * en memoria del proceso: los drivers pueden cambiar entre arranques.
 */
export function sondearCodificadores(h: Herramientas): Promise<CodificadorH264[]> {
  sondeo ??= (async () => {
    const r = await ejecutar(h.ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`ffmpeg -encoders falló: ${r.stderr.trim().slice(0, 300)}`);
    const { presentes } = revisarEncoders(r.stdout, esIntegrado());
    const funcionan: CodificadorH264[] = [];
    for (const c of presentes) {
      const p = await ejecutar(
        h.ffmpeg,
        ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=size=1080x1920:rate=30:duration=1", "-frames:v", "1", "-c:v", c, "-f", "null", "-"],
        { timeoutMs: 30_000 },
      );
      if (p.code === 0) funcionan.push(c);
      else log.info(`Sondeo: ${c} no funciona en esta máquina (${p.timeout ? "timeout" : `código ${p.code}`}).`);
    }
    log.info(`Sondeo de codificadores: ${funcionan.join(", ") || "ninguno"}.`);
    return funcionan;
  })();
  // Un fallo no se cachea: el siguiente render lo reintenta.
  sondeo.catch(() => (sondeo = undefined));
  return sondeo;
}

/** Inyectable para los tests (simular una GPU en una máquina sin ella). */
export const dependencias = { sondear: sondearCodificadores };

/** Codificadores de GPU disponibles en orden y h264_mf siempre al final: es la última reserva y su fallo se verá. */
export function ordenSegundaPasada(disponibles: CodificadorH264[]): CodificadorH264[] {
  return [...CODIFICADORES.filter((c) => c !== "h264_mf" && disponibles.includes(c)), "h264_mf"];
}

export function elegirModo(pedido: "auto" | "rapido" | "compatible", disponibles: CodificadorH264[]): "rapido" | "compatible" {
  const quiere = pedido === "auto" ? MODO_AUTOMATICO : pedido;
  return quiere === "rapido" && disponibles.some((c) => c !== "h264_mf") ? "rapido" : "compatible";
}

const MiB = 1024 * 1024;

/** ProRes 4444 ocupa ~16 MB/s; si no cabe, webm (D11, I15.4); si ni eso, error antes de renderizar. */
export function elegirIntermedio(libresBytes: number, duracionS: number): "mov" | "webm" {
  const necesarioMov = Math.ceil(duracionS) * 16 * MiB * 1.25 + 512 * MiB;
  if (libresBytes >= necesarioMov) return "mov";
  if (libresBytes >= 512 * MiB) return "webm";
  throw new ErrorVideo(
    `No hay espacio para renderizar: hacen falta al menos 512 MB libres (${Math.ceil(necesarioMov / MiB)} MB para la calidad máxima) y hay ${Math.floor(libresBytes / MiB)} MB.`,
  );
}

/** Segunda pasada con el ffmpeg del bundle: solo ficheros locales y el demuxer del intermedio explícito. */
export function segundaPasada(h: Herramientas, intermedio: string, formato: "mov" | "webm", salida: string, cod: CodificadorH264, timeoutMs: number): Promise<Resultado> {
  return ejecutar(
    h.ffmpeg,
    [
      "-y", "-v", "error", ...argsEntrada(intermedio, formato === "mov" ? "mov" : "matroska"), "-i", intermedio,
      "-c:v", cod, ...ARGS_CODIFICADOR[cod], "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", salida,
    ],
    { timeoutMs },
  );
}

/** ¿Un fallo de Rápido justifica repetir en Compatible? No si es del navegador, de disco o de tiempo. */
export function disparaReserva(e: unknown): boolean {
  return !(e instanceof ErrorNavegador || e instanceof ErrorVideo || e instanceof ErrorTiempo);
}

// ---------- Verificación del MP4 (I11) ----------

const FPS = 30;
const TOLERANCIA_DURACION_S = 0.1;
const TOLERANCIA_FPS = 0.01;
const TOLERANCIA_FOTOGRAMAS = 3;

/** Último token de la etiqueta `encoder` que nombra un codificador ("Lavc61.19.101 h264_amf" → "h264_amf"). */
export function codificadorDeEtiqueta(etiqueta?: string): string | undefined {
  return etiqueta
    ?.trim()
    .split(/\s+/)
    .reverse()
    .find((t) => t.startsWith("h264_") || t.startsWith("lib"));
}

/**
 * El MP4 tiene que ser exactamente lo pedido; si no, el job falla (nada de dar por bueno un MP4 sin
 * audio). `codificador`, si se pasa, es el que el motor usó en la segunda pasada.
 */
export function verificarMp4(info: InfoMedio, duracionEsperada: number, codificador?: CodificadorH264): void {
  if (info.ancho !== 1080 || info.alto !== 1920) throw new Error(`El mp4 salió de ${info.ancho}×${info.alto} y tenía que ser 1080×1920.`);
  if (info.codecVideo !== "h264") throw new Error(`El mp4 salió en ${info.codecVideo ?? "un códec desconocido"} y tenía que ser h264.`);
  if (info.pistasVideo !== 1 || info.pistasAudio !== 1) {
    if (!info.pistasAudio) throw new Error("El mp4 salió sin pista de audio.");
    throw new Error(`El mp4 tiene ${info.pistasVideo ?? "?"} pistas de vídeo y ${info.pistasAudio} de audio; tenía que tener 1 y 1.`);
  }
  const cod = codificadorDeEtiqueta(info.codificador);
  if (!cod || !(CODIFICADORES as readonly string[]).includes(cod) || (codificador && cod !== codificador)) {
    throw new Error(`El mp4 salió con el codificador ${cod ?? "desconocido"} y tenía que ser ${codificador ?? CODIFICADORES.join(", ")}.`);
  }
  for (const [nombre, v] of [["r_frame_rate", info.fps], ["avg_frame_rate", info.fpsMedio]] as const) {
    if (v === undefined || Math.abs(v - FPS) > TOLERANCIA_FPS) throw new Error(`El mp4 salió a ${v?.toFixed(2) ?? "?"} fps (${nombre}) y tenía que ser ${FPS}.`);
  }
  for (const [nombre, v] of [["vídeo", info.duracionVideo], ["audio", info.duracionAudio]] as const) {
    if (v === undefined || Math.abs(v - duracionEsperada) > TOLERANCIA_DURACION_S) {
      throw new Error(`La duración del ${nombre} del mp4 es ${v?.toFixed(2) ?? "desconocida"} s y tenía que ser ${duracionEsperada.toFixed(2)} s.`);
    }
  }
  const fotogramas = Math.round(duracionEsperada * FPS);
  if (info.nbFrames !== undefined && Math.abs(info.nbFrames - fotogramas) > TOLERANCIA_FOTOGRAMAS) {
    throw new Error(`El mp4 tiene ${info.nbFrames} fotogramas y tenía que tener ${fotogramas}.`);
  }
  // El índice del contenedor tiene que cuadrar con los paquetes que hay de verdad.
  if (info.nbPaquetes === undefined || info.nbFrames === undefined || info.nbPaquetes !== info.nbFrames) {
    throw new Error(`El mp4 no es íntegro: declara ${info.nbFrames ?? "?"} fotogramas y se leen ${info.nbPaquetes ?? "?"} paquetes de vídeo.`);
  }
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
  /** Modo con el que salió el MP4 (D11). */
  modo?: "rapido" | "compatible";
  /** Codificador H.264 del MP4 final (h264_nvenc, h264_qsv, h264_amf o h264_mf). */
  codificador?: string;
  /** Fabricante del codificador: el adaptador que codificó. */
  adaptador?: string;
  /** Renderer de WebGL de la sonda de HyperFrames; es un diagnóstico, no navigator.gpu.requestAdapter(). */
  gpuChrome?: string;
  intermedio?: "mov" | "webm";
  /** Qué falló y a qué se recurrió, si hubo reserva (I11: nunca en silencio). */
  reserva?: string;
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
  tema?: Tema;
  /** D11; por defecto "auto" (= MODO_AUTOMATICO). Exponerlo en la tool es de la oleada 2. */
  modo?: "auto" | "rapido" | "compatible";
}

/** Valida todo antes de crear el job. Lanza ErrorVideo con un mensaje accionable si falta algo. */
export async function prepararRender(id: string, o: OpcionesRender): Promise<Preparado> {
  const rutas = archivosVideo(o.raiz, id);
  const herramientas = herramientasFfmpeg(o.ffmpegDir);
  if (!herramientas) throw new ErrorVideo(mensajeSinFfmpeg());
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
  comprobarRecurso(rutas.voz);
  comprobarRecurso(rutas.palabras);
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
    comprobarRecurso(ruta);
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
        const a = await analizarAudio(path.join(tmp, "musica.mp3"));
        const r = ajustarCortes(prep.palabras.segmentos, prep.palabras.palabras, a.beats);
        cortes = r.desde;
        avisos.push(
          `Cortes al ritmo: ${r.movidos} de 5 cambios de imagen movidos al beat${a.bpm ? ` (${Math.round(a.bpm)} BPM)` : ""}.` +
            (a.beats.length ? "" : " No se detectaron beats en la pista."),
        );
      }
    }
    const gpu = await hayWebgpu(h);
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

const LINEA_GPU = /^\[hyperframes\] browserGpuMode probe → \S+ \(WebGL renderer vendor="[^"]*" renderer="([^"]*)"\)/;

/** Renderer de la línea de la sonda de GPU. Anclada: a `anotar` también llegan hallazgos con texto de la composición (R0 L2). */
export function extraerGpuChrome(linea: string): string | undefined {
  const m = LINEA_GPU.exec(linea);
  return m?.[1].replace(/[^\w .,:;()/+-]/g, "").trim().slice(0, 120) || undefined;
}

function anotar(job: Job, linea: string): void {
  const limpia = linea.replace(ANSI_RE, "").replace(/[⠀-⣿]/g, "").trim();
  if (!limpia) return;
  job.gpuChrome ??= extraerGpuChrome(limpia);
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
export async function comprobarComposicion(dir: string, gpu: boolean, alLinea?: (l: string) => void): Promise<ResultadoCheck> {
  const args = [HYPERFRAMES_BIN, "check", dir, "--json", "--no-contrast"];
  if (gpu) args.push("--browser-gpu");
  // `ejecutar` fija CI=1 (sin él `check` deja un proceso "caliente" 5 minutos con la carpeta abierta) y
  // el cwd en hf-home, fuera de la composición.
  const r = await ejecutar(process.execPath, args, { timeoutMs: TIMEOUT_CHECK_MS });
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
    // I11: solo JSON válido, ok === true y código 0 dejan seguir.
    if ((j.ok !== true || r.code !== 0) && !errores.length) {
      const sinDetalle = j.ok === false ? "check terminó con errores sin detalle." : `check terminó con código ${r.code} y sin ok.`;
      errores.push(typeof j.error === "string" && j.error ? j.error : sinDetalle);
    }
  } catch {
    for (const l of (r.stdout + "\n" + r.stderr).split(/\r?\n/)) alLinea?.(l);
    errores.push(r.code === 0 ? "check terminó sin JSON válido." : `check terminó con código ${r.code}.`);
  }
  return { errores, avisos: [...porCodigo].map(([c, { n, ejemplo }]) => `check ${c} (×${n}): ${ejemplo}`) };
}

/** Lo que comparten las dos rutas de render de un job. */
interface ContextoRender {
  job: Job;
  prep: Preparado;
  montaje: Montaje;
  disponibles: CodificadorH264[];
  timeoutMs: number;
  /** MP4 temporal: un fallo no deja un mp4 a medias donde lo busca la subida. */
  temporal: string;
}

interface SalidaRender {
  info: InfoMedio;
  codificador: CodificadorH264;
}

/** Una ejecución de la CLI de render; lanza ErrorTiempo o Error con la última línea útil. */
async function renderCli(c: ContextoRender, salida: string, formato: "mp4" | "mov" | "webm"): Promise<void> {
  c.job.fase = "render";
  c.job.progreso = 0;
  const args = [HYPERFRAMES_BIN, "render", c.prep.rutas.composicion, "-o", salida, "--fps", "30", "--format", formato];
  if (formato === "mp4") args.push("--quality", "delivery");
  if (c.montaje.usaWebgpu) args.push("--browser-gpu");
  const r = await ejecutar(process.execPath, args, { onLinea: (l) => anotar(c.job, l), timeoutMs: c.timeoutMs });
  if (r.timeout) throw new ErrorTiempo(`La CLI de HyperFrames superó el tiempo máximo de render (${duracionLegible(c.timeoutMs)}).`);
  if (r.code !== 0 || !fs.existsSync(salida)) {
    const ultima = ultimasLineasUtiles(c.job, 1)[0];
    throw new Error(`La CLI de HyperFrames terminó con código ${r.code}${ultima ? ` (${ultima})` : ""}.`);
  }
}

async function verificarTemporal(c: ContextoRender, cod?: CodificadorH264): Promise<InfoMedio> {
  c.job.fase = "verificacion";
  const info = await sondear(c.prep.herramientas.ffprobe, c.temporal, { soloMp4: true });
  verificarMp4(info, c.montaje.duracion, cod);
  return info;
}

/** HyperFrames elige el codificador: se registra el real y se avisa si no es el que preferiría el motor. */
async function renderRapido(c: ContextoRender): Promise<SalidaRender> {
  await renderCli(c, c.temporal, "mp4");
  const info = await verificarTemporal(c);
  // verificarMp4 ya ha comprobado que la etiqueta es de un codificador admitido.
  const codificador = codificadorDeEtiqueta(info.codificador) as CodificadorH264;
  const preferido = c.disponibles.find((d) => d !== "h264_mf");
  if (preferido && codificador !== preferido) c.job.avisos.push(`HyperFrames eligió ${codificador}; el sondeo del motor prefería ${preferido}.`);
  return { info, codificador };
}

/** Segunda pasada por orden de preferencia hasta la primera que funcione; cada fallo queda registrado. */
async function codificarIntermedio(c: ContextoRender, intermedio: string, formato: "mov" | "webm"): Promise<CodificadorH264> {
  c.job.fase = "codificacion";
  const fallidos: string[] = [];
  for (const cod of ordenSegundaPasada(c.disponibles)) {
    const r = await segundaPasada(c.prep.herramientas, intermedio, formato, c.temporal, cod, c.timeoutMs);
    if (r.timeout) throw new ErrorTiempo(`La codificación con ${cod} superó el tiempo máximo (${duracionLegible(c.timeoutMs)}).`);
    if (r.code === 0) {
      if (fallidos.length) {
        const texto = `${fallidos.join(", ")} falló; se usó ${cod}.`;
        c.job.reserva = c.job.reserva ? `${c.job.reserva} ${texto}` : texto;
        c.job.avisos.push(texto);
      }
      return cod;
    }
    fallidos.push(cod);
    log.warn(`Job ${c.job.job_id}: la segunda pasada con ${cod} falló: ${r.stderr.trim().slice(-300)}`);
    fs.rmSync(c.temporal, { force: true });
  }
  throw new Error(`Ningún codificador H.264 pudo codificar el vídeo (${fallidos.join(", ")}).`);
}

/** HyperFrames saca un intermedio y la segunda pasada la hace el motor, con el codificador que ha sondeado. */
async function renderCompatible(c: ContextoRender): Promise<SalidaRender> {
  const carpeta = path.dirname(c.temporal);
  const formato = elegirIntermedio(espacioLibre(carpeta), c.montaje.duracion);
  c.job.intermedio = formato;
  const intermedio = path.join(carpeta, `${c.prep.id}.intermedio.${formato}`);
  fs.rmSync(intermedio, { force: true });
  try {
    await renderCli(c, intermedio, formato);
    const codificador = await codificarIntermedio(c, intermedio, formato);
    return { info: await verificarTemporal(c, codificador), codificador };
  } finally {
    fs.rmSync(intermedio, { force: true });
  }
}

async function ejecutarJob(job: Job, prep: Preparado, o: OpcionesRender): Promise<void> {
  job.estado = "renderizando";
  job.fase = "composicion";

  const montaje = await montarComposicion(prep, prep.rutas.composicion, o);
  job.avisos.push(...montaje.avisos);

  job.fase = "check";
  const check = await comprobarComposicion(prep.rutas.composicion, montaje.usaWebgpu, (l) => anotar(job, l));
  job.avisos.push(...check.avisos);
  if (check.errores.length) {
    throw new Error(`hyperframes check encontró ${check.errores.length} error(es): ${check.errores.slice(0, 5).join(" | ")}`);
  }

  const disponibles = await dependencias.sondear(prep.herramientas);
  const pedido = o.modo ?? "auto";
  let modo = elegirModo(pedido, disponibles);
  if (pedido === "rapido" && modo === "compatible") job.avisos.push("Rápido no disponible: no hay codificador H.264 de GPU; se usa Compatible.");
  const temporal = path.join(path.dirname(prep.rutas.mp4), `${prep.id}.renderizando.mp4`);
  fs.rmSync(temporal, { force: true });
  const c: ContextoRender = { job, prep, montaje, disponibles, timeoutMs: timeoutPasadaMs(montaje.duracion), temporal };

  let salida: SalidaRender | undefined;
  try {
    if (modo === "rapido") {
      try {
        salida = await renderRapido(c);
      } catch (e) {
        if (!disparaReserva(e)) throw e;
        fs.rmSync(temporal, { force: true });
        job.reserva = `Rápido falló (${(e as Error).message}); se repite en Compatible.`;
        job.avisos.push(job.reserva);
        log.warn(`Job ${job.job_id}: ${job.reserva}`);
        modo = "compatible";
      }
    }
    salida ??= await renderCompatible(c);
  } catch (e) {
    fs.rmSync(temporal, { force: true });
    throw e;
  }

  fs.rmSync(prep.rutas.mp4, { force: true });
  fs.renameSync(temporal, prep.rutas.mp4);
  job.modo = modo;
  job.codificador = salida.codificador;
  job.adaptador = FABRICANTE[salida.codificador];
  job.avisos.push(
    `Codificador: ${salida.codificador} (${job.adaptador}) · modo ${modo === "rapido" ? "Rápido" : "Compatible"}${job.intermedio === "webm" ? " · intermedio webm" : ""}`,
  );
  if (job.gpuChrome) job.avisos.push(`GPU de Chrome: ${job.gpuChrome}`);
  job.duracion = salida.info.duracion;
  job.progreso = 100;
  job.fase = undefined;
  job.estado = "terminado";
  log.info(`Job ${job.job_id} terminado: ${prep.rutas.mp4} (${salida.info.duracion?.toFixed(2)} s, ${salida.codificador}, modo ${modo}).`);
}

function espacioLibre(carpeta: string): number {
  const s = fs.statfsSync(carpeta);
  return s.bavail * s.bsize;
}
