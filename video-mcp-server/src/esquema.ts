// Esquema estricto del guion que produce el modelo y del proyecto que guarda el editor (I1, I6).
// Sin campos de ruta ni de URL; todo objeto es estricto; toda cadena y todo array llevan tope;
// los campos de estilo son enums. El texto es dato: se normaliza a NFC y se rechaza lo que pueda
// colarse como control, bidi o URL. `<` no se rechaza: lo cubre el escape en la composición.
import { z } from "zod";
import { escaparHtml, hallazgosDeRed, jsonParaScript } from "./composicion.js";
import { ESCENAS_SOBRE_FONDO, ESTILOS_SUBTITULOS, FONDOS, LOOKS, normalizarPalabra } from "./formato.js";
import { REGIONES, resolverZona } from "./mapas.js";

export const LIMITES = {
  duracionS: 180,
  escenas: 90,
  narracion: 3000,
  recursos: 30,
  frasesPorEscena: 6,
  fraseChars: 400,
  tituloChars: 100,
  ganchoChars: 80,
  queDebeSalirChars: 200,
} as const;

export const TIPOS_ESCENA_FASE1 = ["cifra", "barras", "mapa", "cartel", "titulo3d"] as const;

/** Estimación de la voz en español (D3). */
const CARACTERES_POR_SEGUNDO = 14;
const MAX_FRASES = LIMITES.escenas * LIMITES.frasesPorEscena;
const MAX_PALABRAS = 5000;
const MAX_ABS = 1e12;

export const PROYECTO_ID_RE = /^video\d{3}$/;
export const RECURSO_ID_RE = /^r-[0-9a-f]{16}$/;
export const PERFIL_ID_RE = /^(defecto|p-[0-9a-f]{16})$/;
/** Ids de frase, escena y pista: sin separadores, `:` ni `.`. */
export const ID_LOCAL_RE = /^[A-Za-z0-9_-]{1,40}$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// ---------- Piezas ----------

// Rechazo por categoría Unicode (con `u`, un sustituto suelto cuenta como Cs):
//  Cc controles (C0, DEL, C1, también \n y \t), Cf formato (bidi LRM/RLM/ALM y 202A–202E/2066–2069, ZWSP/ZWNJ/ZWJ,
//  WJ, SHY, BOM, anotaciones FFF9–FFFB, etiquetas E0000–E007F), Cs sustitutos, Co uso privado, Zl/Zp (U+2028/2029)
//  y no-caracteres (FDD0–FDEF, xFFFE/xFFFF). Los selectores de variación (VS16) son Mn y no entran.
// Además, los invisibles que no son Cf: selectores de variación (FE00–FE0E, E0100–E01EF; U+FE0F solo se admite tras
// una base emoji, ver `VS16_DE_EMOJI_RE`), U+034F, rellenos hangul (115F, 1160, 3164, FFA0) y el braille en blanco (2800).
const INVISIBLES_RE = /[\uFE00-\uFE0E\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0\u2800]/u;
const VS16_DE_EMOJI_RE = /(?<=\p{Extended_Pictographic}|\p{Emoji})\uFE0F/gu;
const PROHIBIDOS_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Noncharacter_Code_Point}]/u;

// Decisión (M2, Review Focus 1): U+200D es Cf, pero sin él se rompen 👨‍👩‍👧 o 🏳️‍🌈. Se admite SOLO entre dos
// Extended_Pictographic (con VS16 o un tono de piel en medio). Cualquier otro ZWJ sigue siendo inseguro. Las etiquetas
// de las banderas de Inglaterra o Escocia (🏴󠁧󠁢󠁥󠁮󠁧󠁿) se rechazan: son el canal del «ASCII smuggling».
const ZWJ_DE_EMOJI_RE = /(?<=\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]?)\u200D(?=\p{Extended_Pictographic})/gu;

// Esquemas que la R0-8 manda rechazar (L2). Cualquier `esquema://` cae (con o sin barras de más), y los esquemas sin
// `//` que ejecutan o incrustan, solo si lo siguiente es una letra o `/`: «Data: cinco filas», «Big data:2024», «FTP:21», «Nota: …» y «10:30» pasan;
// «data:text/html,x» y «javascript:alert(1)» no. Los demás esquemas sin `//` (mailto:, tel:) son texto inofensivo.
const ESQUEMA_GENERICO_RE = /\b[a-z][a-z0-9+.-]{0,31}:[\\/]{2}|\b(?:javascript|vbscript|data|blob|ftps?|sftp|about):(?=[a-z\\/])/i;

