// W2.3 de SEO-112: capas, escena-barras y escena-mapa sin GSAP (hf-tiempo). Unit con DOM falso y, con motor,
// SSIM contra las referencias GSAP congeladas y estado de la preview (seek en frío = seek tras play).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compararContraReferencia } from "../scripts/comparar-fotogramas.mjs";
import { montar } from "../scripts/montar.mjs";
import { sondearPreview } from "../scripts/sondear-preview.mjs";
import { plan, planDeGuion } from "./ayudas-plan.js";
import { compararTunelPng, conCandadoDeRender, ejecutarPieza, ejecucionConMotor, FORMA_GSAP, GUIONES_W2, piezaHtml, SONDA_ESTADO } from "./piezas-comun.js";

const BARRAS = `escenas:
  4:
    tipo: barras
    titulo: Sales per year
    periodos: [2020, 2022, 2024]
    series:
      Alpha: [5, 8, 15]
      Beta: [2, 6, 7]`;
const MAPA = `escenas:
  5:
    tipo: mapa
    region: europa
    destacar: [Spain, Italy]
    etiqueta: Spain and Italy`;

/** Sustituye el JSON de `{{ID}}-datos` / `capas-datos` por `f(datos)`. */
function conDatos(html: string, f: (d: Record<string, unknown>) => void): string {
  return html.replace(/(<script id="[^"]+" type="application\/json">)([\s\S]*?)(<\/script>)/, (_m, a: string, j: string, c: string) => {
    const d = JSON.parse(j) as Record<string, unknown>;
    f(d);
    return a + JSON.stringify(d) + c;
  });
}
const datosDe = (html: string) => JSON.parse(/type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]) as Record<string, any>;

// El DOM falso resuelve `#id .clase` por el nº de veces que sale la clase en toda la pieza (3 destellos = 3 «.ambar»
// por selector): se cuentan animaciones distintas.
const unicas = (a: { sel: string; kf: object[]; op: object }[]) => [...new Set(a.map((x) => JSON.stringify([x.sel, x.kf, x.op])))];

