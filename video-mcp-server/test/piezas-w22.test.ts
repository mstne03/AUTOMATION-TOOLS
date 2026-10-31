// W2.2 (SEO-112): flash, etiqueta, bloque-foto, escena-cartel y fondo-css migradas de GSAP a hf-tiempo.
// «Unit»: la pieza real con un DOM falso (sin motor). «Motor»: SSIM contra la referencia GSAP congelada y sonda de
// preview; se saltan con aviso si falta VIDEO_ENGINE_DIR o W2_REFS.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compararContraReferencia } from "../scripts/comparar-fotogramas.mjs";
import { montar } from "../scripts/montar.mjs";
import { sondearPreview } from "../scripts/sondear-preview.mjs";
import { planDeGuion } from "./ayudas-plan.js";
import { conCandadoDeRender, ejecucionConMotor, ejecutarPieza, FORMA_GSAP, GUIONES_W2, piezaHtml, SONDA_ESTADO } from "./piezas-comun.js";

const todas = planDeGuion(GUIONES_W2.TODAS).p;
const fondoCss = planDeGuion(GUIONES_W2.FONDO_CSS).p;
const sinFondo = planDeGuion(GUIONES_W2.FONDO_CSS.replace("fondo: gradiente", "fondo: ninguno")).p;

const datosDe = (html: string, id: string) => JSON.parse(new RegExp(`id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html)![1]);
const DIR_PIEZAS = new URL("../plantilla/piezas/", import.meta.url);
/** La plantilla con los marcadores sustituidos a mano (para duraciones que `composicion.ts` no genera). */
function plantilla(nombre: string, valores: Record<string, string | number>): string {
  return fs.readFileSync(new URL(`${nombre}.html`, DIR_PIEZAS), "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (k in valores ? String(valores[k]) : m));
}
const lineal = /^linear\(/;

describe("ninguna de las cinco piezas conserva GSAP (I12)", () => {
  for (const nombre of ["flash", "etiqueta", "bloque-foto", "escena-cartel", "fondo-css"]) {
    it(nombre, () => {
      const crudo = fs.readFileSync(new URL(`${nombre}.html`, DIR_PIEZAS), "utf8");
      expect(crudo).not.toMatch(FORMA_GSAP);
      expect(crudo).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    });
  }
});

describe("flash", () => {
  const html = piezaHtml(todas, "flash");
  const destellos: { t: number; opacidad: number; sube: number; baja: number }[] = datosDe(html, "flash-datos").destellos;
  const con = (d: unknown[]) => html.replace(/(id="flash-datos" type="application\/json">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify({ destellos: d })}$2`);

  it("usa el id y el inicio del host", () => {
    expect(html).not.toMatch(FORMA_GSAP);
    expect(html).toContain('HF.contexto("flash", 0)');
  });

  it("dos animaciones por destello, con el retardo y la duración del guion", () => {
    expect(destellos.length).toBeGreaterThan(1);
    const r = ejecutarPieza(html);
    expect(r.animaciones).toHaveLength(destellos.length * 2);
    destellos.forEach((e, i) => {
      const [a, b] = r.animaciones.slice(i * 2, i * 2 + 2);
      expect(a).toMatchObject({ sel: "#flash-luz", kf: [{ opacity: 0 }, { opacity: e.opacidad }], op: { delay: e.t * 1000, duration: e.sube * 1000, fill: "forwards" } });
      expect(b).toMatchObject({ sel: "#flash-luz", kf: [{ opacity: e.opacidad }, { opacity: 0 }], op: { delay: (e.t + e.sube) * 1000, duration: e.baja * 1000, fill: "forwards" } });
      expect(a.op.easing).toMatch(lineal);
      expect(b.op.easing).not.toBe(a.op.easing); // none frente a power2.out
    });
  });

  it("0 destellos: 0 animaciones y no lanza", () => {
    expect(ejecutarPieza(con([])).animaciones).toHaveLength(0);
  });

  it("destellos pegados: cuatro animaciones y no lanza", () => {
    const d = [{ t: 1, opacidad: 0.55, sube: 0.05, baja: 0.2 }, { t: 1.25, opacidad: 0.35, sube: 0.03, baja: 0.15 }];
    expect(ejecutarPieza(con(d)).animaciones).toHaveLength(4);
  });

  it("un dato no válido lanza y no se anima con basura (I11)", () => {
    expect(() => ejecutarPieza(con([{ t: -1, opacidad: 0.5, sube: 0.05, baja: 0.2 }]))).toThrow(/negativo/);
    expect(() => ejecutarPieza(con([{ t: 1, opacidad: "<img>", sube: 0.05, baja: 0.2 }]))).toThrow();
  });
});

