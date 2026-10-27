// Composición v2: raíz + subcomposiciones en _composicion\ (plan v2, §3). Todo el texto del guion se escapa;
// los datos de animación van como JSON en <script type="application/json">.
import fs from "node:fs";
import path from "node:path";
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
import type { ImagenEncontrada } from "./paths.js";

export const PLANTILLA_DIR = path.join(SERVER_ROOT, "plantilla");
export const PIEZAS_DIR = path.join(PLANTILLA_DIR, "piezas");
export const NODE_MODULES = path.join(SERVER_ROOT, "node_modules");
export const GSAP_JS = path.join(NODE_MODULES, "gsap", "dist", "gsap.min.js");
export const SHADERS_JS = path.join(PLANTILLA_DIR, "vendor", "shaders.iife.js");

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

export interface Tema {
  nombre?: string;
  colores: { fondo: string; texto: string; acento: string; contorno?: string; secundario?: string };
  fuentes: Record<"titulos" | "subtitulos", { familia: string; archivo: string; peso: number }> & {
    mono?: { familia: string; archivo: string; peso: number };
  };
  tamanos: { gancho: number; ganchoMinimo: number; subtitulo: number; subtituloMinimo: number };
  subtitulos?: { mayusculas?: boolean };
  degradado?: { opacidad?: number };
  paletaTunel?: string[];
}

export function cargarTema(dir = PLANTILLA_DIR): Tema {
  return JSON.parse(fs.readFileSync(path.join(dir, "tema.json"), "utf8")) as Tema;
}

