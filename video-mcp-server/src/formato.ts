// Formato del guion v2: única fuente de verdad. De aquí salen el validador, la descripción de
// video_guardar_guion y el texto de video_ayuda.
import { tokenizarPalabras } from "./alineacion.js";
import { nombresRegion, parecidos, REGIONES, resolverZona, type Region } from "./mapas.js";

export const LOOKS = ["normal", "videocamara", "pelicula"] as const;
export const ESTILOS_SUBTITULOS = ["karaoke", "pildora", "neon", "impacto"] as const;
export const FONDOS = ["ninguno", "aurora", "plasma", "nebula", "gradiente", "mesh"] as const;
/** Fondos que necesitan WebGPU (los demás son CSS). */
export const FONDOS_WEBGPU = ["aurora", "plasma", "nebula", "mesh"] as const;
export const TIPOS_ESCENA = ["mapa", "barras", "cifra", "titulo3d", "tunel", "cartel"] as const;
/** Escenas que no llevan foto y se pintan sobre `fondo`. */
export const ESCENAS_SOBRE_FONDO = ["mapa", "barras", "cifra", "cartel"] as const;
export const ESCENAS_3D = ["titulo3d", "tunel"] as const;

export type Look = (typeof LOOKS)[number];
export type EstiloSubtitulos = (typeof ESTILOS_SUBTITULOS)[number];
export type Fondo = (typeof FONDOS)[number];
export type TipoEscena = (typeof TIPOS_ESCENA)[number];

export interface EscenaMapa {
  tipo: "mapa";
  region: Region;
  /** Nombres canónicos del atlas, en el orden del guion. */
  destacar: string[];
  etiqueta?: string;
  titulo?: string;
}
export interface EscenaBarras {
  tipo: "barras";
  titulo: string;
  periodos: string[];
  series: { nombre: string; valores: number[] }[];
  prefijo: string;
  sufijo: string;
  fuente?: string;
}
export interface EscenaCifra {
  tipo: "cifra";
  valor: number;
  prefijo: string;
  sufijo: string;
  etiqueta?: string;
  decimales: number;
}
export interface EscenaTitulo3d {
  tipo: "titulo3d";
  texto: string;
}
export interface EscenaTunel {
  tipo: "tunel";
}
export interface EscenaCartel {
  tipo: "cartel";
  texto: string;
  subtexto?: string;
}
export type Escena = EscenaMapa | EscenaBarras | EscenaCifra | EscenaTitulo3d | EscenaTunel | EscenaCartel;

export interface OpcionesV2 {
  etiqueta?: string;
  /** Índice en palabras.json de la palabra del golpe. */
  golpe?: { palabra: string; indice: number };
  /** Índices en palabras.json de todas las apariciones de las palabras de `enfasis`. */
  enfasis: number[];
  enfasisPalabras: string[];
  destellos: number[];
  look: Look;
  fecha?: { iso: string; dia: string; hora: string };
  subtitulos: EstiloSubtitulos;
  fondo: Fondo;
  musicaDesde: number;
  musicaVolumen?: number;
  cortesAlRitmo: boolean;
  escenas: Partial<Record<number, Escena>>;
}

// ---------- Descripción de los campos ----------

interface Campo {
  nombre: string;
  valor: string;
  descripcion: string;
  porDefecto?: string;
}

