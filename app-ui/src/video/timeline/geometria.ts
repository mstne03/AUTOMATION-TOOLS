/** Geometría pura de la timeline: tiempo ↔ posición, reordenado y ajuste a palabra, más el reparto
 *  de tiempos del proyecto. Sin React ni DOM, para probarla sin montar nada.
 *
 *  El proyecto no guarda duraciones: salen de la voz. `planificar` reparte los segundos de la voz
 *  entre las frases por caracteres (el motor hace lo mismo al no tener alineación) y, sin voz
 *  generada, estima con `CARACTERES_POR_SEGUNDO`. Un `recorte` de la frase manda sobre el reparto. */
import type { Proyecto } from "../modelo";

export const PX_POR_SEGUNDO = 40;
/** Ritmo de lectura para estimar mientras no hay voz generada. */
export const CARACTERES_POR_SEGUNDO = 14;
export const DURACION_MINIMA = 0.3;
export const PALABRAS_POR_LINEA = 4;

export interface Intervalo {
  inicio: number;
  fin: number;
}
export interface Palabra extends Intervalo {
  texto: string;
}

const finito = (n: number) => (Number.isFinite(n) ? n : 0);

export function tiempoAX(t: number, pxPorSegundo = PX_POR_SEGUNDO): number {
  const x = finito(t) * finito(pxPorSegundo);
  return x > 0 ? x : 0;
}

export function xATiempo(x: number, pxPorSegundo = PX_POR_SEGUNDO): number {
  if (!(pxPorSegundo > 0)) return 0;
  const t = finito(x) / pxPorSegundo;
  return t > 0 ? t : 0;
}

/** Mueve `ids[desde]` a la posición `hasta`. Devuelve una copia; con índices inválidos, igual. */
export function reordenar<T>(ids: readonly T[], desde: number, hasta: number): T[] {
  const copia = [...ids];
  const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < copia.length;
  if (!ok(desde) || !ok(hasta) || desde === hasta) return copia;
  const [x] = copia.splice(desde, 1);
  copia.splice(hasta, 0, x);
  return copia;
}

/** Límite de palabra (inicio o fin) más cercano a `t`. Sin palabras, `t` no negativo. */
export function ajustarAPalabra(t: number, palabras: readonly Intervalo[]): number {
  const base = Math.max(0, finito(t));
  if (!palabras.length) return base;
  let mejor = palabras[0].inicio;
  let dist = Math.abs(mejor - base);
  for (const p of palabras) {
    for (const c of [p.inicio, p.fin]) {
      const d = Math.abs(c - base);
      if (d < dist) {
        dist = d;
        mejor = c;
      }
    }
  }
  return mejor;
}

/** Siguiente límite de palabra desde `valor` en la dirección `dir` (-1 o 1), dentro de
 *  [`min`, `max`]. `null` si no hay ninguno. */
export function moverLimite(valor: number, dir: -1 | 1, palabras: readonly Intervalo[], min: number, max: number): number | null {
  const EPS = 1e-6;
  const limites = [...new Set(palabras.flatMap((p) => [p.inicio, p.fin]))].filter((l) => l >= min - EPS && l <= max + EPS).sort((a, b) => a - b);
  const candidato = dir < 0 ? [...limites].reverse().find((l) => l < valor - EPS) : limites.find((l) => l > valor + EPS);
  return candidato === undefined ? null : candidato;
}

/** Índice del clip sobre el que cae la posición `x`, dados los anchos consecutivos. */
export function indiceDestino(x: number, anchos: readonly number[]): number {
  if (!anchos.length) return 0;
  let acc = 0;
  for (let i = 0; i < anchos.length; i++) {
    acc += anchos[i];
    if (x < acc) return i;
  }
  return anchos.length - 1;
}

const partir = (texto: string) => texto.split(/\s+/).filter(Boolean);

/** Reparte `intervalo` entre las palabras de `texto` según su longitud. */
export function palabrasDeFrase(texto: string, intervalo: Intervalo): Palabra[] {
  const ws = partir(texto);
  const total = ws.reduce((a, w) => a + [...w].length, 0) || 1;
  const dur = Math.max(0, intervalo.fin - intervalo.inicio);
  let acc = 0;
  return ws.map((w) => {
    const inicio = intervalo.inicio + (acc / total) * dur;
    acc += [...w].length;
    return { texto: w, inicio, fin: intervalo.inicio + (acc / total) * dur };
  });
}

