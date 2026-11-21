// Planificación de la composición sin render: gancho, etiqueta y escenas no se pisan; cifra al golpe; nebula;
// cableado de ID, INICIO y DURACION en todas las piezas (SEO-111).
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HF_TIEMPO_JS, jsonParaScript, PIEZAS_DIR, comprobarTiemposPieza } from "../src/composicion.js";
import { trazarMapa } from "../src/mapas.js";
import { GUION_TODAS, GUION_TUNEL } from "../scripts/montar.mjs";
import { plan, planDeGuion } from "./ayudas-plan.js";

afterEach(() => vi.restoreAllMocks());

const host = (html: string, id: string) => {
  const m = new RegExp(`id="h-${id}"[^>]*data-start="([\\d.]+)" data-duration="([\\d.]+)"[^>]*top: (\\d+)px`).exec(html);
  return m ? { inicio: Number(m[1]), duracion: Number(m[2]), top: Number(m[3]) } : undefined;
};

describe("planificarComposicion", () => {
  it("con escena en el bloque 2 el gancho acaba en el corte y la etiqueta pasa debajo del gancho", () => {
    const { p, palabras } = plan("etiqueta: World Cup winners\nescenas:\n  2:\n    tipo: mapa\n    region: europa\n    destacar: [Spain]");
    const corte2 = palabras.segmentos[1].mostrarDesde;
    expect(corte2).toBeLessThan(2.3);
    const g = host(p.archivos["index.html"], "gancho")!;
    expect(g.duracion).toBeCloseTo(Math.max(0.9, corte2), 2);
    const e = host(p.archivos["index.html"], "etiqueta")!;
    expect(e.top).toBe(860);
    expect(e.inicio + e.duracion).toBeLessThanOrEqual(g.duracion + 0.001);
    expect(p.avisos.join(" ")).toMatch(/debajo del gancho/);
  });

  it.each(["cartel\n    texto: Nobody comes close", "cifra\n    valor: 17"])(
    "con una escena en el bloque 1 (%s) su contenido entra cuando el gancho ya se ha ido (content_overlap)",
    (escena) => {
      const { p } = plan(`escenas:\n  1:\n    tipo: ${escena}`, 0.12);
      const g = host(p.archivos["index.html"], "gancho")!;
      const datos = JSON.parse(/id="esc1-datos" type="application\/json">([^<]+)</.exec(p.archivos["compositions/esc1.html"])![1]);
      expect(datos.empieza).toBeGreaterThan(g.inicio + g.duracion);
    },
  );

  it("sin escenas pronto, gancho de 2,3 s y etiqueta arriba justo después", () => {
    const { p } = plan("etiqueta: World Cup winners", 0.12);
    expect(host(p.archivos["index.html"], "gancho")!.duracion).toBe(2.3);
    const e = host(p.archivos["index.html"], "etiqueta")!;
    expect(e).toMatchObject({ inicio: 2.35, top: 300 });
  });

  it("la cifra aterriza en la palabra del golpe, o 0,55 s tras la entrada si la palabra abre el bloque", () => {
    const datosDe = (p: ReturnType<typeof plan>["p"]) => JSON.parse(/id="esc4-datos" type="application\/json">([^<]+)</.exec(p.archivos["compositions/esc4.html"])![1]);
    // "Seventeen" es la primera palabra del bloque 4: aterriza a 0,15 + 0,55 s.
    const a = plan("golpe: Seventeen\nescenas:\n  4:\n    tipo: cifra\n    valor: 17");
    expect(datosDe(a.p).aterriza).toBeCloseTo(0.7, 2);
    // El destello global se mueve con el aterrizaje.
    const flash = JSON.parse(/id="flash-datos" type="application\/json">([^<]+)</.exec(a.p.archivos["compositions/flash.html"])![1]);
    const inicioHost = host(a.p.archivos["index.html"], "esc4")!.inicio;
    expect(flash.destellos.some((x: { t: number; opacidad: number }) => x.opacidad === 0.35 && Math.abs(x.t - (inicioHost + 0.7)) < 0.002)).toBe(true);
    // "between" está más adentro del bloque: aterriza justo en ella.
    const b = plan("golpe: between\nescenas:\n  4:\n    tipo: cifra\n    valor: 17");
    const ib = host(b.p.archivos["index.html"], "esc4")!.inicio;
    const golpe = b.palabras.palabras.find((w) => w.texto === "between")!.inicio;
    expect(datosDe(b.p).aterriza).toBeCloseTo(golpe - ib, 2);
  });

  it("nebula usa FractalNoise a pantalla completa, no el efecto de forma Nebula", () => {
    const { p } = plan("fondo: nebula\nescenas:\n  5:\n    tipo: cartel\n    texto: Nobody comes close");
    expect(p.archivos["compositions/fondo.html"]).toMatch(/data-shader="FractalNoise"/);
    expect(p.archivos["compositions/esc5.html"]).toMatch(/class="w" data-layout-allow-occlusion>Nobody</);
  });

  it("el mapa de Europa ocupa el encuadre (anillo en sentido horario)", () => {
    const m = trazarMapa("europa", ["Spain", "Italy", "Germany"], 1000, 710);
    for (const z of m.destacadas) {
      expect(z.cx).toBeGreaterThan(100);
      expect(z.cx).toBeLessThan(900);
      expect(z.cy).toBeGreaterThan(100);
      expect(z.cy).toBeLessThan(700);
    }
    const [es, , de] = m.destacadas;
    expect(es.cx).toBeLessThan(de.cx); // España a la izquierda de Alemania
    expect(es.cy).toBeGreaterThan(de.cy); // y más abajo
  });
});