export const CAMPOS: Campo[] = [
  { nombre: "titulo", valor: "texto", descripcion: "Título del vídeo (obligatorio). No sale en pantalla." },
  { nombre: "gancho", valor: "texto", descripcion: "Texto grande del primer fotograma, no se narra (obligatorio). La última palabra va en el color de acento." },
  { nombre: "etiqueta", valor: "texto", descripcion: "Chip de contexto que entra al salir el gancho (lugar, fecha…)." },
  { nombre: "golpe", valor: "palabra", descripcion: 'Palabra exacta de la narración donde la cámara da un golpe con destello. "kicks#2" = 2.ª aparición.' },
  { nombre: "enfasis", valor: "[palabras]", descripcion: "Palabras que crecen en los subtítulos al sonar (todas sus apariciones)." },
  { nombre: "destellos", valor: "[bloques]", descripcion: "Bloques que empiezan con un destello de luz cálida.", porDefecto: "[1] y el bloque del golpe" },
  { nombre: "look", valor: LOOKS.join(" | "), descripcion: "Acabado: videocámara (HUD con REC y fecha) o película (grano y viñeta fuerte).", porDefecto: "normal" },
  { nombre: "fecha", valor: "AAAA-MM-DD HH:MM", descripcion: "Fecha y hora del HUD. Obligatoria con look videocamara." },
  { nombre: "subtitulos", valor: ESTILOS_SUBTITULOS.join(" | "), descripcion: "Estilo de subtítulos. impacto = una palabra a pantalla completa, solo en vídeos de menos de 30 s.", porDefecto: "karaoke" },
  { nombre: "fondo", valor: FONDOS.join(" | "), descripcion: "Fondo animado de las escenas sin foto (mapa, barras, cifra, cartel): aurora (cortinas de luz), plasma (tela ondulante), nebula (nubes de ruido fractal), mesh (degradado de manchas), gradiente (degradado CSS). Los cuatro primeros usan WebGPU; si no hay, se usa un degradado.", porDefecto: "ninguno" },
  { nombre: "musica", valor: "ruta", descripcion: "Pista relativa a VIDEO_ROOT, por ejemplo _musica/tension-01.mp3." },
  { nombre: "musica_desde", valor: "segundos", descripcion: "Segundo de la pista donde empieza la música.", porDefecto: "0" },
  { nombre: "musica_volumen", valor: "0-1", descripcion: "Volumen de la música bajo la voz solo para este vídeo.", porDefecto: "VIDEO_MUSICA_VOLUMEN" },
  { nombre: "cortes_al_ritmo", valor: "true | false", descripcion: "Mueve cada cambio de imagen al beat más cercano (±0,2 s) sin pisar la voz.", porDefecto: "false" },
  { nombre: "escenas", valor: "mapa por bloque", descripcion: `Escenas especiales que sustituyen la foto de un bloque: ${TIPOS_ESCENA.join(", ")}. El bloque con escena no necesita imagen.` },
];

interface DescTipo {
  tipo: TipoEscena;
  campos: string;
  queSeVe: string;
  ejemplo: string;
}

export const TIPOS: DescTipo[] = [
  {
    tipo: "mapa",
    campos: `region (${REGIONES.join(", ")}), destacar (lista de nombres del atlas; acepta nombres en español habituales), etiqueta, titulo`,
    queSeVe: "Mapa vertical; las zonas destacadas se encienden en el color de acento una a una y aparece la etiqueta.",
    ejemplo: "  3:\n    tipo: mapa\n    region: mundo\n    destacar: [Brazil, Canada]\n    etiqueta: Dos países con mucha agua dulce",
  },
  {
    tipo: "barras",
    campos: "titulo, periodos (2-8), series (2-6 series, una cifra por periodo), prefijo, sufijo, fuente",
    queSeVe: "Carrera de barras vertical; cada periodo dura lo que el bloque entre el número de periodos.",
    ejemplo:
      "  4:\n    tipo: barras\n    titulo: Ventas por producto\n    periodos: [2020, 2022, 2024, 2025]\n    series:\n      Producto A: [5, 6, 8, 15]\n      Producto B: [0, 2, 5, 7]\n      Producto C: [0, 2, 4, 6]\n    fuente: Informe interno",
  },
  {
    tipo: "cifra",
    campos: "valor (número, obligatorio), prefijo, sufijo, etiqueta, decimales",
    queSeVe: "Número enorme que cuenta desde 0 y aterriza con un golpe.",
    ejemplo: '  6:\n    tipo: cifra\n    valor: 15\n    sufijo: " %"\n    etiqueta: Crecimiento en un año',
  },
  {
    tipo: "titulo3d",
    campos: "texto (máx. 12 caracteres, solo letras y signos básicos sin acentos)",
    queSeVe: "Letras 3D metálicas que se levantan una a una.",
    ejemplo: "  5:\n    tipo: titulo3d\n    texto: AGUA",
  },
  {
    tipo: "tunel",
    campos: "ninguno: usa las fotos del vídeo (al menos 3)",
    queSeVe: "Túnel 3D con las fotos en las paredes.",
    ejemplo: "  1:\n    tipo: tunel",
  },
  {
    tipo: "cartel",
    campos: "texto (máx. 40 caracteres, obligatorio), subtexto",
    queSeVe: "Frase clave en grande sobre el fondo, palabra a palabra.",
    ejemplo: "  6:\n    tipo: cartel\n    texto: Todo cambió en 2025\n    subtexto: Informe anual",
  },
];