/** Lo que `urlsDeRed` marcaría de este texto tal como llega a la composición: en el HTML, escapado, y en el script, como JSON. */
function contieneUrl(s: string): boolean {
  return (
    ESQUEMA_GENERICO_RE.test(s) ||
    hallazgosDeRed(s, "texto.html").length > 0 ||
    hallazgosDeRed(escaparHtml(s), "texto.html").length > 0 ||
    hallazgosDeRed(jsonParaScript(s), "texto.json").length > 0
  );
}

/** Máximo que una cadena puede crecer al pasar a NFC (U+FB2C, U+1D160: ×3). Corta antes de normalizar. */
const CRECIMIENTO_NFC = 4;

/** Texto libre: NFC, sin invisibles ni control ni bidi ni surrogados sueltos, y sin nada que `urlsDeRed` marcaría. */
function textoSeguro(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max * CRECIMIENTO_NFC)
    .transform((s) => s.normalize("NFC"))
    .superRefine((s, ctx) => {
      // El tope se mide tras NFC, que puede alargar el texto (L1).
      if (s.length > max) ctx.addIssue({ code: "too_big", origin: "string", maximum: max, inclusive: true, input: s });
      const sinEmoji = s.replace(ZWJ_DE_EMOJI_RE, "").replace(VS16_DE_EMOJI_RE, "");
      if (PROHIBIDOS_RE.test(sinEmoji) || INVISIBLES_RE.test(sinEmoji) || sinEmoji.includes("\uFE0F")) {
        ctx.addIssue({ code: "custom", message: "texto_inseguro", params: { codigo: "texto_inseguro" } });
      } else if (contieneUrl(s)) {
        // Mismos patrones que la barrera de la composición, sobre el texto crudo y sobre cómo se inserta: lo que ella marcaría, no entra.
        ctx.addIssue({ code: "custom", message: "url_en_texto", params: { codigo: "url_en_texto" } });
      }
    });
}

const numero = (min: number, max: number) => z.number().min(min).max(max);
const entero = (min: number, max: number) => z.number().int().min(min).max(max);
const cifra12 = numero(-MAX_ABS, MAX_ABS);
const tiempo = numero(0, LIMITES.duracionS);

const issue = (ctx: z.RefinementCtx, codigo: string, path: (string | number)[]) =>
  ctx.addIssue({ code: "custom", message: codigo, params: { codigo }, path });

// ---------- Escenas base (campos de formato.ts) ----------

const EscenaMapa = z.strictObject({
  tipo: z.literal("mapa"),
  region: z.enum(REGIONES),
  destacar: z.array(textoSeguro(60, 1)).max(8),
  etiqueta: textoSeguro(40).optional(),
  titulo: textoSeguro(40).optional(),
}).superRefine((e, ctx) => {
  if (!Array.isArray(e.destacar) || !REGIONES.includes(e.region)) return;
  e.destacar.forEach((nombre, i) => {
    if (!resolverZona(e.region, nombre).zona) issue(ctx, "zona_fuera_de_atlas", ["destacar", i]);
  });
});

/** La composición une prefijo + «0» + sufijo (cifra inicial) y prefijo + valor + sufijo: la unión también debe estar limpia. */
function unionConUrl(prefijo: unknown, sufijo: unknown, ctx: z.RefinementCtx): void {
  if (typeof prefijo !== "string" || typeof sufijo !== "string") return;
  if ([prefijo + "0" + sufijo, prefijo + "1" + sufijo, prefijo + sufijo].some(contieneUrl)) issue(ctx, "url_en_texto", ["sufijo"]);
}

const EscenaBarras = z.strictObject({
  tipo: z.literal("barras"),
  titulo: textoSeguro(48, 1),
  periodos: z.array(textoSeguro(24, 1)).min(2).max(8),
  series: z.array(z.strictObject({ nombre: textoSeguro(40, 1), valores: z.array(cifra12).min(1).max(8) })).min(2).max(6),
  prefijo: textoSeguro(12).default(""),
  sufijo: textoSeguro(12).default(""),
  fuente: textoSeguro(60).optional(),
}).superRefine((e, ctx) => {
  if (!Array.isArray(e.series) || !Array.isArray(e.periodos)) return;
  unionConUrl(e.prefijo, e.sufijo, ctx);
  e.series.forEach((s, i) => {
    if (Array.isArray(s?.valores) && s.valores.length !== e.periodos.length) issue(ctx, "serie_longitud", ["series", i, "valores"]);
  });
});

