// Planificación de la composición sin render: gancho, etiqueta y escenas no se pisan; cifra al golpe; nebula;
// cableado de ID, INICIO y DURACION en todas las piezas (SEO-111).
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion, type ResultadoAlineacion } from "../src/alineacion.js";
import { cargarTema, HF_TIEMPO_JS, jsonParaScript, PIEZAS_DIR, planificarComposicion } from "../src/composicion.js";
import { trazarMapa } from "../src/mapas.js";
import type { ImagenEncontrada } from "../src/paths.js";

const CUERPO = "[1] Five nations rule football.\n[2] Spain, Italy, Germany.\n[3] Brazil and Argentina.\n[4] Seventeen World Cups between them.\n[5] Nobody comes close.\n[6] Can anyone catch up?\n";

/** Plan con palabras sintéticas a `paso` s por carácter. `tocar` modifica la alineación antes de planificar. */
function plan(fm: string, paso = 0.06, tocar?: (p: ResultadoAlineacion) => void, gancho = "Only five nations matter.") {
  const g = parsearGuion(`---\ntitulo: T\ngancho: ${gancho}\n${fm}\n---\n${CUERPO}`);
  const chars = [...g.narracion];
  const al = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * paso), character_end_times_seconds: chars.map((_, i) => (i + 1) * paso) };
  const palabras = procesarAlineacion({ narracion: g.narracion, bloques: g.bloques, alineacion: al, hashNarracion: g.hash });
  tocar?.(palabras);
  const img = (n: number): ImagenEncontrada => ({ n, nombre: `img${n}.jpg`, ruta: `C:\\x\\img${n}.jpg`, extension: ".jpg" });
  const imagenes = [1, 2, 3, 4, 5, 6].map((n) => (g.opciones.escenas[n] ? undefined : img(n)));
  return { p: planificarComposicion({ guion: g, palabras, imagenes, tema: cargarTema(), gpu: true }), palabras };
}

// Los mismos guiones que GUION_TODAS y GUION_TUNEL del arnés (scripts/montar.mjs), sin depender de scripts/.
const GUION_TODAS = `etiqueta: World Cup winners
golpe: Seventeen
fondo: aurora
look: videocamara
fecha: 1995-09-06 20:15
escenas:
  2:
    tipo: cifra
    valor: 3
  3:
    tipo: cartel
    texto: Brazil and Argentina
  4:
    tipo: barras
    titulo: Cups
    periodos: [2000, 2020]
    series:
      Alpha: [1, 2]
      Beta: [2, 3]
  5:
    tipo: mapa
    region: europa
    destacar: [Spain]
  6:
    tipo: titulo3d
    texto: AGUA`;
const GUION_TUNEL = "look: pelicula\nescenas:\n  6:\n    tipo: tunel";

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

  it("sin escenas pronto, gancho de 2,3 s y etiqueta arriba justo después", () => {
    const { p } = plan("etiqueta: World Cup winners", 0.12);
    expect(host(p.archivos["index.html"], "gancho")!.duracion).toBe(2.3);
    const e = host(p.archivos["index.html"], "etiqueta")!;
    expect(e).toMatchObject({ inicio: 2.35, top: 300 });
  });

  it("la cifra aterriza en la palabra del golpe, o 0,55 s tras la entrada si la palabra abre el bloque", () => {
    const datosDe = (p: ReturnType<typeof plan>["p"]) => JSON.parse(/id="bloque4-datos" type="application\/json">([^<]+)</.exec(p.archivos["compositions/bloque4.html"])![1]);
    // "Seventeen" es la primera palabra del bloque 4: aterriza a 0,15 + 0,55 s.
    const a = plan("golpe: Seventeen\nescenas:\n  4:\n    tipo: cifra\n    valor: 17");
    expect(datosDe(a.p).aterriza).toBeCloseTo(0.7, 2);
    // El destello global se mueve con el aterrizaje.
    const flash = JSON.parse(/id="flash-datos" type="application\/json">([^<]+)</.exec(a.p.archivos["compositions/flash.html"])![1]);
    const inicioHost = host(a.p.archivos["index.html"], "bloque4")!.inicio;
    expect(flash.destellos.some((x: { t: number; opacidad: number }) => x.opacidad === 0.35 && Math.abs(x.t - (inicioHost + 0.7)) < 0.002)).toBe(true);
    // "between" está más adentro del bloque: aterriza justo en ella.
    const b = plan("golpe: between\nescenas:\n  4:\n    tipo: cifra\n    valor: 17");
    const ib = host(b.p.archivos["index.html"], "bloque4")!.inicio;
    const golpe = b.palabras.palabras.find((w) => w.texto === "between")!.inicio;
    expect(datosDe(b.p).aterriza).toBeCloseTo(golpe - ib, 2);
  });

  it("nebula usa FractalNoise a pantalla completa, no el efecto de forma Nebula", () => {
    const { p } = plan("fondo: nebula\nescenas:\n  5:\n    tipo: cartel\n    texto: Nobody comes close");
    expect(p.archivos["compositions/fondo.html"]).toMatch(/data-shader="FractalNoise"/);
    expect(p.archivos["compositions/bloque5.html"]).toMatch(/class="w" data-layout-allow-occlusion>Nobody</);
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
  function planMarcado(fm: string) {
    const original = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...r: unknown[]) =>
      typeof p === "string" && path.resolve(p).startsWith(PIEZAS_DIR + path.sep)
        ? "ID={{ID}};INICIO={{INICIO}};DURACION={{DURACION}};ENV={{ENVOLTURA_DATOS}}"
        : (original as (...a: unknown[]) => unknown)(p, ...r)) as typeof fs.readFileSync);
    try {
      return plan(fm, 0.12).p;
    } finally {
      vi.restoreAllMocks();
    }
  }

  it("cada pieza recibe ID, INICIO y DURACION iguales a su host", () => {
    for (const [fm, idsEsperados] of [
      [GUION_TODAS, ["bloque1", "bloque2", "bloque3", "bloque4", "bloque5", "bloque6", "bucle", "capas", "etiqueta", "flash", "fondo", "gancho", "subtitulos"]],
      [GUION_TUNEL, ["bloque1", "bloque2", "bloque3", "bloque4", "bloque5", "bloque6", "bucle", "capas", "flash", "gancho", "subtitulos"]],
    ] as const) {
      const p = planMarcado(fm);
      const hosts = [...p.archivos["index.html"].matchAll(HOSTS)];
      expect(hosts.map((h) => h[1]).sort()).toEqual(idsEsperados);
      for (const [, id, src, inicio, duracion] of hosts) {
        expect(src).toBe(`${id}.html`);
        expect(p.archivos[`compositions/${src}`].startsWith(`ID=${id};INICIO=${inicio};DURACION=${duracion};`), id).toBe(true);
      }
      for (const n of [2, 3, 4, 5, 6]) {
        const env = /;ENV=(.*)$/.exec(p.archivos[`compositions/bloque${n}.html`])![1];
        if (fm === GUION_TUNEL && n < 6) {
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

  it("copia hf-tiempo.js y mantiene gsap", () => {
    const { p } = plan("");
    const destinos = p.copias.map((c) => c.destino);
    expect(destinos).toContain("assets/hf-tiempo.js");
    expect(destinos).toContain("assets/gsap.min.js");
    expect(p.copias.find((c) => c.destino === "assets/hf-tiempo.js")!.origen).toBe(HF_TIEMPO_JS);
    expect(fs.existsSync(HF_TIEMPO_JS)).toBe(true);
  });
});
