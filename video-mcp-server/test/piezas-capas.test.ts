// T7: capas de foto y clip sobre las escenas. Piezas sin GSAP, sin innerHTML y sin leer tiempos del DOM; los datos de la pieza son
// enums y números validados por el plan; el nombre del usuario no entra en la composición; la composición no pide nada a la red.
// Los dos tests que renderizan (seek contra render, SSIM ≥ 0,99) necesitan un Chrome verificado y están marcados `skip` (pendientes-T7.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { planificarComposicion, urlsDeRed, type CapaPlan, type PlanComposicion } from "../src/composicion.js";
import { EsquemaProyecto, type Proyecto } from "../src/esquema.js";
import { montarProyecto, type PreparadoProyecto } from "../src/montaje.js";
import { archivosVideo } from "../src/paths.js";
import { cargarTema } from "../src/composicion.js";
import { entradaDe, lineaDe, proyectoBruto, proyectoN } from "./ayudas-n.js";
import { FORMA_GSAP, ejecutarPieza, piezaHtml } from "./piezas-comun.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "video capas "));
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

const PROHIBIDO_EN_PIEZA = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function|currentTime|performance\.now|Date\.now|requestAnimationFrame|setTimeout|setInterval|getAnimations/;

const capa = (extra: Partial<CapaPlan> = {}): CapaPlan => ({ clase: "foto", origen: path.join(BASE, "foto.png"), ext: "png", ancho: 1080, alto: 1920, modo: "encima", encuadre: "zoom", entrada: 0.5, salida: 2.5, ...extra });
fs.writeFileSync(path.join(BASE, "foto.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(path.join(BASE, "clip.mp4"), Buffer.from("clip"));
fs.writeFileSync(path.join(BASE, "fondo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

/** Plan de 3 escenas de 4 s cada una con la capa en la escena `k` (desde 0). */
function plan(k: number, c: CapaPlan | undefined, base?: Parameters<typeof proyectoN>[1]): PlanComposicion {
  const p = proyectoN(3, base);
  const e = entradaDe(p, { palabras: lineaDe(p, 4) });
  if (c) e.escenas[k].capa = c;
  return planificarComposicion(e);
}
const host = (p: PlanComposicion, id: string): string => {
  const m = new RegExp(`<div id="h-${id}"[^>]*>`).exec(p.archivos["index.html"]);
  if (!m) throw new Error(`no hay host h-${id}`);
  return m[0];
};

describe("capa de foto", () => {
  const p = plan(1, capa());
  const html = piezaHtml(p, "capa-esc2");

  it("host sobre las escenas, dentro de lo que dura la escena, y la copia con nombre del motor", () => {
    const h = host(p, "capa-esc2");
    expect(h).toContain('data-track-index="150"');
    expect(h).toContain("z-index: 150");
    const inicio = Number(/data-start="([\d.]+)"/.exec(h)![1]);
    const dur = Number(/data-duration="([\d.]+)"/.exec(h)![1]);
    const corte = Number(/data-start="([\d.]+)"/.exec(host(p, "esc2"))![1]) + 0.15; // la escena entra SOLAPE antes de su corte
    expect(inicio).toBeCloseTo(corte + 0.5, 1);
    expect(dur).toBeCloseTo(2, 3);
    expect(p.copias.filter((c) => c.destino.startsWith("assets/capa"))).toEqual([{ origen: path.join(BASE, "foto.png"), destino: "assets/capa2.png", recurso: true }]);
    expect(html).toContain('src="assets/capa2.png"');
  });

  it("pieza sin GSAP, sin innerHTML, sin tiempos del DOM y sin red", () => {
    expect(html).not.toMatch(FORMA_GSAP);
    expect(html.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(PROHIBIDO_EN_PIEZA);
    expect(html).toContain("HF.contexto");
    expect(Object.values(p.archivos).join("\n")).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it("zoom: fundido de entrada y de salida y acercamiento lineal durante toda la capa", () => {
    const a = ejecutarPieza(html).animaciones;
    const por = (sel: string) => a.filter((x) => x.sel.endsWith(sel));
    expect(por("-fundido")).toHaveLength(2);
    const zoom = por("-mov");
    expect(zoom).toHaveLength(1);
    expect(zoom[0].op.duration).toBeCloseTo(2000, 0); // ms
    expect(JSON.stringify(zoom[0].kf)).toContain("1.12");
  });

  it("marco y paneo cambian el movimiento, no el resto", () => {
    for (const enc of ["marco", "paneo"] as const) {
      const html2 = piezaHtml(plan(1, capa({ encuadre: enc })), "capa-esc2");
      expect(ejecutarPieza(html2).animaciones.length).toBeGreaterThanOrEqual(3);
      expect(html2).toContain(`"encuadre":"${enc}"`);
    }
  });
});

describe("capa de clip", () => {
  it("clip vertical: <video> mudo gobernado por HyperFrames y sin fondo", () => {
    const p = plan(0, capa({ clase: "clip", origen: path.join(BASE, "clip.mp4"), ext: "mp4", ancho: 1080, alto: 1920 }));
    const html = piezaHtml(p, "capa-esc1");
    expect(html).toMatch(/<video id="capa-esc1-video" class="clip" src="assets\/capa1\.mp4" muted playsinline data-start="0" data-duration="2"/);
    expect(html).not.toContain("-fondo\"");
    expect(html.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(PROHIBIDO_EN_PIEZA);
    expect(html).not.toMatch(FORMA_GSAP);
  });

  it("clip horizontal: fotograma fijo con filter: blur() de fondo (M-D7), no un vídeo", () => {
    const p = plan(0, capa({ clase: "clip", origen: path.join(BASE, "clip.mp4"), ext: "mp4", fondo: path.join(BASE, "fondo.png"), ancho: 1920, alto: 1080 }));
    const html = piezaHtml(p, "capa-esc1");
    expect(html).toContain('<img id="capa-esc1-fondo" class="fondo" src="assets/capa1-fondo.png"');
    expect(html).toContain("filter: blur(36px)");
    expect(html).toContain('"horizontal":true');
    expect(p.copias.map((c) => c.destino)).toEqual(expect.arrayContaining(["assets/capa1.mp4", "assets/capa1-fondo.png"]));
    expect((html.replace(/<!--[\s\S]*?-->/g, "").match(/<video/g) ?? []).length).toBe(1);
  });
});

describe("modo detrás y tiempos", () => {
  const sobreFondo = (k: number) => (k === 1 ? ({ tipo: "cifra", valor: 1, prefijo: "", sufijo: "", decimales: 0 } as const) : ({ tipo: "cartel", texto: `C${k}` } as const));

  it("detras solo vale sobre escenas con fondo: titulo3d lo rechaza, un cartel lo admite entre el fondo y las escenas", () => {
    expect(() => plan(0, capa({ modo: "detras" }), (k) => ({ tipo: "titulo3d", texto: `T${k}` }))).toThrow(/solo vale sobre una escena con fondo/);
    const p = plan(0, capa({ modo: "detras" }), sobreFondo);
    const h = host(p, "capa-esc1");
    expect(h).toContain("z-index: 10");
    expect(h).toContain('data-track-index="9"');
    const idx = p.archivos["index.html"];
    expect(idx.indexOf('id="h-fondo"')).toBeLessThan(idx.indexOf('id="h-capa-esc1"'));
    expect(idx.indexOf('id="h-capa-esc1"')).toBeLessThan(idx.indexOf('id="h-esc1"'));
  });

  it("el esquema también lo rechaza (capa_detras_no_permitida)", () => {
    const bruto = proyectoBruto(1, () => ({ tipo: "titulo3d", texto: "T" }));
    bruto.recursos = [{ id: "r-0123456789abcdef", clase: "foto", ext: "png", nombreOriginal: "a.png", ancho: 100, alto: 100, duracion: 0 }];
    bruto.escenas[0].capa = { recursoId: "r-0123456789abcdef", modo: "detras", encuadre: "zoom", entrada: 0, salida: 1 };
    const r = EsquemaProyecto.safeParse(bruto);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain("capa_detras_no_permitida");
  });

  it("la salida se acota a la escena con aviso; si la entrada cae fuera, no hay capa y hay aviso", () => {
    const larga = plan(1, capa({ entrada: 0, salida: 99 }));
    expect(larga.avisos.join(" ")).toMatch(/se acorta a lo que dura la escena/);
    const dur = Number(/data-duration="([\d.]+)"/.exec(host(larga, "capa-esc2"))![1]);
    expect(dur).toBeLessThanOrEqual(4.01);
    const fuera = plan(1, capa({ entrada: 50, salida: 60 }));
    expect(fuera.avisos.join(" ")).toMatch(/queda fuera de lo que dura la escena/);
    expect(fuera.archivos["compositions/capa-esc2.html"]).toBeUndefined();
  });
});

describe("capas hostiles: el plan no deja pasar texto del usuario", () => {
  it("enums, extensión, números y clase fuera de lista lanzan", () => {
    const casos: [Partial<CapaPlan>, RegExp][] = [
      [{ encuadre: 'zoom"><script>x</script>' as never }, /Encuadre de capa no válido/],
      [{ modo: "arriba" as never }, /Modo de capa no válido/],
      [{ clase: "audio" as never }, /Clase de capa no válida/],
      [{ ext: "mp4" }, /extensión de la capa/],
      [{ entrada: NaN }, /Número no finito/],
      [{ salida: Infinity }, /Número no finito/],
      [{ entrada: -1 }, /fuera de rango/],
      [{ ancho: 0 }, /fuera de rango/],
    ];
    for (const [extra, mensaje] of casos) expect(() => plan(0, capa(extra)), JSON.stringify(extra)).toThrow(mensaje);
  });
});

// ---------- Montaje real (resolverCapa) ----------

describe("montaje con capa desde el proyecto", () => {
  const RAIZ = path.join(BASE, "montaje", "proyectos");
  const rid = "r-0123456789abcdef";
  const NOMBRE_HOSTIL = "<img src=x onerror=alert(1)>.png";

  function preparado(clase: "foto" | "clip", ancho = 1080, alto = 1920, conFondo = false): PreparadoProyecto {
    const bruto = proyectoBruto(2);
    const ext = clase === "foto" ? "png" : "mp4";
    bruto.recursos = [{ id: rid, clase, ext, nombreOriginal: NOMBRE_HOSTIL, ancho, alto, duracion: clase === "clip" ? 3 : 0 } as never];
    bruto.escenas[0].capa = { recursoId: rid, modo: "encima", encuadre: "marco", entrada: 0.2, salida: 1.5 };
    const proyecto: Proyecto = EsquemaProyecto.parse(bruto);
    const dir = path.join(RAIZ, "video001", "recursos");
    fs.rmSync(path.join(RAIZ, "video001"), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${rid}.${ext}`), "x");
    if (conFondo) fs.writeFileSync(path.join(dir, `${rid}.fondo.png`), "x");
    const wav = path.join(BASE, "voz.wav");
    fs.writeFileSync(wav, "RIFF");
    return { id: "video001", proyecto, palabras: lineaDe(proyecto, 3), voz: wav, rutas: archivosVideo(RAIZ, "video001"), herramientas: null, tema: cargarTema(), avisos: [] };
  }
  const todos = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? todos(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  it("nombre_original_con_html: el nombre del usuario no aparece en ningún fichero de la composición", () => {
    const destino = path.join(BASE, "salida-nombre");
    montarProyecto(preparado("foto"), destino, false);
    const texto = todos(destino).filter((f) => /\.(html|json|js|css)$/.test(f));
    expect(texto.length).toBeGreaterThan(3);
    for (const f of texto) {
      const c = fs.readFileSync(f, "utf8");
      expect(c, f).not.toContain("onerror");
      expect(c, f).not.toContain("alert(1)");
      expect(c, f).not.toContain(NOMBRE_HOSTIL);
    }
    expect(fs.existsSync(path.join(destino, "assets", "capa1.png"))).toBe(true);
  });

  it("check_con_clip_sin_red: sin URLs, sin ?hf-proxy y con el proxy automático de HyperFrames cerrado", () => {
    const destino = path.join(BASE, "salida-clip");
    montarProyecto(preparado("clip", 1920, 1080, true), destino, false);
    expect(urlsDeRed(destino)).toEqual([]);
    for (const f of todos(destino).filter((x) => /\.(html|json|js|css)$/.test(x) && !x.includes("vendor"))) expect(fs.readFileSync(f, "utf8"), f).not.toContain("hf-proxy");
    // `serveProxyRequest` (hyperframes 0.8.206) solo atiende ?hf-proxy con autoProxy activo y lanza ffprobe/ffmpeg fuera de `ejecutar`:
    // hyperframes.json lo desactiva para `render` y `preview`, y `check` lleva --no-proxy (render.ts, R2-L1).
    expect(JSON.parse(fs.readFileSync(path.join(destino, "hyperframes.json"), "utf8"))).toEqual({ media: { autoProxy: false } });
    expect(fs.readFileSync(path.join(__dirname, "..", "src", "render.ts"), "utf8")).toContain('"--no-proxy"');
    expect(fs.existsSync(path.join(destino, "assets", "capa1.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(destino, "assets", "capa1-fondo.png"))).toBe(true);
  });

  it("un recurso que es un hardlink a un fichero ajeno no entra en la composición (I6)", () => {
    const prep = preparado("foto");
    const ajeno = path.join(BASE, "ajeno.bin");
    fs.writeFileSync(ajeno, "secreto");
    const f = path.join(RAIZ, "video001", "recursos", `${rid}.png`);
    fs.rmSync(f);
    fs.linkSync(ajeno, f);
    expect(() => montarProyecto(prep, path.join(BASE, "salida-enlace"), false)).toThrow(/enlace duro/);
    expect(fs.existsSync(path.join(BASE, "salida-enlace"))).toBe(false);
  });

  it("una capa cuyo recurso ya no está en el proyecto falla visible", () => {
    const prep = preparado("foto");
    prep.proyecto.recursos = [];
    expect(() => montarProyecto(prep, path.join(BASE, "salida-sin-recurso"), false)).toThrow(/ya no está en el proyecto/);
  });
});

// ---------- Necesitan un Chrome verificado ----------
// Ni el del sistema, ni Edge, ni la caché de HyperFrames o de puppeteer, ni un zip local sin SHA-256 fijado: ninguno se ejecuta desde esta
// sesión. Los dos tests están escritos para cuando Marc decida el Chrome for Testing y se corren con VIDEO_ENGINE_DIR y W2_REFS
// (ver pendientes-T7.md). No hay mocks que «pasen»: son `skip` con el motivo.

describe("seek y render coinciden (SSIM ≥ 0,99, scripts/comparar-fotogramas.mjs)", () => {
  it.skip("capa_foto_seek_y_render: falta Chrome verificado (pendientes-T7.md)", async () => {
    // 1. Montar una composición con una capa de foto en cada encuadre (marco, zoom, paneo), en `_render/` de un proyecto de prueba.
    // 2. renderizar(motor, dir, salida) con la CLI de HyperFrames (check antes, como el motor) y compararPngContraReferencia contra el seek
    //    de la preview en los mismos instantes: ok si ningún fotograma baja de 0,99.
    expect(process.env.VIDEO_ENGINE_DIR).toBeTruthy();
  });

  it.skip("capa_clip_seek_y_render: falta Chrome verificado (pendientes-T7.md)", async () => {
    // Igual con un clip vertical y uno horizontal (fondo desenfocado): además de la SSIM, el fotograma 0 de la capa no es negro.
    expect(process.env.VIDEO_ENGINE_DIR).toBeTruthy();
  });
});
