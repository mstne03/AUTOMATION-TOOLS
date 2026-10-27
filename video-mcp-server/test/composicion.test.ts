// Planificación de la composición sin render: gancho, etiqueta y escenas no se pisan; cifra al golpe; nebula.
import { describe, expect, it } from "vitest";
import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion } from "../src/alineacion.js";
import { cargarTema, planificarComposicion } from "../src/composicion.js";
import { trazarMapa } from "../src/mapas.js";
import type { ImagenEncontrada } from "../src/paths.js";

const CUERPO = "[1] Five nations rule football.\n[2] Spain, Italy, Germany.\n[3] Brazil and Argentina.\n[4] Seventeen World Cups between them.\n[5] Nobody comes close.\n[6] Can anyone catch up?\n";

/** Plan con palabras sintéticas a `paso` s por carácter. */
function plan(fm: string, paso = 0.06) {
  const g = parsearGuion(`---\ntitulo: T\ngancho: Only five nations matter.\n${fm}\n---\n${CUERPO}`);
  const chars = [...g.narracion];
  const al = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * paso), character_end_times_seconds: chars.map((_, i) => (i + 1) * paso) };
  const palabras = procesarAlineacion({ narracion: g.narracion, bloques: g.bloques, alineacion: al, hashNarracion: g.hash });
  const img = (n: number): ImagenEncontrada => ({ n, nombre: `img${n}.jpg`, ruta: `C:\\x\\img${n}.jpg`, extension: ".jpg" });
  const imagenes = [1, 2, 3, 4, 5, 6].map((n) => (g.opciones.escenas[n] ? undefined : img(n)));
  return { p: planificarComposicion({ guion: g, palabras, imagenes, tema: cargarTema(), gpu: true }), palabras };
}

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