describe("capas", () => {
  const { p } = plan("look: videocamara\nfecha: 1995-09-06 20:15\ndestellos: [1, 3, 5]");
  const html = piezaHtml(p, "capas");

  it("sin GSAP y con el contexto del host", () => {
    expect(html).not.toMatch(FORMA_GSAP);
    expect(html).toContain('HF.contexto("capas", 0)');
  });

  it("6 animaciones por destello, en el orden y con el retardo del original", () => {
    const d = datosDe(html);
    const r = ejecutarPieza(html);
    expect(unicas(r.animaciones)).toHaveLength(6 * d.destellos.length);
    const e = d.destellos[0];
    const [o1, o2, o3, a, ro, oro] = unicas(r.animaciones).map((x) => {
      const [sel, kf, op] = JSON.parse(x);
      return { sel, kf, op };
    });
    expect(o1).toMatchObject({ sel: `#${e.id}`, op: { delay: (e.t + e.duracion * 0.06) * 1000, fill: "both" } });
    expect(o1.kf).toEqual([{ opacity: 0 }, { opacity: 0.62 }]);
    expect(o2).toMatchObject({ sel: `#${e.id}`, op: { fill: "forwards" } });
    expect(o3.op.fill).toBe("forwards");
    expect([a.sel, ro.sel, oro.sel]).toEqual([`#${e.id} .ambar`, `#${e.id} .rojo`, `#${e.id} .oro`]);
    expect(a.op.duration).toBeCloseTo(e.duracion * 1000, 6);
    expect(a.op.fill).toBe("both");
  });

  it("HUD: contador acotado a [0, duración] y punto de REC", () => {
    const r = ejecutarPieza(html);
    const D = datosDe(html).duracion as number;
    expect(r.elemento("capas-contador").textContent).toBe("00:00:00");
    r.seek(5);
    expect(r.elemento("capas-contador").textContent).toBe("00:00:05");
    r.seek(0.3);
    expect(r.elemento("capas-punto").style.opacity).toBe("1");
    r.seek(0.6);
    expect(r.elemento("capas-punto").style.opacity).toBe("0.25");
    r.seek(-5);
    expect(r.elemento("capas-contador").textContent).toBe("00:00:00");
    r.seek(1e9);
    const fin = r.elemento("capas-contador").textContent;
    const s = Math.floor(D);
    expect(fin).toBe(`00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`);
    r.seek(NaN);
    expect(r.elemento("capas-contador").textContent).toBe(fin);
  });

  it("una duración no finita lanza (I11) en vez de acotar con NaN", () => {
    for (const malo of [null, "x"]) expect(() => ejecutarPieza(conDatos(html, (d) => ((d as { duracion: unknown }).duracion = malo))), String(malo)).toThrow(/capas/);
  });

  it("un id de destello no válido lanza", () => {
    const malo = conDatos(html, (d) => ((d.destellos as { id: string }[])[0].id = 'x" ,'));
    expect(() => ejecutarPieza(malo)).toThrow(/id de destello/);
  });

  it("vídeo de 180 s: 6 animaciones por destello y ninguna de grano", () => {
    const guion = (look: string, dest: string) =>
      `---\ntitulo: T\ngancho: Only five nations matter.\nlook: ${look}\n${dest}---\n[1] Five nations rule football.\n[2] Spain, Italy, Germany.\n[3] Brazil and Argentina.\n[4] Seventeen World Cups between them.\n[5] Nobody comes close.\n[6] Can anyone catch up?\n`;
    for (const [look, dest, n] of [["videocamara", "fecha: 1995-09-06 20:15\ndestellos: [1, 2, 3, 4]\n", 4], ["pelicula", "", 6]] as const) {
      const h = piezaHtml(planDeGuion(guion(look, dest), 1.2).p, "capas");
      const d = datosDe(h);
      expect(d.duracion).toBeGreaterThan(170);
      expect(d.destellos).toHaveLength(n);
      const r = ejecutarPieza(h);
      expect(unicas(r.animaciones)).toHaveLength(6 * n);
      expect(r.animaciones.some((a) => a.sel.includes("grano"))).toBe(false);
    }
  });

  it("grano: salto cada 0,1 s; 0,3 y 0,3 + 1e-12 dan la misma posición; extremos acotados", () => {
    const { p: peli } = plan("look: pelicula");
    // La textura se resuelve por `#capas-grano .textura`, que el DOM falso no expone por id: una sonda previa a la
    // pieza copia lo que se escribe en su `style.transform` a `#capas-grano`.
    const sonda = `<script>var g = document.querySelector("#capas-grano .textura"), o = document.getElementById("capas-grano");
      Object.defineProperty(g.style, "transform", { set: function (v) { o.style.transform = v; }, get: function () { return o.style.transform; } });</script>
      <script>
        (function () {`;
    const r = ejecutarPieza(piezaHtml(peli, "capas").replace(/<script>\s*\(function \(\) \{/, sonda));
    const pos = () => r.elemento("capas-grano").style.transform;
    const antes = new Map<number, string>();
    for (const t of [0, 0.05, 0.099, 0.1, 0.3, 0.3 + 1e-12, 0.3 - 1e-12, 0.95, -5, 1e9]) {
      r.seek(t);
      antes.set(t, pos());
    }
    expect(antes.get(0.3)).toBe(antes.get(0.3 + 1e-12));
    expect(antes.get(0.3)).toBe(antes.get(0.3 - 1e-12));
    expect(antes.get(0.3)).toBe("translate(5%, -10%)");
    expect(antes.get(0)).toBe("translate(0%, 0%)");
    expect(antes.get(0.05)).toBe(antes.get(0));
    expect(antes.get(0.1)).toBe("translate(-5%, -5%)");
    expect(antes.get(-5)).toBe(antes.get(0));
  });
});

describe("escena-barras", () => {
  const { p } = plan(BARRAS);
  const id = "bloque4";
  const nombre = Object.keys(p.archivos).find((k) => /compositions\/.*barras.*\.html$/.test(k) || (k.startsWith("compositions/") && p.archivos[k].includes("-periodo")));
  const html = nombre ? p.archivos[nombre] : "";
  const idReal = /data-composition-id="([^"]+)"/.exec(html)?.[1] ?? id;

  it("sin GSAP; contexto del host; envoltura con hf", () => {
    expect(nombre).toBeDefined();
    expect(html).not.toMatch(FORMA_GSAP);
    expect(html).toMatch(new RegExp(`HF\\.contexto\\(id, \\d`));
    expect(html).toContain("hf.envoltura(");
  });

  const estado = (r: ReturnType<typeof ejecutarPieza>) => [0, 1].map((j) => [r.elemento(`${idReal}-f${j}`).style.transform ?? "", r.elemento(`${idReal}-periodo`).textContent]);
  const d = datosDe(html);
  const CARRERA = (d.periodos.length - 1) * d.duracionPeriodo;
  // `hf-seek` trae segundos absolutos del vídeo; la pieza resta el inicio de su host.
  const INICIO = Number(/HF\.contexto\(id, ([\d.]+)\)/.exec(html)![1]);

  it("extremos: antes del inicio = inicio, después de la carrera = fin; sin innerHTML", () => {
    const r = ejecutarPieza(html);
    const per = () => r.elemento(`${idReal}-periodo`).textContent;
    const inicial = per();
    r.seek(INICIO + d.empieza + 0.3);
    r.seek(INICIO - 3);
    expect(per()).toBe(inicial);
    r.seek(INICIO + d.empieza);
    const alInicio = JSON.stringify(estado(r));
    r.seek(INICIO + d.empieza + CARRERA);
    const alFin = JSON.stringify(estado(r));
    expect(alFin).not.toBe(alInicio);
    expect(per()).toBe(String(d.periodos.at(-1)));
    r.seek(1e9);
    expect(JSON.stringify(estado(r))).toBe(alFin);
    r.seek(INICIO - 3);
    expect(JSON.stringify(estado(r))).toBe(alInicio);
    r.seek(NaN);
    expect(JSON.stringify(estado(r))).toBe(alInicio);
    expect(html).not.toMatch(/innerHTML/);
  });

  it("T = 1 (sin carrera): todo seek da el estado inicial", () => {
    const uno = conDatos(html, (x) => {
      x.periodos = (x.periodos as unknown[]).slice(0, 1);
      x.series = (x.series as { valores: number[] }[]).map((s) => ({ ...s, valores: [s.valores[0]] }));
    });
    const r = ejecutarPieza(uno);
    const a = JSON.stringify(estado(r));
    r.seek(INICIO + d.empieza + 5);
    r.seek(1e9);
    expect(JSON.stringify(estado(r))).toBe(a);
  });

  it("texto hostil en título, series, prefijo, sufijo y fuente: escapado y solo por textContent", () => {
    const hostil = `escenas:
  4:
    tipo: barras
    titulo: "<img src=x onerror=alert(1)>"
    fuente: "<b>fuente</b>"
    prefijo: "<"
    sufijo: "</script><i>{{ID}}"
    periodos: [2020, 2022]
    series:
      "<u>Alpha</u>": [5, 8]
      "Beta&": [2, 6]`;
    const h = Object.values(plan(hostil).p.archivos).find((x) => x.includes("-periodo"))!;
    expect(h).not.toMatch(/<img src=x|<b>fuente|<u>Alpha/);
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(h.match(/HF\.contexto\([^)]*\)/g)).toHaveLength(1);
    const r = ejecutarPieza(h);
    r.seek(1e9);
    const id = /data-composition-id="([^"]+)"/.exec(h)![1];
    // El valor lleva el prefijo y el sufijo hostiles como texto, no como marcado.
    expect(r.elemento(`${id}-f0`).querySelector(".valor")!.textContent).toMatch(/^<\d+<\/script><i>\{\{ID\}\}$/);
    expect(h).not.toMatch(/innerHTML/);
  });

  it("datos no finitos o inconsistentes lanzan (I11) en vez de repintar en cada seek", () => {
    for (const malo of [{ empieza: null }, { empieza: "x" }, { duracionPeriodo: 0 }, { duracionPeriodo: null }, { series: [{ nombre: "A", valores: [1, null] }] }, { series: [{ nombre: "A", valores: [1] }] }]) {
      expect(() => ejecutarPieza(conDatos(html, (x) => Object.assign(x, malo))), JSON.stringify(malo)).toThrow(/escena-barras/);
    }
  });

  it("mutación: el reloj es lo que mueve las barras", () => {
    const sinReloj = html.replace(/hf\.reloj\(/, "(function(f){})(");
    const r = ejecutarPieza(sinReloj);
    const a = JSON.stringify(estado(r));
    r.seek(INICIO + d.empieza + CARRERA);
    expect(JSON.stringify(estado(r))).toBe(a);
  });
});

