import { describe, expect, it } from "vitest";
import {
  agruparFrases,
  procesarAlineacion,
  tiemposPorCaracter,
  type AlineacionCaracteres,
} from "../src/alineacion.js";

/** Alineación sintética: cada carácter dura `paso` segundos. */
function alinear(texto: string, paso = 0.05, desde = 0): AlineacionCaracteres {
  const chars = [...texto];
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => +(desde + i * paso).toFixed(3)),
    character_end_times_seconds: chars.map((_, i) => +(desde + (i + 1) * paso).toFixed(3)),
  };
}

function bloquesDe(textos: string[]) {
  let narracion = "";
  const bloques = textos.map((t, i) => {
    if (narracion) narracion += " ";
    const inicio = narracion.length;
    narracion += t;
    return { n: i + 1, inicio, fin: narracion.length };
  });
  return { narracion, bloques };
}

const TEXTOS = [
  "In 1999, a goalkeeper did something.",
  "Nobody had seen it.",
  "He ran forward.",
  "The ball flew — far.",
  "It went in!",
  "And they still sing his name.",
];

describe("procesarAlineacion", () => {
  it("caso normal: palabras, segmentos y frases coherentes", () => {
    const { narracion, bloques } = bloquesDe(TEXTOS);
    const r = procesarAlineacion({ narracion, bloques, alineacion: alinear(narracion), hashNarracion: "h" });
    expect(r.avisos).toEqual([]);
    expect(r.palabras[0]).toEqual({ texto: "In", inicio: 0, fin: 0.1, segmento: 1 });
    expect(r.palabras.map((p) => p.segmento)).toEqual([...r.palabras.map((p) => p.segmento)].sort());
    expect(r.segmentos).toHaveLength(6);
    // Segmento 2 empieza en la "N" de "Nobody".
    const off = narracion.indexOf("Nobody");
    expect(r.segmentos[1].inicio).toBeCloseTo(off * 0.05, 3);
    // La imagen N se ve hasta el inicio de la siguiente; la última, hasta audio + 0,4.
    expect(r.segmentos[0].mostrarDesde).toBe(0);
    expect(r.segmentos[0].mostrarHasta).toBe(r.segmentos[1].inicio);
    expect(r.segmentos[5].mostrarHasta).toBeCloseTo(narracion.length * 0.05 + 0.4, 3);
    expect(r.duracionTotal).toBeCloseTo(r.duracionAudio + 0.4, 3);
    // Frases: ≤ 3 palabras o ≤ 18 caracteres y nunca cruzan segmentos.
    for (const f of r.frases) {
      expect(f.palabras.length).toBeLessThanOrEqual(3);
      if (f.palabras.length > 1) expect(f.texto.length).toBeLessThanOrEqual(18);
      expect(new Set(f.palabras.map((i) => r.palabras[i].segmento)).size).toBe(1);
    }
    // Todas las palabras están en exactamente una frase, en orden.
    expect(r.frases.flatMap((f) => f.palabras)).toEqual(r.palabras.map((_, i) => i));
  });

  it("puntuación pegada a la palabra, también la suelta", () => {
    const { narracion, bloques } = bloquesDe(TEXTOS);
    const r = procesarAlineacion({ narracion, bloques, alineacion: alinear(narracion), hashNarracion: "h" });
    const textos = r.palabras.map((p) => p.texto);
    expect(textos).toContain("1999,");
    expect(textos).toContain("in!");
    expect(textos).toContain("flew —");
    expect(textos).not.toContain("—");
  });

  it("usa la duración real del audio si se le da", () => {
    const { narracion, bloques } = bloquesDe(TEXTOS);
    const r = procesarAlineacion({ narracion, bloques, alineacion: alinear(narracion), duracionAudio: 20, hashNarracion: "h" });
    expect(r.duracionAudio).toBe(20);
    expect(r.segmentos[5].mostrarHasta).toBe(20.4);
  });

  it("descuadre por normalización: alineamiento tolerante con aviso, sin fallar", () => {
    const { narracion, bloques } = bloquesDe(TEXTOS);
    // ElevenLabs "normaliza" 1999 → nineteen ninety-nine.
    const normalizado = narracion.replace("1999", "nineteen ninety-nine");
    const r = procesarAlineacion({ narracion, bloques, alineacion: alinear(normalizado), hashNarracion: "h" });
    expect(r.avisos.length).toBe(1);
    expect(r.avisos[0]).toMatch(/tolerante/);
    expect(r.palabras).toHaveLength(narracion.split(" ").filter((t) => t !== "—").length);
    expect(r.palabras.map((p) => p.texto)).toContain("1999,");
    // Los tiempos siguen siendo crecientes y la última palabra cae al final del audio normalizado.
    for (let i = 1; i < r.palabras.length; i++) expect(r.palabras[i].inicio).toBeGreaterThanOrEqual(r.palabras[i - 1].inicio);
    expect(r.palabras.at(-1)!.fin).toBeCloseTo(normalizado.length * 0.05, 2);
    // "goalkeeper" está desplazado por los caracteres añadidos.
    const gk = r.palabras.find((p) => p.texto === "goalkeeper")!;
    expect(gk.inicio).toBeCloseTo(normalizado.indexOf("goalkeeper") * 0.05, 2);
  });

  it("alineación con menos caracteres de los enviados", () => {
    const texto = "Hello there world";
    const recortado = alinear("Hello there");
    const r = tiemposPorCaracter(texto, recortado);
    expect(r.descuadre).toBeGreaterThan(0);
    expect(r.inicios).toHaveLength(texto.length);
    expect(r.inicios.every(Number.isFinite)).toBe(true);
  });
});

describe("agruparFrases", () => {
  it("corta a 3 palabras, a 18 caracteres y en límite de segmento", () => {
    const p = (texto: string, segmento: number, i: number) => ({ texto, inicio: i, fin: i + 0.5, segmento });
    const palabras = [
      p("a", 1, 0),
      p("b", 1, 1),
      p("c", 1, 2),
      p("d", 1, 3),
      p("extraordinarily", 1, 4),
      p("long", 1, 5),
      p("x", 2, 6),
    ];
    const f = agruparFrases(palabras);
    expect(f.map((x) => x.texto)).toEqual(["a b c", "d extraordinarily", "long", "x"]);
  });
});
