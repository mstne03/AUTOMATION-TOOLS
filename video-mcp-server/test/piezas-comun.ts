// Ayudas comunes de los tests de migración de piezas GSAP → hf-tiempo (SEO-112, oleada 2): pieza ejecutada con un DOM
// falso (sin motor), guiones de comparación, exclusión mutua entre renders y sonda de estado de la preview.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PlanComposicion } from "../src/composicion.js";
import { compararPngContraReferencia, renderizar } from "../scripts/comparar-fotogramas.mjs";
import { GUION_TODAS, GUION_TUNEL } from "../scripts/montar.mjs";

const HF_TIEMPO = fs.readFileSync(new URL("../plantilla/vendor/hf-tiempo.js", import.meta.url), "utf8");

/** Lo que una pieza migrada no puede conservar (I12): el timeline de GSAP, `__timelines` y el marcador de envoltura. */
export const FORMA_GSAP = /gsap|__timelines|\{\{ENVOLTURA\}\}/i;

export function piezaHtml(p: PlanComposicion, nombre: string): string {
  const html = p.archivos[`compositions/${nombre}.html`];
  if (html === undefined) throw new Error(`piezaHtml: no hay compositions/${nombre}.html en el plan`);
  return html;
}

export type Animacion = { sel: string; kf: object[]; op: { delay: number; duration: number; easing: string; fill: string } };
export type ElementoFalso = {
  textContent: string;
  style: Record<string, string>;
  children: ElementoFalso[];
  /** Llama a los oyentes registrados con `addEventListener(tipo, …)` (p. ej. `load` de una imagen). */
  disparar(tipo: string): void;
  [propiedad: string]: unknown;
};
export type EjecucionPieza = {
  animaciones: Animacion[];
  /** Despacha `hf-seek` con `{ detail: { time: t } }` a los oyentes de la pieza. */
  seek(t: number): void;
  elemento(id: string): ElementoFalso;
};

type Nodo = ElementoFalso & {
  id: string;
  children: Nodo[];
  addEventListener(tipo: string, f: () => void): void;
  animate(kf: object[], op: Animacion["op"]): { pause(): void };
  appendChild(n: Nodo): Nodo;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  querySelector(sel: string): Nodo | null;
  querySelectorAll(sel: string): Nodo[] & { forEach: Array<Nodo>["forEach"] };
};

/**
 * Ejecuta los `<script>` clásicos de `html` (sin `type` ni `src`) con el `hf-tiempo.js` real y un DOM falso.
 * Un selector `#id` o `#id .clase` solo existe si el HTML tiene ese `id` / esa clase (como «no existe en» del runtime);
 * `.clase` devuelve tantos elementos como veces aparece la clase en el HTML.
 */
export function ejecutarPieza(html: string): EjecucionPieza {
  const animaciones: Animacion[] = [];
  const oyentes: ((e: { detail: { time: unknown } }) => void)[] = [];
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const clases = new Map<string, number>();
  for (const m of html.matchAll(/\bclass="([^"]*)"/g)) for (const c of m[1].split(/\s+/).filter(Boolean)) clases.set(c, (clases.get(c) ?? 0) + 1);
  const texto = new Map<string, string>();
  for (const m of html.matchAll(/<script\b[^>]*\bid="([^"]+)"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) texto.set(m[1], m[2]);
  const raizId = /data-composition-id="([^"]+)"/.exec(html)?.[1];

  const cache = new Map<string, Nodo[]>();
  const alertas = new Map<Nodo, Map<string, (() => void)[]>>();
  const nodo = (clave: string, id = ""): Nodo => {
    const n: Nodo = {
      id,
      textContent: texto.get(id) ?? "",
      style: {},
      children: [],
      addEventListener(tipo, f) {
        (alertas.get(n) ?? alertas.set(n, new Map()).get(n)!).set(tipo, [...(alertas.get(n)!.get(tipo) ?? []), f]);
      },
      disparar(tipo) {
        (alertas.get(n)?.get(tipo) ?? []).forEach((f) => f());
      },
      animate(kf, op) {
        animaciones.push({ sel: clave, kf, op });
        return { pause() {} };
      },
      appendChild(h) {
        n.children.push(h);
        return h;
      },
      // Solo el contenedor tiene atributos útiles: `data-composition-variables` (declaración de variables de la pieza).
      getAttribute: (a) => (a === "data-composition-variables" && id === raizId ? /data-composition-variables='([^']*)'/.exec(html)?.[1] ?? null : null),
      setAttribute() {},
      querySelector: (sel) => resolver(sel)[0] ?? null,
      querySelectorAll: (sel) => resolver(sel),
    };
    return n;
  };
  const resolver = (sel: string): Nodo[] => {
    const hit = cache.get(sel);
    if (hit) return hit;
    let r: Nodo[] = [];
    const m = /^#([a-z][\w-]*)(?:\s+\.([\w-]+))?$/i.exec(sel) ?? /^()\.([\w-]+)$/.exec(sel);
    if (m && (!m[1] || ids.has(m[1]))) {
      if (!m[2]) r = [nodo(sel, m[1])];
      else r = Array.from({ length: clases.get(m[2]) ?? 0 }, () => nodo(sel));
    }
    cache.set(sel, r);
    return r;
  };
  const porId = (id: string): Nodo | null => (ids.has(id) ? resolver(`#${id}`)[0] : null);

  const raiz = raizId ? nodo(`[data-composition-id="${raizId}"]`, raizId) : undefined;
  const document = {
    getElementById: porId,
    querySelector: (sel: string) => (sel === `[data-composition-id="${raizId}"]` ? raiz! : resolver(sel)[0] ?? null),
    querySelectorAll: (sel: string) => resolver(sel),
    createElement: (tag: string) => nodo(`<${tag}>`),
  };
  const window: Record<string, unknown> = { addEventListener: (tipo: string, fn: (typeof oyentes)[number]) => tipo === "hf-seek" && oyentes.push(fn) };
  new Function("window", "document", HF_TIEMPO)(window, document);
  const HF = window.HF;

  // Scripts clásicos: ni `type=` (módulo, JSON) ni `src=`.
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\b(?:type|src)\s*=/.test(m[1])) continue;
    new Function("window", "document", "HF", `"use strict";\n${m[2]}`)(window, document, HF);
  }
  return {
    animaciones,
    seek: (t) => oyentes.forEach((f) => f({ detail: { time: t } })),
    elemento(id) {
      const n = porId(id);
      if (!n) throw new Error(`ejecutarPieza: no hay #${id} en la pieza`);
      return n;
    },
  };
}

