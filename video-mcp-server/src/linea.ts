// Línea de tiempo de un Proyecto (T3): suma la voz de cada frase, con su recorte, y fija el corte de cada escena.
// Consume solo el Proyecto ya validado y la voz ya generada por frase; no lee disco.
import { agruparFrases, COLA_FINAL, type Frase, type Palabra, type ResultadoAlineacion, type Segmento } from "./alineacion.js";
import type { EntradaPlan } from "./composicion.js";
import type { Proyecto } from "./esquema.js";
import { hashNarracion } from "./guion.js";

/** Voz de una frase: su duración y su alineación (de la frase sola, un único bloque). */
export interface VozFrase {
  duracion: number;
  palabras: ResultadoAlineacion;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const finito = (x: unknown, que: string): number => {
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`Tiempo no finito en ${que}.`);
  return x;
};

/**
 * Misma regla que `ensamblarVoz`: el recorte solo cuenta si deja ≥ 0,05 s y de verdad recorta algo.
 * Así los tiempos de aquí y el audio ensamblado no se separan.
 */
function tramo(duracion: number, recorte?: { inicio: number; fin: number }): [number, number] {
  if (recorte) {
    const inicio = Math.max(0, recorte.inicio);
    const fin = Math.min(duracion, recorte.fin);
    if (fin - inicio >= 0.05 && (inicio > 0 || fin < duracion)) return [inicio, fin];
  }
  return [0, duracion];
}

export function construirLinea(p: Proyecto, voz: Map<string, VozFrase>): ResultadoAlineacion {
  const porId = new Map(p.frases.map((f) => [f.id, f]));
  const vistas = new Set<string>();
  const palabras: Palabra[] = [];
  const textos: string[] = [];
  let t0 = 0;
  p.escenas.forEach((esc, k) => {
    for (const id of esc.fraseIds) {
      const f = porId.get(id);
      if (!f || vistas.has(id)) continue;
      vistas.add(id);
      const v = voz.get(id);
      if (!v) throw new Error(`Falta la voz de la frase ${vistas.size} (escena ${k + 1}).`);
      const dur = finito(v.duracion, `la frase ${vistas.size}`);
      if (!(dur > 0)) throw new Error(`La voz de la frase ${vistas.size} no tiene duración.`);
      const [ini, fin] = tramo(dur, f.recorte);
      for (const w of v.palabras.palabras) {
        const a = finito(w.inicio, `la frase ${vistas.size}`);
        const b = finito(w.fin, `la frase ${vistas.size}`);
        if (b <= ini || a >= fin) continue;
        palabras.push({ texto: w.texto, inicio: r3(Math.max(a, ini) - ini + t0), fin: r3(Math.min(b, fin) - ini + t0), segmento: k + 1 });
      }
      textos.push(f.texto);
      t0 += fin - ini;
    }
  });
  if (!palabras.length) throw new Error("La línea de tiempo no tiene palabras.");
  const duracionAudio = r3(t0);
  for (const c of p.subtitulos.correcciones) if (palabras[c.indice]) palabras[c.indice].texto = c.texto;

  // Corte de cada escena: inicio de su primera palabra más el ajuste, pegado a la palabra más cercana (SPEC §144).
  const inicios = palabras.map((w) => w.inicio);
  const segmentos: Segmento[] = [];
  p.escenas.forEach((esc, k) => {
    const ps = palabras.filter((w) => w.segmento === k + 1);
    const previo = segmentos.at(-1);
    const inicio = ps.length ? ps[0].inicio : (previo?.fin ?? 0);
    const fin = ps.length ? ps[ps.length - 1].fin : inicio;
    let desde = 0;
    if (k > 0) {
      const objetivo = inicio + finito(esc.ajusteCorte, `el ajuste de la escena ${k + 1}`);
      const cerca = inicios.reduce((m, c) => (Math.abs(c - objetivo) < Math.abs(m - objetivo) ? c : m), inicios[0]);
      desde = Math.max(previo!.mostrarDesde, cerca);
    }
    segmentos.push({ n: k + 1, inicio, fin, mostrarDesde: r3(desde), mostrarHasta: 0 });
  });
  segmentos.forEach((s, k) => (s.mostrarHasta = k + 1 < segmentos.length ? segmentos[k + 1].mostrarDesde : r3(duracionAudio + COLA_FINAL)));

  // Frases de subtítulo: las de siempre, partidas donde el usuario puso un corte de línea.
  const cortes = new Set(p.subtitulos.cortes);
  const frases: Frase[] = agruparFrases(palabras).flatMap((fr) => {
    const trozos: number[][] = [];
    for (const i of fr.palabras) {
      if (!trozos.length || cortes.has(i)) trozos.push([i]);
      else trozos[trozos.length - 1].push(i);
    }
    return trozos.map((idx) => ({ texto: idx.map((i) => palabras[i].texto).join(" "), inicio: palabras[idx[0]].inicio, fin: palabras[idx.at(-1)!].fin, segmento: fr.segmento, palabras: idx }));
  });

  return { version: 1, hashNarracion: hashNarracion(textos.join(" ")), duracionAudio, duracionTotal: r3(duracionAudio + COLA_FINAL), palabras, segmentos, frases, avisos: [] };
}

const norma = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Parte del `EntradaPlan` que sale del Proyecto ya validado (nunca del JSON crudo). El resto (voz, tema, música, GPU) lo pone el montaje.
 * Toda escena trae su `base`; las fotos y capas son de T7. El golpe `{frase, palabra}` se resuelve a la palabra de esa escena.
 */
export function desdeProyecto(p: Proyecto, palabras: ResultadoAlineacion): Pick<EntradaPlan, "titulo" | "gancho" | "escenas" | "opciones"> {
  const o = p.opciones;
  let golpe: { indice: number } | undefined;
  if (o.golpe) {
    const id = [...new Set(p.escenas.flatMap((e) => e.fraseIds))].filter((x) => p.frases.some((f) => f.id === x))[o.golpe.frase];
    const k = p.escenas.findIndex((e) => id !== undefined && e.fraseIds.includes(id));
    const indice = palabras.palabras.findIndex((w) => w.segmento === k + 1 && norma(w.texto) === norma(o.golpe!.palabra));
    if (indice >= 0) golpe = { indice };
  }
  return {
    titulo: p.titulo,
    gancho: p.gancho,
    escenas: p.escenas.map((e) => ({ base: e.base as never })),
    opciones: { fondo: o.fondo, look: o.look, subtitulos: p.subtitulos.estilo, etiqueta: o.etiqueta, destellos: o.destellos, golpe, enfasis: [] },
  };
}