export interface Disposicion {
  escenas: { id: string; inicio: number; fin: number }[];
  /** Posición global de cada frase usada por alguna escena. */
  frases: Record<string, Intervalo>;
  /** Duración del audio de cada frase antes de recortar (el eje del recorte). */
  audio: Record<string, number>;
  total: number;
}

const nCaracteres = (t: string) => Math.max(1, [...t].length);

/** `segundosVoz`: duración total de la voz generada, si la hay. */
export function planificar(p: Proyecto, segundosVoz: number | undefined): Disposicion {
  const totalCar = p.frases.reduce((a, f) => a + nCaracteres(f.texto), 0) || 1;
  const porId = new Map(p.frases.map((f) => [f.id, f]));
  const voz = typeof segundosVoz === "number" && Number.isFinite(segundosVoz) && segundosVoz > 0 ? segundosVoz : undefined;
  const audio: Record<string, number> = {};
  const frases: Record<string, Intervalo> = {};
  const escenas: Disposicion["escenas"] = [];
  let t = 0;
  for (const e of p.escenas) {
    const inicio = t;
    for (const fid of e.fraseIds) {
      const f = porId.get(fid);
      if (!f) continue;
      const car = nCaracteres(f.texto);
      const base = voz !== undefined ? (voz * car) / totalCar : car / CARACTERES_POR_SEGUNDO;
      audio[fid] = base;
      const dur = Math.max(DURACION_MINIMA, f.recorte ? f.recorte.fin - f.recorte.inicio : base);
      frases[fid] = { inicio: t, fin: t + dur };
      t += dur;
    }
    if (t === inicio) t += 0.5; // escena sin frases reconocibles: ocupa un hueco mínimo
    escenas.push({ id: e.id, inicio, fin: t });
  }
  return { escenas, frases, audio, total: t };
}

export interface PalabraProyecto extends Palabra {
  fraseId: string;
}

/** Palabras de la narración en el orden de las escenas (el orden de `correcciones.indice`). */
export function palabrasProyecto(p: Proyecto, d?: Disposicion): PalabraProyecto[] {
  const porId = new Map(p.frases.map((f) => [f.id, f]));
  const res: PalabraProyecto[] = [];
  for (const e of p.escenas) {
    for (const fid of e.fraseIds) {
      const f = porId.get(fid);
      if (!f) continue;
      const iv = d?.frases[fid] ?? { inicio: 0, fin: 0 };
      for (const w of palabrasDeFrase(f.texto, iv)) res.push({ ...w, fraseId: fid });
    }
  }
  return res;
}

export interface LineaSubtitulo extends Intervalo {
  indice: number;
  /** Índice global de su primera palabra. */
  desde: number;
  /** Con las correcciones aplicadas. */
  palabras: string[];
  originales: string[];
}

/** Cortes de línea guardados; sin ninguno, los de por defecto: cada frase empieza línea y ninguna
 *  pasa de `PALABRAS_POR_LINEA`. */
export function cortesEfectivos(p: Proyecto, palabras: readonly PalabraProyecto[]): number[] {
  const guardados = [...new Set(p.subtitulos.cortes)].filter((c) => Number.isInteger(c) && c > 0 && c < palabras.length).sort((a, b) => a - b);
  if (guardados.length) return guardados;
  const res: number[] = [];
  let enLinea = 0;
  for (let i = 1; i < palabras.length; i++) {
    enLinea++;
    if (palabras[i].fraseId !== palabras[i - 1].fraseId || enLinea >= PALABRAS_POR_LINEA) {
      res.push(i);
      enLinea = 0;
    }
  }
  return res;
}

export function lineasSubtitulos(p: Proyecto, d?: Disposicion): LineaSubtitulo[] {
  const ws = palabrasProyecto(p, d);
  if (!ws.length) return [];
  const corr = new Map(p.subtitulos.correcciones.map((c) => [c.indice, c.texto]));
  const lineas: LineaSubtitulo[] = [];
  const limites = [0, ...cortesEfectivos(p, ws), ws.length];
  for (let i = 0; i + 1 < limites.length; i++) {
    const trozo = ws.slice(limites[i], limites[i + 1]);
    lineas.push({
      indice: i,
      desde: limites[i],
      palabras: trozo.map((w, j) => corr.get(limites[i] + j) ?? w.texto),
      originales: trozo.map((w) => w.texto),
      inicio: trozo[0].inicio,
      fin: trozo[trozo.length - 1].fin,
    });
  }
  return lineas;
}