export const CAMPOS_VALIDOS = CAMPOS.map((c) => c.nombre);

/** Una línea por campo: para la descripción de video_guardar_guion. */
export function resumenCampos(): string {
  return CAMPOS.map((c) => `${c.nombre}: ${c.valor}`).join("; ");
}

export function textoAyuda(): string {
  const l: string[] = [];
  l.push("# Formato del guion (guion.md, v2)", "");
  l.push("Frontmatter YAML entre dos líneas `---` y luego exactamente 6 bloques [1] a [6], uno por imagen o escena.");
  l.push("La narración (los 6 bloques unidos con un espacio) tiene como máximo 650 caracteres. Un guion v1 (solo titulo, gancho y musica) sigue siendo válido.", "");
  l.push("## Campos del frontmatter", "");
  for (const c of CAMPOS) l.push(`- \`${c.nombre}\`: ${c.valor}. ${c.descripcion}${c.porDefecto ? ` Por defecto: ${c.porDefecto}.` : ""}`);
  l.push("", "## Escenas especiales (`escenas`)", "");
  l.push("Clave = número de bloque (1-6). Cada escena sustituye la foto de ese bloque; los subtítulos siguen encima.", "");
  for (const t of TIPOS) {
    l.push(`### ${t.tipo}`, "", `${t.queSeVe}`, `Campos: ${t.campos}.`, "", "```yaml", "escenas:", t.ejemplo, "```", "");
  }
  l.push("## Listas válidas", "");
  l.push(`- look: ${LOOKS.join(", ")}`);
  l.push(`- subtitulos: ${ESTILOS_SUBTITULOS.join(", ")}`);
  l.push(`- fondo: ${FONDOS.join(", ")} (WebGPU: ${FONDOS_WEBGPU.join(", ")})`);
  l.push(`- region: ${REGIONES.join(", ")}`);
  l.push(`- España (destacar): ${nombresRegion("espana").join(", ")}`);
  l.push("- Europa y mundo (destacar): nombres de país en inglés del atlas (Spain, Germany, United Kingdom…) o en español habitual (Alemania, Inglaterra → Reino Unido).", "");
  l.push("## Ejemplo completo", "", "```markdown", EJEMPLO, "```");
  return l.join("\n");
}

export const EJEMPLO = `---
titulo: El agua del planeta en cifras
gancho: Casi todo es océano.
etiqueta: Datos · Planeta Tierra
golpe: setenta
enfasis: [océanos, dulce]
destellos: [1, 5]
look: normal
subtitulos: karaoke
fondo: aurora
musica: _musica/tension-01.mp3
musica_desde: 12.5
cortes_al_ritmo: true
escenas:
  3:
    tipo: mapa
    region: mundo
    destacar: [Brazil, Canada]
    etiqueta: Dos países con mucha agua dulce
  6:
    tipo: cartel
    texto: Cuidarla es cosa de todos
---

[1] El agua cubre casi todo el planeta.
[2] Más de setenta por ciento de la superficie son océanos.
[3] Pero la mayor parte es agua salada.
[4] El agua dulce es una fracción muy pequeña.
[5] Y la mayoría está congelada o bajo tierra.
[6] Por eso cada gota cuenta.`;

// ---------- Validación ----------

/** Minúsculas y sin puntuación, para comparar palabras de la narración. */
export function normalizarPalabra(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’]+/gu, "")
    .replace(/['’]/g, "'");
}

function similitud(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  let previa = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const fila = [i];
    for (let j = 1; j <= n; j++) fila[j] = Math.min(previa[j] + 1, fila[j - 1] + 1, previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previa = fila;
  }
  return 1 - previa[n] / Math.max(m, n);
}

export interface ContextoValidacion {
  narracion: string;
  bloques: { n: number; inicio: number; fin: number; texto: string }[];
}

export interface ResultadoOpciones {
  opciones: OpcionesV2;
  problemas: string[];
  avisos: string[];
  musica?: string;
}

const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);
const texto = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
const numero = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(",", ".")))) return Number(v.replace(",", "."));
  return undefined;
};
function booleano(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "sí" || v === "si") return true;
  if (v === "false" || v === "no") return false;
  return undefined;
}
function enLista<T extends string>(v: unknown, valores: readonly T[], campo: string, porDefecto: T, problemas: string[]): T {
  if (v === undefined || v === null || v === "") return porDefecto;
  const t = texto(v).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "") as T;
  if (valores.includes(t)) return t;
  problemas.push(`\`${campo}: ${texto(v)}\` no es válido. Valores posibles: ${valores.join(", ")}.`);
  return porDefecto;
}