const EscenaCifra = z.strictObject({
  tipo: z.literal("cifra"),
  valor: cifra12,
  prefijo: textoSeguro(12).default(""),
  sufijo: textoSeguro(12).default(""),
  etiqueta: textoSeguro(48).optional(),
  decimales: entero(0, 3).default(0),
}).superRefine((e, ctx) => {
  if (typeof e.prefijo === "string" && typeof e.sufijo === "string" && e.prefijo.length + e.sufijo.length > 12) issue(ctx, "prefijo_sufijo_largos", ["sufijo"]);
  else unionConUrl(e.prefijo, e.sufijo, ctx);
});

const EscenaTitulo3d = z.strictObject({
  tipo: z.literal("titulo3d"),
  texto: textoSeguro(12, 1),
}).superRefine((e, ctx) => {
  if (typeof e.texto === "string" && !/^[ -~]+$/.test(e.texto)) issue(ctx, "titulo3d_caracteres", ["texto"]);
});

const EscenaCartel = z.strictObject({
  tipo: z.literal("cartel"),
  texto: textoSeguro(40, 1),
  subtexto: textoSeguro(60).optional(),
});

// Sin `tunel`: el modelo no puede pedirlo en la fase 1.
const EscenaBase = z.union([EscenaCifra, EscenaBarras, EscenaMapa, EscenaCartel, EscenaTitulo3d]);

// ---------- Recursos y opciones ----------

const Resolucion = z.strictObject({ ancho: entero(1, 8192), alto: entero(1, 8192) });
const RecursoPedido = z.strictObject({
  tipo: z.enum(["foto", "clip"]),
  que_debe_salir: textoSeguro(LIMITES.queDebeSalirChars, 1),
  resolucion_minima: Resolucion,
});

const Opciones = z.strictObject({
  fondo: z.enum(FONDOS),
  look: z.enum(LOOKS),
  subtitulos: z.enum(ESTILOS_SUBTITULOS),
  etiqueta: textoSeguro(40, 1).optional(),
  /** Índices de escena (desde 0) que empiezan con destello. */
  destellos: z.array(entero(0, LIMITES.escenas - 1)).max(LIMITES.escenas),
  /** `frase`: índice (desde 0) de la frase en el orden de la narración. */
  golpe: z.strictObject({ frase: entero(0, MAX_FRASES - 1), palabra: textoSeguro(40, 1) }).optional(),
});

const narracion = (frases: string[]) => frases.join(" ");

// ---------- Guion del modelo ----------

export const EsquemaGuionVideo = z.strictObject({
  version: z.literal(1),
  titulo: textoSeguro(LIMITES.tituloChars, 1),
  gancho: textoSeguro(LIMITES.ganchoChars, 1),
  escenas: z.array(z.strictObject({
    frases: z.array(textoSeguro(LIMITES.fraseChars, 1)).min(1).max(LIMITES.frasesPorEscena),
    base: EscenaBase,
    recurso: RecursoPedido.optional(),
  })).min(1).max(LIMITES.escenas),
  opciones: Opciones,
}).superRefine((g, ctx) => {
  if (!Array.isArray(g.escenas)) return;
  const frases = g.escenas.flatMap((e) => (Array.isArray(e?.frases) ? e.frases : []));
  if (narracion(frases).length > LIMITES.narracion) issue(ctx, "narracion_excedida", ["escenas"]);
});

// ---------- Proyecto ----------

const Capa = z.strictObject({
  recursoId: z.string().max(40).regex(RECURSO_ID_RE),
  modo: z.enum(["encima", "detras"]),
  encuadre: z.enum(["marco", "zoom", "paneo"]),
  entrada: tiempo,
  salida: tiempo,
}).superRefine((c, ctx) => {
  if (typeof c.entrada === "number" && typeof c.salida === "number" && c.salida <= c.entrada) issue(ctx, "tiempos_no_crecientes", ["salida"]);
});

const EXT_POR_CLASE = { foto: ["jpg", "png", "webp"], clip: ["mp4"], musica: ["wav"] } as const;

