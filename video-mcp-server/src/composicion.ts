// Composición v2: raíz + subcomposiciones en _composicion\ (plan v2, §3). Todo el texto del guion se escapa;
// los datos de animación van como JSON en <script type="application/json">.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SERVER_ROOT } from "./raiz.js";
import type { Guion } from "./guion.js";
import { COLA_FINAL, type ResultadoAlineacion } from "./alineacion.js";
import {
  ESCENAS_SOBRE_FONDO,
  FONDOS_WEBGPU,
  type Escena,
  type EscenaBarras,
  type EscenaCartel,
  type EscenaCifra,
  type EscenaMapa,
  type EscenaTitulo3d,
} from "./formato.js";
import { trazarMapa } from "./mapas.js";
import { borrarArbol, type ImagenEncontrada } from "./paths.js";

export const PLANTILLA_DIR = path.join(SERVER_ROOT, "plantilla");
export const PIEZAS_DIR = path.join(PLANTILLA_DIR, "piezas");
export const NODE_MODULES = path.join(SERVER_ROOT, "node_modules");
export const SHADERS_JS = path.join(PLANTILLA_DIR, "vendor", "shaders.iife.js");
/** Motor de tiempo WAAPI de las piezas (SEO-111). */
export const HF_TIEMPO_JS = path.join(PLANTILLA_DIR, "vendor", "hf-tiempo.js");
/** Duración máxima del vídeo (voz) que acepta la composición, en segundos. */
const DURACION_MAXIMA = 180;
const ID_PIEZA_RE = /^[a-z][a-z0-9-]*$/;

const TRANSICION = 0.3;
const SOLAPE = TRANSICION / 2;
const GANCHO_DURACION = 2.3;
const ETIQUETA_DURACION = 1.35;
// Dirección del Ken Burns por índice de imagen (px de desplazamiento al final del zoom).
const DIRECCIONES: [number, number][] = [
  [-36, -28],
  [36, -28],
  [-36, 28],
  [36, 28],
  [0, -44],
  [0, 44],
];
// "nebula" usa FractalNoise: el shader Nebula del catálogo es un efecto de forma (una esfera de cristal), no un fondo.
const SHADERS: Record<string, string> = { aurora: "Aurora", plasma: "Plasma", nebula: "FractalNoise", mesh: "MeshGradient" };

const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const Color = z.string().regex(COLOR_RE);
// Lista cerrada: una familia solo existe con la cara que trae plantilla/fuentes/.
const cara = <F extends string, A extends string, P extends number>(familia: F, archivo: A, peso: P) =>
  z.strictObject({ familia: z.literal(familia), archivo: z.literal(archivo), peso: z.literal(peso) });
const Fuente = z.union([
  cara("Anton", "anton-latin-400-normal.woff2", 400),
  cara("Inter Tight", "inter-tight-latin-800-normal.woff2", 800),
  cara("JetBrains Mono", "jetbrains-mono-latin-700-normal.woff2", 700),
]);
const Tamano = z.number().int().min(8).max(400);
const TEMA = z.strictObject({
  nombre: z.string().max(200).optional(),
  colores: z.strictObject({ fondo: Color, texto: Color, acento: Color, contorno: Color.optional(), secundario: Color.optional() }),
  fuentes: z.strictObject({ titulos: Fuente, subtitulos: Fuente, mono: Fuente.optional() }),
  tamanos: z
    .strictObject({ gancho: Tamano, ganchoMinimo: Tamano, subtitulo: Tamano, subtituloMinimo: Tamano })
    .refine((t) => t.ganchoMinimo <= t.gancho, { path: ["ganchoMinimo"] })
    .refine((t) => t.subtituloMinimo <= t.subtitulo, { path: ["subtituloMinimo"] }),
  subtitulos: z.strictObject({ mayusculas: z.boolean().optional() }).optional(),
  degradado: z.strictObject({ opacidad: z.number().min(0).max(1).optional() }).optional(),
  paletaTunel: z.array(Color).min(1).max(64).optional(),
});

export type Tema = z.infer<typeof TEMA>;

/** I1: el tema se rechaza entero al cargar. El mensaje solo lleva las claves: un valor malo puede ser cualquier cosa. */
export function validarTema(v: unknown): Tema {
  const r = TEMA.safeParse(v);
  if (!r.success) throw new Error(`Tema no válido: ${[...new Set(r.error.issues.map((i) => i.path.join(".") || "(raíz)"))].join(", ")}`);
  return r.data;
}

export function cargarTema(dir = PLANTILLA_DIR): Tema {
  return validarTema(JSON.parse(fs.readFileSync(path.join(dir, "tema.json"), "utf8")));
}

export function escaparHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * JSON seguro para incrustar dentro de un <script>. Un número no finito lanza (JSON lo convertiría en `null` y la
 * pieza se animaría con basura sin error visible: I1, I11).
 */
export function jsonParaScript(v: unknown): string {
  return JSON.stringify(v, (clave, valor: unknown) => {
    if (typeof valor === "number" && !Number.isFinite(valor)) throw new Error(`Número no finito en los datos de la composición (clave «${clave}»): ${valor}`);
    return valor;
  })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(" ", "g"), "\\u2028")
    .replace(new RegExp(" ", "g"), "\\u2029");
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Id y tiempos de una pieza (I1): id por regex, inicio y duración números finitos, y dentro del vídeo de `D` s.
 * Devuelve los tiempos redondeados que van al host y a {{INICIO}}/{{DURACION}}.
 */