describe("escena-mapa", () => {
  const { p } = plan(MAPA);
  const nombre = Object.keys(p.archivos).find((k) => k.startsWith("compositions/") && p.archivos[k].includes("-etq-caja"))!;
  const html = p.archivos[nombre];
  const d = datosDe(html);
  const INICIO = Number(/HF\.contexto\(id, ([\d.]+)\)/.exec(html)![1]);

  it("sin GSAP; contexto del host", () => {
    expect(html).not.toMatch(FORMA_GSAP);
    expect(html).toMatch(/HF\.contexto\(id, \d/);
  });

  it("n zonas = n animaciones, con la lista exacta del original", () => {
    const r = ejecutarPieza(html);
    const id = /data-composition-id="([^"]+)"/.exec(html)![1];
    const zonas = r.animaciones.filter((a) => /-z\d+$/.test(a.sel));
    expect(zonas).toHaveLength(d.destacadas.length);
    zonas.forEach((z, i) => {
      expect(z.sel).toBe(`#${d.destacadas[i]}`);
      expect(z.op.delay).toBeCloseTo((INICIO + d.enciende + i * 0.25) * 1000, 6);
      expect(z.op.fill).toBe("forwards");
      expect(z.kf).toEqual([{ fill: "rgba(244, 241, 232, 0.16)", stroke: "rgba(11, 15, 12, 0.85)" }, { fill: d.colores.acento, stroke: d.colores.texto }]);
    });
    // envoltura (fundido + punch) + svg + título + zonas + etiqueta
    const resto = r.animaciones.filter((a) => !/-z\d+$/.test(a.sel)).map((a) => a.sel);
    expect(resto).toEqual(expect.arrayContaining([`#${id}-svg`, `#${id}-titulo`, `#${id}-etq`]));
    expect(r.animaciones.length).toBe(zonas.length + resto.length);
    // `d.empieza` no existe en los datos: GSAP colocaba el mapa al acabar la envoltura (punch 0,45 s) y el título al acabar el mapa.
    expect(r.animaciones.find((a) => a.sel === `#${id}-svg`)!.op.delay).toBeCloseTo((INICIO + 0.45) * 1000, 6);
    expect(r.animaciones.find((a) => a.sel === `#${id}-titulo`)!.op.delay).toBeCloseTo((INICIO + 0.95) * 1000, 6);
    const etq = r.animaciones.find((a) => a.sel === `#${id}-etq`)!;
    expect(etq.op.delay).toBeCloseTo((INICIO + d.etiqueta) * 1000, 6);
  });

  it("un id de zona no válido lanza antes del tween", () => {
    const malo = conDatos(html, (x) => ((x.destacadas as string[])[0] = "x, #y"));
    expect(() => ejecutarPieza(malo)).toThrow(/id de zona/);
  });

  it("una zona que no existe en el SVG lanza (I11)", () => {
    const malo = conDatos(html, (x) => ((x.destacadas as string[])[0] = "no-existe-z9"));
    expect(() => ejecutarPieza(malo)).toThrow(/no existe/);
  });

  it("sin innerHTML", () => {
    expect(html).not.toMatch(/innerHTML/);
  });

  it("texto hostil en título y etiqueta: escapado, sin marcado ni marcadores sin sustituir", () => {
    const hostil = `escenas:
  5:
    tipo: mapa
    region: europa
    titulo: "<img src=x onerror=alert(1)> {{INICIO}}"
    destacar: [Spain, Italy]
    etiqueta: "</div><script>alert(1)</script>"`;
    const { p: pm } = plan(hostil);
    const h = Object.values(pm.archivos).find((x) => x.includes("-etq-caja"))!;
    expect(h).not.toMatch(/<img src=x|<script>alert/);
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(h).toContain("&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(h.match(/HF\.contexto\([^)]*\)/g)).toHaveLength(1);
    expect(() => ejecutarPieza(h)).not.toThrow();
  });

  it("datos no válidos lanzan antes de animar", () => {
    for (const malo of [{ destacadas: "no-es-lista" }, { destacadas: [7] }, { destacadas: ["x, #y"] }]) {
      expect(() => ejecutarPieza(conDatos(html, (x) => Object.assign(x, malo))), JSON.stringify(malo)).toThrow();
    }
  });
});

