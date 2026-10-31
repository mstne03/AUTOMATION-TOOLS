// W2.1 (SEO-112): `gancho` y `escena-cifra` sin GSAP, con hf-tiempo. Unit con DOM falso (sin motor) y, si hay
// VIDEO_ENGINE_DIR y W2_REFS, SSIM contra el render GSAP congelado y sonda de preview (seek, play, seek tras play).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compararContraReferencia } from "../scripts/comparar-fotogramas.mjs";
import { montar } from "../scripts/montar.mjs";
import { sondearPreview } from "../scripts/sondear-preview.mjs";
import { plan } from "./ayudas-plan.js";
import { conCandadoDeRender, ejecucionConMotor, ejecutarPieza, FORMA_GSAP, GUIONES_W2, piezaHtml, sondaConTiempos } from "./piezas-comun.js";

/** Easing `linear(...)` de una curva, tal como lo genera hf-tiempo (se pide al propio runtime, no se duplica). */
const facil = (curva: string, extra = ""): string =>
  ejecutarPieza(`<div data-composition-id="x"><i id="a"></i></div><script>HF.contexto("x", 0).tween("#a", { opacity: 0 }, { opacity: 1 }, 0, 1, "${curva}"${extra});</script>`).animaciones[0].op.easing;

const datosDe = (html: string, id: string) => JSON.parse(new RegExp(`id="${id}-datos" type="application/json">([^<]+)<`).exec(html)![1]);
const ms = (s: number) => Math.round(s * 1000 * 1e6) / 1e6;

describe("gancho", () => {
  const { p } = plan("", 0.12);
  const html = piezaHtml(p, "gancho");
  const D = Number(/var D = ([\d.]+);/.exec(html)![1]);

  it("sin GSAP, con el contexto del host y sin innerHTML", () => {
    expect(html).not.toMatch(FORMA_GSAP);
    expect(html).toContain('HF.contexto("gancho", 0)');
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(D).toBe(2.3);
  });

  it("D = 2,3: lista exacta de animaciones", () => {
    const a = ejecutarPieza(html).animaciones;
    const F = 1 / 30;
    expect(a.map((x) => [x.sel, ms(x.op.delay / 1000), ms(x.op.duration / 1000), x.op.fill, x.op.easing])).toEqual([
      ["#gancho-titular", 0, 580, "both", facil("expo.out")],
      ["#gancho-stage", ms(0.58), ms(F), "forwards", facil("power2.out")],
      ["#gancho-stage", ms(0.58 + F), ms(F), "forwards", facil("power2.out")],
      ["#gancho-stage", ms(0.58 + 2 * F), ms(F), "forwards", facil("power2.out")],
      ["#gancho-titular", ms(0.72), ms(2.3 - 0.72 - 0.46), "both", facil("sine.inOut")],
      ["#gancho-titular", ms(2.3 - 0.46), 460, "forwards", facil("power4.in")],
    ]);
    expect(a[0].kf).toEqual([{ scale: "1.12" }, { scale: "1" }]);
    expect(a[5].kf).toEqual([{ translate: "calc(0px) calc(-6px)" }, { translate: "calc(0px) calc(-900px)" }]);
  });

  it("#gancho-stage solo con x+y y #gancho-titular sin tweens de solo-x", () => {
    const a = ejecutarPieza(html).animaciones;
    for (const s of a.filter((x) => x.sel === "#gancho-stage")) for (const kf of s.kf) expect((kf as { translate: string }).translate).toMatch(/^calc\(-?[\d.]+px\) calc\(-?[\d.]+px\)$/);
    // Todo desplazamiento del titular es vertical: x siempre 0.
    for (const t of a.filter((x) => x.sel === "#gancho-titular")) for (const kf of t.kf) if ("translate" in kf) expect((kf as { translate: string }).translate).toMatch(/^calc\(0px\) calc\(/);
  });

  it("D = 1,0 (rama de reescalado): IN, OUT, LAND y F se acortan y no hay espera", () => {
    const corto = html.replace(/var D = [\d.]+;/, "var D = 1;");
    const a = ejecutarPieza(corto).animaciones;
    const k = 1 / (0.72 + 0.46);
    const IN = 0.72 * k, OUT = 0.46 * k, LAND = 0.58 * k, F = (1 / 30) * k;
    // Sin espera: 1 del titular + 3 del temblor + la salida, que pinta su valor inicial (antes: true).
    expect(a).toHaveLength(5);
    expect(a[0].op).toMatchObject({ delay: 0, fill: "both" });
    expect(a[0].op.duration).toBeCloseTo(ms(LAND), 6);
    expect(a[1].op.delay).toBeCloseTo(ms(LAND), 6);
    expect(a[1].op.duration).toBeCloseTo(ms(F), 6);
    expect(a[4].sel).toBe("#gancho-titular");
    expect(a[4].op.delay).toBeCloseTo(ms(IN), 6);
    expect(a[4].op.duration).toBeCloseTo(ms(OUT), 6);
    expect(a[4].op.fill).toBe("both");
    expect(a[4].kf[0]).toEqual({ translate: "calc(0px) calc(0px)" });
    // Nunca congela la pieza: ningún tiempo negativo ni no finito (hf.tween lanzaría).
    for (const x of a) expect(Number.isFinite(x.op.delay + x.op.duration) && x.op.delay >= 0).toBe(true);
  });

  it("duraciones degeneradas muy cortas no lanzan", () => {
    for (const d of [0.1, 0.5, 1.18]) expect(() => ejecutarPieza(html.replace(/var D = [\d.]+;/, `var D = ${d};`))).not.toThrow();
  });

  it("el inicio absoluto del host entra en el retardo", () => {
    const a = ejecutarPieza(html.replace('HF.contexto("gancho", 0)', 'HF.contexto("gancho", 3)')).animaciones;
    expect(a[0].op.delay).toBe(3000);
  });

  it("texto hostil: sale escapado y la pieza no escribe nada en el DOM", () => {
    const hostil = `<script>alert(1)</script> {{INICIO}} "x" '`;
    const { p: ph } = plan("", 0.12, undefined, JSON.stringify(hostil));
    const h = piezaHtml(ph, "gancho");
    expect(h).not.toContain("<script>alert(1)");
    expect(h).toContain("&lt;script&gt;alert(1)");
    // El `{{INICIO}}` del texto no se sustituye ni queda como marcador sin resolver en el script.
    expect(h.match(/HF\.contexto\([^)]*\)/g)).toEqual(['HF.contexto("gancho", 0)']);
    const r = ejecutarPieza(h);
    expect(r.animaciones.length).toBe(6);
    expect(r.elemento("gancho-titular").textContent).toBe("");
  });
});