export function comprobarTiemposPieza(id: string, inicio: number, duracion: number, D: number): { i: number; d: number } {
  if (!ID_PIEZA_RE.test(id)) throw new Error(`Id de pieza no válido: ${id}`);
  if (typeof inicio !== "number" || typeof duracion !== "number" || !Number.isFinite(inicio) || !Number.isFinite(duracion)) {
    throw new Error(`Tiempo no finito en la pieza ${id}: inicio=${inicio}, duración=${duracion}.`);
  }
  const i = r3(inicio);
  const d = r3(duracion);
  if (i < 0 || d <= 0 || i + d > D + 0.001) throw new Error(`Tiempo fuera de rango en la pieza ${id}: inicio=${i}, duración=${d}, vídeo=${D} s.`);
  return { i, d };
}

/** El mayor tamaño en px con el que `texto` cabe en una caja de ancho×alto (Anton, ~0,5 em por carácter). */
export function tamanoGancho(texto: string, base: number, minimo: number, ancho = 900, alto = 470): number {
  for (let s = base; s > minimo; s -= 4) {
    const porLinea = Math.max(1, Math.floor(ancho / (s * 0.5)));
    let lineas = 1;
    let actual = 0;
    for (const w of texto.split(/\s+/)) {
      if (w.length > porLinea) {
        actual = Infinity;
        break;
      }
      const largo = actual ? actual + 1 + w.length : w.length;
      if (largo > porLinea && actual) {
        lineas++;
        actual = w.length;
      } else actual = largo;
    }
    if (actual !== Infinity && lineas * s * 1.04 <= alto) return s;
  }
  return minimo;
}

export function tamanoFrase(texto: string, base: number, minimo: number, ancho = 800, factor = 0.62): number {
  return Math.max(minimo, Math.min(base, Math.floor(ancho / (Math.max(texto.length, 1) * factor))));
}

// ---------- Plan de la composición ----------

export interface EntradaComposicion {
  guion: Guion;
  palabras: ResultadoAlineacion;
  /** Índice n-1: imagen del bloque n (o undefined si ese bloque es una escena sin foto). */
  imagenes: (ImagenEncontrada | undefined)[];
  tema: Tema;
  /** Música ya preparada en assets/musica.mp3. */
  musica?: { volumen: number; automatizacion: string };
  /** `mostrarDesde` de cada bloque tras los cortes al ritmo (si no, los de palabras.json). */
  cortes?: number[];
  /** Hay WebGPU para los fondos con shader. */
  gpu: boolean;
}

export interface PlanComposicion {
  duracion: number;
  /** Archivos de texto a escribir, por ruta relativa a _composicion\. */
  archivos: Record<string, string>;
  /** Archivos a copiar: origen absoluto → ruta relativa. */
  copias: { origen: string; destino: string }[];
  avisos: string[];
  usaWebgpu: boolean;
  estiloSubtitulos: string;
}

function pieza(nombre: string, valores: Record<string, string | number>): string {
  const plantilla = fs.readFileSync(path.join(PIEZAS_DIR, nombre), "utf8");
  return plantilla.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (k in valores ? String(valores[k]) : m));
}