// ---------- Motor: SSIM contra GSAP y estado de la preview ----------

const motor = ejecucionConMotor();
const dirTmp = motor ? fs.mkdtempSync(path.join(os.tmpdir(), "w23-")) : "";

describe.skipIf(!motor)("W2.3 con motor", () => {
  for (const clave of ["TODAS", "TUNEL"] as const) {
    // TUNEL se mide por PNG sin pérdida (x264 recuantiza el grano: por mp4 la propia referencia da 0,9875 contra sí misma con
    // el grano a 0,152). El suelo por PNG es ~0,9927 (el render no es bit a bit determinista entre ejecuciones).
    it(
      `SSIM ≥ 0,99 por fotograma contra GSAP (${clave}${clave === "TUNEL" ? ", por PNG" : ""})`,
      async () => {
        const m = await conCandadoDeRender(() => montar(motor!.motor, path.join(dirTmp, `cand-${clave}`), GUIONES_W2[clave]));
        // Solo TODAS lleva el fondo aurora (WebGPU): el túnel no tiene fondo con shader y su montaje no usa la GPU.
        expect(m.usaWebgpu, `la prueba de GPU del montaje falló (el fondo habría caído a CSS): ${m.avisos.join(" | ")}`).toBe(clave === "TODAS");
        const salida = path.join(dirTmp, `cmp-${clave}`);
        const inf =
          clave === "TUNEL"
            ? await compararTunelPng(motor!.motor, motor!.refs, m.dir, salida)
            : await conCandadoDeRender(() => compararContraReferencia(motor!.motor, path.join(motor!.refs, clave, "ref.mp4"), m.dir, salida));
        process.stderr.write(`[W2.3] ${clave}: ssimMin=${inf.ssimMin} media=${inf.ssimMedia} fotogramas=${inf.fotogramasCandidata}/${inf.fotogramasReferencia}
`);
        expect(inf.fotogramasCandidata).toBe(inf.fotogramasReferencia);
        expect(inf.ssimMin).toBeGreaterThanOrEqual(0.99);
        expect(inf.ok).toBe(true);
      },
      3_600_000,
    );

    // El túnel no tiene ningún elemento de capas, barras ni mapa: su preview es de W2.4.
    if (clave !== "TODAS") continue;

    it(
      `preview: la candidata iguala a la referencia en frío y tras 12 s de play (${clave})`,
      async () => {
        const navegador = path.join(motor!.motor, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
        const cand = (await conCandadoDeRender(() => montar(motor!.motor, path.join(dirTmp, `prev-${clave}`), GUIONES_W2[clave]))).dir;
        const ref = path.join(motor!.refs, clave, "montaje", "proyecto", "video001", "_composicion");
        const [a, b] = (await conCandadoDeRender(async () => [
          (await sondearPreview({ navegador, dir: cand, sonda: SONDA_ESTADO })).resultado,
          (await sondearPreview({ navegador, dir: ref, sonda: SONDA_ESTADO })).resultado,
        ])) as any[];
        const cerca = (x: any, y: any) =>
          x.rect.every((v: number, i: number) => Math.abs(v - y.rect[i]) <= 0.75) && Math.abs(x.opacity - y.opacity) <= 0.01 && x.texto === y.texto;
        // Solo los elementos de estas tres piezas.
        const propios = (e: any) => /^(capas|bloque4|bloque5|.*-f\d|.*-periodo|.*-z\d)/.test(e.id) || /^capas/.test(e.id);
        const fallos: string[] = [];
        let comparados = 0;
        for (const t of Object.keys(a.frio)) {
          const mios = a.frio[t].filter(propios);
          expect(mios.length, `t=${t}: ningún elemento propio en la candidata`).toBeGreaterThan(0);
          for (const e of mios) {
            const o = b.frio[t].find((x: any) => x.id === e.id);
            comparados++;
            if (!o) fallos.push(`frío t=${t} ${e.id}: falta en la referencia`);
            else if (!cerca(e, o)) fallos.push(`frío t=${t} ${e.id}`);
          }
          // Seek tras play = seek en frío, de la propia candidata.
          if (JSON.stringify(a.tras[t]) !== JSON.stringify(a.frio[t])) fallos.push(`tras play t=${t}`);
        }
        expect(comparados).toBeGreaterThan(0);
        expect(a.play.hfSeeks).toBeGreaterThan(0);
        expect(a.play.animaciones).toBeGreaterThan(0);
        // Mediana del desfase WAAPI frente al reloj del player; null (nada medido) es un fallo, no un pase.
        expect(a.play.desfaseMedianaMs).not.toBeNull();
        expect(a.play.desfaseMedianaMs).toBeLessThanOrEqual(3.1);
        expect(fallos).toEqual([]);
      },
      600_000,
    );
  }
});