const Recurso = z.strictObject({
  id: z.string().max(40).regex(RECURSO_ID_RE),
  clase: z.enum(["foto", "clip", "musica"]),
  ext: z.enum(["jpg", "png", "webp", "mp4", "wav"]),
  // Solo el nombre: sin separadores de ruta, `:` de unidad ni `..` (L7).
  nombreOriginal: textoSeguro(120).refine((n) => !/[\\/:]|\.\./.test(n), { message: "nombre_con_ruta", params: { codigo: "nombre_con_ruta" } }),
  ancho: entero(1, 8192),
  alto: entero(1, 8192),
  duracion: numero(0, 3600),
}).superRefine((r, ctx) => {
  const permitidas: readonly string[] | undefined = Object.hasOwn(EXT_POR_CLASE, r.clase) ? EXT_POR_CLASE[r.clase] : undefined;
  if (!permitidas?.includes(r.ext)) issue(ctx, "ext_no_permitida", ["ext"]);
});

const Frase = z.strictObject({
  id: z.string().regex(ID_LOCAL_RE).max(40),
  texto: textoSeguro(LIMITES.fraseChars, 1),
  recorte: z.strictObject({ inicio: tiempo, fin: tiempo }).superRefine((r, ctx) => {
    if (typeof r.inicio === "number" && typeof r.fin === "number" && r.fin <= r.inicio) issue(ctx, "tiempos_no_crecientes", ["fin"]);
  }).optional(),
});

export const EsquemaProyecto = z.strictObject({
  version: z.literal(1),
  id: z.string().max(20).regex(PROYECTO_ID_RE),
  revision: entero(0, 1e9),
  titulo: textoSeguro(LIMITES.tituloChars, 1),
  gancho: textoSeguro(LIMITES.ganchoChars, 1),
  aspecto: z.literal("9:16"),
  perfilId: z.string().max(20).regex(PERFIL_ID_RE),
  creado: z.string().max(40).regex(FECHA_RE),
  actualizado: z.string().max(40).regex(FECHA_RE),
  frases: z.array(Frase).min(1).max(MAX_FRASES),
  escenas: z.array(z.strictObject({
    id: z.string().regex(ID_LOCAL_RE).max(40),
    fraseIds: z.array(z.string().regex(ID_LOCAL_RE).max(40)).min(1).max(LIMITES.frasesPorEscena),
    base: EscenaBase,
    ajusteCorte: tiempo,
    capa: Capa.optional(),
    recursoPendiente: RecursoPedido.optional(),
  }).superRefine((e, ctx) => {
    const tipo = (e.base as { tipo?: string } | undefined)?.tipo ?? "";
    if (e.capa?.modo === "detras" && !(ESCENAS_SOBRE_FONDO as readonly string[]).includes(tipo)) issue(ctx, "capa_detras_no_permitida", ["capa", "modo"]);
  })).min(1).max(LIMITES.escenas),
  recursos: z.array(Recurso).max(LIMITES.recursos),
  musica: z.strictObject({
    pistaId: z.string().regex(ID_LOCAL_RE).max(40),
    inicio: numero(0, 3600),
    volumen: numero(0, 1),
    ducking: z.boolean(),
  }).optional(),
  subtitulos: z.strictObject({
    estilo: z.enum(ESTILOS_SUBTITULOS),
    correcciones: z.array(z.strictObject({ indice: entero(0, MAX_PALABRAS), texto: textoSeguro(60, 1) })).max(500),
    cortes: z.array(entero(0, MAX_PALABRAS)).max(500),
  }),
  opciones: Opciones,
}).superRefine((p, ctx) => {
  if (!Array.isArray(p.frases) || !Array.isArray(p.escenas) || !Array.isArray(p.recursos)) return;
  const unicos = (ids: string[], ruta: string) => {
    const vistos = new Set<string>();
    ids.forEach((id, i) => {
      if (vistos.has(id)) issue(ctx, "id_duplicado", [ruta, i, "id"]);
      vistos.add(id);
    });
    return vistos;
  };
  const frases = unicos(p.frases.map((f) => f?.id), "frases");
  unicos(p.escenas.map((e) => e?.id), "escenas");
  const recursos = unicos(p.recursos.map((r) => r?.id), "recursos");
  p.escenas.forEach((e, i) => {
    e?.fraseIds?.forEach((f, j) => {
      if (!frases.has(f)) issue(ctx, "referencia_inexistente", ["escenas", i, "fraseIds", j]);
    });
    if (e?.capa && !recursos.has(e.capa.recursoId)) issue(ctx, "referencia_inexistente", ["escenas", i, "capa", "recursoId"]);
  });
  if (narracion(p.frases.map((f) => f?.texto ?? "")).length > LIMITES.narracion) issue(ctx, "narracion_excedida", ["frases"]);
});

