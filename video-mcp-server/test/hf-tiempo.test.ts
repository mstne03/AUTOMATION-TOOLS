// Motor de tiempo WAAPI de las piezas (SEO-111) con un DOM falso: retardo absoluto, fill, traducción de propiedades,
// tiempos e ids validados (I1, I11), reloj por hf-seek y envoltura de escena equivalente a envolturaJs.
import fs from "node:fs";
import { describe, expect, it } from "vitest";

type Llamada = { sel: string; kf: Record<string, string>[]; op: { delay: number; duration: number; easing: string; fill: string } };
type Ctx = {
  inicio: number;
  tween: (sel: string, desde: object, hasta: object, t: number, d: number, curva: string, op?: { antes?: boolean }) => void;
  reloj: (fn: (t: number) => void) => void;
  envoltura: (e: unknown) => void;
};
type Hf = { contexto: (id: string, inicio: number) => Ctx };

const CODIGO = fs.readFileSync(new URL("../plantilla/vendor/hf-tiempo.js", import.meta.url), "utf8");

function entorno() {
  const llamadas: Llamada[] = [];
  const oyentes: ((e: { detail: { time: unknown } }) => void)[] = [];
  const elementos = new Map<string, object>();
  const raiz = {
    querySelectorAll(sel: string) {
      if (sel === "#no-existe") return [];
      if (!elementos.has(sel))
        elementos.set(sel, {
          id: sel,
          animate(kf: Llamada["kf"], op: Llamada["op"]) {
            llamadas.push({ sel, kf, op });
            return { pause() {} };
          },
        });
      return [elementos.get(sel)];
    },
  };
  const document = { querySelector: (s: string) => (s === '[data-composition-id="b1"]' ? raiz : null) };
  const window: { HF?: Hf; addEventListener: (tipo: string, fn: (typeof oyentes)[number]) => void } = {
    addEventListener: (tipo, fn) => tipo === "hf-seek" && oyentes.push(fn),
  };
  new Function("window", "document", CODIGO)(window, document);
  return { HF: window.HF!, llamadas, seek: (time: unknown) => oyentes.forEach((f) => f({ detail: { time } })) };
}