// ---------- Guiones de comparación ----------

const CUERPO = `
[1] It started small, and then the money kept coming in.
[2] Nearly ninety thousand points ahead of everyone else.
[3] Nobody comes close to that number today.
[4] Sales went up every single year since then.
[5] Spain and Italy led the way in Europe.
[6] And the water kept rising all along.
`;

/** `fondo-css` solo se monta con `fondo: gradiente` y una escena sobre fondo (cifra y cartel). */
const FONDO_CSS = `---
titulo: Arnés SEO-112 fondo-css
gancho: "Nobody saw this coming"
fondo: gradiente
escenas:
  2:
    tipo: cifra
    valor: 90000
    sufijo: " pts"
    etiqueta: Points ahead
  3:
    tipo: cartel
    texto: Nobody comes close
    subtexto: Not even near
---
${CUERPO}`;

/** Solo subtítulos de `estilo` (con dos palabras de énfasis del cuerpo) y ninguna escena. */
const sub = (estilo: string) => `---
titulo: Arnés SEO-112 subtítulos ${estilo}
gancho: "Nobody saw this coming"
subtitulos: ${estilo}
enfasis: [money, ninety]
---
${CUERPO}`;

export const GUIONES_W2: Record<"TODAS" | "TUNEL" | "FONDO_CSS" | "SUB_PILDORA" | "SUB_NEON" | "SUB_IMPACTO", string> = {
  TODAS: GUION_TODAS,
  TUNEL: GUION_TUNEL,
  FONDO_CSS,
  SUB_PILDORA: sub("pildora"),
  SUB_NEON: sub("neon"),
  SUB_IMPACTO: sub("impacto"),
};

// ---------- Motor y renders ----------

/** `VIDEO_ENGINE_DIR` y `W2_REFS`, o `undefined` con aviso en stderr (`console.warn` lo oculta vitest; patrón de M4). */
export function ejecucionConMotor(): { motor: string; refs: string } | undefined {
  const motor = process.env.VIDEO_ENGINE_DIR?.trim();
  const refs = process.env.W2_REFS?.trim();
  if (motor && refs) return { motor, refs };
  process.stderr.write("[AVISO] SSIM y preview de las piezas NO verificados: falta VIDEO_ENGINE_DIR o W2_REFS\n");
  return undefined;
}

const CADUCIDAD_CANDADO_MS = 30 * 60_000;

/**
 * Exclusión mutua entre worktrees: `mkdir` atómico de `<W2_REFS>/../candado-render`, sondeo cada 5 s y candado caducado
 * a los 30 min. Cinco renders a la vez dan el `encoder unavailable` intermitente medido en W1.2.
 */
export async function conCandadoDeRender<T>(fn: () => Promise<T>): Promise<T> {
  const refs = process.env.W2_REFS?.trim();
  if (!refs) throw new Error("conCandadoDeRender: falta W2_REFS");
  const candado = path.join(refs, "..", "candado-render");
  for (;;) {
    try {
      fs.mkdirSync(candado);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(candado).mtimeMs > CADUCIDAD_CANDADO_MS) fs.rmSync(candado, { recursive: true, force: true });
      } catch {
        /* otro proceso lo acaba de liberar */
      }
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(candado, { recursive: true, force: true });
  }
}