export function escaparHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** JSON seguro para incrustar dentro de un <script>. */
export function jsonParaScript(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(" ", "g"), "\\u2028")
    .replace(new RegExp(" ", "g"), "\\u2029");
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
function color(v: string | undefined, porDefecto: string): string {
  return v && COLOR_RE.test(v) ? v : porDefecto;
}
function familiaCss(f: string): string {
  return f.replace(/[^\p{L}\p{N} _-]/gu, "");
}
function archivoFuente(f: string): string {
  const base = path.basename(f);
  if (!/^[\w.-]+\.(woff2?|ttf|otf)$/i.test(base)) throw new Error(`Nombre de fuente no válido en tema.json: ${f}`);
  return base;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

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

function envolturaJs(id: string, e: { fundido: number; punch: boolean; golpes: number[] }): string {
  return `(function (tl, id, e) {
            if (e.fundido > 0) tl.fromTo("#" + id + "-fundido", { opacity: 0 }, { opacity: 1, duration: e.fundido, ease: "none" }, 0);
            if (e.punch) tl.fromTo("#" + id + "-punch", { scale: 1.07 }, { scale: 1, duration: 0.45, ease: "expo.out" }, 0);
            var f = 1 / 30, p = [[0, 0], [22, -14], [-16, 10], [8, -4], [0, 0]];
            e.golpes.forEach(function (t) {
              for (var i = 0; i < 4; i++) tl.fromTo("#" + id + "-golpe", { x: p[i][0], y: p[i][1] }, { x: p[i + 1][0], y: p[i + 1][1], duration: f, ease: "none", immediateRender: false }, t + i * f);
            });
          })(tl, ${JSON.stringify(id)}, ${jsonParaScript(e)});`;
}

export function planificarComposicion(e: EntradaComposicion): PlanComposicion {
  const { guion, palabras: al, tema } = e;
  const o = guion.opciones;
  const avisos: string[] = [];
  const D = r3(al.duracionAudio + COLA_FINAL);
  const archivos: Record<string, string> = {};
  const copias: PlanComposicion["copias"] = [];
  const colores = {
    fondo: color(tema.colores.fondo, "#0B0F0C"),
    texto: color(tema.colores.texto, "#F4F1E8"),
    acento: color(tema.colores.acento, "#E8B931"),
    contorno: color(tema.colores.contorno, "#000000"),
    secundario: color(tema.colores.secundario, "#1F7A3A"),
  };
  const f = tema.fuentes;
  const fuentesCss = (["titulos", "subtitulos", "mono"] as const)
    .filter((k) => f[k])
    .map(
      (k) =>
        `@font-face { font-family: "${familiaCss(f[k]!.familia)}"; src: url("assets/fonts/${archivoFuente(f[k]!.archivo)}") format("woff2"); font-weight: ${Number(f[k]!.peso) || 400}; font-style: normal; font-display: block; }`,
    )
    .join("\n        ");
  for (const k of ["titulos", "subtitulos", "mono"] as const) {
    if (f[k]) copias.push({ origen: path.join(PLANTILLA_DIR, "fuentes", archivoFuente(f[k]!.archivo)), destino: `assets/fonts/${archivoFuente(f[k]!.archivo)}` });
  }
  copias.push({ origen: GSAP_JS, destino: "assets/gsap.min.js" });

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
  const host = (id: string, src: string, inicio: number, duracion: number, z: number, extra = "", alto = 1920, top = 0) =>
    hosts.push(
      `      <div id="h-${id}" data-composition-id="${id}" data-composition-src="compositions/${src}" data-start="${r3(inicio)}" data-duration="${r3(duracion)}" data-track-index="${z}" data-width="1080" data-height="${alto}"${extra} style="position: absolute; left: 0; top: ${top}px; width: 1080px; height: ${alto}px; z-index: ${z}"></div>`,
    );

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
      archivos["compositions/fondo.html"] = pieza("fondo-shader.html", { ID: "fondo", DURACION: D, SHADER: SHADERS[o.fondo], PROPS: escaparHtml(JSON.stringify(props)) });
      copias.push({ origen: SHADERS_JS, destino: "assets/vendor/shaders.iife.js" });
      host("fondo", "fondo.html", 0, D, 10, " data-no-timeline");
    } else {
      if (conShader) avisos.push(`No hay WebGPU en esta máquina: \`fondo: ${o.fondo}\` se sustituye por un degradado animado con los colores del tema.`);
      const animado = o.fondo !== "ninguno";
      archivos["compositions/fondo.html"] = pieza("fondo-css.html", {
        ID: "fondo",
        DURACION: D,
        COLOR_A: colores.acento,
        COLOR_B: colores.secundario,
        ANIMADO: animado ? "true" : "false",
        OCULTO: animado ? "" : "display: none",
      });
      host("fondo", "fondo.html", 0, D, 10);
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
    let html: string;
    if (!esc) {
      const img = e.imagenes[k];
      if (!img) throw new Error(`Falta la imagen del bloque ${v.n}.`);
      const archivo = `img${v.n}${img.extension}`;
      copias.push({ origen: img.ruta, destino: `assets/${archivo}` });
      const [dx, dy] = DIRECCIONES[k % DIRECCIONES.length];
      html = pieza("bloque-foto.html", {
        ID: id,
        DURACION: v.duracion,
        IMG: escaparHtml(archivo),
        DATOS: jsonParaScript({ duracion: v.duracion, dx, dy, movimiento: true, ...env }),
      });
    } else {
      const comun = { ID: id, DURACION: v.duracion, FUENTES: fuentesCss, ENVOLTURA: envolturaJs(id, env) };
      switch (esc.tipo) {
        case "cifra":
          html = piezaCifra(esc, comun, v, empieza, env.golpes[0]);
          break;
        case "cartel":
          html = piezaCartel(esc, comun, empieza);
          break;
        case "barras":
          html = piezaBarras(esc, comun, v, empieza, colores);
          break;
        case "mapa":
          html = piezaMapa(esc, comun, empieza, colores);
          break;
        case "titulo3d":
          usa3d = true;
          html = pieza("escena-titulo3d.html", {
            ...comun,
            DATOS: jsonParaScript({ texto: (esc as EscenaTitulo3d).texto, acento: colores.acento, duracion: v.duracion, empieza }),
          });
          break;
        case "tunel": {
          usaTunel = true;
          const fotos = e.imagenes
            .map((img, i) => (img ? `assets/img${i + 1}${img.extension}` : undefined))
            .filter((x): x is string => !!x);
          e.imagenes.forEach((img, i) => img && copias.push({ origen: img.ruta, destino: `assets/img${i + 1}${img.extension}` }));
          const paleta = (tema.paletaTunel ?? [colores.acento, colores.secundario, colores.texto]).filter((c) => COLOR_RE.test(c));
          html = pieza("escena-tunel.html", { ...comun, IMAGENES: escaparHtml(fotos.join(",")), PALETA: paleta.join(","), ACENTO: colores.acento });
          break;
        }
      }
    }
    archivos[`compositions/${id}.html`] = html;
    host(id, `${id}.html`, v.inicio, v.duracion, 10 + v.n);
  }

  // Reencuadre final de la imagen 1 para que el short haga bucle (solo si el bloque 1 es una foto).
  const img1 = e.imagenes[0];
  if (!escenas[1] && img1) {
    const archivo = `img1-bucle${img1.extension}`;
    copias.push({ origen: img1.ruta, destino: `assets/${archivo}` });
    archivos["compositions/bucle.html"] = pieza("bloque-foto.html", {
      ID: "bucle",
      DURACION: COLA_FINAL,
      IMG: escaparHtml(archivo),
      DATOS: jsonParaScript({ duracion: COLA_FINAL, dx: 0, dy: 0, movimiento: false, fundido: TRANSICION, punch: false, golpes: [] }),
    });
    host("bucle", "bucle.html", D - COLA_FINAL, COLA_FINAL, 17);
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
  archivos["compositions/capas.html"] = pieza("capas.html", {
    DURACION: D,
    FUENTES: fuentesCss,
    VINETA: o.look === "pelicula" ? 0.75 : 0.62,
    BLOQUES_LUZ: luzHtml,
    LOOK: lookHtml,
    DATOS: jsonParaScript({ duracion: D, destellos }),
  });
  host("capas", "capas.html", 0, D, 40);

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
  archivos["compositions/gancho.html"] = pieza("gancho.html", {
    DURACION: finGancho,
    FUENTES: fuentesCss,
    TAMANO: tamanoGancho(guion.gancho, tema.tamanos.gancho, tema.tamanos.ganchoMinimo, 972, 600),
    PALABRAS: palabrasGancho
      .map((w, i) => `<span class="palabra${i === palabrasGancho.length - 1 ? " acento" : ""}">${escaparHtml(w)}</span>`)
      .join(""),
  });
  host("gancho", "gancho.html", 0, finGancho, 50, "", 620, 200);
  if (o.etiqueta && etiqueta) {
    const dur = r3(etiqueta.fin - etiqueta.inicio);
    archivos["compositions/etiqueta.html"] = pieza("etiqueta.html", {
      DURACION: dur,
      FUENTES: fuentesCss,
      TEXTO: escaparHtml(o.etiqueta),
      TAMANO: Math.min(64, Math.floor(872 / (Math.max(o.etiqueta.length, 1) * 0.56))),
    });
    host("etiqueta", "etiqueta.html", etiqueta.inicio, dur, 51, "", 160, etiqueta.top);
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
  archivos["compositions/subtitulos.html"] = pieza("subtitulos.html", {
    DURACION: D,
    ESTILO: estilo,
    FUENTES: fuentesCss,
    GRUPOS: gruposHtml,
    DATOS: jsonParaScript({
      estilo,
      colores: { texto: colores.texto, acento: colores.acento },
      grupos: grupos.map((g) => ({ id: g.id, inicio: g.inicio, palabras: g.palabras.map((p) => ({ id: p.id, inicio: p.inicio, fin: p.fin, enfasis: p.enfasis })) })),
    }),
  });
  host("subtitulos", "subtitulos.html", 0, D, 60, ' data-track-kind="captions"');

  // ---- Destellos blancos: cambio de bloque y golpe ----
  const flash = ventanas.slice(1).map((v) => ({ t: v.corte, opacidad: 0.55, sube: 0.05, baja: 0.2 }));
  if (golpe) flash.push({ t: r3(golpe.t), opacidad: 0.35, sube: 0.03, baja: 0.15 });
  flash.sort((a, b) => a.t - b.t);
  // Dos destellos no pueden pisarse: si el golpe cae encima de un corte, gana el más fuerte.
  const flashSinSolape = flash.filter((x, i) => i === 0 || x.t >= flash[i - 1].t + flash[i - 1].sube + flash[i - 1].baja);
  archivos["compositions/flash.html"] = pieza("flash.html", { DURACION: D, DATOS: jsonParaScript({ destellos: flashSinSolape }) });
  host("flash", "flash.html", 0, D, 70);

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
    `--fuente-titulos: "${familiaCss(f.titulos.familia)}", "League Gothic", sans-serif;`,
    `--peso-titulos: ${Number(f.titulos.peso) || 400};`,
    `--fuente-subtitulos: "${familiaCss(f.subtitulos.familia)}", "Inter", sans-serif;`,
    `--peso-subtitulos: ${Number(f.subtitulos.peso) || 800};`,
    `--mayusculas: ${tema.subtitulos?.mayusculas === false ? "none" : "uppercase"};`,
    `--degradado: ${Math.min(1, Math.max(0, tema.degradado?.opacidad ?? 0.78))};`,
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

type Comun = { ID: string; DURACION: number; FUENTES: string; ENVOLTURA: string };
type Ventana = { duracion: number; visible: number };

function piezaCifra(esc: EscenaCifra, comun: Comun, v: Ventana, empieza: number, golpe?: number): string {
  const final = esc.prefijo + esc.valor.toLocaleString("en-US", { minimumFractionDigits: esc.decimales, maximumFractionDigits: esc.decimales }) + esc.sufijo;
  const tamano = Math.max(140, Math.min(380, Math.floor(900 / (Math.max(final.length, 1) * 0.5))));
  // La cuenta dura el 60 % del bloque; si el golpe cae en este bloque, aterriza justo en esa palabra.
  const cuenta = golpe !== undefined && golpe > empieza + 0.5 ? r3(golpe - (empieza + 0.1)) : r3(Math.max(0.4, v.visible * 0.6));
  return pieza("escena-cifra.html", {
    ...comun,
    TAMANO: tamano,
    INICIAL: escaparHtml(esc.prefijo + "0" + esc.sufijo),
    ETIQUETA: escaparHtml(esc.etiqueta ?? ""),
    DATOS: jsonParaScript({ valor: esc.valor, prefijo: esc.prefijo, sufijo: esc.sufijo, decimales: esc.decimales, empieza: r3(empieza + 0.1), cuenta, aterriza: r3(empieza + 0.1 + cuenta) }),
  });
}

function piezaCartel(esc: EscenaCartel, comun: Comun, empieza: number): string {
  const palabras = esc.texto.split(/\s+/).filter(Boolean);
  return pieza("escena-cartel.html", {
    ...comun,
    TAMANO: tamanoGancho(esc.texto, 180, 80, 900, esc.subtexto ? 520 : 640),
    PALABRAS: palabras.map((w, i) => `<span class="w${i === palabras.length - 1 ? " ultima" : ""}" data-layout-allow-occlusion>${escaparHtml(w)}</span>`).join(""),
    SUBTEXTO: escaparHtml(esc.subtexto ?? ""),
    DATOS: jsonParaScript({ empieza: r3(empieza) }),
  });
}

function piezaBarras(esc: EscenaBarras, comun: Comun, v: Ventana, empieza: number, colores: { texto: string; acento: string }): string {
  const filas = esc.series
    .map(
      (s, j) =>
        `                <div id="${comun.ID}-f${j}" class="fila"><div class="nombre" data-layout-allow-occlusion>${escaparHtml(s.nombre)}</div><div class="barra"></div><div class="valor" data-layout-allow-occlusion></div></div>`,
    )
    .join("\n");
  const duracionPeriodo = r3(Math.max(0.3, (v.visible - 0.3) / esc.periodos.length));
  return pieza("escena-barras.html", {
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
  });
}

function piezaMapa(esc: EscenaMapa, comun: Comun, empieza: number, colores: { texto: string; acento: string }): string {
  // El mapa ocupa de 300 a 920 px: por debajo va la etiqueta (930-1010) y no debe tapar ninguna zona.
  const m = trazarMapa(esc.region, esc.destacar, 1000, 620);
  const trazados = [
    ...m.extra.filter((x) => x.clase !== "marco").map((x) => `                <path class="${x.clase}" d="${x.d}" />`),
    ...m.base.map((x) => `                <path class="base" d="${x.d}" />`),
    ...m.destacadas.map((x, i) => `                <path id="${comun.ID}-z${i}" class="dest" d="${x.d}" />`),
    ...m.extra.filter((x) => x.clase === "marco").map((x) => `                <path class="${x.clase}" d="${x.d}" />`),
  ].join("\n");
  const enciende = r3(empieza + 0.35);
  return pieza("escena-mapa.html", {
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
  });
}

// ---------- Escritura ----------

/** Escribe _composicion\ desde cero con el plan ya calculado. */
export function escribirPlan(destino: string, plan: PlanComposicion): void {
  // En Windows un Chrome que acaba de cerrarse puede tener la carpeta abierta unos instantes.
  fs.rmSync(destino, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
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

/** Busca URLs de red en la composición generada (no debe quedar ninguna). */
export function urlsDeRed(destino: string): string[] {
  const encontradas: string[] = [];
  const recorrer = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const ruta = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "vendor" && !e.name.startsWith(".")) recorrer(ruta);
      } else if (/\.(html|css)$/i.test(e.name)) {
        const t = fs.readFileSync(ruta, "utf8");
        for (const m of t.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
          if (!m[0].startsWith("http://www.w3.org/")) encontradas.push(`${path.relative(destino, ruta)}: ${m[0]}`);
        }
      }
    }
  };
  recorrer(destino);
  return encontradas;
}
