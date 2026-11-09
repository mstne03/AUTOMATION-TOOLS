// T3: composición de N escenas. Negativas de seguridad (I1, I2), ids por índice, capas fijas y texto límite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cabeGancho, escribirPlan, planificarComposicion, tamanoGancho, type PlanComposicion } from "../src/composicion.js";
import { proyectoBruto, proyectoN, entradaDe, lineaDe } from "./ayudas-n.js";

const SRC = path.resolve(import.meta.dirname, "../src/composicion.ts");
const texto = (p: PlanComposicion) => Object.values(p.archivos).join("\n");
const z = (p: PlanComposicion, id: string) => Number(new RegExp(`id="h-${id}"[^>]*z-index: (\\d+)`).exec(p.archivos["index.html"])![1]);
const hosts = (p: PlanComposicion) => [...p.archivos["index.html"].matchAll(/id="h-([a-z0-9-]+)"/g)].map((m) => m[1]);

describe("N escenas", () => {
  it.each([1, 6, 12, 90])("n_escenas: %i escenas dan %i hosts esc<n> y la duración de la voz", (n) => {
    const p = planificarComposicion(entradaDe(proyectoN(n)));
    const escenas = hosts(p).filter((h) => /^esc\d+$/.test(h));
    expect(escenas).toEqual(Array.from({ length: n }, (_, k) => `esc${k + 1}`));
    expect(p.duracion).toBeCloseTo(n + 0.4, 2);
  });

  it("ids_por_indice: los ids de los ficheros nunca salen de los ids del Proyecto", () => {
    const raro = proyectoBruto(3);
    raro.escenas.forEach((e, k) => (e.id = `mia-${k}`));
    const p = planificarComposicion(entradaDe(raro));
    expect(Object.keys(p.archivos).filter((r) => r.startsWith("compositions/esc"))).toEqual(["esc1", "esc2", "esc3"].map((i) => `compositions/${i}.html`));
    expect(texto(p)).not.toContain("mia-");
  });

  it("noventa_escenas_orden_z: las capas fijas quedan por encima de esc90", () => {
    const p = planificarComposicion(entradaDe(proyectoN(90, undefined, (k) => `Frase ${k + 1} uno.`), { gpu: false }));
    const z90 = z(p, "esc90");
    expect(z(p, "fondo")).toBeLessThan(z(p, "esc1"));
    for (const [id, fijo] of [["capas", 200], ["gancho", 210], ["subtitulos", 220], ["flash", 230]] as const) {
      expect(z(p, id)).toBe(fijo);
      expect(z(p, id)).toBeGreaterThan(z90);
    }
  });

  it("capas fijas: bucle 199, etiqueta 211", () => {
    const e = entradaDe(proyectoN(3), { palabras: lineaDe(proyectoN(3), 4) }); // frases de 4 s: la foto del inicio deja sitio a la etiqueta
    e.opciones.etiqueta = "ETIQ";
    e.escenas[0] = { imagen: { n: 1, nombre: "img1.jpg", ruta: "C:\\x\\img1.jpg", extension: ".jpg" } };
    const p = planificarComposicion(e);
    expect(z(p, "bucle")).toBe(199);
    expect(z(p, "etiqueta")).toBe(211);
  });

  it("sin_6_literal: composicion.ts no tiene los literales del guion de 6 bloques", () => {
    const src = fs.readFileSync(SRC, "utf8");
    expect(src).not.toMatch(/\[1,\s*2,\s*3,\s*4,\s*5,\s*6\]/);
    expect(src).not.toMatch(/k\s*===\s*5|k\s*<\s*5|slice\(0,\s*5\)|!==\s*6/);
  });

  it("los segmentos deben ser tantos como escenas", () => {
    const e = entradaDe(proyectoN(3));
    e.escenas.pop();
    expect(() => planificarComposicion(e)).toThrow(/escenas/);
  });

  it("destello fuera de rango lanza antes de escribir", () => {
    const e = entradaDe(proyectoN(3));
    e.opciones.destellos = [3];
    expect(() => planificarComposicion(e)).toThrow(/destello/i);
  });

  it("destellos por índice desde 0 y look película en todas las escenas", () => {
    const e = entradaDe(proyectoN(4));
    e.opciones.destellos = [1];
    expect(texto(planificarComposicion(e)).match(/id="capas-luz\d+"/g)).toEqual(['id="capas-luz2"']);
    e.opciones.look = "pelicula";
    expect(texto(planificarComposicion(e)).match(/id="capas-luz\d+"/g)).toHaveLength(4);
  });
});