export function planificarComposicion(e: EntradaComposicion): PlanComposicion {
  const { guion, palabras: al } = e;
  const tema = validarTema(e.tema); // cubre también o.tema; el valor devuelto, nunca e.tema.
  const o = guion.opciones;
  const avisos: string[] = [];
  const D = r3(al.duracionAudio + COLA_FINAL);
  if (typeof al.duracionAudio !== "number" || !Number.isFinite(D)) throw new Error(`Tiempo no finito: la voz dura ${al.duracionAudio} s.`);
  if (D > DURACION_MAXIMA + COLA_FINAL) throw new Error(`La voz dura ${al.duracionAudio} s y el máximo es ${DURACION_MAXIMA} s.`);
  const archivos: Record<string, string> = {};
  const copias: PlanComposicion["copias"] = [];
  const colores = { ...tema.colores, contorno: tema.colores.contorno ?? "#000000", secundario: tema.colores.secundario ?? "#1F7A3A" };
  const f = tema.fuentes;
  const fuentesCss = (["titulos", "subtitulos", "mono"] as const)
    .filter((k) => f[k])
    .map(
      (k) =>
        `@font-face { font-family: "${f[k]!.familia}"; src: url("assets/fonts/${f[k]!.archivo}") format("woff2"); font-weight: ${f[k]!.peso}; font-style: normal; font-display: block; }`,
    )
    .join("\n        ");
  for (const k of ["titulos", "subtitulos", "mono"] as const) {
    if (f[k]) copias.push({ origen: path.join(PLANTILLA_DIR, "fuentes", f[k]!.archivo), destino: `assets/fonts/${f[k]!.archivo}` });
  }
  copias.push({ origen: HF_TIEMPO_JS, destino: "assets/hf-tiempo.js" });

  // ---- Ventanas de cada bloque ----
  const desde = al.segmentos.map((s, k) => (e.cortes?.[k] !== undefined ? e.cortes[k] : s.mostrarDesde));
  desde[0] = 0;
  const escenas = o.escenas;
  const usaFondo = (n: number) => {
    const esc = escenas[n];
    return !!esc && (ESCENAS_SOBRE_FONDO as readonly string[]).includes(esc.tipo);
  };
  const ventanas = desde.map((d0, k) => {
    const n = k + 1;
    const inicio = k === 0 ? 0 : r3(Math.max(0, d0 - SOLAPE));
    let fin = k === 5 ? D : r3(Math.min(D, desde[k + 1] + SOLAPE));
    // Si el bloque siguiente va sobre el fondo, este acaba justo en el corte (el fondo no tapa nada).
    if (k < 5 && usaFondo(n + 1)) fin = r3(desde[k + 1]);
    return { n, inicio, fin, duracion: r3(Math.max(0.1, fin - inicio)), corte: r3(d0), visible: r3((k === 5 ? al.duracionAudio : desde[k + 1]) - d0) };
  });

  // Golpe: instante de la palabra y bloque al que pertenece.
  let golpe: { t: number; n: number } | undefined;
  if (o.golpe && al.palabras[o.golpe.indice]) {
    const p = al.palabras[o.golpe.indice];
    golpe = { t: p.inicio, n: p.segmento };
  } else if (o.golpe) {
    avisos.push("palabras.json no tiene la palabra del golpe; regenera la voz si cambiaste el guion.");
  }

  const hosts: string[] = [];
  // Cada host y su pieza salen de aquí: el {{INICIO}}/{{DURACION}} de la pieza es por construcción el
  // data-start/data-duration del host (SEO-111). Tiempos calculados por el motor y validados (I1).
  const anadirPieza = (
    id: string,
    plantilla: string,
    inicio: number,
    duracion: number,
    valores: Record<string, string | number>,
    h: { z: number; extra?: string; alto?: number; top?: number },
  ) => {
    const { i, d } = comprobarTiemposPieza(id, inicio, duracion, D);
    const { z, extra = "", alto = 1920, top = 0 } = h;
    hosts.push(
      `      <div id="h-${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${i}" data-duration="${d}" data-track-index="${z}" data-width="1080" data-height="${alto}"${extra} style="position: absolute; left: 0; top: ${top}px; width: 1080px; height: ${alto}px; z-index: ${z}"></div>`,
    );
    archivos[`compositions/${id}.html`] = pieza(plantilla, { ...valores, ID: id, INICIO: i, DURACION: d });
  };

  // ---- Fondo (un único host bajo los bloques) ----
  let usaWebgpu = false;
  if ([1, 2, 3, 4, 5, 6].some(usaFondo)) {
    const conShader = (FONDOS_WEBGPU as readonly string[]).includes(o.fondo);
    if (conShader && e.gpu) {
      usaWebgpu = true;
      const props =
        o.fondo === "aurora"
          ? { colorA: colores.acento, colorB: colores.secundario, colorC: colores.texto }
          : o.fondo === "plasma"
            ? { colorA: colores.secundario, colorB: colores.fondo }
            : o.fondo === "mesh"
              ? { colorA: colores.fondo, colorB: colores.acento }
              : { colorA: colores.fondo, colorB: colores.secundario, contrast: 0.7, speed: 0.25 };
      copias.push({ origen: SHADERS_JS, destino: "assets/vendor/shaders.iife.js" });
      anadirPieza(
        "fondo",
        "fondo-shader.html",
        0,
        D,
        { SHADER: SHADERS[o.fondo], PROPS: escaparHtml(JSON.stringify(props)) },
        { z: 10, extra: " data-no-timeline" },
      );
    } else {
      if (conShader) avisos.push(`No hay WebGPU en esta máquina: \`fondo: ${o.fondo}\` se sustituye por un degradado animado con los colores del tema.`);
      const animado = o.fondo !== "ninguno";
      anadirPieza(
        "fondo",
        "fondo-css.html",
        0,
        D,
        { COLOR_A: colores.acento, COLOR_B: colores.secundario, ANIMADO: animado ? "true" : "false", OCULTO: animado ? "" : "display: none" },
        { z: 10 },
      );
    }
  }

  // ---- Bloques ----
  let usa3d = false;
  let usaTunel = false;
  for (const v of ventanas) {
    const id = `bloque${v.n}`;
    const k = v.n - 1;
    const empieza = k === 0 ? 0.1 : SOLAPE;
    const esc: Escena | undefined = escenas[v.n];
    // Golpe en una cifra: el número aterriza en esa palabra; si la palabra abre el bloque no da tiempo a contar,
    // así que aterriza 0,55 s después de la entrada y el temblor y el destello se mueven con él.
    if (golpe && golpe.n === v.n && esc?.tipo === "cifra") {
      golpe.t = r3(v.inicio + Math.max(golpe.t - v.inicio, empieza + 0.55));
    }
    const env = { fundido: k === 0 ? 0 : TRANSICION, punch: k > 0, golpes: golpe && golpe.n === v.n ? [r3(golpe.t - v.inicio)] : [] };
    let p: PiezaPlan;
    if (!esc) {
      const img = e.imagenes[k];
      if (!img) throw new Error(`Falta la imagen del bloque ${v.n}.`);
      const archivo = `img${v.n}${img.extension}`;
      copias.push({ origen: img.ruta, destino: `assets/${archivo}` });
      const [dx, dy] = DIRECCIONES[k % DIRECCIONES.length];
      p = ["bloque-foto.html", { IMG: escaparHtml(archivo), DATOS: jsonParaScript({ duracion: v.duracion, dx, dy, movimiento: true, ...env }) }];
    } else {
      const comun = { ID: id, FUENTES: fuentesCss, ENVOLTURA_DATOS: jsonParaScript(env) };
      switch (esc.tipo) {
        case "cifra":
          p = piezaCifra(esc, comun, v, empieza, env.golpes[0]);
          break;
        case "cartel":
          p = piezaCartel(esc, comun, empieza);
          break;
        case "barras":
          p = piezaBarras(esc, comun, v, empieza, colores);
          break;
        case "mapa":
          p = piezaMapa(esc, comun, empieza, colores);
          break;
        case "titulo3d":
          usa3d = true;
          p = [
            "escena-titulo3d.html",
            { ...comun, DATOS: jsonParaScript({ texto: (esc as EscenaTitulo3d).texto, acento: colores.acento, duracion: v.duracion, empieza }) },
          ];
          break;
        case "tunel": {
          usaTunel = true;
          const fotos = e.imagenes
            .map((img, i) => (img ? `assets/img${i + 1}${img.extension}` : undefined))
            .filter((x): x is string => !!x);
          e.imagenes.forEach((img, i) => img && copias.push({ origen: img.ruta, destino: `assets/img${i + 1}${img.extension}` }));
          const paleta = tema.paletaTunel ?? [colores.acento, colores.secundario, colores.texto];
          p = ["escena-tunel.html", { ...comun, IMAGENES: escaparHtml(fotos.join(",")), PALETA: paleta.join(","), ACENTO: colores.acento }];
          break;
        }
      }
    }
    anadirPieza(id, p[0], v.inicio, v.duracion, p[1], { z: 10 + v.n });
  }

  // Reencuadre final de la imagen 1 para que el short haga bucle (solo si el bloque 1 es una foto).
  const img1 = e.imagenes[0];
  if (!escenas[1] && img1) {
    const archivo = `img1-bucle${img1.extension}`;
    copias.push({ origen: img1.ruta, destino: `assets/${archivo}` });
    anadirPieza(
      "bucle",
      "bloque-foto.html",
      D - COLA_FINAL,
      COLA_FINAL,
      {
        IMG: escaparHtml(archivo),
        DATOS: jsonParaScript({ duracion: COLA_FINAL, dx: 0, dy: 0, movimiento: false, fundido: TRANSICION, punch: false, golpes: [] }),
      },
      { z: 17 },
    );
  }

  // ---- Capas: degradado, viñeta, destellos y look ----
  const bloquesLuz = o.look === "pelicula" ? [1, 2, 3, 4, 5, 6] : o.destellos;
  const destellos = bloquesLuz.map((n, i) => ({ id: `capas-luz${n}`, t: ventanas[n - 1].corte, duracion: i % 2 === 0 ? 1.8 : 1.7 }));
  const luzHtml = destellos
    .map(
      (d) =>
        `      <div id="${d.id}" class="clip leak" data-start="${r3(d.t)}" data-duration="${d.duracion}" data-track-index="2" data-layout-ignore data-layout-allow-occlusion><div class="ly ambar"></div><div class="ly rojo"></div><div class="ly oro"></div></div>`,
    )
    .join("\n");
  let lookHtml = "";
  if (o.look === "videocamara" && o.fecha) {
    lookHtml = [
      `      <div id="capas-tinte" class="clip lleno" data-start="0" data-duration="${D}" data-track-index="3" data-layout-ignore data-layout-allow-occlusion></div>`,
      `      <div id="capas-scan" class="clip lleno" data-start="0" data-duration="${D}" data-track-index="4" data-layout-ignore data-layout-allow-occlusion></div>`,
      `      <div id="capas-hud" class="clip lleno" data-start="0" data-duration="${D}" data-track-index="5">`,
      `        <div class="esquina rec"><span id="capas-punto" class="punto"></span><span>REC</span></div>`,
      `        <div class="esquina bateria"></div>`,
      `        <div class="esquina fecha">${escaparHtml(o.fecha.dia)}<br />${escaparHtml(o.fecha.hora)}</div>`,
      `        <div class="esquina contador"><span class="modo">SP</span><span id="capas-contador">00:00:00</span></div>`,
      `      </div>`,
    ].join("\n");
  } else if (o.look === "pelicula") {
    lookHtml = `      <div id="capas-grano" class="clip lleno" data-start="0" data-duration="${D}" data-track-index="3" data-layout-ignore data-layout-allow-occlusion><div class="textura"></div></div>`;
  }
  anadirPieza(
    "capas",
    "capas.html",
    0,
    D,
    {
      FUENTES: fuentesCss,
      VINETA: o.look === "pelicula" ? 0.75 : 0.62,
      BLOQUES_LUZ: luzHtml,
      LOOK: lookHtml,
      DATOS: jsonParaScript({ duracion: D, destellos }),
    },
    { z: 40 },
  );

  // ---- Gancho y etiqueta ----
  // El gancho y la etiqueta ocupan la mitad superior, igual que el texto de las escenas: no pueden pisarse.
  // Si una escena (bloque 2 en adelante) empieza antes de que acabe el gancho, el gancho termina en su corte.
  let finGancho = Math.min(GANCHO_DURACION, D);
  for (const v of ventanas.slice(1)) {
    if (escenas[v.n] && v.corte < finGancho) {
      finGancho = r3(Math.max(0.9, v.corte));
      break;
    }
  }
  const bloqueEn = (t: number) => {
    let k = 0;
    for (let i = 0; i < ventanas.length; i++) if (ventanas[i].corte <= t) k = i;
    return ventanas[k];
  };
  // Etiqueta: tras el gancho y solo sobre una foto; si no cabe (escena justo después), debajo del gancho mientras se ve.
  let etiqueta: { inicio: number; fin: number; top: number } | undefined;
  if (o.etiqueta) {
    const inicio = r3(finGancho + 0.05);
    let fin = Math.min(inicio + ETIQUETA_DURACION, D - 0.5);
    const siguienteEscena = ventanas.find((v) => escenas[v.n] && v.corte > inicio);
    if (siguienteEscena) fin = Math.min(fin, siguienteEscena.corte);
    if (!escenas[bloqueEn(inicio).n] && fin - inicio >= 0.8) {
      etiqueta = { inicio, fin: r3(fin), top: 300 };
    } else if (finGancho - 0.6 >= 0.8) {
      etiqueta = { inicio: 0.6, fin: finGancho, top: 860 };
      avisos.push("La etiqueta se muestra debajo del gancho porque justo después empieza una escena y no le queda tiempo sobre una foto.");
    } else {
      avisos.push("La etiqueta no se muestra: el bloque 2 es una escena y empieza demasiado pronto. Alarga el bloque 1 o quita la escena del bloque 2.");
    }
  }
  const palabrasGancho = guion.gancho.split(/\s+/).filter(Boolean);
  anadirPieza(
    "gancho",
    "gancho.html",
    0,
    finGancho,
    {
      FUENTES: fuentesCss,
      TAMANO: tamanoGancho(guion.gancho, tema.tamanos.gancho, tema.tamanos.ganchoMinimo, 972, 600),
      PALABRAS: palabrasGancho
        .map((w, i) => `<span class="palabra${i === palabrasGancho.length - 1 ? " acento" : ""}">${escaparHtml(w)}</span>`)
        .join(""),
    },
    { z: 50, alto: 620, top: 200 },
  );
  if (o.etiqueta && etiqueta) {
    anadirPieza(
      "etiqueta",
      "etiqueta.html",
      etiqueta.inicio,
      r3(etiqueta.fin - etiqueta.inicio),
      { FUENTES: fuentesCss, TEXTO: escaparHtml(o.etiqueta), TAMANO: Math.min(64, Math.floor(872 / (Math.max(o.etiqueta.length, 1) * 0.56))) },
      { z: 51, alto: 160, top: etiqueta.top },
    );
  }

  // ---- Subtítulos ----
  let estilo: string = o.subtitulos;
  if (estilo === "impacto" && D >= 30) {
    avisos.push(`\`subtitulos: impacto\` es solo para vídeos de menos de 30 s y este dura ${D.toFixed(1)} s: se usa karaoke.`);
    estilo = "karaoke";
  }
  const enfasis = new Set(o.enfasis);
  const gruposBase =
    estilo === "impacto"
      ? al.palabras.map((p, i) => ({ texto: p.texto, inicio: p.inicio, fin: p.fin, palabras: [i] }))
      : al.frases.map((fr) => ({ texto: fr.texto, inicio: fr.inicio, fin: fr.fin, palabras: fr.palabras }));
  const grupos = gruposBase.map((g, i) => {
    const sig = gruposBase[i + 1];
    const margen = estilo === "impacto" ? 0.15 : 0.7;
    let hasta = Math.min(g.fin + margen, sig ? sig.inicio : Math.max(g.fin, al.duracionAudio));
    if (hasta <= g.inicio + 0.05) hasta = g.inicio + 0.05;
    hasta = Math.min(hasta, D);
    const inicio = r3(g.inicio);
    const tamano =
      estilo === "impacto"
        ? tamanoFrase(g.texto, 220, 90, 800, 0.5)
        : estilo === "pildora"
          ? tamanoFrase(g.texto, 76, 48, 720)
          : tamanoFrase(g.texto, tema.tamanos.subtitulo, tema.tamanos.subtituloMinimo);
    return {
      id: `sub-g${i + 1}`,
      inicio,
      duracion: r3(hasta - inicio),
      tamano,
      palabras: g.palabras.map((pi, j) => {
        const p = al.palabras[pi];
        const sigP = g.palabras[j + 1] !== undefined ? al.palabras[g.palabras[j + 1]].inicio : hasta;
        return { id: `sub-g${i + 1}w${j + 1}`, texto: p.texto, inicio: r3(p.inicio), fin: r3(Math.max(p.inicio + 0.04, Math.min(sigP, hasta))), enfasis: enfasis.has(pi) };
      }),
    };
  });
  const gruposHtml = grupos
    .map((g) => {
      const spans = g.palabras.map((p) => `<span id="${p.id}" class="p${p.enfasis ? " enf" : ""}">${escaparHtml(p.texto)}</span>`).join(" ");
      return `      <div id="${g.id}" class="clip grupo" data-start="${g.inicio}" data-duration="${g.duracion}" data-track-index="0"><div id="${g.id}-txt" class="txt" style="font-size: ${g.tamano}px">${spans}</div></div>`;
    })
    .join("\n");
  anadirPieza(
    "subtitulos",
    "subtitulos.html",
    0,
    D,
    {
      ESTILO: estilo,
      FUENTES: fuentesCss,
      GRUPOS: gruposHtml,
      DATOS: jsonParaScript({
        estilo,
        colores: { texto: colores.texto, acento: colores.acento },
        grupos: grupos.map((g) => ({ id: g.id, inicio: g.inicio, palabras: g.palabras.map((p) => ({ id: p.id, inicio: p.inicio, fin: p.fin, enfasis: p.enfasis })) })),
      }),
    },
    { z: 60, extra: ' data-track-kind="captions"' },
  );

  // ---- Destellos blancos: cambio de bloque y golpe ----
  const flash = ventanas.slice(1).map((v) => ({ t: v.corte, opacidad: 0.55, sube: 0.05, baja: 0.2 }));
  if (golpe) flash.push({ t: r3(golpe.t), opacidad: 0.35, sube: 0.03, baja: 0.15 });
  flash.sort((a, b) => a.t - b.t);
  // Dos destellos no pueden pisarse: si el golpe cae encima de un corte, gana el más fuerte.
  const flashSinSolape = flash.filter((x, i) => i === 0 || x.t >= flash[i - 1].t + flash[i - 1].sube + flash[i - 1].baja);
  anadirPieza("flash", "flash.html", 0, D, { DATOS: jsonParaScript({ destellos: flashSinSolape }) }, { z: 70 });

  // ---- Vendor 3D ----
  if (usa3d) {
    const tres = path.join(NODE_MODULES, "three");
    copias.push(
      { origen: path.join(tres, "build", "three.module.js"), destino: "assets/vendor/three184/three.module.js" },
      { origen: path.join(tres, "build", "three.core.js"), destino: "assets/vendor/three184/three.core.js" },
      { origen: path.join(tres, "examples", "jsm", "loaders", "FontLoader.js"), destino: "assets/vendor/three184/addons/loaders/FontLoader.js" },
      { origen: path.join(tres, "examples", "jsm", "geometries", "TextGeometry.js"), destino: "assets/vendor/three184/addons/geometries/TextGeometry.js" },
      { origen: path.join(PLANTILLA_DIR, "fuentes", "3d", "Geist-Bold.typeface.json"), destino: "assets/fonts/Geist-Bold.typeface.json" },
    );
  }
  if (usaTunel) copias.push({ origen: path.join(NODE_MODULES, "three147", "build", "three.min.js"), destino: "assets/vendor/three147.min.js" });

  // ---- Audio ----
  const audio = [
    `      <audio id="voz" class="clip" src="assets/voz.mp3" data-start="0" data-duration="${r3(al.duracionAudio)}" data-track-index="30" data-volume="1"></audio>`,
  ];
  if (e.musica) {
    audio.push(
      `      <audio id="musica" class="clip" src="assets/musica.mp3" data-start="0" data-duration="${D}" data-track-index="31" data-volume="${e.musica.volumen}" data-fade-in="0.5" data-fade-out="1" data-automation="${escaparHtml(e.musica.automatizacion)}"></audio>`,
    );
  }

  const temaCss = [
    `--fondo: ${colores.fondo};`,
    `--texto: ${colores.texto};`,
    `--acento: ${colores.acento};`,
    `--contorno: ${colores.contorno};`,
    `--fuente-titulos: "${f.titulos.familia}", sans-serif;`,
    `--peso-titulos: ${f.titulos.peso};`,
    `--fuente-subtitulos: "${f.subtitulos.familia}", sans-serif;`,
    `--peso-subtitulos: ${f.subtitulos.peso};`,
    `--mayusculas: ${tema.subtitulos?.mayusculas === false ? "none" : "uppercase"};`,
    `--degradado: ${tema.degradado?.opacidad ?? 0.78};`,
  ].join("\n        ");
  const importmap = usa3d
    ? `    <script type="importmap">{"imports":{"three":"./assets/vendor/three184/three.module.js","three/addons/":"./assets/vendor/three184/addons/"}}</script>`
    : "";
  archivos["index.html"] = fs
    .readFileSync(path.join(PLANTILLA_DIR, "index.html"), "utf8")
    .replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) =>
      ({ TITULO: escaparHtml(guion.titulo), IMPORTMAP: importmap, TEMA_CSS: temaCss, DURACION: String(D), HOSTS: hosts.join("\n"), AUDIO: audio.join("\n") })[k] ?? m,
    );

  return { duracion: D, archivos, copias, avisos, usaWebgpu, estiloSubtitulos: estilo };
}

