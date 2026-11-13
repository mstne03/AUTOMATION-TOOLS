/** Espejo en la UI del esquema del motor (`video-mcp-server/src/esquema.ts`). Sin validación
 *  propia: el motor es la autoridad y todo pasa por la API (T9). Aquí solo hay tipos y los
 *  lectores defensivos de lo que llega del modelo o del servidor. Nada de lo que sale de aquí
 *  se pinta como HTML (I1) y ningún campo es una ruta (I6). */
import { esObjeto } from "../json";

export type TipoEscena = "cifra" | "barras" | "mapa" | "cartel" | "titulo3d";
export type EscenaBase =
  | { tipo: "cifra"; valor: number; prefijo: string; sufijo: string; etiqueta?: string; decimales: number }
  | { tipo: "barras"; titulo: string; periodos: string[]; series: { nombre: string; valores: number[] }[]; prefijo: string; sufijo: string; fuente?: string }
  | { tipo: "mapa"; region: "espana" | "europa" | "mundo"; destacar: string[]; etiqueta?: string; titulo?: string }
  | { tipo: "cartel"; texto: string; subtexto?: string }
  | { tipo: "titulo3d"; texto: string };

export interface RecursoPedido {
  tipo: "foto" | "clip";
  que_debe_salir: string;
  resolucion_minima: { ancho: number; alto: number };
}

export type Fondo = "ninguno" | "aurora" | "plasma" | "nebula" | "gradiente" | "mesh";
export type Look = "normal" | "videocamara" | "pelicula";
export type EstiloSubtitulos = "karaoke" | "pildora" | "neon" | "impacto";

export interface Opciones {
  fondo: Fondo;
  look: Look;
  subtitulos: EstiloSubtitulos;
  etiqueta?: string;
  destellos: number[];
  golpe?: { frase: number; palabra: string };
}

/** Lo que produce el modelo. */
export interface GuionVideo {
  version: 1;
  titulo: string;
  gancho: string;
  escenas: { frases: string[]; base: EscenaBase; recurso?: RecursoPedido }[];
  opciones: Opciones;
}

export interface Capa {
  recursoId: string;
  modo: "encima" | "detras";
  encuadre: "marco" | "zoom" | "paneo";
  entrada: number;
  salida: number;
}

export interface Recurso {
  id: string;
  clase: "foto" | "clip" | "musica";
  ext: "jpg" | "png" | "webp" | "mp4" | "wav";
  nombreOriginal: string;
  ancho: number;
  alto: number;
  duracion: number;
}

export interface Frase {
  id: string;
  texto: string;
  recorte?: { inicio: number; fin: number };
}

export interface EscenaProyecto {
  id: string;
  fraseIds: string[];
  base: EscenaBase;
  ajusteCorte: number;
  capa?: Capa;
  recursoPendiente?: RecursoPedido;
}

/** Lo que guarda el editor. */
export interface Proyecto {
  version: 1;
  id: string;
  revision: number;
  titulo: string;
  gancho: string;
  aspecto: "9:16";
  perfilId: string;
  creado: string;
  actualizado: string;
  frases: Frase[];
  escenas: EscenaProyecto[];
  recursos: Recurso[];
  musica?: { pistaId: string; inicio: number; volumen: number; ducking: boolean };
  subtitulos: { estilo: EstiloSubtitulos; correcciones: { indice: number; texto: string }[]; cortes: number[] };
  opciones: Opciones;
}

export interface Aviso {
  codigo: string;
  mensaje: string;
  ruta?: string; // ruta dentro del documento (p. ej. «escenas.0»), no del sistema de ficheros
}

// ---------- Preview ----------

/** El `src` del iframe solo sale de aquí: `http://127.0.0.1:4781[0-3]/p/…` (M-D1, I8). */
const PREVIEW_RE = /^http:\/\/127\.0\.0\.1:4781[0-3]\/p\/[A-Za-z0-9_-]+\/[A-Za-z0-9._~\-/?=&%]*$/;
export function aPreviewUrl(url: unknown): string | null {
  if (typeof url !== "string" || !PREVIEW_RE.test(url) || url.includes("..") || /%2e|%2f|%5c/i.test(url) || url.includes("//", 7)) return null;
  // El parser decide: si normaliza algo (segmentos de punto, mayúsculas…), la URL no es de fiar.
  try {
    const u = new URL(url);
    if (u.href !== url || u.hostname !== "127.0.0.1" || u.username || u.password) return null;
  } catch {
    return null;
  }
  return url;
}

// ---------- Guion del modelo → vista editable ----------

type Plano = string | number | boolean | null | Plano[] | { [k: string]: Plano };
const PROFUNDIDAD_MAXIMA = 8;
const CLAVES_PELIGROSAS = new Set(["__proto__", "constructor", "prototype"]);

/** Copia solo JSON plano (cadenas, números, booleanos, arrays y objetos), sin claves de prototipo. */
function plano(v: unknown, nivel = 0): Plano {
  if (nivel > PROFUNDIDAD_MAXIMA) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => plano(x, nivel + 1));
  if (esObjeto(v)) {
    const o: Record<string, Plano> = {};
    for (const [k, x] of Object.entries(v)) if (!CLAVES_PELIGROSAS.has(k)) o[k] = plano(x, nivel + 1);
    return o;
  }
  return null;
}

export interface EscenaGuionUi {
  tipo: string;
  frases: string[];
  /** Campos de la escena base tal como llegan; la UI solo los muestra como texto. */
  base: Record<string, Plano> & { texto?: string };
  recurso: { tipo: string; queDebeSalir: string } | null;
  /** Recurso tal como llegó, atado a su escena: reordenar o borrar escenas no lo descoloca. */
  recursoCrudo: Plano | null;
}

export interface GuionVideoUi {
  titulo: string;
  gancho: string;
  escenas: EscenaGuionUi[];
  /** Cuerpo para `POST /video/guiones`: lo editado más lo que la UI no toca. El motor decide si vale. */
  aCuerpo(): unknown;
}

const texto = (v: unknown) => (typeof v === "string" ? v : "");

/** Lector defensivo de la respuesta del modelo. `null` si no tiene la forma mínima de un guion. */
export function aGuionVideo(j: unknown): GuionVideoUi | null {
  if (!esObjeto(j) || typeof j.titulo !== "string" || !j.titulo || !Array.isArray(j.escenas) || !j.escenas.length) return null;
  const escenas: EscenaGuionUi[] = [];
  for (const e of j.escenas) {
    if (!esObjeto(e) || !Array.isArray(e.frases) || !e.frases.every((f) => typeof f === "string") || !esObjeto(e.base) || typeof e.base.tipo !== "string") return null;
    const r = esObjeto(e.recurso) ? { tipo: texto(e.recurso.tipo), queDebeSalir: texto(e.recurso.que_debe_salir) } : null;
    escenas.push({ tipo: e.base.tipo, frases: [...(e.frases as string[])], base: plano(e.base) as EscenaGuionUi["base"], recurso: r, recursoCrudo: e.recurso === undefined ? null : plano(e.recurso) });
  }
  const raiz = plano(j) as Record<string, Plano>;
  const ui: GuionVideoUi = {
    titulo: j.titulo,
    gancho: texto(j.gancho),
    escenas,
    aCuerpo() {
      return {
        ...raiz,
        titulo: ui.titulo,
        gancho: ui.gancho,
        escenas: ui.escenas.map((e) => ({ frases: e.frases, base: { ...e.base, tipo: e.tipo }, ...(e.recursoCrudo ? { recurso: e.recursoCrudo } : {}) })),
      };
    },
  };
  return ui;
}
