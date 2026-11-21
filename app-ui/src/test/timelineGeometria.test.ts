import { describe, expect, it } from "vitest";
import {
  PX_POR_SEGUNDO,
  ajustarAPalabra,
  indiceDestino,
  lineasSubtitulos,
  moverLimite,
  palabrasDeFrase,
  planificar,
  reordenar,
  tiempoAX,
  xATiempo,
} from "../video/timeline/geometria";
import type { Proyecto } from "../video/modelo";

const proyecto = (n: number, extra: Partial<Proyecto> = {}): Proyecto => ({
  version: 1,
  id: "p1",
  revision: 1,
  titulo: "T",
  gancho: "G",
  aspecto: "9:16",
  perfilId: "defecto",
  creado: "2026-11-07T10:00:00Z",
  actualizado: "2026-11-07T10:00:00Z",
  frases: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, texto: "diez letra" })),
  escenas: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, fraseIds: [`f${i}`], base: { tipo: "cartel" as const, texto: "x" }, ajusteCorte: 0 })),
  recursos: [],
  subtitulos: { estilo: "karaoke", correcciones: [], cortes: [] },
  opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [] },
  ...extra,
});

describe("conversión tiempo y posición", () => {
  it("tiempoAX y xATiempo son inversas", () => {
    expect(tiempoAX(2)).toBe(2 * PX_POR_SEGUNDO);
    expect(xATiempo(tiempoAX(3.5))).toBeCloseTo(3.5);
    expect(xATiempo(-20)).toBe(0);
    expect(tiempoAX(1, 100)).toBe(100);
    expect(xATiempo(250, 100)).toBe(2.5);
  });
  it("una escala inválida no produce NaN", () => {
    expect(tiempoAX(1, 0)).toBe(0);
    expect(xATiempo(10, 0)).toBe(0);
    expect(tiempoAX(Number.NaN)).toBe(0);
  });
});

describe("reordenar", () => {
  it("mueve un elemento sin mutar la lista", () => {
    const ids = ["a", "b", "c", "d"];
    expect(reordenar(ids, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reordenar(ids, 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });
  it("índices fuera de rango o iguales devuelven una copia igual", () => {
    const ids = ["a", "b"];
    expect(reordenar(ids, 0, 0)).toEqual(ids);
    expect(reordenar(ids, -1, 1)).toEqual(ids);
    expect(reordenar(ids, 0, 9)).toEqual(ids);
    expect(reordenar(ids, 0, 9)).not.toBe(ids);
  });
});

describe("ajustarAPalabra", () => {
  const palabras = [
    { inicio: 0, fin: 0.4 },
    { inicio: 0.5, fin: 1.0 },
    { inicio: 1.2, fin: 2.0 },
  ];
  it("elige el límite de palabra más cercano", () => {
    expect(ajustarAPalabra(0.44, palabras)).toBe(0.4);
    expect(ajustarAPalabra(0.49, palabras)).toBe(0.5);
    expect(ajustarAPalabra(1.9, palabras)).toBe(2.0);
    expect(ajustarAPalabra(-3, palabras)).toBe(0);
    expect(ajustarAPalabra(50, palabras)).toBe(2.0);
  });
  it("sin palabras devuelve el tiempo, no negativo", () => {
    expect(ajustarAPalabra(1.3, [])).toBe(1.3);
    expect(ajustarAPalabra(-1, [])).toBe(0);
  });
});

describe("indiceDestino", () => {
  it("devuelve el índice del clip sobre el que cae la posición", () => {
    // tres clips de 100 px
    const anchos = [100, 100, 100];
    expect(indiceDestino(10, anchos)).toBe(0);
    expect(indiceDestino(140, anchos)).toBe(1);
    expect(indiceDestino(900, anchos)).toBe(2);
    expect(indiceDestino(-5, [])).toBe(0);
  });
});

describe("planificar", () => {
  it("reparte la duración de la voz entre las frases por caracteres", () => {
    const p = proyecto(2, { frases: [{ id: "f0", texto: "aaaa" }, { id: "f1", texto: "aaaaaaaa" }] });
    const l = planificar(p, 6);
    expect(l.total).toBeCloseTo(6);
    expect(l.frases.f0).toEqual({ inicio: 0, fin: 2 });
    expect(l.escenas[1].inicio).toBeCloseTo(2);
    expect(l.escenas[1].fin).toBeCloseTo(6);
  });
  it("el recorte manda sobre el reparto", () => {
    const p = proyecto(2, { frases: [{ id: "f0", texto: "aaaa", recorte: { inicio: 0.5, fin: 1.5 } }, { id: "f1", texto: "aaaa" }] });
    const l = planificar(p, 10);
    expect(l.frases.f0.fin - l.frases.f0.inicio).toBeCloseTo(1);
  });
  it("sin voz estima la duración y nunca devuelve NaN", () => {
    const l = planificar(proyecto(3), undefined);
    expect(l.total).toBeGreaterThan(0);
    for (const e of l.escenas) expect(Number.isFinite(e.fin)).toBe(true);
  });
  it("una escena con frases desconocidas dura el mínimo", () => {
    const p = proyecto(1);
    p.escenas[0].fraseIds = ["nada"];
    const l = planificar(p, 5);
    expect(l.escenas[0].fin - l.escenas[0].inicio).toBeGreaterThan(0);
  });
});

describe("palabras y líneas de subtítulos", () => {
  it("palabrasDeFrase reparte el intervalo por caracteres", () => {
    const w = palabrasDeFrase("uno tres", { inicio: 0, fin: 8 });
    expect(w).toHaveLength(2);
    expect(w[0].inicio).toBe(0);
    expect(w[1].fin).toBeCloseTo(8);
    expect(w[0].fin).toBeLessThanOrEqual(w[1].inicio);
  });
  it("lineasSubtitulos usa los cortes y aplica las correcciones", () => {
    const p = proyecto(1, {
      frases: [{ id: "f0", texto: "a b c d e" }],
      subtitulos: { estilo: "karaoke", correcciones: [{ indice: 1, texto: "B" }], cortes: [2] },
    });
    const l = lineasSubtitulos(p);
    expect(l.map((x) => x.palabras)).toEqual([["a", "B"], ["c", "d", "e"]]);
    expect(l[1].desde).toBe(2);
  });
  it("sin cortes parte en líneas de 4 palabras como máximo", () => {
    const p = proyecto(1, { frases: [{ id: "f0", texto: "a b c d e f" }] });
    expect(lineasSubtitulos(p).map((x) => x.palabras.length)).toEqual([4, 2]);
  });
});

describe("moverLimite", () => {
  const palabras = [
    { inicio: 0, fin: 1 },
    { inicio: 1, fin: 3 },
    { inicio: 3, fin: 4 },
  ];
  it("salta al límite de palabra anterior o siguiente", () => {
    expect(moverLimite(4, -1, palabras, 0.1, 4)).toBe(3);
    expect(moverLimite(3, -1, palabras, 0.1, 4)).toBe(1);
    expect(moverLimite(1, 1, palabras, 0.1, 4)).toBe(3);
  });
  it("no se sale de [mínimo, máximo]", () => {
    expect(moverLimite(4, 1, palabras, 0.1, 4)).toBeNull();
    expect(moverLimite(1, -1, palabras, 1, 4)).toBeNull();
  });
});
