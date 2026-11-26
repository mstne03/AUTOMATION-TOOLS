// Tarea 0 de SEO-112: arnés de comparación arreglado (R2-L5) y ayudas comunes de las piezas migradas.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compararContraReferencia, veredicto } from "../scripts/comparar-fotogramas.mjs";
import { parsearGuion } from "../src/guion.js";
import { avisoSsimAislado, conCandadoDeRender, debeRehacerPngRef, ejecutarPieza, FORMA_GSAP, GUIONES_W2, SONDA_ESTADO } from "./piezas-comun.js";

const ENTORNO = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ENTORNO)) delete process.env[k];
  Object.assign(process.env, ENTORNO);
});

const SCRIPT = new URL("../scripts/comparar-fotogramas.mjs", import.meta.url);

describe("comparar-fotogramas (R2-L5)", () => {
  const fuente = fs.readFileSync(SCRIPT, "utf8");

  it("renderizar llama a comprobarComposicion(dir, gpu) y no pasa env a ejecutar", () => {
    expect(fuente).toMatch(/comprobarComposicion\(dir, gpu\)/);
    expect(fuente).not.toMatch(/env\b.*ejecutar|ejecutar\([^)]*\benv\b/);
  });

  it("existe compararContraReferencia y el veredicto sigue fallando con un solo fotograma bajo el umbral", () => {
    expect(typeof compararContraReferencia).toBe("function");
    expect(veredicto([{ n: 1, ssim: 1 }, { n: 2, ssim: 0.9899 }], 0.99).ok).toBe(false);
  });
});

describe("ejecutarPieza", () => {
  const pieza = (script: string, cuerpo = '<div id="a"></div>') =>
    `<div id="x" data-composition-id="x">${cuerpo}</div><script>${script}</script>`;

  it("una animación por tween, con retardo absoluto", () => {
    const r = ejecutarPieza(pieza('HF.contexto("x", 2).tween("#a", { opacity: 0 }, { opacity: 1 }, 0.5, 1, "none");'));
    expect(r.animaciones).toHaveLength(1);
    expect(r.animaciones[0]).toMatchObject({ sel: "#a", op: { delay: 2500, duration: 1000, fill: "both" } });
  });

  it("un selector que no está en el HTML lanza «no existe»", () => {
    expect(() => ejecutarPieza(pieza('HF.contexto("x", 0).tween("#no-existe", { opacity: 0 }, { opacity: 1 }, 0, 1, "none");'))).toThrow(/no existe/);
  });

  it("#id .clase cuenta tantos elementos como veces sale la clase", () => {
    const r = ejecutarPieza(pieza('HF.contexto("x", 0).tween("#a .w", { opacity: 0 }, { opacity: 1 }, 0, 1, "none");', '<div id="a"><b class="w"></b><b class="w"></b></div>'));
    expect(r.animaciones).toHaveLength(2);
  });

  it("seek(NaN) no llama al reloj; seek(3) sí, en segundos locales", () => {
    const r = ejecutarPieza(pieza('window.visto = []; HF.contexto("x", 1).reloj(function (t) { document.getElementById("a").textContent = String(t); });'));
    expect(r.elemento("a").textContent).toBe("-1");
    r.seek(NaN);
    expect(r.elemento("a").textContent).toBe("-1");
    r.seek(3);
    expect(r.elemento("a").textContent).toBe("2");
  });

  it("lee el JSON de datos y salta módulos y scripts con src", () => {
    const r = ejecutarPieza(
      `<div id="x" data-composition-id="x"><div id="a"></div></div><script id="x-datos" type="application/json">{"v":7}</script>` +
        `<script type="module">throw new Error("no")</script><script src="a.js"></script>` +
        `<script>document.getElementById("a").textContent = String(JSON.parse(document.getElementById("x-datos").textContent).v);</script>`,
    );
    expect(r.elemento("a").textContent).toBe("7");
  });
});

describe("FORMA_GSAP", () => {
  it("detecta gsap.timeline, window.__timelines y {{ENVOLTURA}}", () => {
    expect(FORMA_GSAP.test("var tl = gsap.timeline({})")).toBe(true);
    expect(FORMA_GSAP.test("window.__timelines[id] = tl")).toBe(true);
    expect(FORMA_GSAP.test("{{ENVOLTURA}}")).toBe(true);
    expect(FORMA_GSAP.test('HF.contexto("x", 0)')).toBe(false);
  });
});

describe("GUIONES_W2", () => {
  it("las seis claves parsean y los nuevos activan lo que dicen", () => {
    expect(Object.keys(GUIONES_W2).sort()).toEqual(["FONDO_CSS", "SUB_IMPACTO", "SUB_NEON", "SUB_PILDORA", "TODAS", "TUNEL"]);
    for (const g of Object.values(GUIONES_W2)) expect(() => parsearGuion(g)).not.toThrow();
    expect(parsearGuion(GUIONES_W2.FONDO_CSS).opciones.fondo).toBe("gradiente");
    for (const [k, estilo] of [["SUB_PILDORA", "pildora"], ["SUB_NEON", "neon"], ["SUB_IMPACTO", "impacto"]] as const) {
      const o = parsearGuion(GUIONES_W2[k]).opciones;
      expect(o.subtitulos).toBe(estilo);
      expect(o.enfasisPalabras).toHaveLength(2);
      expect(Object.keys(o.escenas)).toHaveLength(0);
    }
  });
});

describe("conCandadoDeRender", () => {
  it("serializa y libera el candado aunque falle", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "w2-candado-"));
    process.env.W2_REFS = path.join(base, "refs");
    const candado = path.join(base, "candado-render");
    await expect(conCandadoDeRender(async () => { expect(fs.existsSync(candado)).toBe(true); throw new Error("x"); })).rejects.toThrow("x");
    expect(fs.existsSync(candado)).toBe(false);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("SONDA_ESTADO es una expresión asíncrona con el player", () => {
    expect(SONDA_ESTADO).toMatch(/^\(async \(\) => \{/);
    expect(SONDA_ESTADO).toContain("hf-seek");
  });
});

describe("caché PNG de TUNEL y aviso de SSIM", () => {
  it("debeRehacerPngRef: solo se reutiliza con caché y sello igual al SHA actual", () => {
    expect(debeRehacerPngRef(true, "a", "a")).toBe(false);
    expect(debeRehacerPngRef(false, "a", "a")).toBe(true);
    expect(debeRehacerPngRef(true, "a", "b")).toBe(true);
    expect(debeRehacerPngRef(true, null, "a")).toBe(true);
  });

  it("avisoSsimAislado: avisa bajo 0,9915 (también bajo 0,99) y calla en el umbral", () => {
    expect(avisoSsimAislado(0.9914)).toMatch(/repetirse antes de diagnosticarlo/);
    expect(avisoSsimAislado(0.98)).not.toBeNull();
    expect(avisoSsimAislado(0.9915)).toBeNull();
  });
});