const ATAQUES = ["<script>alert(1)</script>", "{{ID}}", "</script><script>x()</script>", '"><img src=x onerror=alert(1)>', "&lt;b&gt; & '"];

/** Lo que no debe aparecer jamás sin escapar en ningún fichero. */
function sinCrudo(p: PlanComposicion, ataque: string) {
  const total = texto(p);
  expect(total).not.toContain("<script>alert");
  expect(total).not.toContain("</script><script>");
  expect(total).not.toContain('"><img');
  expect(total).not.toContain("<img src=x");
  // Una sola pasada: el valor no se vuelve a expandir. Se exige en las piezas que pasan por `pieza()`, no en index.html
  // (su título sale de otro `replace` y conservaría el literal aunque `pieza()` hiciera dos pasadas).
  if (ataque === "{{ID}}") {
    const piezas = Object.entries(p.archivos).filter(([rel]) => /^compositions\/(esc\d+|subtitulos)\.html$/.test(rel));
    expect(piezas.some(([rel, c]) => rel.includes("esc") && c.includes("{{ID}}"))).toBe(true);
    expect(piezas.some(([rel, c]) => rel.includes("subtitulos") && c.includes("{{ID}}"))).toBe(true);
  }
  // Todo `<script` del plan es el del propio motor (los de las piezas y el JSON de datos).
  for (const [rel, c] of Object.entries(p.archivos)) {
    for (const m of c.matchAll(/<script\b[^>]*>/g)) expect(m[0], rel).toMatch(/^<script(?: type="(?:module|application\/json|importmap)")?(?: [a-z-]+="[^"<>]*")*>$/);
  }
}

describe("negativas de seguridad (I1, I2)", () => {
  it.each(ATAQUES)("script_y_llaves_escapados: %s en cada campo de texto de cada tipo", (a) => {
    const bases = [
      (k: number) => ({ tipo: "cartel" as const, texto: a, subtexto: a }),
      (k: number) => ({ tipo: "cifra" as const, valor: 12, prefijo: a.slice(0, 6), sufijo: a.slice(0, 6), etiqueta: a, decimales: 0 }),
      (k: number) => ({ tipo: "barras" as const, titulo: a, periodos: [a, "B"], series: [{ nombre: a, valores: [1, 2] }, { nombre: "x", valores: [3, 4] }], prefijo: a.slice(0, 6), sufijo: a.slice(0, 6), fuente: a }),
      (k: number) => ({ tipo: "mapa" as const, region: "europa" as const, destacar: ["Spain"], etiqueta: a, titulo: a }),
    ];
    const proyecto = proyectoBruto(bases.length, (k) => bases[k](k) as never, () => `${a} dos.`);
    proyecto.titulo = a;
    proyecto.gancho = a;
    const e = entradaDe(proyecto, { titulo: a, gancho: a, palabras: lineaDe(proyecto) });
    e.opciones.etiqueta = a;
    // Los tests de escapar no validan (el esquema ya rechaza URL): `&lt;` y compañía deben pasar tal cual por el plan.
    const p = planificarComposicion(e);
    sinCrudo(p, a);
  });

  it("sin_url_de_red: un Proyecto a mano con http://x se rechaza antes de escribir nada", () => {
    for (const campo of ["cartel", "gancho", "titulo", "frase"] as const) {
      const pr = proyectoBruto(2, (k) => ({ tipo: "cartel", texto: k === 0 && campo === "cartel" ? "mira http://x.example/a" : "Hola" }));
      if (campo === "gancho") pr.gancho = "http://x.example";
      if (campo === "titulo") pr.titulo = "https://x.example";
      if (campo === "frase") pr.frases[0].texto = "ve a http://x.example ahora.";
      expect(() => planificarComposicion(entradaDe(pr, { titulo: pr.titulo, gancho: pr.gancho })), campo).toThrow(/red/i);
    }
  });

  it("clave_no_llega: ELEVENLABS_API_KEY no está en ningún fichero del plan", () => {
    const antes = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "sk-centinela-t3-1234567890";
    try {
      const p = planificarComposicion(entradaDe(proyectoN(4)));
      expect(texto(p)).not.toContain("sk-centinela-t3");
      expect(JSON.stringify(p.copias)).not.toContain("sk-centinela-t3");
    } finally {
      if (antes === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = antes;
    }
  });

  it("numero_no_finito_lanza", () => {
    const cifra = proyectoBruto(1, () => ({ tipo: "cifra", valor: Number.NaN, prefijo: "", sufijo: "", decimales: 0 }));
    expect(() => planificarComposicion(entradaDe(cifra))).toThrow(/finito/i);
    const e = entradaDe(proyectoN(2));
    e.palabras.duracionAudio = Number.POSITIVE_INFINITY;
    expect(() => planificarComposicion(e)).toThrow(/finito/i);
    const w = entradaDe(proyectoN(2));
    w.palabras.palabras[0].inicio = Number.NaN;
    expect(() => planificarComposicion(w)).toThrow(/finito/i);
  });
});

describe("texto límite (Review Focus 1)", () => {
  const casos: [string, string][] = [
    ["palabra de 80 letras", "A".repeat(80)],
    ["emoji", "🔥🔥🔥 ".repeat(12).trim()],
    ["árabe", "مرحبا بالعالم كيف حالك اليوم يا صديقي العزيز"],
  ];
  it.each(casos)("test_texto_limite_cabe: %s", (_n, gancho) => {
    const e = entradaDe(proyectoN(2), { gancho });
    const p = planificarComposicion(e);
    const t = e.tema.tamanos;
    const s = tamanoGancho(gancho, t.gancho, t.ganchoMinimo, 972, 600);
    expect(s).toBeGreaterThanOrEqual(t.ganchoMinimo);
    // Cabe al tamaño elegido o hay aviso: nunca se desborda en silencio.
    expect(cabeGancho(gancho, s, 972, 600) || p.avisos.some((a) => /gancho/i.test(a))).toBe(true);
  });
});

describe("cierres de la R1 de T3", () => {
  const A = '<script>x</script>"><img onerror=x>{{ID}}';
  it("etiqueta, correcciones y titulo3d con ataque: sin crudo", () => {
    const pr = proyectoBruto(3, (k) => (k === 1 ? { tipo: "titulo3d", texto: "<script>x" } : { tipo: "cartel", texto: "Hola" }), () => "Uno dos tres cuatro cinco.");
    pr.subtitulos.correcciones = [{ indice: 1, texto: A }];
    const e = entradaDe(pr, { palabras: lineaDe(pr, 4) });
    e.opciones.etiqueta = A;
    e.escenas[0] = { imagen: { n: 1, nombre: "img1.jpg", ruta: "C:\\x\\img1.jpg", extension: ".jpg" } };
    const p = planificarComposicion(e);
    expect(p.archivos["compositions/etiqueta.html"]).toBeDefined(); // el escape de la etiqueta se ejercita de verdad
    sinCrudo(p, A);
    expect(texto(p)).not.toContain("<script>x");
  });
  it("escribirPlan rechaza un rel fuera de destino, antes de escribir", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "t3-"));
    const dest = path.join(d, "_composicion");
    const base = planificarComposicion(entradaDe(proyectoN(1)));
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, "centinela.txt"), "vivo"); // si se borrara antes de validar, desaparecería
    expect(() => escribirPlan(dest, { ...base, archivos: { ...base.archivos, "../fuera.html": "x" } })).toThrow(/fuera/);
    expect(() => escribirPlan(dest, { ...base, copias: [{ origen: import.meta.filename, destino: "..\\fuera.js" }] })).toThrow(/fuera/);
    expect(fs.existsSync(path.join(d, "fuera.html"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "centinela.txt"), "utf8")).toBe("vivo");
    fs.rmSync(d, { recursive: true, force: true });
  });
  it("más de 90 escenas lanza", () => {
    expect(() => planificarComposicion(entradaDe(proyectoBruto(91)))).toThrow(/90/);
  });
  it("estilo de subtítulos desconocido lanza", () => {
    const e = entradaDe(proyectoN(2));
    (e.opciones as { subtitulos: string }).subtitulos = 'x" onload="y';
    expect(() => planificarComposicion(e)).toThrow(/subt/i);
  });
});