// ---------- Piezas de escena ----------

type Comun = { ID: string; FUENTES: string; ENVOLTURA_DATOS: string };
/** Plantilla de la pieza y sus valores; ID, INICIO y DURACION los pone anadirPieza. */
type PiezaPlan = [string, Record<string, string | number>];
type Ventana = { duracion: number; visible: number };

function piezaCifra(esc: EscenaCifra, comun: Comun, v: Ventana, empieza: number, golpe?: number): PiezaPlan {
  const final = esc.prefijo + esc.valor.toLocaleString("en-US", { minimumFractionDigits: esc.decimales, maximumFractionDigits: esc.decimales }) + esc.sufijo;
  const tamano = Math.max(140, Math.min(380, Math.floor(900 / (Math.max(final.length, 1) * 0.5))));
  // La cuenta dura el 60 % del bloque; si el golpe cae en este bloque, aterriza justo en esa palabra.
  const cuenta = golpe !== undefined && golpe > empieza + 0.5 ? r3(golpe - (empieza + 0.1)) : r3(Math.max(0.4, v.visible * 0.6));
  return [
    "escena-cifra.html",
    {
      ...comun,
      TAMANO: tamano,
      INICIAL: escaparHtml(esc.prefijo + "0" + esc.sufijo),
      ETIQUETA: escaparHtml(esc.etiqueta ?? ""),
      DATOS: jsonParaScript({ valor: esc.valor, prefijo: esc.prefijo, sufijo: esc.sufijo, decimales: esc.decimales, empieza: r3(empieza + 0.1), cuenta, aterriza: r3(empieza + 0.1 + cuenta) }),
    },
  ];
}