describe("etiqueta", () => {
  const { p } = planDeGuion(GUIONES_W2.TODAS);
  const html = piezaHtml(p, "etiqueta");
  const D = Number(/data-duration="([\d.]+)"/.exec(html)![1]);
  const inicio = Number(/HF\.contexto\("etiqueta", ([\d.]+)\)/.exec(html)?.[1]);

  it("entra con back.out(2) y sale 0,2 s antes del final", () => {
    expect(html).not.toMatch(FORMA_GSAP);
    expect(Number.isFinite(inicio)).toBe(true);
    const r = ejecutarPieza(html);
    expect(r.animaciones).toHaveLength(2);
    const [entra, sale] = r.animaciones;
    expect(entra).toMatchObject({ sel: "#etiqueta-txt", kf: [{ translate: "calc(0px) calc(120%)", opacity: 0 }, { translate: "calc(0px) calc(0%)", opacity: 1 }], op: { delay: inicio * 1000, duration: 300, fill: "both" } });
    expect(sale).toMatchObject({ sel: "#etiqueta-txt", kf: [{ opacity: 1 }, { opacity: 0 }], op: { delay: (inicio + D - 0.2) * 1000, duration: 200, fill: "forwards" } });
    expect(entra.op.easing).not.toBe(sale.op.easing);
  });

  it("duración mínima (0,8 s, la que admite el plan) y degenerada (D < 0,2): no lanza ni congela", () => {
    for (const d of [0.8, 0.1]) {
      const r = ejecutarPieza(plantilla("etiqueta", { ID: "etiqueta", INICIO: 1, DURACION: d, TEXTO: "X", TAMANO: 64, FUENTES: "" }));
      expect(r.animaciones).toHaveLength(2);
      expect(r.animaciones[1].op.delay).toBe((1 + Math.max(0, d - 0.2)) * 1000);
    }
  });

  it("texto hostil: sale escapado y la pieza no escribe HTML", () => {
    const hostil = planDeGuion(GUIONES_W2.TODAS.replace("etiqueta: World Cup winners", 'etiqueta: "<script>alert(1)</script> {{INICIO}}"')).p;
    const h = piezaHtml(hostil, "etiqueta");
    expect(h).not.toContain("<script>alert(1)");
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(ejecutarPieza(h).animaciones).toHaveLength(2);
  });
});

