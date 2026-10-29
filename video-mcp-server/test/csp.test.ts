// I2 (a): la composición lleva una CSP en <meta> con default-src 'none' y ninguna fuente de red; la raíz no registra
// timeline (data-no-timeline) y carga hf-tiempo.js junto a gsap (convivencia hasta W3.1). Se comprueba la plantilla y
// el index.html generado, con y sin importmap (titulo3d).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion } from "../src/alineacion.js";
import { cargarTema, PLANTILLA_DIR, planificarComposicion } from "../src/composicion.js";
import type { ImagenEncontrada } from "../src/paths.js";

// Valores exactos medidos (ver el comentario de index.html). Cambiar uno exige medirlo de nuevo.
const EXACTAS: Record<string, string> = {
  "default-src": "'none'",
  "script-src": "'self' 'unsafe-inline'",
  "style-src": "'self' 'unsafe-inline'",
  "worker-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'none'",
};
// Directivas que se pueden usar en un <meta> y tienen sentido aquí. report-to/report-uri, frame-ancestors y sandbox
// no funcionan en <meta>; cualquier otra no prevista se rechaza.
const DIRECTIVAS = new Set(["default-src", "script-src", "style-src", "img-src", "font-src", "media-src", "connect-src", "worker-src", "base-uri", "form-action"]);
const FUENTES_PERMITIDAS = new Set(["'none'", "'self'", "data:", "blob:", "'unsafe-inline'"]);

function decodificar(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const sinComentarios = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");

function politica(html: string): Map<string, string[]> {
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi)];
  expect(metas).toHaveLength(1);
  const p = new Map<string, string[]>();
  for (const parte of decodificar(metas[0][1]).split(";")) {
    const [nombre, ...fuentes] = parte.trim().split(/\s+/);
    if (!nombre) continue;
    expect(p.has(nombre), `directiva repetida ${nombre}`).toBe(false);
    p.set(nombre.toLowerCase(), fuentes);
  }
  return p;
}

const CUERPO = "[1] Five nations rule football.\n[2] Spain, Italy, Germany.\n[3] Brazil and Argentina.\n[4] Seventeen World Cups between them.\n[5] Nobody comes close.\n[6] Can anyone catch up?\n";
function indexGenerado(fm: string): string {
  const g = parsearGuion(`---\ntitulo: T\ngancho: Only five nations matter.\n${fm}\n---\n${CUERPO}`);
  const chars = [...g.narracion];
  const al = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.1) };
  const palabras = procesarAlineacion({ narracion: g.narracion, bloques: g.bloques, alineacion: al, hashNarracion: g.hash });
  const img = (n: number): ImagenEncontrada => ({ n, nombre: `img${n}.jpg`, ruta: `C:\\x\\img${n}.jpg`, extension: ".jpg" });
  const imagenes = [1, 2, 3, 4, 5, 6].map((n) => (g.opciones.escenas[n] ? undefined : img(n)));
  return planificarComposicion({ guion: g, palabras, imagenes, tema: cargarTema(), gpu: true }).archivos["index.html"];
}

const CASOS: [string, () => string][] = [
  ["plantilla/index.html", () => fs.readFileSync(path.join(PLANTILLA_DIR, "index.html"), "utf8")],
  ["index.html generado sin importmap", () => indexGenerado("")],
  ["index.html generado con importmap (titulo3d)", () => indexGenerado("escenas:\n  6:\n    tipo: titulo3d\n    texto: AGUA")],
];

describe.each(CASOS)("CSP de %s (I2 a)", (_, leer) => {
  it("hay una sola CSP en meta y va antes de cualquier script, estilo o importmap", () => {
    const html = sinComentarios(leer());
    const meta = html.search(/<meta\s+http-equiv="Content-Security-Policy"/i);
    expect(meta).toBeGreaterThan(0);
    for (const otro of [/<script\b/i, /<style\b/i, /\{\{IMPORTMAP\}\}/, /<link\b/i]) {
      const i = html.search(otro);
      if (i >= 0) expect(i, String(otro)).toBeGreaterThan(meta);
    }
    politica(html);
  });

  it("default-src es 'none', las directivas obligatorias tienen su valor exacto y no hay nombres desconocidos", () => {
    const p = politica(leer());
    for (const [d, v] of Object.entries(EXACTAS)) expect(p.get(d)?.join(" "), d).toBe(v);
    for (const d of p.keys()) expect(DIRECTIVAS.has(d), `directiva no permitida: ${d}`).toBe(true);
  });

  it("ninguna fuente es de red", () => {
    for (const [d, fuentes] of politica(leer())) {
      for (const f of fuentes) expect(FUENTES_PERMITIDAS.has(f), `${d}: ${f}`).toBe(true);
      if (["connect-src", "img-src", "media-src", "font-src"].includes(d)) expect(fuentes, d).not.toContain("'unsafe-inline'");
    }
  });

  it("'unsafe-eval' no aparece y worker-src nunca es 'self'", () => {
    const p = politica(leer());
    expect([...p.values()].flat().join(" ")).not.toMatch(/unsafe-eval/);
    expect(sinComentarios(leer())).not.toMatch(/unsafe-eval/);
    expect(p.get("worker-src")).not.toContain("'self'");
  });

  it("si hay 'unsafe-inline', un comentario lo justifica nombrando la directiva", () => {
    const html = leer();
    const comentarios = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]).join("\n");
    for (const [d, fuentes] of politica(html)) {
      if (fuentes.includes("'unsafe-inline'")) expect(comentarios, d).toMatch(new RegExp(`${d}[^\\n]*unsafe-inline|unsafe-inline[^\\n]*${d}`));
    }
  });

  it("no contiene URLs de red, ni en comentarios (urlsDeRed la rechazaría al montar, I2 c)", () => {
    expect(leer()).not.toMatch(/https?:\/\/(?!www\.w3\.org\/)/);
  });

  it("apaga el DNS prefetch (M2)", () => {
    expect(leer()).toMatch(/<meta\s+http-equiv="x-dns-prefetch-control"\s+content="off"\s*\/?>/i);
  });

  it("la raíz lleva data-no-timeline y no hay timeline main", () => {
    const html = leer();
    expect(html).toMatch(/<div id="root" data-composition-id="main" data-no-timeline/);
    expect(html).not.toMatch(/__timelines/);
  });

  it("carga gsap.min.js y hf-tiempo.js", () => {
    const html = leer();
    expect(html).toContain('<script src="assets/gsap.min.js"></script>');
    expect(html).toContain('<script src="assets/hf-tiempo.js"></script>');
  });
});