export type EscenaBase = z.infer<typeof EscenaBase>;
export type GuionVideo = z.infer<typeof EsquemaGuionVideo>;
export type Proyecto = z.infer<typeof EsquemaProyecto>;
export interface Aviso {
  codigo: string;
  mensaje: string;
  ruta?: string;
}

// ---------- Errores y validación ----------

/** `problemas` solo lleva la ruta y el código: nunca el valor, que es texto del atacante. */
export class ErrorEsquema extends Error {
  problemas: { ruta: string; codigo: string }[];
  constructor(problemas: { ruta: string; codigo: string }[]) {
    super(`El documento no cumple el esquema (${problemas.length} problema${problemas.length === 1 ? "" : "s"}).`);
    this.name = "ErrorEsquema";
    this.problemas = problemas;
  }
}

function validar<T>(esquema: z.ZodType<T>, v: unknown): T {
  const r = esquema.safeParse(v);
  if (r.success) return r.data;
  const problemas = r.error.issues.slice(0, 50).map((i) => {
    const params = (i as { params?: { codigo?: unknown } }).params;
    return {
      // Las claves desconocidas se quedan fuera de la ruta: el nombre también es del atacante.
      ruta: i.path.map((p) => (typeof p === "number" ? String(p) : /^[A-Za-z0-9_]{1,40}$/.test(String(p)) ? String(p) : "?")).join("."),
      codigo: i.code === "custom" && typeof params?.codigo === "string" ? params.codigo : i.code,
    };
  });
  throw new ErrorEsquema(problemas);
}

export const validarGuionVideo = (v: unknown): GuionVideo => validar<GuionVideo>(EsquemaGuionVideo as unknown as z.ZodType<GuionVideo>, v);
export const validarProyecto = (v: unknown): Proyecto => validar<Proyecto>(EsquemaProyecto as unknown as z.ZodType<Proyecto>, v);

// ---------- Recomendaciones (D3): nunca bloquean ni lanzan ----------

const segundos = (t: string) => t.length / CARACTERES_POR_SEGUNDO;
const palabrasClave = (t: string) =>
  new Set(t.split(/\s+/).map(normalizarPalabra).filter((p) => p.length >= 4));

/**
 * Frases de cada escena, venga de un guion o de un proyecto. Pensada para entrada ya validada, pero nunca lanza ni
 * se vuelve cara con basura: como mucho `LIMITES.escenas` escenas, `frasesPorEscena` frases por escena y
 * `fraseChars` caracteres por frase (M3).
 */
function frasesPorEscena(g: unknown): string[][] {
  const o = g as { escenas?: unknown; frases?: unknown } | null | undefined;
  if (!o || typeof o !== "object" || !Array.isArray(o.escenas)) return [];
  const recorta = (t: string) => t.slice(0, LIMITES.fraseChars);
  const porId = new Map<string, string>();
  if (Array.isArray(o.frases)) for (const f of o.frases.slice(0, MAX_FRASES)) if (f && typeof f.id === "string" && typeof f.texto === "string") porId.set(f.id.slice(0, 40), recorta(f.texto));
  return o.escenas.slice(0, LIMITES.escenas).map((e: any) => {
    if (Array.isArray(e?.frases)) return e.frases.slice(0, LIMITES.frasesPorEscena).filter((t: unknown): t is string => typeof t === "string").map(recorta);
    if (Array.isArray(e?.fraseIds)) return e.fraseIds.slice(0, LIMITES.frasesPorEscena).map((id: unknown) => porId.get(String(id).slice(0, 40))).filter((t: unknown): t is string => typeof t === "string");
    return [];
  });
}