/**
 * SSIM por fotograma de TUNEL por PNG sin pérdida (x264 recuantiza el grano y baja el SSIM aunque la pieza sea idéntica).
 * La referencia GSAP se renderiza una vez a PNG (~1 GB, ~7 min) en `W2_SCRATCH` (o junto a W2_REFS, que no se toca) y se
 * reutiliza; se escribe en un directorio temporal y se renombra, para no dejar una caché a medias. Todo bajo el candado.
 */
export async function compararTunelPng(motor: string, refs: string, dirCand: string, salida: string) {
  const base = process.env.W2_SCRATCH?.trim() || path.join(refs, "..");
  const pngRef = path.join(base, "png-ref-tunel");
  const sello = `${pngRef}.sello`;
  const dirRef = path.join(refs, "TUNEL", "montaje", "proyecto", "video001", "_composicion");
  return conCandadoDeRender(async () => {
    // La caché va ligada a la referencia: si ref.mp4 cambia, el PNG guardado ya no la representa.
    const sha = createHash("sha256").update(fs.readFileSync(path.join(refs, "TUNEL", "ref.mp4"))).digest("hex");
    const guardado = fs.existsSync(sello) ? fs.readFileSync(sello, "utf8").trim() : null;
    if (debeRehacerPngRef(fs.existsSync(pngRef), guardado, sha)) {
      fs.rmSync(pngRef, { recursive: true, force: true });
      const tmp = `${pngRef}.tmp`;
      fs.rmSync(tmp, { recursive: true, force: true });
      await renderizar(motor, dirRef, tmp, path.join(base, "hf-home-png-ref"), { png: true, timeoutMs: 1_800_000 });
      fs.renameSync(tmp, pngRef);
      fs.writeFileSync(sello, sha);
    }
    const informe = await compararPngContraReferencia(motor, pngRef, dirCand, salida);
    const aviso = avisoSsimAislado(informe.ssimMin);
    if (aviso) process.stderr.write(aviso);
    return informe;
  });
}

/** Decisión pura: la caché PNG se reutiliza solo si existe y su sello coincide con el SHA-256 actual de ref.mp4. */
export function debeRehacerPngRef(existe: boolean, selloGuardado: string | null, shaActual: string): boolean {
  return !existe || selloGuardado !== shaActual;
}

/** Umbral blando de TUNEL: el duro es 0,99; entre ambos hay ruido de ejecución que no justifica diagnóstico. */
export const SSIM_AVISO_TUNEL = 0.9915;

/** Aviso (o `null`) para un `ssimMin` bajo el umbral blando; no falla el test. */
export function avisoSsimAislado(ssimMin: number): string | null {
  return ssimMin < SSIM_AVISO_TUNEL
    ? `[AVISO] TUNEL ssimMin=${ssimMin} < ${SSIM_AVISO_TUNEL}: un rojo aislado debe repetirse antes de diagnosticarlo.
`
    : null;
}

// ---------- Sonda de preview ----------

/** Sonda con la lista de tiempos (s) a la que se hace `seek`; `SONDA_ESTADO` usa los de por defecto. */
export function sondaConTiempos(tiempos: number[]): string {
  return `(async () => {
  const P = window.__player, espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const TIEMPOS = ${JSON.stringify(tiempos)};
  const r05 = (v) => Math.round(v * 2) / 2;
  const estado = () => [...document.querySelectorAll("[id]")]
    .filter((e) => !["SCRIPT", "STYLE", "AUDIO", "VIDEO", "META", "LINK"].includes(e.tagName))
    .map((e) => {
      const c = getComputedStyle(e), b = e.getBoundingClientRect();
      return { id: e.id, rect: [r05(b.x), r05(b.y), r05(b.width), r05(b.height)], opacity: +Number(c.opacity).toFixed(3), color: c.color, texto: e.children.length ? "" : e.textContent.slice(0, 200) };
    });
  const seeks = async () => { const o = {}; for (const t of TIEMPOS) { P.seek(t); await espera(150); o[t] = estado(); } return o; };
  P.seek(0); await espera(200);
  const frio = await seeks();
  P.seek(0); await espera(200);
  let hfSeeks = 0;
  window.addEventListener("hf-seek", () => hfSeeks++);
  const anim = document.getAnimations().find((a) => Number.isFinite(a.currentTime));
  const desfases = [];
  P.play();
  const t0 = performance.now();
  while (performance.now() - t0 < 3000) { await new Promise((r) => requestAnimationFrame(r)); if (anim) desfases.push(Math.abs(anim.currentTime - P.getTime() * 1000)); }
  P.pause();
  desfases.sort((x, y) => x - y);
  P.seek(0); await espera(150); P.play(); await espera(12000); P.pause();
  const tras = await seeks();
  return { frio, tras, play: { hfSeeks, animaciones: document.getAnimations().length, desfaseMedianaMs: desfases.length ? desfases[desfases.length >> 1] : null } };
})()`;
}

export const SONDA_ESTADO: string = sondaConTiempos([0.5, 1, 2.5, 4.2, 6.9, 10, 15]);
