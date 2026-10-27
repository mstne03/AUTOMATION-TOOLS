import { describe, expect, it } from "vitest";
import { ErrorGuion, parsearGuion } from "../src/guion.js";

const FM = `---
titulo: The keeper who scored from his own box
gancho: He scored. From his own penalty area.
musica: _musica/tension-01.mp3     # opcional
---
`;

const BLOQUES = `
[1] In 1999, a goalkeeper did something nobody had ever seen...
[2] Second block.
[3] Third
block on two lines.
[4] Fourth.
[5] Fifth.
[6] ...and that is why they still sing his name.
`;

function problemas(contenido: string): string[] {
  try {
    parsearGuion(contenido);
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorGuion);
    return (e as ErrorGuion).problemas;
  }
  throw new Error("se esperaba un error");
}

describe("parsearGuion", () => {
  it("acepta un guion válido y calcula offsets sobre la narración concatenada", () => {
    const g = parsearGuion(FM + BLOQUES);
    expect(g.titulo).toBe("The keeper who scored from his own box");
    expect(g.gancho).toBe("He scored. From his own penalty area.");
    expect(g.musica).toBe("_musica/tension-01.mp3");
    expect(g.bloques).toHaveLength(6);
    expect(g.bloques[2].texto).toBe("Third block on two lines.");
    for (const b of g.bloques) expect(g.narracion.slice(b.inicio, b.fin)).toBe(b.texto);
    expect(g.narracion).toBe(g.bloques.map((b) => b.texto).join(" "));
    expect(g.caracteres).toBe(g.narracion.length);
    expect(g.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("acepta CRLF y música ausente", () => {
    const g = parsearGuion((FM.replace(/musica:.*\n/, "") + BLOQUES).replace(/\n/g, "\r\n"));
    expect(g.musica).toBeUndefined();
    expect(g.bloques).toHaveLength(6);
  });

  it("rechaza menos de 6 bloques", () => {
    const p = problemas(FM + BLOQUES.replace(/\[6\].*\n/, ""));
    expect(p.join(" ")).toMatch(/5 bloques/);
  });

  it("rechaza bloques desordenados", () => {
    const p = problemas(FM + BLOQUES.replace("[2]", "[X]").replace("[3]", "[2]").replace("[X]", "[3]"));
    expect(p.join(" ")).toMatch(/orden/);
  });

  it("rechaza un guion sin gancho", () => {
    const p = problemas(FM.replace(/gancho:.*\n/, "") + BLOQUES);
    expect(p.join(" ")).toMatch(/gancho/);
  });

  it("rechaza un guion sin frontmatter", () => {
    expect(problemas(BLOQUES).join(" ")).toMatch(/frontmatter/);
  });

  it("rechaza el exceso de caracteres e indica cuántos hay", () => {
    const largo = "word ".repeat(30).trim();
    const cuerpo = [1, 2, 3, 4, 5, 6].map((n) => `[${n}] ${largo}`).join("\n");
    const total = 6 * largo.length + 5;
    const p = problemas(FM + cuerpo);
    expect(p.join(" ")).toContain(`${total} caracteres`);
  });

  it("rechaza bloques vacíos y texto antes de [1]", () => {
    const p = problemas(FM + "Intro suelta\n" + BLOQUES.replace("[4] Fourth.", "[4]"));
    expect(p.join(" ")).toMatch(/antes de `\[1\]`/);
    expect(p.join(" ")).toMatch(/\[4\] está vacío/);
  });
});
