// W2.6 (SEO-114): el glue «el último gana» del vendor, extraído del fichero real y evaluado con un `Ji` falso.
// Port de spikes/shader/glue.test.mjs. Sin navegador.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { OE_NUEVO, OE_ORIGINAL, VENDOR } from "./shaders-comun.js";

const tick = () => new Promise<void>((ok) => setTimeout(ok, 0));

interface Falso { Pe: number; enCurso: number; maxEnCurso: number; renders: number; lanzarDiag: number; rechazar: number }

/** Evalúa `texto` (que empieza dentro de una lista `var` del bundle) con un `Ji` falso. */
function crear(texto: string): { OE: (t: number | null) => Promise<void>; f: Falso } {
  const f: Falso = { Pe: 0, enCurso: 0, maxEnCurso: 0, renders: 0, lanzarDiag: 0, rechazar: 0 };
  const YE = () => ({
    __testing: {
      getFrameDiagnostics() {
        if (f.lanzarDiag > 0) { f.lanzarDiag--; throw new Error("diag síncrono"); }
        return { globalElapsedTime: f.Pe };
      },
    },
    async renderSyntheticFrame(d: number) {
      f.enCurso++;
      f.maxEnCurso = Math.max(f.maxEnCurso, f.enCurso);
      await tick();
      f.enCurso--;
      if (f.rechazar > 0) { f.rechazar--; throw new Error("render rechazado"); }
      f.Pe += d;
      f.renders++;
    },
  });
  const OE = new Function("YE", `var ${texto};return OE;`)(YE) as (t: number | null) => Promise<void>;
  return { OE, f };
}

/** El glue tal como está en el vendor. La última línea acaba en «\n» (L13 de la R0): hay que recortar antes de partir. */
function glueDelVendor(): string {
  const ultima = fs.readFileSync(VENDOR, "utf8").trimEnd().split("\n").at(-1)!;
  const ini = ultima.indexOf("Ji=YE(),T0=");
  expect(ini, "no se encuentra el glue en la última línea del vendor").toBeGreaterThanOrEqual(0);
  return ultima.slice(ini, ini + OE_NUEVO.length);
}

describe("glue de shaders «el último gana» (vendor real, Ji falso)", () => {
  it("el texto extraído del vendor es el literal del arreglo", () => {
    expect(glueDelVendor()).toBe(OE_NUEVO);
  });

  it("OE(null) y no finitos no congelan", async () => {
    const { OE, f } = crear(glueDelVendor());
    await OE(null);
    await OE(NaN);
    await OE(Infinity);
    await OE(5);
    expect(f.Pe).toBe(5);
  });

  it("throw síncrono de getFrameDiagnostics no congela", async () => {
    const { OE, f } = crear(glueDelVendor());
    f.lanzarDiag = 1;
    await expect(OE(3)).rejects.toThrow(/diag síncrono/);
    await OE(7);
    expect(f.Pe).toBe(7);
  });

  it("tras un rechazo vuelve a pintar", async () => {
    const { OE, f } = crear(glueDelVendor());
    f.rechazar = 1;
    await expect(OE(2)).rejects.toThrow(/render rechazado/);
    await OE(9);
    expect(f.Pe).toBe(9);
  });

  it("rechazo con peticiones nuevas pendientes: se relanza y pinta la última", async () => {
    const { OE, f } = crear(glueDelVendor());
    f.rechazar = 1;
    const p = OE(1);
    const rechazo = expect(p).rejects.toThrow(/render rechazado/);
    await Promise.resolve(); // deja arrancar el cuerpo (tras su `await null`): el render de 1 queda en curso
    expect(f.enCurso).toBe(1);
    OE(4).catch(() => {}); // llega mientras el primer render está en curso
    await rechazo;
    for (let i = 0; i < 10 && f.Pe !== 4; i++) await tick();
    expect(f.Pe).toBe(4);
  });

  it("60 llamadas seguidas: un solo render en curso y pinta el último valor", async () => {
    const { OE, f } = crear(glueDelVendor());
    const ps: Promise<void>[] = [];
    for (let i = 1; i <= 60; i++) ps.push(OE(i / 2));
    await Promise.all(ps);
    expect(f.maxEnCurso).toBe(1);
    expect(f.Pe).toBe(30);
    expect(f.renders).toBeLessThanOrEqual(3);
  });

  it("control negativo: el glue original hace un render por llamada", async () => {
    const { OE, f } = crear(OE_ORIGINAL);
    const ps: Promise<void>[] = [];
    for (let i = 1; i <= 60; i++) ps.push(OE(i / 2));
    await Promise.all(ps);
    expect(f.renders).toBe(60);
  });
});