const MESES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function parsearFecha(v: unknown): OpcionesV2["fecha"] | undefined {
  // YAML convierte "1995-09-06 20:15" en Date: se vuelve a texto en UTC.
  const t = v instanceof Date ? v.toISOString().slice(0, 16).replace("T", " ") : texto(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(t);
  if (!m) return undefined;
  const [, a, mes, d, h, min] = m.map(Number) as unknown as number[];
  if (mes < 1 || mes > 12 || d < 1 || d > 31 || h > 23 || min > 59) return undefined;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return {
    iso: t,
    dia: `${MESES[mes - 1]} ${String(d).padStart(2, "0")} ${a}`,
    hora: `${String(h12).padStart(2, "0")}:${String(min).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`,
  };
}

/** Valida y normaliza los campos v2 del frontmatter. No toca disco. */
export function validarOpciones(datos: Record<string, unknown>, ctx: ContextoValidacion): ResultadoOpciones {
  const problemas: string[] = [];
  const avisos: string[] = [];

  const desconocidos = Object.keys(datos).filter((k) => !CAMPOS_VALIDOS.includes(k));
  if (desconocidos.length) {
    avisos.push(`Campos desconocidos en el frontmatter (se ignoran): ${desconocidos.join(", ")}. Campos válidos: ${CAMPOS_VALIDOS.join(", ")}.`);
  }

  const tokens = tokenizarPalabras(ctx.narracion, ctx.bloques);
  const normal = tokens.map((t) => normalizarPalabra(t.texto));
  const sugerencia = (palabra: string) => {
    let mejor = { bloque: 1, s: -1 };
    tokens.forEach((t, i) => {
      const s = similitud(palabra, normal[i]);
      if (s > mejor.s) mejor = { bloque: t.segmento, s };
    });
    const b = ctx.bloques.find((x) => x.n === mejor.bloque);
    const palabras = tokens.filter((t) => t.segmento === mejor.bloque).map((t) => normalizarPalabra(t.texto));
    return `Palabras del bloque [${b?.n ?? mejor.bloque}]: ${palabras.join(", ")}.`;
  };

  const etiqueta = texto(datos.etiqueta) || undefined;
  if (etiqueta && etiqueta.length > 40) problemas.push(`\`etiqueta\` tiene ${etiqueta.length} caracteres; el máximo es 40.`);

  let golpe: OpcionesV2["golpe"];
  if (datos.golpe !== undefined && datos.golpe !== null && datos.golpe !== "") {
    const crudo = texto(datos.golpe);
    const m = /^(.*?)(?:#(\d+))?$/.exec(crudo)!;
    const palabra = normalizarPalabra(m[1]);
    const ocurrencia = m[2] ? Number(m[2]) : 1;
    const apariciones = normal.map((p, i) => (p === palabra ? i : -1)).filter((i) => i >= 0);
    if (!palabra) problemas.push("`golpe` está vacío. Pon una palabra exacta de la narración.");
    else if (!apariciones.length) problemas.push(`\`golpe: ${crudo}\` no aparece en la narración. ${sugerencia(palabra)}`);
    else if (apariciones.length < ocurrencia) {
      problemas.push(`\`golpe: ${crudo}\` pide la aparición ${ocurrencia}, pero "${palabra}" sale ${apariciones.length} vez/veces en la narración.`);
    } else golpe = { palabra, indice: apariciones[ocurrencia - 1] };
  }

  const enfasisPalabras = lista(datos.enfasis).map((v) => normalizarPalabra(texto(v))).filter(Boolean);
  const enfasis: number[] = [];
  for (const p of enfasisPalabras) {
    const ap = normal.map((x, i) => (x === p ? i : -1)).filter((i) => i >= 0);
    if (!ap.length) problemas.push(`\`enfasis\`: "${p}" no aparece en la narración. ${sugerencia(p)}`);
    enfasis.push(...ap);
  }

  let destellos: number[];
  if (datos.destellos === undefined || datos.destellos === null) {
    destellos = [1];
    if (golpe) destellos.push(tokens[golpe.indice].segmento);
  } else {
    destellos = [];
    for (const v of lista(datos.destellos)) {
      const n = numero(v);
      if (n === undefined || !Number.isInteger(n) || n < 1 || n > 6) problemas.push(`\`destellos\`: "${texto(v)}" no es un bloque válido (1-6).`);
      else destellos.push(n);
    }
  }
  destellos = [...new Set(destellos)].sort();

  const look = enLista(datos.look, LOOKS, "look", "normal", problemas);
  let fecha: OpcionesV2["fecha"];
  if (datos.fecha !== undefined && datos.fecha !== null && datos.fecha !== "") {
    fecha = parsearFecha(datos.fecha);
    if (!fecha) problemas.push(`\`fecha: ${texto(datos.fecha)}\` no tiene el formato AAAA-MM-DD HH:MM (por ejemplo 1995-09-06 20:15).`);
  }
  if (look === "videocamara" && !fecha && datos.fecha === undefined) {
    problemas.push("`look: videocamara` necesita `fecha` (AAAA-MM-DD HH:MM) para el HUD; la fecha del render no vale.");
  }
  const subtitulos = enLista(datos.subtitulos, ESTILOS_SUBTITULOS, "subtitulos", "karaoke", problemas);
  const fondo = enLista(datos.fondo, FONDOS, "fondo", "ninguno", problemas);

  let musica: string | undefined;
  if (datos.musica !== undefined && datos.musica !== null && datos.musica !== "") {
    musica = texto(datos.musica);
    if (!musica) problemas.push("`musica` tiene que ser una ruta relativa a VIDEO_ROOT, por ejemplo _musica/tension-01.mp3.");
  }
  let musicaDesde = 0;
  if (datos.musica_desde !== undefined && datos.musica_desde !== null) {
    const n = numero(datos.musica_desde);
    if (n === undefined || n < 0) problemas.push(`\`musica_desde: ${texto(datos.musica_desde)}\` tiene que ser un número de segundos ≥ 0.`);
    else musicaDesde = n;
  }
  let musicaVolumen: number | undefined;
  if (datos.musica_volumen !== undefined && datos.musica_volumen !== null) {
    const n = numero(datos.musica_volumen);
    if (n === undefined || n < 0 || n > 1) problemas.push(`\`musica_volumen: ${texto(datos.musica_volumen)}\` tiene que estar entre 0 y 1.`);
    else musicaVolumen = n;
  }
  if ((datos.musica_desde !== undefined || datos.musica_volumen !== undefined) && !musica) {
    avisos.push("`musica_desde` y `musica_volumen` no hacen nada sin `musica`.");
  }
  let cortesAlRitmo = false;
  if (datos.cortes_al_ritmo !== undefined && datos.cortes_al_ritmo !== null) {
    const b = booleano(datos.cortes_al_ritmo);
    if (b === undefined) problemas.push("`cortes_al_ritmo` tiene que ser true o false.");
    else cortesAlRitmo = b;
    if (b && !musica) avisos.push("`cortes_al_ritmo` necesita `musica`; sin música no se mueve ningún corte.");
  }

  const escenas: OpcionesV2["escenas"] = {};
  if (datos.escenas !== undefined && datos.escenas !== null) {
    if (typeof datos.escenas !== "object" || Array.isArray(datos.escenas)) {
      problemas.push("`escenas` tiene que ser un mapa con el número de bloque como clave, por ejemplo `3: {tipo: cifra, valor: 15}`.");
    } else {
      for (const [clave, valor] of Object.entries(datos.escenas as Record<string, unknown>)) {
        const n = Number(clave);
        if (!Number.isInteger(n) || n < 1 || n > 6) {
          problemas.push(`\`escenas\`: la clave "${clave}" no es un bloque válido (1-6).`);
          continue;
        }
        const escena = validarEscena(n, valor, problemas, avisos);
        if (escena) escenas[n] = escena;
      }
    }
  }
  if (look === "videocamara") {
    const e1 = escenas[1];
    if (e1 && (ESCENAS_3D as readonly string[]).includes(e1.tipo)) {
      avisos.push(`El bloque 1 es una escena 3D (${e1.tipo}) con look videocamara: el HUD tapará parte del 3D en el fotograma de portada.`);
    }
  }
  if (fondo !== "ninguno" && !Object.values(escenas).some((e) => e && (ESCENAS_SOBRE_FONDO as readonly string[]).includes(e.tipo))) {
    avisos.push(`\`fondo: ${fondo}\` solo se ve en escenas mapa, barras, cifra o cartel, y este guion no tiene ninguna.`);
  }

  return {
    opciones: {
      etiqueta,
      golpe,
      enfasis: [...new Set(enfasis)].sort((a, b) => a - b),
      enfasisPalabras,
      destellos,
      look,
      fecha,
      subtitulos,
      fondo,
      musicaDesde,
      musicaVolumen,
      cortesAlRitmo,
      escenas,
    },
    problemas,
    avisos,
    musica,
  };
}

function validarEscena(n: number, v: unknown, problemas: string[], avisos: string[]): Escena | undefined {
  const pre = `\`escenas.${n}\``;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    problemas.push(`${pre} tiene que ser un mapa con \`tipo\` y sus campos.`);
    return undefined;
  }
  const d = v as Record<string, unknown>;
  const tipo = texto(d.tipo).toLowerCase().replace("título", "titulo").replace("túnel", "tunel") as TipoEscena;
  if (!TIPOS_ESCENA.includes(tipo)) {
    problemas.push(`${pre}: \`tipo: ${texto(d.tipo) || "(vacío)"}\` no es válido. Tipos: ${TIPOS_ESCENA.join(", ")}.`);
    return undefined;
  }
  const antes = problemas.length;
  const permitidos: Record<TipoEscena, string[]> = {
    mapa: ["region", "destacar", "etiqueta", "titulo"],
    barras: ["titulo", "periodos", "series", "prefijo", "sufijo", "fuente"],
    cifra: ["valor", "prefijo", "sufijo", "etiqueta", "decimales"],
    titulo3d: ["texto"],
    tunel: [],
    cartel: ["texto", "subtexto"],
  };
  const sobran = Object.keys(d).filter((k) => k !== "tipo" && !permitidos[tipo].includes(k));
  if (sobran.length) {
    avisos.push(`${pre} (${tipo}): se ignoran ${sobran.join(", ")}. Campos de ${tipo}: ${permitidos[tipo].join(", ") || "ninguno"}.`);
  }
  const corto = (campo: string, max: number, obligatorio = false): string | undefined => {
    const t = texto(d[campo]);
    if (!t) {
      if (obligatorio) problemas.push(`${pre} (${tipo}) necesita \`${campo}\`.`);
      return undefined;
    }
    if (t.length > max) problemas.push(`${pre} (${tipo}): \`${campo}\` tiene ${t.length} caracteres; el máximo es ${max}.`);
    return t;
  };

  switch (tipo) {
    case "mapa": {
      const regionTxt = texto(d.region).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
      if (!(REGIONES as readonly string[]).includes(regionTxt)) {
        problemas.push(`${pre} (mapa): \`region\` tiene que ser ${REGIONES.join(", ")}.`);
        return undefined;
      }
      const region = regionTxt as Region;
      const destacar: string[] = [];
      for (const nombre of lista(d.destacar).map(texto).filter(Boolean)) {
        const { zona, aviso } = resolverZona(region, nombre);
        if (!zona) {
          problemas.push(`${pre} (mapa): "${nombre}" no está en el atlas de ${region}. Los más parecidos: ${parecidos(region, nombre, 10).join(", ")}.`);
        } else {
          if (aviso) avisos.push(`${pre} (mapa): ${aviso}`);
          if (!destacar.includes(zona.nombre)) destacar.push(zona.nombre);
        }
      }
      if (!lista(d.destacar).length) avisos.push(`${pre} (mapa): sin \`destacar\` el mapa no enciende ninguna zona.`);
      if (lista(d.destacar).length > 8) problemas.push(`${pre} (mapa): como mucho 8 zonas en \`destacar\`.`);
      const r: EscenaMapa = { tipo, region, destacar, etiqueta: corto("etiqueta", 40), titulo: corto("titulo", 40) };
      return problemas.length > antes ? undefined : r;
    }
    case "barras": {
      const titulo = corto("titulo", 48, true) ?? "";
      const periodos = lista(d.periodos).map(texto).filter(Boolean);
      if (periodos.length < 2 || periodos.length > 8) problemas.push(`${pre} (barras): \`periodos\` tiene ${periodos.length}; tienen que ser de 2 a 8.`);
      const series: EscenaBarras["series"] = [];
      if (!d.series || typeof d.series !== "object" || Array.isArray(d.series)) {
        problemas.push(`${pre} (barras): \`series\` tiene que ser un mapa \`Nombre: [cifra, cifra, …]\`.`);
      } else {
        for (const [nombre, valores] of Object.entries(d.series as Record<string, unknown>)) {
          const nums = lista(valores).map(numero);
          if (nums.some((x) => x === undefined)) {
            problemas.push(`${pre} (barras): la serie "${nombre}" tiene valores que no son números.`);
            continue;
          }
          if (nums.length !== periodos.length) {
            problemas.push(`${pre} (barras): la serie "${nombre}" tiene ${nums.length} cifras y hay ${periodos.length} periodos; tiene que tener una por periodo.`);
            continue;
          }
          series.push({ nombre: nombre.trim(), valores: nums as number[] });
        }
        const total = Object.keys(d.series as object).length;
        if (total < 2 || total > 6) problemas.push(`${pre} (barras): hay ${total} series; tienen que ser de 2 a 6.`);
      }
      const r: EscenaBarras = {
        tipo,
        titulo,
        periodos,
        series,
        prefijo: texto(d.prefijo),
        sufijo: typeof d.sufijo === "string" ? d.sufijo : texto(d.sufijo),
        fuente: corto("fuente", 60),
      };
      return problemas.length > antes ? undefined : r;
    }
    case "cifra": {
      const valor = numero(d.valor);
      if (valor === undefined) problemas.push(`${pre} (cifra) necesita \`valor\` numérico, por ejemplo \`valor: 15\`.`);
      const decimales = d.decimales === undefined ? (valor !== undefined && !Number.isInteger(valor) ? 1 : 0) : numero(d.decimales);
      if (decimales === undefined || decimales < 0 || decimales > 3 || !Number.isInteger(decimales)) problemas.push(`${pre} (cifra): \`decimales\` tiene que ser 0, 1, 2 o 3.`);
      const prefijo = typeof d.prefijo === "string" ? d.prefijo : texto(d.prefijo);
      const sufijo = typeof d.sufijo === "string" ? d.sufijo : texto(d.sufijo);
      if ((prefijo + sufijo).length > 12) problemas.push(`${pre} (cifra): prefijo y sufijo juntos no pueden pasar de 12 caracteres.`);
      const r: EscenaCifra = { tipo, valor: valor ?? 0, prefijo, sufijo, etiqueta: corto("etiqueta", 48), decimales: decimales ?? 0 };
      return problemas.length > antes ? undefined : r;
    }
    case "titulo3d": {
      const t = corto("texto", 12, true) ?? "";
      if (t && !/^[ -~]+$/.test(t)) {
        problemas.push(`${pre} (titulo3d): \`texto\` solo admite letras, cifras y signos básicos sin acentos (la fuente 3D no tiene más). Quita: ${[...new Set([...t].filter((c) => !/[ -~]/.test(c)))].join(" ")}.`);
      }
      return problemas.length > antes ? undefined : { tipo, texto: t };
    }
    case "tunel":
      return { tipo };
    case "cartel": {
      const t = corto("texto", 40, true) ?? "";
      const r: EscenaCartel = { tipo, texto: t, subtexto: corto("subtexto", 60) };
      return problemas.length > antes ? undefined : r;
    }
  }
}

/** Bloques que necesitan foto: los que no tienen escena. */
export function bloquesConFoto(escenas: OpcionesV2["escenas"]): number[] {
  return [1, 2, 3, 4, 5, 6].filter((n) => !escenas[n]);
}

export function fondoUsaWebgpu(o: OpcionesV2): boolean {
  return (FONDOS_WEBGPU as readonly string[]).includes(o.fondo) && Object.values(o.escenas).some((e) => e && (ESCENAS_SOBRE_FONDO as readonly string[]).includes(e.tipo));
}