function piezaCartel(esc: EscenaCartel, comun: Comun, empieza: number): PiezaPlan {
  const palabras = esc.texto.split(/\s+/).filter(Boolean);
  return [
    "escena-cartel.html",
    {
      ...comun,
      TAMANO: tamanoGancho(esc.texto, 180, 80, 900, esc.subtexto ? 520 : 640),
      PALABRAS: palabras
        .map((w, i) => `<span class="w${i === palabras.length - 1 ? " ultima" : ""}" data-layout-allow-occlusion>${escaparHtml(w)}</span>`)
        .join(""),
      SUBTEXTO: escaparHtml(esc.subtexto ?? ""),
      DATOS: jsonParaScript({ empieza: r3(empieza) }),
    },
  ];
}

function piezaBarras(esc: EscenaBarras, comun: Comun, v: Ventana, empieza: number, colores: { texto: string; acento: string }): PiezaPlan {
  const filas = esc.series
    .map(
      (s, j) =>
        `                <div id="${comun.ID}-f${j}" class="fila"><div class="nombre" data-layout-allow-occlusion>${escaparHtml(s.nombre)}</div><div class="barra"></div><div class="valor" data-layout-allow-occlusion></div></div>`,
    )
    .join("\n");
  const duracionPeriodo = r3(Math.max(0.3, (v.visible - 0.3) / esc.periodos.length));
  return [
    "escena-barras.html",
    {
      ...comun,
      TITULO: escaparHtml(esc.titulo),
      PRIMER_PERIODO: escaparHtml(esc.periodos[0] ?? ""),
      FILAS: filas,
      FUENTE: esc.fuente ? `Fuente: ${escaparHtml(esc.fuente)}` : "",
      DATOS: jsonParaScript({
        periodos: esc.periodos,
        series: esc.series.map((s) => ({ nombre: s.nombre, valores: s.valores })),
        prefijo: esc.prefijo,
        sufijo: esc.sufijo,
        duracionPeriodo,
        empieza: r3(empieza + 0.2),
        colores,
      }),
    },
  ];
}

