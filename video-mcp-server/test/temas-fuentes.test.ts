// Las reservas de fuente sin @font-face ("League Gothic", "Inter") hacían que HyperFrames inyectara su propia cara y el
// texto cambiara sin avisar. Todo lo que el tema y las piezas piden por nombre tiene que traer su @font-face.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { plan } from "./ayudas-plan.js";

const familias = (css: string) => [...css.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const conFace = (html: string, f: string) => html.includes(`@font-face { font-family: "${f}"`);

describe("fuentes del tema", () => {
  const { p } = plan("");
  const index = p.archivos["index.html"];

  it("las variables de fuente no llevan reservas sin @font-face", () => {
    const vars = [...index.matchAll(/--fuente-(?:titulos|subtitulos): ([^;]+);/g)].map((m) => m[1]);
    expect(vars).toHaveLength(2);
    for (const v of vars) {
      expect(v).not.toContain("League Gothic");
      expect(v).not.toMatch(/"Inter"/);
    }
    expect(index).toContain("Inter Tight");
  });

  it("cada familia de las variables tiene su @font-face en la pieza", () => {
    const gancho = p.archivos["compositions/gancho.html"];
    for (const m of index.matchAll(/--fuente-(?:titulos|subtitulos): ([^;]+);/g)) {
      for (const f of familias(m[1])) expect(conFace(gancho, f), f).toBe(true);
    }
  });

  it("cada font-family literal de una pieza tiene @font-face en esa pieza", () => {
    for (const [ruta, html] of Object.entries(p.archivos)) {
      if (!ruta.startsWith("compositions/")) continue;
      for (const f of familias([...html.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1]).join(" "))) {
        expect(conFace(html, f), `${path.basename(ruta)}: ${f}`).toBe(true);
      }
    }
  });
});
