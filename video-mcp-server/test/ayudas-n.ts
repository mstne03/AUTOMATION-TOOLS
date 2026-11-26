// Ayuda de los tests de T3: un Proyecto de N escenas con voz sintética (2 palabras por frase, 1 s por frase).
import { EsquemaProyecto, type Proyecto } from "../src/esquema.js";
import { construirLinea, desdeProyecto, type VozFrase } from "../src/linea.js";
import { cargarTema, type EntradaPlan, type Tema } from "../src/composicion.js";
import { procesarAlineacion } from "../src/alineacion.js";

type Base = Proyecto["escenas"][number]["base"];

/** Voz sintética de una frase: sus palabras reparten `duracion` por igual. */
export function vozDe(texto: string, duracion = 1): VozFrase {
  const chars = [...texto];
  const al = {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => (i * duracion) / chars.length),
    character_end_times_seconds: chars.map((_, i) => ((i + 1) * duracion) / chars.length),
  };
  const palabras = procesarAlineacion({ narracion: texto, bloques: [{ n: 1, inicio: 0, fin: texto.length }], alineacion: al, duracionAudio: duracion, hashNarracion: "h" });
  return { duracion, palabras };
}

/** Proyecto en bruto (sin validar): sirve para meter a mano lo que el esquema rechazaría. */
export function proyectoBruto(n: number, base: (k: number) => Base = (k) => ({ tipo: "cartel", texto: `Cartel ${k + 1}` }), frase = (k: number) => `Frase ${k + 1} uno.`): Proyecto {
  return {
    version: 1,
    id: "video001",
    revision: 0,
    titulo: "Título",
    gancho: "Gancho corto",
    aspecto: "9:16",
    perfilId: "defecto",
    creado: "2026-11-01T10:00:00Z",
    actualizado: "2026-11-01T10:00:00Z",
    frases: Array.from({ length: n }, (_, k) => ({ id: `f${k + 1}`, texto: frase(k) })),
    escenas: Array.from({ length: n }, (_, k) => ({ id: `e${k + 1}`, fraseIds: [`f${k + 1}`], base: base(k), ajusteCorte: 0 })),
    recursos: [],
    subtitulos: { estilo: "karaoke", correcciones: [], cortes: [] },
    opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [] },
  } as unknown as Proyecto;
}

export const proyectoN = (n: number, base?: (k: number) => Base, frase?: (k: number) => string): Proyecto => EsquemaProyecto.parse(proyectoBruto(n, base, frase));

/** Línea de tiempo del proyecto con la voz sintética de cada frase. */
export function lineaDe(p: Proyecto, duracion = 1) {
  return construirLinea(p, new Map(p.frases.map((f) => [f.id, vozDe(f.texto, duracion)])));
}

/** EntradaPlan de un Proyecto (el puente real de la fase 1, `desdeProyecto`) con voz sintética. */
export function entradaDe(p: Proyecto, extra: Partial<EntradaPlan> = {}, tema: Tema = cargarTema()): EntradaPlan {
  const palabras = extra.palabras ?? lineaDe(p);
  return { ...desdeProyecto(p, palabras), palabras, tema, gpu: true, ...extra };
}