describe("hf-tiempo.js", () => {
  it("tween crea una animación en pausa con delay absoluto", () => {
    const { HF, llamadas } = entorno();
    HF.contexto("b1", 2).tween("#t", { opacity: 0 }, { opacity: 1 }, 0.5, 0.4, "none");
    expect(llamadas).toHaveLength(1);
    const { op, kf } = llamadas[0];
    expect(op.delay).toBe(2500);
    expect(op.duration).toBe(400);
    expect(op.fill).toBe("both");
    expect(op.easing.startsWith("linear(")).toBe(true);
    expect(kf).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it("antes: false equivale a immediateRender: false", () => {
    const { HF, llamadas } = entorno();
    HF.contexto("b1", 0).tween("#t", { opacity: 0 }, { opacity: 1 }, 0, 1, "none", { antes: false });
    expect(llamadas[0].op.fill).toBe("forwards");
  });

  it("x/y/scale/rotation van a translate/scale/rotate", () => {
    const { HF, llamadas } = entorno();
    HF.contexto("b1", 0).tween("#t", { x: 0, y: 0, scale: 1, rotation: 0 }, { x: 10, y: -5, scale: 1.2, rotation: 3 }, 0, 1, "none");
    expect(llamadas[0].kf[1]).toEqual({ translate: "calc(10px) calc(-5px)", scale: "1.2", rotate: "3deg" });
  });

  it("mezclar tweens de x e y por separado en el mismo elemento lanza", () => {
    const { HF } = entorno();
    const c = HF.contexto("b1", 0);
    c.tween("#t", { x: 0 }, { x: 10 }, 0, 1, "none");
    expect(() => c.tween("#t", { y: 0 }, { y: 10 }, 1, 1, "none")).toThrow(/mezcla tweens de x e y/);
  });

  it("un selector que no existe lanza", () => {
    const { HF } = entorno();
    expect(() => HF.contexto("b1", 0).tween("#no-existe", { opacity: 0 }, { opacity: 1 }, 0, 1, "none")).toThrow(/no existe en b1/);
  });

  it("inicio, t o d no finitos lanzan (I1)", () => {
    const { HF } = entorno();
    expect(() => HF.contexto("b1", NaN)).toThrow(/no finito/);
    expect(() => HF.contexto("b1", -1)).toThrow(/no finito/);
    expect(() => HF.contexto("b1", "2" as unknown as number)).toThrow(/no finito/);
    const c = HF.contexto("b1", 0);
    expect(() => c.tween("#t", { opacity: 0 }, { opacity: 1 }, Infinity, 0.4, "none")).toThrow(/no finito/);
    expect(() => c.tween("#t", { opacity: 0 }, { opacity: 1 }, 0, NaN, "none")).toThrow(/no finito/);
    expect(() => c.tween("#t", { opacity: 0 }, { opacity: 1 }, 0, -1, "none")).toThrow(/no finito/);
  });

  it("x, y, xPercent, yPercent, scale o rotation no finitos lanzan (L3)", () => {
    const { HF, llamadas } = entorno();
    const c = HF.contexto("b1", 0);
    for (const p of ["x", "y", "xPercent", "yPercent", "scale", "rotation"]) {
      expect(() => c.tween(`#${p}`, { [p]: 0 }, { [p]: NaN }, 0, 1, "none"), p).toThrow(/no finito/);
      expect(() => c.tween(`#${p}2`, { [p]: "1" }, { [p]: 1 }, 0, 1, "none"), p).toThrow(/no finito/);
    }
    expect(llamadas).toHaveLength(0);
  });

  it("un id fuera de la regex lanza", () => {
    const { HF } = entorno();
    expect(() => HF.contexto('b1"]', 0)).toThrow(/id no válido/);
    expect(() => HF.contexto("B1", 0)).toThrow(/id no válido/);
  });

  it("reloj da tiempo local e ignora tiempos no finitos", () => {
    const { HF, seek } = entorno();
    const vistos: number[] = [];
    HF.contexto("b1", 2).reloj((t) => vistos.push(t));
    expect(vistos).toEqual([-2]);
    seek(3.5);
    seek(NaN);
    seek("1");
    seek(Infinity);
    expect(vistos).toEqual([-2, 1.5]);
  });

  it("envoltura equivale a envolturaJs", () => {
    const { HF, llamadas } = entorno();
    HF.contexto("b1", 0).envoltura({ fundido: 0.3, punch: true, golpes: [1.2] });
    expect(llamadas).toHaveLength(6);
    expect(llamadas[0]).toMatchObject({ sel: "#b1-fundido", kf: [{ opacity: 0 }, { opacity: 1 }], op: { delay: 0, duration: 300, fill: "both" } });
    expect(llamadas[1]).toMatchObject({ sel: "#b1-punch", kf: [{ scale: "1.07" }, { scale: "1" }], op: { delay: 0, duration: 450, fill: "both" } });
    expect(llamadas[1].op.easing).toBe((HF as unknown as { linear: (n: string) => string }).linear("expo.out"));
    expect(llamadas[0].op.easing).toBe((HF as unknown as { linear: (n: string) => string }).linear("none"));
    const golpes = llamadas.slice(2);
    golpes.forEach((g, i) => {
      expect(g.sel).toBe("#b1-golpe");
      expect(Math.abs(g.op.delay - (1.2 + i / 30) * 1000)).toBeLessThan(1e-6);
      expect(g.op.fill).toBe("forwards");
    });
    expect(golpes[0].kf).toEqual([{ translate: "calc(0px) calc(0px)" }, { translate: "calc(22px) calc(-14px)" }]);
    expect(golpes[3].kf[1]).toEqual({ translate: "calc(0px) calc(0px)" });
  });

  it("envoltura sin fundido, punch ni golpes no anima nada", () => {
    const { HF, llamadas } = entorno();
    HF.contexto("b1", 0).envoltura({ fundido: 0, punch: false, golpes: [] });
    expect(llamadas).toHaveLength(0);
  });

  it("envoltura con datos no válidos lanza (M1)", () => {
    const { HF } = entorno();
    const c = HF.contexto("b1", 0);
    expect(() => c.envoltura({ fundido: 0, punch: false, golpes: [null] })).toThrow(/envoltura/);
    expect(() => c.envoltura({ golpes: ["1"] })).toThrow(/envoltura/);
    expect(() => c.envoltura({ fundido: NaN, punch: false, golpes: [] })).toThrow(/envoltura/);
    expect(() => c.envoltura({ fundido: -1, punch: false, golpes: [] })).toThrow(/envoltura/);
    expect(() => c.envoltura({ fundido: 0, punch: "sí", golpes: [] })).toThrow(/envoltura/);
    expect(() => c.envoltura({ fundido: 0, punch: false, golpes: [-1] })).toThrow(/envoltura/);
    expect(() => c.envoltura(null)).toThrow(/envoltura/);
  });
});
