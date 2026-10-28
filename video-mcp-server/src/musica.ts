// Música v2: recorte con musica_desde, bucle, sonoridad, ducking bajo la voz y cortes al ritmo.
import fs from "node:fs";
import path from "node:path";
import { SERVER_ROOT } from "./raiz.js";
import { STATE_DIR } from "./estado.js";
import type { Palabra, Segmento } from "./alineacion.js";
import { ejecutar, entornoConFfmpeg, sondear, type Herramientas } from "./proceso.js";
import { log } from "./log.js";

/**
 * CLI de HyperFrames. VIDEO_HYPERFRAMES_BIN la sustituye (solo para tests: p. ej. un script que se
 * cuelga para probar el timeout). Se lee una vez, al cargar el módulo, y el entorno del proceso lo fija
 * quien lanza el motor, con la misma confianza que el PATH; en producción no se define.
 */
export const HYPERFRAMES_BIN =
  process.env.VIDEO_HYPERFRAMES_BIN || path.join(SERVER_ROOT, "node_modules", "hyperframes", "bin", "hyperframes.mjs");
export const EXTENSIONES_AUDIO = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

/** Sonoridad objetivo de la voz (LUFS integrados). La música se normaliza igual y luego baja a su volumen. */
export const LUFS_VOZ = -14;
const HUECO_MINIMO = 0.6;
const RAMPA = 0.25;
const SUBIDA_EN_HUECOS = 1.8;
const VENTANA_BEAT = 0.2;

export interface AnalisisAudio {
  duracion?: number;
  beats: number[];
  bpm?: number;
  lufs?: number;
}