describe("bloque-foto", () => {
  const bloque = (nombre: string, p = todas) => piezaHtml(p, nombre);
  const esperadas = (id: string, d: { duracion: number; dx: number; dy: number; movimiento: boolean; fundido: number; punch: boolean; golpes: number[] }, inicio: number) => {
    const ms = (s: number) => (inicio + s) * 1000;
    const r: object[] = [];
    if (d.movimiento) r.push({ sel: `#${id}-img`, op: { delay: ms(0), duration: d.duracion * 1000, fill: "both" } });
    if (d.fundido > 0) r.push({ sel: `#${id}-fundido`, op: { delay: ms(0), duration: d.fundido * 1000, fill: "both" } });
    if (d.punch) r.push({ sel: `#${id}-punch`, op: { delay: ms(0), duration: 450, fill: "both" } });
    for (const t of d.golpes) for (let i = 0; i < 4; i++) r.push({ sel: `#${id}-golpe`, op: { delay: ms(t + i / 30), duration: 1000 / 30, fill: "forwards" } });
    return r;
  };

  for (const [id, descripcion] of [["bloque1", "bloque 1 (sin fundido ni punch)"], ["bloque3", "bloque ≥ 2 con golpe de cámara"], ["bucle", "el bucle final"]] as const) {
    it(`${descripcion}: la lista exacta de animaciones`, () => {
      const nombre = id;
      // TODAS tiene fotos solo en el bloque 1 y el bucle; TUNEL las tiene en los bloques 1-5 (el 3 lleva fundido y punch).
      const p = id === "bloque3" ? planDeGuion(GUIONES_W2.TUNEL).p : todas;
      const html = bloque(nombre, p);
      expect(html).not.toMatch(FORMA_GSAP);
      const d = datosDe(html, `${nombre}-datos`);
      const inicio = Number(new RegExp(`HF\\.contexto\\("${nombre}", ([\\d.]+)\\)`).exec(html)?.[1]);
      expect(Number.isFinite(inicio)).toBe(true);
      const r = ejecutarPieza(html);
      expect(r.animaciones.map(({ sel, op }) => ({ sel, op: { delay: op.delay, duration: op.duration, fill: op.fill } }))).toEqual(esperadas(nombre, d, inicio));
      if (id === "bloque1") expect(d).toMatchObject({ fundido: 0, punch: false });
      if (id === "bloque3") expect(d.punch).toBe(true);
    });
  }

  it("Ken Burns: x, y y scale en el mismo tween, hasta (dx, dy, 1,08)", () => {
    const html = bloque("bloque1");
    const d = datosDe(html, "bloque1-datos");
    const kb = ejecutarPieza(html).animaciones.find((a) => a.sel === "#bloque1-img")!;
    expect(kb.kf).toEqual([{ translate: "calc(0px) calc(0px)", scale: "1" }, { translate: `calc(${d.dx}px) calc(${d.dy}px)`, scale: "1.08" }]);
  });

  it("el golpe de cámara sale con el DATOS real: cuatro pasos en el bloque del golpe", () => {
    const conGolpe = planDeGuion(GUIONES_W2.TUNEL.replace("look: pelicula", "look: pelicula\ngolpe: ninety")).p;
    const id = [1, 2, 3, 4, 5].map((n) => `bloque${n}`).find((b) => !conGolpe.archivos[`compositions/${b}.html`].includes('"golpes":[]'));
    expect(id).toBeDefined();
    const golpe = ejecutarPieza(conGolpe.archivos[`compositions/${id}.html`]).animaciones.filter((a) => a.sel === `#${id}-golpe`);
    expect(golpe).toHaveLength(4);
    expect(golpe.every((a) => a.op.fill === "forwards")).toBe(true);
  });

  it("DATOS no válidos: la envoltura lanza", () => {
    const html = bloque("bloque1");
    const mal = (campo: string, valor: unknown) => html.replace(/(id="bloque1-datos" type="application\/json">)([\s\S]*?)(<\/script>)/, (_m, a, b, c) => a + JSON.stringify({ ...JSON.parse(b), [campo]: valor }) + c);
    expect(() => ejecutarPieza(mal("punch", "si"))).toThrow(/envoltura/);
    expect(() => ejecutarPieza(mal("golpes", "x"))).toThrow(/envoltura/);
    expect(() => ejecutarPieza(mal("duracion", null))).toThrow();
  });
});