function piezaMapa(esc: EscenaMapa, comun: Comun, empieza: number, colores: { texto: string; acento: string }): PiezaPlan {
  // El mapa ocupa de 300 a 920 px: por debajo va la etiqueta (930-1010) y no debe tapar ninguna zona.
  const m = trazarMapa(esc.region, esc.destacar, 1000, 620);
  const trazados = [
    ...m.extra.filter((x) => x.clase !== "marco").map((x) => `                <path class="${x.clase}" d="${x.d}" />`),
    ...m.base.map((x) => `                <path class="base" d="${x.d}" />`),
    ...m.destacadas.map((x, i) => `                <path id="${comun.ID}-z${i}" class="dest" d="${x.d}" />`),
    ...m.extra.filter((x) => x.clase === "marco").map((x) => `                <path class="${x.clase}" d="${x.d}" />`),
  ].join("\n");
  const enciende = r3(empieza + 0.35);
  return [
    "escena-mapa.html",
    {
      ...comun,
      ANCHO: m.ancho,
      ALTO: m.alto,
      TITULO: escaparHtml(esc.titulo ?? ""),
      TRAZADOS: trazados,
      ETIQUETA: escaparHtml(esc.etiqueta ?? ""),
      ETQ_VISIBLE: esc.etiqueta ? "" : "display: none",
      CLASE_SVG: esc.region === "europa" ? "recorte" : "",
      DATOS: jsonParaScript({
        destacadas: m.destacadas.map((_, i) => `${comun.ID}-z${i}`),
        enciende,
        // La etiqueta entra con la primera zona encendida: en bloques cortos, si espera a todas, apenas se lee.
        etiqueta: r3(enciende + 0.15),
        colores,
      }),
    },
  ];
}

