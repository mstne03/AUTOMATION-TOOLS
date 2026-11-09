// Montaje de un Proyecto (T6): voz por frases → línea de tiempo → composición, para la preview (`_composicion/r<n>/`) y para el
// render (`_render/<job>/`). Todo sale del Proyecto ya validado y de la voz ya generada; ninguna ruta ni texto llega de la UI.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { ResultadoAlineacion } from "./alineacion.js";
import { FONDOS_WEBGPU } from "./formato.js";
import { DURACION_MAXIMA, escribirPlan, planificarComposicion, urlsDeRed, type Tema } from "./composicion.js";
import type { Proyecto } from "./esquema.js";
import { construirLinea, desdeProyecto } from "./linea.js";
import { normalizarVoz } from "./musica.js";
import { ErrorVideo, archivosVideo, borrarArbol, validarId } from "./paths.js";
import { cargarPerfil, temaDePerfil } from "./perfil.js";
import { herramientasFfmpeg, mensajeSinFfmpeg, type Herramientas } from "./proceso.js";
import { ensamblarVoz, vozDeProyecto } from "./voz.js";

export interface PreparadoProyecto {
  id: string;
  proyecto: Proyecto;
  palabras: ResultadoAlineacion;
  /** WAV de la voz ya normalizado (caché por hash del ensamblado). */
  voz: string;
  rutas: ReturnType<typeof archivosVideo>;
  /** Solo hace falta ffmpeg para normalizar; con la caché caliente puede ser null (preview rápida). */
  herramientas: Herramientas | null;
  tema: Tema;
  avisos: string[];
}

export interface Montaje {
  duracion: number;
  usaWebgpu: boolean;
  avisos: string[];
  /** Fondo pedido y fondo usado: `css` es el degradado de reserva (I11: nunca en silencio). */
  fondo: { pedido: string; usado: string };
}

// Un montaje a la vez por proceso: el contador de la preview y la caché de audio no admiten dos escritores.
let turno: Promise<unknown> = Promise.resolve();
export function enSerie<T>(f: () => Promise<T>): Promise<T> {
  const r = turno.then(f, f);
  turno = r.catch(() => undefined);
  return r;
}

const esFichero = (ruta: string): boolean => {
  try {
    const s = fs.lstatSync(ruta);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
};

/**
 * Voz normalizada a −14 LUFS en la carpeta de voz, con el hash del ensamblado en el nombre: mientras las frases y sus
 * recortes no cambien, un cambio de texto de una escena no repite `loudnorm`. Se conservan las dos más recientes.
 */
async function normalizadaEnCache(wav: string, h: Herramientas | null): Promise<string> {
  const destino = path.join(path.dirname(wav), path.basename(wav).replace(/^ensamblada-/, "normalizada-"));
  if (esFichero(destino)) return destino;
  if (!h) throw new ErrorVideo(mensajeSinFfmpeg());
  const tmp = `${destino}.tmp-${process.pid}`;
  try {
    await normalizarVoz(h, wav, tmp);
    fs.renameSync(tmp, destino);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const otras = fs
    .readdirSync(path.dirname(destino))
    .filter((n) => /^normalizada-[0-9a-f]{32}\.wav$/.test(n) && n !== path.basename(destino))
    .map((n) => ({ n, t: fs.statSync(path.join(path.dirname(destino), n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const o of otras.slice(1)) fs.rmSync(path.join(path.dirname(destino), o.n), { force: true });
  return destino;
}

/** Valida todo antes de montar. `voz_pendiente` (con la lista de frases) si falta alguna voz; nunca llama a ElevenLabs. */
export async function prepararProyecto(id: string, o: { cfg: Config; tema?: Tema }): Promise<PreparadoProyecto> {
  validarId(id);
  const { proyecto, voz } = vozDeProyecto(o.cfg, id);
  const palabras = construirLinea(proyecto, voz);
  if (!(palabras.duracionAudio <= DURACION_MAXIMA)) throw new ErrorVideo(`La voz dura ${palabras.duracionAudio} s y el máximo es ${DURACION_MAXIMA} s.`);
  const herramientas = herramientasFfmpeg(o.cfg.ffmpegDir);
  const wav = await ensamblarVoz(o.cfg, id);
  const normalizada = await normalizadaEnCache(wav, herramientas);
  const tema = o.tema ?? temaDePerfil(cargarPerfil(o.cfg.videoRoot, proyecto.perfilId));
  return { id, proyecto, palabras, voz: normalizada, rutas: archivosVideo(o.cfg.videoRoot, id), herramientas, tema, avisos: [] };
}

/** Escribe la composición completa en `destino` (una carpeta nueva: `escribirPlan` la vacía antes con `borrarArbol`). */
export function montarProyecto(prep: PreparadoProyecto, destino: string, gpu: boolean): Montaje {
  const plan = planificarComposicion({ ...desdeProyecto(prep.proyecto, prep.palabras), palabras: prep.palabras, tema: prep.tema, gpu });
  escribirPlan(destino, plan);
  fs.copyFileSync(prep.voz, path.join(destino, "assets", "voz.wav"));
  const red = urlsDeRed(destino);
  if (red.length) throw new Error(`La composición tiene recursos de red y el render tiene que ser local: ${red.slice(0, 5).join("; ")}`);
  const pedido = prep.proyecto.opciones.fondo;
  const conShader = (FONDOS_WEBGPU as readonly string[]).includes(pedido);
  return { duracion: plan.duracion, usaWebgpu: plan.usaWebgpu, avisos: [...prep.avisos, ...plan.avisos], fondo: { pedido, usado: conShader && !gpu ? "css" : pedido } };
}

// ---------- Preview ----------

const CARPETA_R = /^r(\d+)$/;
const ultimoContador = new Map<string, number>();

function contadores(base: string): number[] {
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && CARPETA_R.test(e.name))
    .map((e) => Number(CARPETA_R.exec(e.name)![1]));
}

export interface ResultadoPreview {
  carpeta: string;
  duracion: number;
  avisos: string[];
  fondo: { pedido: string; usado: string };
}

/**
 * `video_montar_preview`: monta en `_composicion/r<n>/`. El número sale de un contador del motor (el mayor del disco o del
 * proceso, más uno), nunca de la UI; se conserva la inmediatamente anterior por si la preview abierta aún la está leyendo y
 * se borran las más viejas. `gpu` lo decide la UI (WebView2 puede diferir de Chrome for Testing).
 */
export function montarPreview(cfg: Config, a: { id: string; webgpu: boolean }): Promise<ResultadoPreview> {
  return enSerie(async () => {
    const prep = await prepararProyecto(a.id, { cfg });
    const base = prep.rutas.composicion;
    fs.mkdirSync(base, { recursive: true });
    const n = Math.max(0, ...contadores(base), ultimoContador.get(base) ?? 0) + 1;
    const m = montarProyecto(prep, path.join(base, `r${n}`), a.webgpu);
    ultimoContador.set(base, n);
    for (const k of contadores(base)) if (k < n - 1) borrarArbol(path.join(base, `r${k}`));
    return { carpeta: `r${n}`, duracion: m.duracion, avisos: m.avisos, fondo: m.fondo };
  });
}