describe("escena-cartel", () => {
  const html = piezaHtml(todas, "bloque3");
  const d = datosDe(html, "bloque3-datos");
  const inicio = Number(/HF\.contexto\("bloque3", ([\d.]+)\)/.exec(html)?.[1]);

  it("una animación por palabra, separadas 0,067 s, más el subtexto y la envoltura", () => {
    expect(html).not.toMatch(FORMA_GSAP);
    expect(Number.isFinite(inicio)).toBe(true);
    const r = ejecutarPieza(html);
    const palabras = r.animaciones.filter((a) => a.sel === "#bloque3-txt .w");
    expect(palabras).toHaveLength(3); // «Nobody comes close»
    palabras.forEach((a, i) => {
      expect(a.kf).toEqual([
        { opacity: 0, filter: "blur(6px)", translate: "calc(0px) calc(24px)" },
        { opacity: 1, filter: "blur(0px)", translate: "calc(0px) calc(0px)" },
      ]);
      expect(a.op.delay).toBeCloseTo((inicio + d.empieza + i * 0.067) * 1000, 6);
      expect(a.op).toMatchObject({ duration: 350, fill: "both" });
    });
    const sub = r.animaciones.filter((a) => a.sel === "#bloque3-sub");
    expect(sub).toHaveLength(1);
    expect(sub[0].kf[1]).toMatchObject({ opacity: 0.85 });
    expect(sub[0].op.delay).toBeCloseTo((inicio + d.empieza + 0.4) * 1000, 6);
    // envoltura de un bloque ≥ 2: fundido + punch (+ golpes si los hay)
    const env = r.animaciones.filter((a) => !["#bloque3-txt .w", "#bloque3-sub"].includes(a.sel));
    expect(env.map((a) => a.sel)).toEqual(["#bloque3-fundido", "#bloque3-punch"]);
  });

  it("texto hostil: sale escapado y la pieza no usa innerHTML", () => {
    const hostil = planDeGuion(GUIONES_W2.TODAS.replace("texto: Nobody comes close", 'texto: "<img src=x onerror=1> {{INICIO}} B"').replace("subtexto: Not even near", 'subtexto: "<b>x</b>"')).p;
    const h = piezaHtml(hostil, "bloque3");
    expect(h).not.toContain("<img src=x");
    expect(h).not.toContain("<b>x</b>");
    expect(h).toContain("&lt;img");
    const r = ejecutarPieza(h);
    expect(r.animaciones.filter((a) => a.sel === "#bloque3-txt .w").length).toBeGreaterThan(0);
  });

  it("DATOS sin `empieza` válido lanza (I11)", () => {
    const mal = html.replace(/(id="bloque3-datos" type="application\/json">)[\s\S]*?(<\/script>)/, '$1{"empieza":"x"}$2');
    expect(() => ejecutarPieza(mal)).toThrow();
  });
});

describe("fondo-css", () => {
  it("animado: dos manchas, x, y y scale en el mismo tween, durante todo el vídeo", () => {
    const html = piezaHtml(fondoCss, "fondo");
    expect(html).not.toMatch(FORMA_GSAP);
    const D = Number(/data-duration="([\d.]+)"/.exec(html)![1]);
    const r = ejecutarPieza(html);
    expect(r.animaciones).toHaveLength(2);
    expect(r.animaciones[0]).toMatchObject({ sel: "#fondo-a", kf: [{ translate: "calc(0px) calc(0px)", scale: "1" }, { translate: "calc(420px) calc(520px)", scale: "1.15" }], op: { delay: 0, duration: D * 1000, fill: "both" } });
    expect(r.animaciones[1]).toMatchObject({ sel: "#fondo-b", kf: [{ translate: "calc(0px) calc(0px)", scale: "1.1" }, { translate: "calc(-480px) calc(-620px)", scale: "0.95" }] });
  });

  it("fondo: ninguno → 0 animaciones", () => {
    const html = piezaHtml(sinFondo, "fondo");
    expect(html).toContain("display: none");
    expect(ejecutarPieza(html).animaciones).toHaveLength(0);
  });
});

// ---------- Motor: SSIM contra GSAP y preview ----------

const motor = ejecucionConMotor();
const SALIDA = path.join(os.tmpdir(), "w2", "cand-w22");
const TIEMPO_MAXIMO = 25 * 60_000; // montaje + candado de render (otros worktrees) + render + SSIM

type Estado = { id: string; rect: number[]; opacity: number; color: string; texto: string };
type Sonda = { frio: Record<string, Estado[]>; tras: Record<string, Estado[]>; play: { hfSeeks: number; animaciones: number; desfaseMedianaMs: number | null } };