// ---------- Escritura ----------

/** Escribe _composicion\ desde cero con el plan ya calculado. */
export function escribirPlan(destino: string, plan: PlanComposicion): void {
  // En Windows un Chrome que acaba de cerrarse puede tener la carpeta abierta unos instantes.
  borrarArbol(destino);
  for (const [rel, contenido] of Object.entries(plan.archivos)) {
    const ruta = path.join(destino, rel);
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, contenido, "utf8");
  }
  const hechas = new Set<string>();
  for (const c of plan.copias) {
    if (hechas.has(c.destino)) continue;
    hechas.add(c.destino);
    const ruta = path.join(destino, c.destino);
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.copyFileSync(c.origen, ruta);
  }
}

/**
 * Vendor copiado tal cual (ruta relativa → SHA-256): traen URLs de documentación. Si cambia un byte, se escanea entero.
 * Al subir three, HyperFrames o las fuentes, el test de urls-de-red.test.ts avisa de que hay que recalcularlo.
 */
export const VENDOR_FIJADO: Record<string, string> = {
  "assets/vendor/shaders.iife.js": "012b904bcf2621aa8dd99e1959ba71ddc1de86b9958d5ac9f48a40ff94cef776",
  "assets/vendor/three184/three.module.js": "61134198639a10885daf893fb29669ca26386e2a4cde76e8399f51e329f741f2",
  "assets/vendor/three184/three.core.js": "368dc78835287709a48939e8eb9a7a61d0732098bdf916e56840d458aae9ccf3",
  "assets/vendor/three184/addons/loaders/FontLoader.js": "a8d78ab85e596ef6c274023ee165520000f010011553dbfafe5c966387aca3d8",
  "assets/vendor/three184/addons/geometries/TextGeometry.js": "edf69c1cd6087c84d020156d1adbb29b40b098e4cbe8da4c0c36bbadc58dceac",
  "assets/vendor/three147.min.js": "f34446bf875b5fb0dcd93819ffe1d9e182d46634ee855f5d904c6c4ac7cdbc95",
  "assets/fonts/Geist-Bold.typeface.json": "e42c3305dcef66919fb1f2cf96101173c593abbd78eaed155025071b3fe6f621",
};
const W3_PERMITIDAS = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml", "http://www.w3.org/1999/xlink"]);
const ENTIDADES: Record<string, string> = {
  colon: ":", sol: "/", bsol: "\\", lpar: "(", period: ".", num: "#", quest: "?", amp: "&", comma: ",", lbrack: "[", lsqb: "[", equals: "=", semi: ";", Tab: "\t", NewLine: "\n",
};
// El host (rama `.`) excluye el punto y se acota a 253 caracteres, el máximo de un nombre DNS: así `http:http:http:…` no
// recorre el resto de la cadena en cada `http:` (coste cuadrático).
const ESQUEMA_RE = /\b(?:https?|wss?):(?:[\\/]+[^\s"'<>)]|[^\s"'<>)\\/.]{0,253}\.)/gi;
const FILE_RE = /\bfile:(?:[\\/]|[a-z]:)/gi;
// Sin esquema: en marcado y CSS, tras inicio, control o espacio, comilla, acento grave, `(`, `=`, `,` o `;`.
const HOST_MARCADO_RE = /(?<=^|[\x00-\x20"'`(=,;])[\\/]{2,}[^\s"'<>)\\/]/gim;
// En JS y JSON `//` abre también un comentario: solo cuenta dentro de una cadena o justo tras `(`.
const HOST_JS_RE = /(?<=["'`(])[\\/]{2,}[^\s"'<>)\\/]/gi;

function caracter(n: number): string {
  return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "�";
}

/** Una sola pasada, como el navegador: `&amp;#104;` queda en `&#104;`. */
function sinEntidades(t: string): string {
  return t.replace(/&#[xX]([0-9a-fA-F]+);?|&#([0-9]+);?|&([a-zA-Z]+);|&amp/g, (m, hex?: string, dec?: string, nombre?: string) => {
    if (hex) return caracter(parseInt(hex, 16));
    if (dec) return caracter(parseInt(dec, 10));
    return nombre ? (Object.hasOwn(ENTIDADES, nombre) ? ENTIDADES[nombre] : m) : "&";
  });
}

function sinEscapesCss(t: string): string {
  return t.replace(/\\(?:([0-9a-f]{1,6})[ \t\r\n\f]?|([^\r\n\f]))/gi, (_, hex?: string, c?: string) => (hex ? caracter(parseInt(hex, 16)) : c!));
}

export function hallazgosDeRed(texto: string, nombre: string): string[] {
  const hallados = new Set<string>();
  const anotar = (t: string, re: RegExp) => {
    for (const m of t.matchAll(re)) {
      const ficha = /[^\s"'<>)]*/y;
      ficha.lastIndex = m.index;
      const url = ficha.exec(t)![0];
      if (!W3_PERMITIDAS.has(url.toLowerCase())) hallados.add(url.slice(0, 200));
    }
  };
  const marcado = /\.(html|svg)$/i.test(nombre);
  const base = marcado ? sinEntidades(texto) : texto;
  const variantes = marcado || /\.css$/i.test(nombre) ? [base, sinEscapesCss(base)] : [base];
  for (const v of variantes) {
    // El navegador quita tabuladores y saltos de la URL; borrarlos sin más pegaría palabras, así que se miran las dos.
    const pegada = v.replace(/[\t\n\r]/g, "");
    for (const t of [v, pegada]) {
      anotar(t, ESQUEMA_RE);
      anotar(t, FILE_RE);
      if (/speculationrules/i.test(t)) hallados.add("speculationrules");
    }
    if (marcado || /\.css$/i.test(nombre)) for (const t of [v, pegada]) anotar(t, HOST_MARCADO_RE);
    else anotar(v, HOST_JS_RE); // pegada no: une un comentario `//x` con la línea anterior.
  }
  return [...hallados];
}

/**
 * Busca URLs de red en la composición generada (no debe quedar ninguna, I2 c).
 * ponytail: aviso temprano, no barrera. No ve concatenación ni escapes en JS (ver urls-de-red.test.ts); eso lo imponen
 * I2 (a) y (b). Un fichero de texto con otra extensión o en UTF-16 tampoco se lee: las copias las decide este motor.
 */
export function urlsDeRed(destino: string): string[] {
  const encontradas: string[] = [];
  const recorrer = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const ruta = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(ruta);
      else if (/\.(html|css|js|mjs|json|svg)$/i.test(e.name)) {
        const rel = path.relative(destino, ruta).split(path.sep).join("/");
        const bytes = fs.readFileSync(ruta);
        if (VENDOR_FIJADO[rel] === crypto.createHash("sha256").update(bytes).digest("hex")) continue;
        for (const h of hallazgosDeRed(bytes.toString("utf8"), e.name)) encontradas.push(`${rel}: ${h}`);
      }
    }
  };
  recorrer(destino);
  return encontradas;
}