export function recomendaciones(g: GuionVideo | Proyecto): Aviso[] {
  const avisos: Aviso[] = [];
  try {
    const escenas = frasesPorEscena(g);
    const todas = escenas.flat();
    const gancho = typeof (g as { gancho?: unknown })?.gancho === "string" ? (g as { gancho: string }).gancho.slice(0, LIMITES.ganchoChars) : "";
    escenas.forEach((fs, i) => {
      const s = segundos(narracion(fs));
      if (s > 4) avisos.push({ codigo: "corte_largo", ruta: `escenas.${i}`, mensaje: `La escena ${i + 1} dura unos ${s.toFixed(1)} s; conviene un corte cada 2 a 4 s.` });
      else if (fs.length > 0 && s < 2) avisos.push({ codigo: "corte_corto", ruta: `escenas.${i}`, mensaje: `La escena ${i + 1} dura unos ${s.toFixed(1)} s; por debajo de 2 s el corte se nota brusco.` });
    });
    if (todas.length > 0 && segundos(todas[0]) > 3) {
      avisos.push({ codigo: "gancho_tarde", ruta: "escenas.0", mensaje: "La primera frase pasa de 3 s: el gancho debe abrirse en los 3 primeros segundos." });
    }
    if (todas.length > 1) {
      const inicio = palabrasClave(`${gancho} ${todas[0]}`);
      const final = [...palabrasClave(todas[todas.length - 1])];
      if (!final.some((p) => inicio.has(p))) {
        avisos.push({ codigo: "sin_bucle", mensaje: "La última frase no enlaza con el inicio; repetir una palabra del gancho cierra el bucle." });
      }
    }
    if (segundos(narracion(todas)) > LIMITES.duracionS) {
      avisos.push({ codigo: "duracion_excesiva", mensaje: `La narración se estima en más de ${LIMITES.duracionS} s (14 caracteres por segundo).` });
    }
    const textos = [gancho, ...todas];
    if (textos.some((t) => contieneUrl(t))) {
      avisos.push({ codigo: "url_en_texto", mensaje: "Hay una dirección web en el texto: escribe solo el dominio, sin esquema (ejemplo.com)." });
    }
  } catch {
    // Las recomendaciones nunca bloquean.
  }
  return avisos;
}

// ---------- Descripción para el prompt: fuente única ----------

export function descripcionEsquema(): string {
  const L = LIMITES;
  return [
    "Guion de vídeo vertical 9:16 en JSON. Solo JSON, sin campos de más. Todo texto en una línea, sin caracteres de control ni direcciones web.",
    `Raíz: { version: 1, titulo (máx. ${L.tituloChars}), gancho (máx. ${L.ganchoChars}), escenas, opciones }.`,
    `escenas: de 1 a ${L.escenas}. Cada una: { frases: de 1 a ${L.frasesPorEscena} frases de máx. ${L.fraseChars} caracteres, base, recurso? }.`,
    `La narración (frases unidas con un espacio) tiene como máximo ${L.narracion} caracteres y dura como mucho ${L.duracionS} s (unos 14 caracteres por segundo). Un corte cada 2 a 4 s.`,
    "base, según tipo:",
    "- cifra: { tipo, valor (número), prefijo, sufijo (juntos máx. 12), etiqueta? (máx. 48), decimales (0 a 3) }",
    "- barras: { tipo, titulo (máx. 48), periodos (2 a 8), series (2 a 6, cada una { nombre, valores } con un valor por periodo), prefijo, sufijo, fuente? }",
    `- mapa: { tipo, region (${REGIONES.join(" | ")}), destacar (hasta 8 nombres del atlas), etiqueta? (máx. 40), titulo? (máx. 40) }`,
    "- cartel: { tipo, texto (máx. 40), subtexto? (máx. 60) }",
    "- titulo3d: { tipo, texto (máx. 12, solo ASCII imprimible) }",
    `recurso?: { tipo: foto | clip, que_debe_salir (máx. ${L.queDebeSalirChars}), resolucion_minima: { ancho, alto } }. Describe lo que hace falta; el usuario aporta el archivo.`,
    `opciones: { fondo (${FONDOS.join(" | ")}), look (${LOOKS.join(" | ")}), subtitulos (${ESTILOS_SUBTITULOS.join(" | ")}), etiqueta? (máx. 40), destellos (índices de escena desde 0), golpe?: { frase (índice desde 0), palabra } }.`,
    `Límite de recursos por proyecto: ${L.recursos}.`,
  ].join("\n");
}