describe.skipIf(!motor)("W2.2 con motor", () => {
  const navegador = () => path.join(motor!.motor, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe");

  for (const clave of ["TODAS", "FONDO_CSS"] as const) {
    describe(clave, () => {
      let dirCand = "";

      it(
        "SSIM ≥ 0,99 por fotograma contra la referencia GSAP, mismo número de fotogramas y check sin errores",
        async () => {
          // El montaje lanza una prueba de GPU con la CLI: con la GPU ocupada falla y el fondo cae a CSS en silencio.
          const m = await conCandadoDeRender(() => montar(motor!.motor, path.join(SALIDA, clave, "montaje"), GUIONES_W2[clave]));
          expect(m.usaWebgpu, `la prueba de GPU del montaje falló: ${m.avisos.join(" | ")}`).toBe(clave === "TODAS");
          dirCand = m.dir;
          const informe = await conCandadoDeRender(() => compararContraReferencia(motor!.motor, path.join(motor!.refs, clave, "ref.mp4"), dirCand, path.join(SALIDA, clave, "cmp")));
          fs.writeFileSync(path.join(SALIDA, `${clave}-informe.json`), JSON.stringify(informe, null, 2));
          expect(informe.fotogramasCandidata).toBe(informe.fotogramasReferencia);
          expect(informe.ssimMin, JSON.stringify(informe.peores?.slice(0, 3))).toBeGreaterThanOrEqual(0.99);
          expect(informe.ok).toBe(true);
        },
        TIEMPO_MAXIMO,
      );

      it(
        "preview: estado en frío como GSAP, hf-seek durante el play y mismo estado tras 12 s de play",
        async () => {
          const cand = await conCandadoDeRender(() => sondearPreview({ navegador: navegador(), dir: dirCand, sonda: SONDA_ESTADO }));
          const ref = await conCandadoDeRender(() => sondearPreview({ navegador: navegador(), dir: path.join(motor!.refs, clave, "montaje", "proyecto", "video001", "_composicion"), sonda: SONDA_ESTADO }));
          fs.writeFileSync(path.join(SALIDA, `${clave}-preview.json`), JSON.stringify({ cand: cand.resultado, ref: ref.resultado }, null, 2));
          // Con el CfT 152 no hay adaptador WebGPU: el shader de aurora (W2.6) lo avisa también en la referencia GSAP.
          const propios = (e: string[]) => e.filter((x) => !/shaders: WebGPU unavailable/.test(x));
          expect(propios(cand.erroresPagina)).toEqual([]);
          expect(propios(ref.erroresPagina)).toEqual([]);
          const c = cand.resultado as Sonda;
          const r = ref.resultado as Sonda;
          // (a) en frío, rect ±0,75 px y opacidad ±0,01 contra la referencia GSAP
          const diferencias: string[] = [];
          for (const t of Object.keys(r.frio)) {
            const porId = new Map(c.frio[t].map((e) => [e.id, e]));
            for (const e of r.frio[t]) {
              const k = porId.get(e.id);
              if (!k) diferencias.push(`t=${t} ${e.id}: falta`);
              else if (e.rect.some((v, i) => Math.abs(v - k.rect[i]) > 0.75) || Math.abs(e.opacity - k.opacity) > 0.01 || e.texto !== k.texto) diferencias.push(`t=${t} ${e.id}: ${JSON.stringify(e)} ≠ ${JSON.stringify(k)}`);
            }
          }
          expect(diferencias).toEqual([]);
          // (b) durante el play llegan hf-seek y las animaciones WAAPI siguen al reloj
          expect(c.play.hfSeeks).toBeGreaterThan(0);
          expect(c.play.desfaseMedianaMs).not.toBeNull();
          expect(c.play.desfaseMedianaMs!).toBeLessThanOrEqual(3.1);
          // (c) cada seek tras 12 s de play da el mismo estado que en frío
          expect(c.tras).toEqual(c.frio);
        },
        TIEMPO_MAXIMO,
      );
    });
  }
});
