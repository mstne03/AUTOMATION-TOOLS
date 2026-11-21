// T3: construirLinea suma los tiempos de cada frase con su recorte y el ajuste de corte de cada escena.
import { describe, expect, it } from "vitest";
import { COLA_FINAL } from "../src/alineacion.js";
import { construirLinea, desdeProyecto } from "../src/linea.js";
import { proyectoBruto, vozDe } from "./ayudas-n.js";

const voz = (p: ReturnType<typeof proyectoBruto>, duracion = 1) => new Map(p.frases.map((f) => [f.id, vozDe(f.texto, duracion)]));

describe("construirLinea", () => {
  it("suma las frases en orden y una escena por segmento", () => {
    const p = proyectoBruto(3);
    const r = construirLinea(p, voz(p));
    expect(r.duracionAudio).toBeCloseTo(3, 2);
    expect(r.duracionTotal).toBeCloseTo(3 + COLA_FINAL, 2);
    expect(r.segmentos.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(r.segmentos.map((s) => s.mostrarDesde)).toEqual([0, 1, 2]);
    expect(r.segmentos.at(-1)!.mostrarHasta).toBeCloseTo(3 + COLA_FINAL, 2);
    expect(r.palabras.every((w) => w.segmento >= 1 && w.segmento <= 3)).toBe(true);
    for (let i = 1; i < r.palabras.length; i++) expect(r.palabras[i].inicio).toBeGreaterThanOrEqual(r.palabras[i - 1].inicio);
  });

  it("el recorte acorta la frase y mueve las siguientes", () => {
    const p = proyectoBruto(2);
    p.frases[0].recorte = { inicio: 0.25, fin: 0.75 };
    const r = construirLinea(p, voz(p));
    expect(r.duracionAudio).toBeCloseTo(1.5, 2);
    expect(r.segmentos[1].mostrarDesde).toBeCloseTo(0.5, 1);
    expect(r.palabras.every((w) => w.inicio >= 0 && w.fin <= 1.5 + 1e-6)).toBe(true);
  });

  it("ajusteCorte se pega al inicio de palabra más cercano", () => {
    const p = proyectoBruto(2);
    p.escenas[1].ajusteCorte = 0.3; // cae entre dos palabras de la frase 2
    const r = construirLinea(p, voz(p));
    const inicios = r.palabras.map((w) => w.inicio);
    expect(inicios).toContain(r.segmentos[1].mostrarDesde);
    expect(r.segmentos[1].mostrarDesde).toBeGreaterThan(1);
    p.escenas[1].ajusteCorte = -5; // nunca antes del inicio de la escena anterior
    expect(construirLinea(p, voz(p)).segmentos[1].mostrarDesde).toBeGreaterThanOrEqual(0);
  });

  it("correcciones y cortes de subtítulos", () => {
    const p = proyectoBruto(1, undefined, () => "Una dos tres cuatro cinco.");
    p.subtitulos.correcciones = [{ indice: 1, texto: "DOS" }];
    p.subtitulos.cortes = [2];
    const r = construirLinea(p, voz(p));
    expect(r.palabras[1].texto).toBe("DOS");
    const f = r.frases.find((x) => x.palabras.includes(2))!;
    expect(f.palabras[0]).toBe(2);
  });

  it("una frase sin voz lanza, y un tiempo no finito también", () => {
    const p = proyectoBruto(2);
    const v = voz(p);
    v.delete("f2");
    expect(() => construirLinea(p, v)).toThrow(/voz/i);
    const m = voz(p);
    m.get("f1")!.duracion = Number.NaN;
    expect(() => construirLinea(p, m)).toThrow(/finito/i);
  });
});

describe("desdeProyecto", () => {
  it("resuelve el golpe {frase, palabra} a la palabra de su escena y pasa los destellos por índice", () => {
    const p = proyectoBruto(3, undefined, (k) => `Hola mundo ${k + 1} fin.`);
    p.opciones.golpe = { frase: 1, palabra: "MUNDO," };
    p.opciones.destellos = [2];
    const r = construirLinea(p, voz(p));
    const d = desdeProyecto(p, r);
    expect(r.palabras[d.opciones.golpe!.indice]).toMatchObject({ segmento: 2 });
    expect(r.palabras[d.opciones.golpe!.indice].texto).toMatch(/mundo/i);
    expect(d.opciones.destellos).toEqual([2]);
    expect(d.escenas).toHaveLength(3);
    p.opciones.golpe = { frase: 1, palabra: "nada" };
    expect(desdeProyecto(p, r).opciones.golpe).toBeUndefined();
  });
});
