// W2.5 (SEO-112): `subtitulos` sin GSAP. Unit con DOM falso (sin motor), SSIM contra el render GSAP congelado,
// sonda de preview y medición de coste (decide tweens o `reloj`).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compararContraReferencia } from "../scripts/comparar-fotogramas.mjs";
import { montar } from "../scripts/montar.mjs";
import { sondearPreview } from "../scripts/sondear-preview.mjs";
import { CUERPO, plan, planDeGuion } from "./ayudas-plan.js";
import { conCandadoDeRender, ejecucionConMotor, ejecutarPieza, FORMA_GSAP, GUIONES_W2, piezaHtml, SONDA_ESTADO, type Animacion } from "./piezas-comun.js";

type Datos = { estilo: string; colores: { texto: string; acento: string }; grupos: { id: string; inicio: number; palabras: { id: string; inicio: number; fin: number; enfasis: boolean }[] }[] };
const datosDe = (html: string): Datos => JSON.parse(/<script id="subtitulos-datos" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
const conDatos = (html: string, f: (d: Datos) => void): string => {
  const d = datosDe(html);
  f(d);
  return html.replace(/(<script id="subtitulos-datos" type="application\/json">)[\s\S]*?(<\/script>)/, (_m, a, b) => a + JSON.stringify(d) + b);
};
/** Easing que produce hf-tiempo para una curva (el mismo `linear(...)`), sin duplicar sus fórmulas. */
const facil = (nombre: string): string =>
  ejecutarPieza(`<div id="x" data-composition-id="x"><i id="a"></i></div><script>HF.contexto("x", 0).tween("#a", { opacity: 0 }, { opacity: 1 }, 0, 1, ${JSON.stringify(nombre)});</script>`).animaciones[0].op.easing;

const FM = (estilo: string) => `subtitulos: ${estilo}\nenfasis: [Spain, rule]`;
const planEstilo = (estilo: string, paso = 0.06) => plan(FM(estilo), paso).p;

/** Lista de animaciones que producía el timeline GSAP (P1), en el mismo orden de creación. */
function esperadas(d: Datos): { sel: string; delay: number; duration: number; fill: string; curva: string; kf?: object[] }[] {
  const o: ReturnType<typeof esperadas> = [];
  const add = (sel: string, t: number, dur: number, curva: string, fill: string, kf?: object[]) => o.push({ sel, delay: t * 1000, duration: Math.max(dur, 0.001) * 1000, fill, curva, kf });
  d.grupos.forEach((g, gi) => {
    const txt = `#${g.id}-txt`;
    if (d.estilo === "impacto") {
      const m = gi % 4;
      add(txt, g.inicio, m === 3 ? 0.24 : 0.2, m === 0 ? "back.out(1.7)" : m === 3 ? "back.out(2.2)" : "expo.out", "both");
    } else add(txt, g.inicio, 0.1, "power2.out", "both", [{ opacity: 0, scale: "0.92" }, { opacity: 1, scale: "1" }]);
    for (const p of g.palabras) {
      const s = `#${p.id}`;
      if (d.estilo === "karaoke") {
        add(s, p.inicio, 0.04, "none", "forwards", [{ color: d.colores.texto }, { color: d.colores.acento }]);
        add(s, p.fin, 0.04, "none", "forwards", [{ color: d.colores.acento }, { color: d.colores.texto }]);
      } else if (d.estilo === "pildora") add(s, Math.max(g.inicio, p.inicio - 0.05), 0.1, "none", "forwards", [{ color: "#a6a6a6" }, { color: "#1c1e1d" }]);
      else if (d.estilo === "neon") {
        add(s, p.inicio, 0.06, "none", "forwards");
        add(s, p.fin, 0.06, "none", "forwards");
      }
      if (p.enfasis && d.estilo !== "impacto") {
        add(s, p.inicio, 0.12, "back.out(3)", "forwards", [{ scale: "1" }, { scale: "1.12" }]);
        add(s, p.inicio + 0.12, 0.2, "power2.out", "forwards", [{ scale: "1.12" }, { scale: "1.05" }]);
      }
    }
  });
  return o;
}

/** El guion exige exactamente seis bloques: `primero` en el [1] y `Ok.` en el resto. */
const seis = (primero: string, resto = "Ok.") => [primero, ...Array(5).fill(resto)].map((t, i) => `[${i + 1}] ${t}`).join("\n");

describe("subtitulos sin GSAP (unit)", () => {
  for (const estilo of ["karaoke", "pildora", "neon", "impacto"]) {
    describe(estilo, () => {
      const html = piezaHtml(planEstilo(estilo), "subtitulos");
      const d = datosDe(html);

      it("sin GSAP y con el id y el inicio del host", () => {
        expect(d.estilo).toBe(estilo);
        expect(html).not.toMatch(FORMA_GSAP);
        expect(html).toContain('HF.contexto("subtitulos", 0)');
        expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
      });

      it("las animaciones son exactamente las del timeline GSAP, en su orden", () => {
        const r = ejecutarPieza(html);
        const e = esperadas(d);
        expect(e.length).toBeGreaterThan(0);
        expect(r.animaciones.map((a) => ({ sel: a.sel, delay: a.op.delay, duration: a.op.duration, fill: a.op.fill }))).toEqual(
          e.map((x) => ({ sel: x.sel, delay: x.delay, duration: x.duration, fill: x.fill })),
        );
        r.animaciones.forEach((a, i) => {
          expect(a.op.easing, `${a.sel} #${i}`).toBe(facil(e[i].curva));
          if (e[i].kf) for (const [k, kf] of a.kf.entries()) expect(kf).toMatchObject((e[i].kf as object[])[k]);
        });
      });

      it("mutación: sin un tween falta una animación", () => {
        const roto = html.replace(/\n\s*hf\.tween\(txt, \{ opacity: 0, scale: 0\.92 \}[^\n]*/, "");
        const n = (h: string) => ejecutarPieza(h).animaciones.length;
        if (estilo !== "impacto") expect(n(roto)).toBeLessThan(n(html));
      });
    });
  }

  it("neón: textShadow en camelCase y sombra de tres capas con el brillo", () => {
    const r = ejecutarPieza(piezaHtml(planEstilo("neon"), "subtitulos"));
    const con = r.animaciones.filter((a) => a.kf.some((k) => "textShadow" in k));
    expect(con.length).toBeGreaterThan(0);
    for (const a of r.animaciones) for (const k of a.kf) expect(Object.keys(k).some((p) => p.includes("-"))).toBe(false);
    expect((con[0].kf[1] as { textShadow: string }).textShadow).toMatch(/^0 0 10px .+, 0 0 35px .+, 0 0 90px .+$/);
  });

  it("énfasis de neón: el brillo usa el acento; el resto, #00fff0", () => {
    const html = piezaHtml(planEstilo("neon"), "subtitulos");
    const d = datosDe(html);
    const enf = d.grupos.flatMap((g) => g.palabras).find((p) => p.enfasis)!;
    const r = ejecutarPieza(html);
    const a = r.animaciones.find((x) => x.sel === `#${enf.id}` && x.kf.some((k) => "textShadow" in k))!;
    expect((a.kf[1] as { color: string }).color).toBe(d.colores.acento);
    const normal = d.grupos.flatMap((g) => g.palabras).find((p) => !p.enfasis)!;
    expect((r.animaciones.find((x) => x.sel === `#${normal.id}` && x.kf.some((k) => "textShadow" in k))!.kf[1] as { color: string }).color).toBe("#00fff0");
  });

  it("impacto alterna cuatro entradas: y, x, x y escala", () => {
    const r = ejecutarPieza(piezaHtml(planEstilo("impacto"), "subtitulos"));
    const grupos = r.animaciones.filter((a) => a.sel.endsWith("-txt"));
    expect(grupos.length).toBeGreaterThanOrEqual(4);
    const claves = grupos.slice(0, 4).map((a) => Object.keys(a.kf[0]).filter((k) => k !== "opacity")[0]);
    expect(claves).toEqual(["translate", "translate", "translate", "scale"]);
    expect(grupos.slice(0, 4).map((a) => a.op.duration)).toEqual([200, 200, 200, 240]);
  });

  it("I1/I11: un id que no cumple el patrón lanza (grupo y palabra) y no anima con basura", () => {
    const html = piezaHtml(planEstilo("karaoke"), "subtitulos");
    expect(() => ejecutarPieza(conDatos(html, (d) => (d.grupos[0].id = "Sub G1")))).toThrow(/id no válido/);
    expect(() => ejecutarPieza(conDatos(html, (d) => (d.grupos[0].palabras[0].id = "sub-g1w1, body")))).toThrow(/id no válido/);
    expect(() => ejecutarPieza(conDatos(html, (d) => (d.grupos[0].palabras[0].id = "1x")))).toThrow(/id no válido/);
  });

  it("I11: un tiempo no finito o negativo lanza", () => {
    const html = piezaHtml(planEstilo("pildora"), "subtitulos");
    expect(() => ejecutarPieza(conDatos(html, (d) => (d.grupos[0].inicio = -1)))).toThrow(/no finito o negativo/);
    expect(() => ejecutarPieza(conDatos(html, (d) => (d.grupos[0].palabras[0].fin = "x" as unknown as number)))).not.toThrow(); // pildora no usa `fin`
    expect(() => ejecutarPieza(conDatos(piezaHtml(planEstilo("karaoke"), "subtitulos"), (d) => (d.grupos[0].palabras[0].fin = "x" as unknown as number)))).toThrow(/no finito/);
  });

  it("duración mínima del plan: seis bloques de una palabra", () => {
    const { p } = planDeGuion(`---\ntitulo: T\ngancho: Hi\nsubtitulos: karaoke\n---\n${seis("Hi.")}\n`, 0.05);
    const r = ejecutarPieza(piezaHtml(p, "subtitulos"));
    expect(r.animaciones.length).toBe(esperadas(datosDe(piezaHtml(p, "subtitulos"))).length);
    for (const a of r.animaciones) expect(Number.isFinite(a.op.delay) && a.op.delay >= 0 && a.op.duration > 0).toBe(true);
  });

  it("sin audio de más: seek no rompe (la pieza no usa reloj)", () => {
    const r = ejecutarPieza(piezaHtml(planEstilo("karaoke"), "subtitulos"));
    for (const t of [-5, 0, 1e9, NaN]) expect(() => r.seek(t)).not.toThrow();
  });
});

describe("subtitulos: texto hostil (I1)", () => {
  const hostil = (estilo: string) =>
    planDeGuion(`---\ntitulo: T\ngancho: Hi\nsubtitulos: ${estilo}\n---\n${seis('<img src=x onerror=alert(1)> {{INICIO}} "quoted" </script><script>alert(2)</script> end.')}\n`, 0.05).p;

  for (const estilo of ["karaoke", "pildora", "neon", "impacto"]) {
    it(`${estilo}: el HTML sale escapado, la pieza no escribe HTML y anima igual`, () => {
      const html = piezaHtml(hostil(estilo), "subtitulos");
      expect(html).not.toMatch(/<img\b/);
      expect(html).toContain("&lt;img");
      expect((html.match(/<script\b/g) ?? []).length).toBe(2); // datos + pieza; el `<script>` del texto va escapado
      expect(html).not.toMatch(/alert\(2\)<\/script>/);
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
      expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
      expect(html).toContain('HF.contexto("subtitulos", 0)');
      expect(ejecutarPieza(html).animaciones.length).toBeGreaterThan(0);
    });
  }
});

describe("subtitulos: tope de I1 (180 s)", () => {
  // MAX_CARACTERES (650) manda: el máximo de palabras en 180 s son las de una letra (~320).
  const denso = (estilo: string) => {
    const letras = "abcdefghijklmnopqrstuvwxyz".split("");
    const bloque = (i: number) => Array.from({ length: 53 }, (_, j) => letras[(i * 53 + j) % 26]).join(" ") + ".";
    const cuerpo = Array.from({ length: 6 }, (_, i) => `[${i + 1}] ${bloque(i)}`).join("\n");
    return planDeGuion(`---
titulo: T
gancho: Hi
subtitulos: ${estilo}
enfasis: [${letras.join(", ")}]
---
${cuerpo}
`, 175 / 640).p;
  };

  for (const estilo of ["karaoke", "pildora", "neon"]) {
    it(`${estilo}: nº de animaciones del peor guion de 180 s ≤ 3000 y igual al del timeline GSAP`, () => {
      const html = piezaHtml(denso(estilo), "subtitulos");
      const d = datosDe(html);
      const palabras = d.grupos.flatMap((g) => g.palabras).length;
      expect(palabras).toBeGreaterThan(250);
      const n = ejecutarPieza(html).animaciones.length;
      expect(n).toBe(esperadas(d).length);
      expect(n).toBeLessThanOrEqual(3000);
    });
  }
});

// ---------- Motor (SSIM y preview) ----------

const motor = ejecucionConMotor();
const NAVEGADOR = motor ? path.join(motor.motor, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe") : "";

const CLAVES = [["TODAS", "karaoke"], ["SUB_PILDORA", "pildora"], ["SUB_NEON", "neon"], ["SUB_IMPACTO", "impacto"]] as const;

describe.skipIf(!motor)("subtitulos contra el render GSAP congelado (motor)", () => {
  for (const [clave, estilo] of CLAVES) {
    it(`SSIM ≥ 0,99 por fotograma, ${estilo} (${clave})`, async () => {
      const { motor: m, refs } = motor!;
      const cand = path.join(refs, "..", "cand-w25", clave);
      fs.rmSync(cand, { recursive: true, force: true });
      const montaje = await montar(m, path.join(cand, "montaje"), GUIONES_W2[clave]);
      const html = fs.readFileSync(path.join(montaje.dir, "compositions", "subtitulos.html"), "utf8");
      expect(html).not.toMatch(FORMA_GSAP);
      if (clave === "TODAS") expect(montaje.usaWebgpu, `la prueba de GPU del montaje falló (el fondo habría caído a CSS): ${montaje.avisos.join(" | ")}`).toBe(true);
      const informe = await conCandadoDeRender(() => compararContraReferencia(m, path.join(refs, clave, "ref.mp4"), montaje.dir, path.join(cand, "salida")));
      expect(informe.fotogramasCandidata).toBe(informe.fotogramasReferencia);
      expect(informe.ssimMin).toBeGreaterThanOrEqual(0.99);
      expect(informe.ok).toBe(true);
    }, 900_000);
  }
});

type Estado = { id: string; rect: number[]; opacity: number; color: string; texto: string };
type Sonda = { frio: Record<string, Estado[]>; tras: Record<string, Estado[]>; play: { hfSeeks: number; animaciones: number; desfaseMedianaMs: number | null } };

describe.skipIf(!motor)("subtitulos en la preview frente a la referencia GSAP (motor)", () => {
  for (const [clave, estilo] of CLAVES) {
    it(`${estilo}: estado en frío igual, hf-seek en play y seek tras play = frío`, async () => {
      const { refs } = motor!;
      const cand = path.join(refs, "..", "cand-w25", clave, "montaje", "proyecto", "video001", "_composicion");
      const ref = path.join(refs, clave, "montaje", "proyecto", "video001", "_composicion");
      expect(fs.existsSync(cand), "ejecuta antes el test de SSIM de esta clave").toBe(true);
      const [c, r] = await conCandadoDeRender(async () => [
        await sondearPreview({ navegador: NAVEGADOR, dir: cand, sonda: SONDA_ESTADO }),
        await sondearPreview({ navegador: NAVEGADOR, dir: ref, sonda: SONDA_ESTADO }),
      ]);
      // Los mismos errores que la referencia GSAP (p. ej. sin WebGPU el shader de TODAS se queja en ambas): la migración no añade ninguno.
      expect(c.erroresPagina).toEqual(r.erroresPagina);
      const rc = c.resultado as Sonda;
      const rr = r.resultado as Sonda;
      // (a) en frío: rect ±0,75 px y opacidad ±0,01 contra la referencia (solo elementos presentes en ambas).
      let comparados = 0;
      for (const t of Object.keys(rc.frio)) {
        const mr = new Map(rr.frio[t].map((e) => [e.id, e]));
        for (const e of rc.frio[t]) {
          const o = mr.get(e.id);
          if (!o) continue;
          comparados++;
          e.rect.forEach((v, i) => expect(Math.abs(v - o.rect[i]), `${e.id} @${t} rect[${i}]`).toBeLessThanOrEqual(0.75));
          expect(Math.abs(e.opacity - o.opacity), `${e.id} @${t} opacidad`).toBeLessThanOrEqual(0.01);
        }
      }
      expect(comparados).toBeGreaterThan(50);
      fs.writeFileSync(path.join(refs, "..", "cand-w25", clave, "preview.json"), JSON.stringify({ comparados, candidata: rc.play, referencia: rr.play }, null, 2));
      // (b) el runtime reparte hf-seek durante el play y WAAPI no se desfasa.
      expect(rc.play.hfSeeks).toBeGreaterThan(0);
      expect(rc.play.animaciones).toBeGreaterThan(0);
      if (rc.play.desfaseMedianaMs !== null) expect(rc.play.desfaseMedianaMs).toBeLessThanOrEqual(3.1);
      // (c) cada seek tras 12 s de play da exactamente el estado en frío.
      expect(rc.tras).toEqual(rc.frio);
    }, 300_000);
  }
});

// ---------- Medición de coste en preview (Step 4) ----------

const SONDA_COSTE = `(async () => {
  const P = window.__player, espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  P.seek(0); await espera(300);
  const D = P.getDuration ? P.getDuration() : 60;
  // getAnimations() solo devuelve las «relevantes»: con el tiempo al final, todas las de fill forwards cuentan.
  P.seek(D - 0.05); await espera(300);
  const animaciones = document.getAnimations().length;
  P.seek(0); await espera(300);
  const costes = [];
  for (let i = 0; i < 100; i++) { const t = (i * 0.37 + 0.11) % Math.max(1, D - 1); const a = performance.now(); P.seek(t); costes.push(performance.now() - a); await new Promise((r) => requestAnimationFrame(r)); }
  P.seek(0); await espera(200);
  const marcas = [];
  let activo = true;
  const bucle = (ts) => { if (activo) { marcas.push(ts); requestAnimationFrame(bucle); } };
  requestAnimationFrame(bucle);
  P.play(); await espera(5000); P.pause(); activo = false;
  const esperados = Math.round((marcas[marcas.length - 1] - marcas[0]) / (1000 / 60));
  const perdidos = Math.max(0, esperados - (marcas.length - 1));
  return { animaciones, seekMedianaMs: pct(costes, 0.5), seekP95Ms: pct(costes, 0.95), fotogramas: marcas.length - 1, perdidos, pctPerdidos: esperados ? perdidos / esperados : 0 };
})()`;

const GUION_COSTE = (estilo: string, duracion: number, denso: boolean) => {
  const letras = "abcdefghijklmnopqrstuvwxyz".split("");
  const lineas = denso
    ? Array.from({ length: 6 }, (_, i) => `[${i + 1}] ${Array.from({ length: 53 }, (_, j) => letras[(i * 53 + j) % 26]).join(" ")}.`).join("\n")
    : CUERPO;
  return { texto: `---\ntitulo: Coste ${estilo} ${duracion}\ngancho: "Nobody saw this coming"\nsubtitulos: ${estilo}\nenfasis: [${denso ? letras.join(", ") : "Spain, rule"}]\n---\n${lineas}\n`, duracion };
};

describe.skipIf(!motor || !process.env.W25_MEDIR)("subtitulos: coste en preview (medición)", () => {
  for (const [estilo, duracion, denso] of [["karaoke", 60, false], ["neon", 60, false], ["karaoke", 180, true], ["neon", 180, true]] as const) {
    it(`${estilo} ${duracion} s${denso ? " (denso)" : ""}`, async () => {
      const { refs } = motor!;
      const g = GUION_COSTE(estilo, duracion, denso);
      const dir = path.join(refs, "..", "cand-w25", `coste-${estilo}-${duracion}`);
      fs.rmSync(dir, { recursive: true, force: true });
      const m = await montar(motor!.motor, dir, g.texto, { duracionVoz: g.duracion });
      const r = await conCandadoDeRender(() => sondearPreview({ navegador: NAVEGADOR, dir: m.dir, sonda: SONDA_COSTE }));
      fs.writeFileSync(path.join(dir, "coste.json"), JSON.stringify({ ...(r.resultado as object), errores: r.erroresPagina }, null, 2));
    }, 600_000);
  }
});

// Base de comparación: la misma sonda sobre la composición de 20 s de la ejecución GSAP congelada y sobre la migrada.
describe.skipIf(!motor || !process.env.W25_MEDIR)("subtitulos: coste frente a la referencia GSAP (20 s)", () => {
  for (const clave of ["SUB_NEON", "SUB_PILDORA"]) {
    it(clave, async () => {
      const { refs } = motor!;
      const ruta = (raiz: string) => path.join(raiz, "montaje", "proyecto", "video001", "_composicion");
      const dirs = { candidata: ruta(path.join(refs, "..", "cand-w25", clave)), referencia: ruta(path.join(refs, clave)) };
      const salida: Record<string, unknown> = {};
      for (const [nombre, dir] of Object.entries(dirs)) salida[nombre] = (await conCandadoDeRender(() => sondearPreview({ navegador: NAVEGADOR, dir, sonda: SONDA_COSTE }))).resultado;
      fs.writeFileSync(path.join(refs, "..", "cand-w25", clave, "coste-vs-gsap.json"), JSON.stringify(salida, null, 2));
    }, 600_000);
  }
});
