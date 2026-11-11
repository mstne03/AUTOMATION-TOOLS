// Montaje de un Proyecto (T6): voz por frases → línea de tiempo → composición, para la preview (`_composicion/r<n>/`) y para el
// render (`_render/<job>/`). Todo sale del Proyecto ya validado y de la voz ya generada; ninguna ruta ni texto llega de la UI.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { ResultadoAlineacion } from "./alineacion.js";
import { FONDOS_WEBGPU } from "./formato.js";
import { DURACION_MAXIMA, escribirPlan, planificarComposicion, urlsDeRed, type CapaPlan, type Tema } from "./composicion.js";
import type { Proyecto } from "./esquema.js";
import { construirLinea, desdeProyecto } from "./linea.js";
import { normalizarVoz } from "./musica.js";
import { ErrorVideo, archivosVideo, borrarArbol, comprobarRecurso, resolverDentro, validarId } from "./paths.js";
import { cargarPerfil, temaDePerfil } from "./perfil.js";
import { herramientasFfmpeg, mensajeSinFfmpeg, pasaPorEnlace, type Herramientas } from "./proceso.js";
import { log } from "./log.js";
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
  const tmp = `${destino}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
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

/**
 * La capa de una escena (T7) con los ficheros ya normalizados de `recursos/`: el nombre sale del id del recurso (nunca del nombre
 * del usuario), cada fichero es normal y sin enlaces (I6) y está dentro de la carpeta de recursos del proyecto.
 */
function resolverCapa(prep: PreparadoProyecto, c: NonNullable<PreparadoProyecto["proyecto"]["escenas"][number]["capa"]>): CapaPlan {
  const r = prep.proyecto.recursos.find((x) => x.id === c.recursoId);
  if (!r) throw new ErrorVideo("Una escena usa un recurso que ya no está en el proyecto.");
  if (r.clase !== "foto" && r.clase !== "clip") throw new ErrorVideo("Una capa solo puede llevar una foto o un clip.");
  const dir = path.join(prep.rutas.dir, "recursos");
  const fichero = (nombre: string): string => {
    const ruta = resolverDentro(dir, nombre);
    comprobarRecurso(ruta);
    return ruta;
  };
  const ext = r.clase === "foto" ? "png" : "mp4";
  if (r.ext !== ext) throw new ErrorVideo("El recurso de la capa no está normalizado.");
  const fondo = r.clase === "clip" && r.ancho > r.alto && fs.existsSync(path.join(dir, `${r.id}.fondo.png`)) ? fichero(`${r.id}.fondo.png`) : undefined;
  return { clase: r.clase, origen: fichero(`${r.id}.${ext}`), ext, ...(fondo ? { fondo } : {}), ancho: r.ancho, alto: r.alto, modo: c.modo, encuadre: c.encuadre, entrada: c.entrada, salida: c.salida };
}

/** Escribe la composición completa en `destino` (una carpeta nueva: `escribirPlan` la vacía antes con `borrarArbol`). */
export function montarProyecto(prep: PreparadoProyecto, destino: string, gpu: boolean): Montaje {
  const entrada = desdeProyecto(prep.proyecto, prep.palabras);
  const escenas = entrada.escenas.map((e, k) => {
    const c = prep.proyecto.escenas[k].capa;
    return c ? { ...e, capa: resolverCapa(prep, c) } : e;
  });
  const plan = planificarComposicion({ ...entrada, escenas, palabras: prep.palabras, tema: prep.tema, gpu });
  escribirPlan(destino, plan);
  // R2-L1, T7: HyperFrames transcodifica por su cuenta los vídeos «hostiles» (ffmpeg fuera de `ejecutar`) salvo que el proyecto diga lo contrario.
  // Los clips ya entran normalizados, pero la composición lo cierra también aquí, además del `--no-proxy` de `check`.
  fs.writeFileSync(path.join(destino, "hyperframes.json"), JSON.stringify({ media: { autoProxy: false } }));
  fs.copyFileSync(prep.voz, path.join(destino, "assets", "voz.wav"));
  const red = urlsDeRed(destino);
  if (red.length) throw new Error(`La composición tiene recursos de red y el render tiene que ser local: ${red.slice(0, 5).join("; ")}`);
  const pedido = prep.proyecto.opciones.fondo;
  const conShader = (FONDOS_WEBGPU as readonly string[]).includes(pedido);
  return { duracion: plan.duracion, usaWebgpu: plan.usaWebgpu, avisos: [...prep.avisos, ...plan.avisos], fondo: { pedido, usado: conShader && !gpu ? "css" : pedido } };
}

/**
 * Antes de escribir o borrar en `_composicion/` o `_render/` (L-2): se crea si falta y no puede pasar, ni ella ni sus
 * padres, por un enlace simbólico o junction (se escribiría y borraría fuera de VIDEO_ROOT). Falla cerrado.
 */
export function carpetaDeSalida(base: string): void {
  fs.mkdirSync(base, { recursive: true });
  if (pasaPorEnlace(base)) throw new ErrorVideo("La carpeta de montaje es un enlace o pasa por uno (junction o symlink): no la uso.");
}

// ---------- Huérfanas ----------

const EDAD_SIN_MARCA_MS = 10 * 60_000;
const vivo = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * L-7: al arrancar, borra las `_render/<job>` que dejó un motor muerto, con `borrarArbol` y solo bajo `VIDEO_ROOT/<id>/_render`.
 * Hay dos motores vivos (general y render): una carpeta es huérfana si su marca `.motor` apunta a un pid muerto, o si no tiene
 * marca y lleva más de 10 minutos. Las carpetas de enlace se saltan.
 */
export function barrerRenderHuerfanos(raiz: string): number {
  let borradas = 0;
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(raiz).filter((n) => /^video\d{3}$/.test(n));
  } catch {
    return 0;
  }
  for (const id of ids) {
    const base = path.join(raiz, id, "_render");
    try {
      if (!fs.lstatSync(base).isDirectory() || pasaPorEnlace(base)) continue;
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        const dir = path.join(base, e.name);
        // Marca ausente, vacía o ilegible (la otra instancia puede estar escribiéndola): solo cuenta la edad (L-7a).
        let pid = NaN;
        try {
          pid = Number(fs.readFileSync(path.join(dir, ".motor"), "utf8").trim());
        } catch {
          /* sin marca */
        }
        const huerfana = Number.isInteger(pid) && pid > 0 ? !vivo(pid) : Date.now() - fs.statSync(dir).mtimeMs > EDAD_SIN_MARCA_MS;
        if (huerfana) {
          borrarArbol(dir);
          borradas++;
        }
      }
    } catch (e) {
      log.warn(`Barrido de _render de ${id}: ${(e as Error).message}`);
    }
  }
  return borradas;
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
    carpetaDeSalida(base);
    const n = Math.max(0, ...contadores(base), ultimoContador.get(base) ?? 0) + 1;
    const m = montarProyecto(prep, path.join(base, `r${n}`), a.webgpu);
    ultimoContador.set(base, n);
    for (const k of contadores(base)) if (k < n - 1) borrarArbol(path.join(base, `r${k}`));
    return { carpeta: `r${n}`, duracion: m.duracion, avisos: m.avisos, fondo: m.fondo };
  });
}