describe("cableado de tiempos de las piezas (SEO-111)", () => {
  const HOSTS = /id="h-([^"]+)"[^>]*data-composition-src="compositions\/([^"]+)"[^>]*data-start="([\d.]+)" data-duration="([\d.]+)"/g;

  /** Plan con cada pieza sustituida por sus marcadores de tiempo. */
  function planMarcado(guion: string) {
    const original = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...r: unknown[]) =>
      typeof p === "string" && path.resolve(p).startsWith(PIEZAS_DIR + path.sep)
        ? "ID={{ID}};INICIO={{INICIO}};DURACION={{DURACION}};ENV={{ENVOLTURA_DATOS}}"
        : (original as (...a: unknown[]) => unknown)(p, ...r)) as typeof fs.readFileSync);
    try {
      return planDeGuion(guion, 0.12).p;
    } finally {
      vi.restoreAllMocks();
    }
  }

  it("cada pieza recibe ID, INICIO y DURACION iguales a su host", () => {
    for (const [guion, idsEsperados] of [
      [GUION_TODAS, ["bucle", "capas", "esc1", "esc2", "esc3", "esc4", "esc5", "esc6", "etiqueta", "flash", "fondo", "gancho", "subtitulos"]],
      [GUION_TUNEL, ["bucle", "capas", "esc1", "esc2", "esc3", "esc4", "esc5", "esc6", "flash", "gancho", "subtitulos"]],
    ] as const) {
      const p = planMarcado(guion);
      const hosts = [...p.archivos["index.html"].matchAll(HOSTS)];
      expect(hosts.map((h) => h[1]).sort()).toEqual(idsEsperados);
      for (const [, id, src, inicio, duracion] of hosts) {
        expect(src).toBe(`${id}.html`);
        expect(p.archivos[`compositions/${src}`].startsWith(`ID=${id};INICIO=${inicio};DURACION=${duracion};`), id).toBe(true);
      }
      for (const n of [2, 3, 4, 5, 6]) {
        const env = /;ENV=(.*)$/.exec(p.archivos[`compositions/esc${n}.html`])![1];
        if (guion === GUION_TUNEL && n < 6) {
          expect(env).toBe("{{ENVOLTURA_DATOS}}"); // las fotos no tienen envoltura de escena
          continue;
        }
        expect(Object.keys(JSON.parse(env)).sort()).toEqual(["fundido", "golpes", "punch"]);
      }
    }
  });

  it("un tiempo no finito para el plan con un error legible (I1)", () => {
    expect(() => plan("", 0.06, (al) => (al.duracionAudio = NaN))).toThrow(/Tiempo no finito/);
  });

  it("la palabra del golpe con inicio NaN para el plan (M1)", () => {
    expect(() =>
      plan("golpe: Seventeen", 0.06, (al) => {
        al.palabras.find((w) => w.texto === "Seventeen")!.inicio = NaN;
      }),
    ).toThrow(/no finito/);
  });

  // Guarda de anadirPieza (R1, bloqueante 2): llegan a ella, no las paran otras guardas antes.
  it("un corte NaN que solo afecta a la duración de una escena para el plan en anadirPieza", () => {
    // Bloque 1 con escena (cartel): sus DATOS no llevan la duración, así que jsonParaScript no lo para antes.
    const cortes = [0, NaN, 3, 4, 5, 6];
    expect(() => plan("escenas:\n  1:\n    tipo: cartel\n    texto: Hola", 0.12, undefined, undefined, cortes)).toThrow(/Tiempo no finito en la pieza esc1/);
  });

  it("una pieza que acaba después del vídeo para el plan en anadirPieza", () => {
    // Corte del bloque 6 más allá del final: la ventana empieza tarde y su duración mínima (0,1 s) se sale de D.
    const { palabras } = plan("", 0.12);
    const D = palabras.duracionAudio + 0.4;
    const cortes = palabras.segmentos.map((s) => s.mostrarDesde);
    cortes[5] = D + 5;
    expect(() => plan("", 0.12, undefined, undefined, cortes)).toThrow(/fuera de rango en la pieza esc6/);
  });

  it("comprobarTiemposPieza: NaN, cadena, inicio negativo, duración nula y fin fuera del vídeo lanzan", () => {
    expect(() => comprobarTiemposPieza("etiqueta", NaN, 1, 10)).toThrow(/Tiempo no finito en la pieza etiqueta/);
    expect(() => comprobarTiemposPieza("etiqueta", "1" as unknown as number, 1, 10)).toThrow(/Tiempo no finito en la pieza/);
    expect(() => comprobarTiemposPieza("etiqueta", 1, Infinity, 10)).toThrow(/Tiempo no finito en la pieza/);
    // inicio < 0 no se puede provocar desde planificarComposicion (las ventanas se recortan a 0): se prueba aquí.
    expect(() => comprobarTiemposPieza("etiqueta", -0.5, 1, 10)).toThrow(/fuera de rango/);
    expect(() => comprobarTiemposPieza("etiqueta", 1, 0, 10)).toThrow(/fuera de rango/);
    expect(() => comprobarTiemposPieza("etiqueta", 9.5, 0.6, 10)).toThrow(/fuera de rango/);
    expect(() => comprobarTiemposPieza('etiqueta"', 1, 1, 10)).toThrow(/Id de pieza no válido/);
    expect(comprobarTiemposPieza("etiqueta", 9.4004, 0.6, 10)).toEqual({ i: 9.4, d: 0.6 });
  });

  it("un vídeo de más de 180 s para el plan (M1)", () => {
    expect(() => plan("", 0.06, (al) => (al.duracionAudio = 181))).toThrow(/180/);
  });

  it("los DATOS no admiten números no finitos y nombran la clave (M1)", () => {
    expect(() => jsonParaScript({ a: { duracion: Infinity } })).toThrow(/no finito.*duracion/);
    expect(jsonParaScript({ a: 1, b: [0.5] })).toBe('{"a":1,"b":[0.5]}');
  });

  it("el texto del guion con <script> o {{…}} sale escapado y sin segunda sustitución", () => {
    const { p } = plan("etiqueta: '{{INICIO}} <script>alert(1)</script>'", 0.12, undefined, "'{{INICIO}} <script>alert(1)</script>'");
    for (const f of ["compositions/gancho.html", "compositions/etiqueta.html"]) {
      expect(p.archivos[f], f).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(p.archivos[f], f).toContain("{{INICIO}}");
      expect(p.archivos[f], f).not.toContain("<script>alert");
    }
  });

  it("copia hf-tiempo.js", () => {
    const { p } = plan("");
    expect(p.copias.map((c) => c.destino)).toContain("assets/hf-tiempo.js");
    expect(p.copias.find((c) => c.destino === "assets/hf-tiempo.js")!.origen).toBe(HF_TIEMPO_JS);
    expect(fs.existsSync(HF_TIEMPO_JS)).toBe(true);
  });
});