/** `hyperframes audio --only beats,bpm,loudness --json` sobre un archivo. */
export async function analizarAudio(h: Herramientas, archivo: string): Promise<AnalisisAudio> {
  const r = await ejecutar(process.execPath, [HYPERFRAMES_BIN, "audio", archivo, "--only", "beats,bpm,loudness", "--json"], {
    env: entornoConFfmpeg(h),
    cwd: path.dirname(archivo),
    timeoutMs: 180000,
  });
  if (r.code !== 0) throw new Error(`hyperframes audio falló con ${path.basename(archivo)}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as {
    items?: { duration?: number; beats?: { times?: number[] }; bpm?: { value?: number }; loudness?: { lufsIntegrated?: number } }[];
  };
  const it = j.items?.[0] ?? {};
  return { duracion: it.duration, beats: it.beats?.times ?? [], bpm: it.bpm?.value, lufs: it.loudness?.lufsIntegrated };
}

/** Normaliza la voz a −14 LUFS sin cambiar su duración. */
export async function normalizarVoz(h: Herramientas, origen: string, destino: string): Promise<void> {
  const r = await ejecutar(
    h.ffmpeg,
    ["-y", "-v", "error", "-i", origen, "-af", `loudnorm=I=${LUFS_VOZ}:TP=-1.5:LRA=11`, "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", destino],
    { timeoutMs: 120000 },
  );
  if (r.code !== 0) throw new Error(`ffmpeg no pudo normalizar la voz: ${r.stderr.trim().slice(0, 300)}`);
}

/** Recorta desde `desde`, repite en bucle hasta `duracion` y normaliza la pista a la misma sonoridad que la voz. */
export async function prepararMusica(h: Herramientas, origen: string, destino: string, desde: number, duracion: number): Promise<void> {
  const args = ["-y", "-v", "error"];
  if (desde > 0) args.push("-ss", desde.toFixed(3));
  args.push("-stream_loop", "-1", "-i", origen, "-t", duracion.toFixed(3), "-vn", "-af", `loudnorm=I=${LUFS_VOZ}:TP=-1.5:LRA=11`, "-ar", "44100", "-c:a", "libmp3lame", "-q:a", "2", destino);
  const r = await ejecutar(h.ffmpeg, args, { timeoutMs: 180000 });
  if (r.code !== 0) throw new Error(`ffmpeg no pudo preparar la música (${path.basename(origen)}): ${r.stderr.trim().slice(0, 300)}`);
}

/** Huecos de voz de al menos 0,6 s, sacados de los tiempos por palabra (más exactos que un silencedetect). */
export function huecosDeVoz(palabras: Palabra[], duracion: number): [number, number][] {
  const huecos: [number, number][] = [];
  let anterior = 0;
  for (const p of palabras) {
    if (p.inicio - anterior >= HUECO_MINIMO) huecos.push([anterior, p.inicio]);
    anterior = Math.max(anterior, p.fin);
  }
  if (duracion - anterior >= HUECO_MINIMO) huecos.push([anterior, duracion]);
  return huecos;
}

/** Carril de volumen (data-automation) que sube la música ×1,8 en los huecos de voz con rampas de 0,25 s. */
export function automatizacionDucking(huecos: [number, number][]): string {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const puntos: { t: number; v: number }[] = [{ t: 0, v: 1 }];
  for (const [a, b] of huecos) {
    const rampa = Math.min(RAMPA, (b - a) / 2);
    puntos.push({ t: r3(a), v: 1 }, { t: r3(a + rampa), v: SUBIDA_EN_HUECOS }, { t: r3(b - rampa), v: SUBIDA_EN_HUECOS }, { t: r3(b), v: 1 });
  }
  const unicos = puntos.filter((p, i) => i === 0 || p.t > puntos[i - 1].t).slice(0, 512);
  return JSON.stringify({ version: 1, lanes: [{ target: "volume", points: unicos }] });
}

/**
 * Mueve cada cambio de bloque (salvo el primero) al beat más cercano si está a ±0,2 s, sin salirse del hueco
 * entre la última palabra del bloque anterior y la primera del bloque. Devuelve el nuevo `mostrarDesde`.
 */
export function ajustarCortes(segmentos: Segmento[], palabras: Palabra[], beats: number[]): { desde: number[]; movidos: number } {
  const desde = segmentos.map((s) => s.mostrarDesde);
  let movidos = 0;
  for (let k = 1; k < segmentos.length; k++) {
    const s = segmentos[k];
    const previas = palabras.filter((p) => p.segmento === segmentos[k - 1].n);
    const minimo = previas.length ? previas[previas.length - 1].fin : segmentos[k - 1].inicio;
    const maximo = s.inicio;
    const original = s.mostrarDesde;
    let mejor: number | undefined;
    for (const b of beats) {
      if (Math.abs(b - original) > VENTANA_BEAT || b < minimo || b > maximo) continue;
      if (mejor === undefined || Math.abs(b - original) < Math.abs(mejor - original)) mejor = b;
    }
    if (mejor !== undefined && Math.abs(mejor - original) > 0.001) {
      desde[k] = Math.round(mejor * 1000) / 1000;
      movidos++;
    }
  }
  return { desde, movidos };
}

// ---------- Biblioteca de música (video_musica) ----------

export interface Pista {
  archivo: string;
  ruta: string;
  duracion?: number;
  bpm?: number;
  lufs?: number;
  error?: string;
}

const CACHE = path.join(STATE_DIR, "musica-cache.json");

function leerCache(): Record<string, Pista & { clave: string }> {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

export async function listarMusica(h: Herramientas, carpeta: string): Promise<Pista[]> {
  let nombres: string[] = [];
  try {
    nombres = fs.readdirSync(carpeta).filter((n) => EXTENSIONES_AUDIO.includes(path.extname(n).toLowerCase())).sort();
  } catch {
    return [];
  }
  const cache = leerCache();
  const pistas: Pista[] = [];
  for (const nombre of nombres) {
    const ruta = path.join(carpeta, nombre);
    const st = fs.statSync(ruta);
    const clave = `${st.size}:${st.mtimeMs}`;
    const previa = cache[ruta];
    if (previa && previa.clave === clave) {
      pistas.push({ archivo: nombre, ruta, duracion: previa.duracion, bpm: previa.bpm, lufs: previa.lufs });
      continue;
    }
    const p: Pista = { archivo: nombre, ruta };
    try {
      const a = await analizarAudio(h, ruta);
      p.duracion = a.duracion ?? (await sondear(h.ffprobe, ruta)).duracion;
      p.bpm = a.bpm;
      p.lufs = a.lufs;
    } catch (e) {
      p.error = (e as Error).message;
      log.warn(`No pude analizar ${nombre}: ${p.error}`);
    }
    pistas.push(p);
    if (!p.error) cache[ruta] = { ...p, clave };
  }
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  } catch {
    /* sin caché */
  }
  return pistas;
}