describe("escena-cifra", () => {
  const FM = "golpe: Seventeen\nescenas:\n  4:\n    tipo: cifra\n    valor: 17\n    sufijo: ' Copas'\n    etiqueta: World Cups";
  const { p } = plan(FM);
  const html = piezaHtml(p, "bloque4");
  const d = datosDe(html, "bloque4");
  const env = JSON.parse(/hf\.envoltura\((\{[^)]*\})\)/.exec(html)![1]);
  const fmt = (v: number) => d.prefijo + v.toLocaleString("en-US", { minimumFractionDigits: d.decimales, maximumFractionDigits: d.decimales }) + d.sufijo;
  const inicio = Number(/HF\.contexto\("bloque4", ([\d.]+)\)/.exec(html)![1]);

  it("sin GSAP, con contexto y envoltura por datos", () => {
    expect(html).not.toMatch(FORMA_GSAP);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(html).toMatch(/HF\.contexto\("bloque4", [\d.]+\)/);
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(env).toMatchObject({ punch: true });
  });

  it("lista exacta de animaciones con golpe", () => {
    const a = ejecutarPieza(html).animaciones;
    const f = 1 / 30;
    const base = (t: number) => ms(inicio + t);
    const esperado: [string, number, number, string][] = [
      ["#bloque4-fundido", base(0), ms(env.fundido), "both"],
      ["#bloque4-punch", base(0), 450, "both"],
      ...env.golpes.flatMap((g: number) => [0, 1, 2, 3].map((i): [string, number, number, string] => ["#bloque4-golpe", base(g + i * f), ms(f), "forwards"])),
      ["#bloque4-grupo", base(d.empieza - 0.1), 400, "both"],
      ["#bloque4-etq", base(d.aterriza), 350, "both"],
      ["#bloque4-num", base(d.aterriza), 300, "forwards"],
      ["#bloque4-luz", base(d.aterriza), 30, "forwards"],
      ["#bloque4-luz", base(d.aterriza + 0.03), 150, "forwards"],
    ];
    expect(env.golpes).toHaveLength(1);
    expect(a.map((x) => [x.sel, x.op.delay, x.op.duration, x.op.fill])).toEqual(esperado.map(([s, de, du, fi]) => [s, expect.closeTo(de, 6), expect.closeTo(du, 6), fi]));
  });

  it("sin golpe: sin animaciones de golpe", () => {
    const sin = piezaHtml(plan("escenas:\n  4:\n    tipo: cifra\n    valor: 17").p, "bloque4");
    expect(ejecutarPieza(sin).animaciones.some((x) => x.sel === "#bloque4-golpe")).toBe(false);
  });

  it("la cuenta: seek(empieza) → inicial, seek(empieza+cuenta) → texto final, y por el camino sigue power2.out", () => {
    const r = ejecutarPieza(html);
    const num = r.elemento("bloque4-num");
    expect(num.textContent).toBe(fmt(0));
    r.seek(inicio + d.empieza);
    expect(num.textContent).toBe(fmt(0));
    r.seek(inicio + d.empieza + d.cuenta);
    expect(num.textContent).toBe(fmt(d.valor));
    r.seek(inicio + d.empieza + d.cuenta / 2);
    expect(num.textContent).toBe(fmt(d.valor * 0.875)); // power2.out(0,5) = 1 - 0,5^3
  });

  it("seek(-5), seek(1e9) y seek(NaN) no lanzan y dan los extremos", () => {
    const r = ejecutarPieza(html);
    const num = r.elemento("bloque4-num");
    r.seek(inicio + d.empieza + d.cuenta / 2);
    r.seek(-5);
    expect(num.textContent).toBe(fmt(0));
    r.seek(1e9);
    expect(num.textContent).toBe(fmt(d.valor));
    r.seek(inicio + d.empieza + d.cuenta / 2);
    const medio = num.textContent;
    for (const t of [NaN, Infinity, -Infinity, undefined as unknown as number]) expect(() => r.seek(t)).not.toThrow();
    expect(num.textContent).toBe(medio); // un tiempo no finito se ignora
  });

  it("el reloj redondea t a 6 decimales (y sin el redondeo no)", () => {
    const g = globalThis as { __t?: number };
    const con = (h: string) => h.replace("num.textContent = fmt(", "globalThis.__t = t; num.textContent = fmt(");
    ejecutarPieza(con(html)).seek(inicio + 1.23456789);
    expect(String(g.__t).split(".")[1].length).toBeLessThanOrEqual(6);
    const sinRedondeo = con(html.replace("t = Math.round(t * 1e6) / 1e6;", ""));
    expect(sinRedondeo).not.toContain("Math.round(t");
    ejecutarPieza(sinRedondeo).seek(inicio + 1.23456789);
    expect(String(g.__t).split(".")[1].length).toBeGreaterThan(6);
    delete g.__t;
  });

  it("cuenta <= 0 o valor no finito lanzan", () => {
    for (const malo of [{ cuenta: 0 }, { cuenta: -1 }, { cuenta: null }, { valor: null }]) {
      const m = html.replace(/(id="bloque4-datos" type="application\/json">)([^<]+)</, (_, a, j) => `${a}${JSON.stringify({ ...JSON.parse(j), ...malo })}<`);
      expect(() => ejecutarPieza(m), JSON.stringify(malo)).toThrow(/escena-cifra/);
    }
  });

  it("texto hostil en la etiqueta, el prefijo y el sufijo: escapado y sin escrituras HTML", () => {
    const fm = `escenas:\n  4:\n    tipo: cifra\n    valor: 3\n    prefijo: "<"\n    sufijo: "</i>{{ID}}"\n    etiqueta: "<img src=x onerror=alert(1)> {{INICIO}}"`;
    const h = piezaHtml(plan(fm).p, "bloque4");
    expect(h).not.toMatch(/<img src=x/);
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(h.match(/HF\.contexto\([^)]*\)/g)).toHaveLength(1);
    const r = ejecutarPieza(h);
    // Lo dinámico solo entra por textContent: el número lleva el sufijo hostil como texto.
    r.seek(1e9);
    expect(r.elemento("bloque4-num").textContent).toBe("<3</i>{{ID}}");
  });

  it("duración mínima del bloque (cuenta 0,4 s) no lanza", () => {
    const corta = html.replace(/(id="bloque4-datos" type="application\/json">)([^<]+)</, (_, a, j) => `${a}${JSON.stringify({ ...JSON.parse(j), cuenta: 0.4, aterriza: d.empieza + 0.4 })}<`);
    expect(() => ejecutarPieza(corta)).not.toThrow();
  });
});

// ---------- Motor: SSIM contra el render GSAP congelado y preview ----------

const motor = ejecucionConMotor();
const NAVEGADOR = motor ? path.join(motor.motor, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe") : "";
const TIEMPOS = [0.3, 0.6, 1, 1.5, 2.2, 2.6, 3.5, 5, 6.5, 8, 10, 14];
const MIOS = /^(h-)?(gancho|bloque2)(-|$)/;

describe.skipIf(!motor)("contra el render GSAP congelado", () => {
  const trabajo = path.join(process.env.W2_SCRATCH ?? path.join(os.tmpdir(), "w2-w21"), "cand");

  // FONDO_CSS (cifra sin golpe) lo mide W2.2. Su fotograma 127 (t = 4,2333 s) era un empate de redondeo: la cuenta valía 4721,5011
  // y GSAP, que redondea el tiempo, daba 4721,4975. La cifra redondea ahora el tiempo a 6 decimales como el reloj anterior.
  const clave = "TODAS" as const;
  it(`SSIM >= 0,99 por fotograma, mismo nº de fotogramas y check sin errores (${clave})`, { timeout: 1_800_000 }, async () => {
    const dirCand = path.join(trabajo, clave, "montaje");
    fs.rmSync(path.join(trabajo, clave), { recursive: true, force: true });
    const m = await conCandadoDeRender(() => montar(motor!.motor, dirCand, GUIONES_W2[clave]));
    expect(m.usaWebgpu, `la prueba de GPU del montaje falló (el fondo habría caído a CSS): ${m.avisos.join(" | ")}`).toBe(true);
    for (const f of ["gancho.html", "bloque2.html"]) expect(fs.readFileSync(path.join(m.dir, "compositions", f), "utf8")).not.toMatch(FORMA_GSAP);
    const salida = path.join(trabajo, clave, "comparacion");
    const informe = await conCandadoDeRender(() => compararContraReferencia(motor!.motor, path.join(motor!.refs, clave, "ref.mp4"), m.dir, salida));
    console.error(`[W2.1 ${clave}] ssimMin=${informe.ssimMin} media=${informe.ssimMedia} fotogramas=${informe.fotogramasCandidata}/${informe.fotogramasReferencia} peores=${JSON.stringify(informe.peores.slice(0, 3))}`);
    expect(informe.fotogramasCandidata).toBe(informe.fotogramasReferencia);
    expect(informe.ssimMin).toBeGreaterThanOrEqual(0.99);
    expect(informe.ok).toBe(true);
  });

  it("preview: seek, play y seek tras play dan el mismo estado que la referencia GSAP", { timeout: 600_000 }, async () => {
    const dirCand = path.join(trabajo, "TODAS", "montaje", "proyecto", "video001", "_composicion");
    const dirRef = path.join(motor!.refs, "TODAS", "montaje", "proyecto", "video001", "_composicion");
    expect(fs.existsSync(path.join(dirCand, "index.html")), "ejecuta antes el SSIM de TODAS").toBe(true);
    const sonda = sondaConTiempos(TIEMPOS);
    const cand = await sondearPreview({ navegador: NAVEGADOR, dir: dirCand, sonda });
    const ref = await sondearPreview({ navegador: NAVEGADOR, dir: dirRef, sonda });
    // El fondo aurora (no es de W2.1) da «WebGPU unavailable» en el headless sin GPU: igual en las dos; la migración no añade errores.
    expect(cand.erroresPagina).toEqual(ref.erroresPagina);
    type E = { id: string; rect: number[]; opacity: number; color: string; texto: string };
    const mios = (fase: Record<string, E[]>, t: string) => fase[t].filter((e) => MIOS.test(e.id));
    const comparar = (a: E[], b: E[], t: string, que: string) => {
      expect(a.map((e) => e.id), `${que} t=${t}: ids`).toEqual(b.map((e) => e.id));
      a.forEach((e, i) => {
        e.rect.forEach((v, j) => expect(Math.abs(v - b[i].rect[j]), `${que} t=${t} ${e.id} rect[${j}]`).toBeLessThanOrEqual(0.75));
        expect(Math.abs(e.opacity - b[i].opacity), `${que} t=${t} ${e.id} opacity`).toBeLessThanOrEqual(0.01);
        expect(e.texto, `${que} t=${t} ${e.id} texto`).toBe(b[i].texto);
      });
    };
    for (const t of TIEMPOS.map(String)) {
      expect(mios(cand.resultado.frio, t).length).toBeGreaterThan(0);
      comparar(mios(cand.resultado.frio, t), mios(ref.resultado.frio, t), t, "(a) frío");
      // (c) tras 12 s de play, el mismo estado que en frío (criterio del spike: `igual`).
      comparar(mios(cand.resultado.tras, t), mios(cand.resultado.frio, t), t, "(c) tras play");
    }
    // (b) durante el play llegan hf-seek y el desfase WAAPI es <= 3,1 ms de mediana.
    console.error(`[W2.1 preview] play candidata=${JSON.stringify(cand.resultado.play)} referencia=${JSON.stringify(ref.resultado.play)}`);
    expect(cand.resultado.play.hfSeeks).toBeGreaterThan(0);
    expect(cand.resultado.play.animaciones).toBeGreaterThan(0);
    expect(cand.resultado.play.desfaseMedianaMs).toBeLessThanOrEqual(3.1);
  });
});
