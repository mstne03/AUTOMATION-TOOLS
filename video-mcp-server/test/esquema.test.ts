import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  descripcionEsquema,
  ErrorEsquema,
  EsquemaGuionVideo,
  EsquemaProyecto,
  LIMITES,
  recomendaciones,
  TIPOS_ESCENA_FASE1,
  validarGuionVideo,
  validarProyecto,
} from "../src/esquema.js";
import { escaparHtml, hallazgosDeRed, jsonParaScript, urlsDeRed } from "../src/composicion.js";
import { resolverZona } from "../src/mapas.js";

// ---------- Fixtures ----------

const GUION_FUTBOL = {
  version: 1,
  titulo: "La final de 1999",
  gancho: "Dos goles en tres minutos.",
  escenas: [
    { frases: ["Minuto noventa en Barcelona.", "Todo parecía decidido."], base: { tipo: "cartel", texto: "Minuto 90" } },
    { frases: ["Entonces llegó el empate."], base: { tipo: "cifra", valor: 1, prefijo: "", sufijo: " gol", decimales: 0 }, recurso: { tipo: "foto", que_debe_salir: "El estadio lleno", resolucion_minima: { ancho: 1080, alto: 1920 } } },
    { frases: ["Y el empate se convirtió en victoria."], base: { tipo: "titulo3d", texto: "CAMPEONES" } },
  ],
  opciones: { fondo: "aurora", look: "normal", subtitulos: "karaoke", etiqueta: "Barcelona, 1999", destellos: [0], golpe: { frase: 3, palabra: "empate" } },
};

const GUION_COCINA = {
  version: 1,
  titulo: "Tortilla perfecta",
  gancho: "El secreto está en la patata.",
  escenas: [
    { frases: ["Corta las patatas finas."], base: { tipo: "barras", titulo: "Tiempo de fritura", periodos: ["Min 5", "Min 10"], series: [{ nombre: "Patata", valores: [3, 9] }, { nombre: "Cebolla", valores: [1, 6] }], prefijo: "", sufijo: " %" } },
    { frases: ["Origen de la receta."], base: { tipo: "mapa", region: "espana", destacar: ["Madrid"], etiqueta: "Cuna de la tortilla" } },
  ],
  opciones: { fondo: "gradiente", look: "pelicula", subtitulos: "pildora", destellos: [] },
};

function proyectoBase(): any {
  return {
    version: 1,
    id: "video001",
    revision: 0,
    titulo: "Prueba",
    gancho: "Gancho",
    aspecto: "9:16",
    perfilId: "defecto",
    creado: "2026-11-01T10:00:00Z",
    actualizado: "2026-11-01T10:00:00.123Z",
    frases: [
      { id: "f1", texto: "Primera frase.", recorte: { inicio: 0, fin: 1.5 } },
      { id: "f2", texto: "Segunda frase." },
    ],
    escenas: [
      { id: "e1", fraseIds: ["f1"], base: { tipo: "cartel", texto: "Hola" }, ajusteCorte: 0.2, capa: { recursoId: "r-0123456789abcdef", modo: "encima", encuadre: "zoom", entrada: 0, salida: 2 } },
      { id: "e2", fraseIds: ["f2"], base: { tipo: "cifra", valor: 3, prefijo: "", sufijo: "", decimales: 0 }, ajusteCorte: 0, recursoPendiente: { tipo: "clip", que_debe_salir: "Un saque", resolucion_minima: { ancho: 720, alto: 1280 } } },
    ],
    recursos: [{ id: "r-0123456789abcdef", clase: "foto", ext: "jpg", nombreOriginal: "estadio.jpg", ancho: 1920, alto: 1080, duracion: 0 }],
    musica: { pistaId: "pista-1", inicio: 0, volumen: 0.3, ducking: true },
    subtitulos: { estilo: "karaoke", correcciones: [{ indice: 2, texto: "Segunda" }], cortes: [3] },
    opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [0] },
  };
}

function problemasDe(f: () => unknown): ErrorEsquema["problemas"] {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorEsquema);
    return (e as ErrorEsquema).problemas;
  }
  throw new Error("se esperaba ErrorEsquema");
}
const codigos = (f: () => unknown) => problemasDe(f).map((p) => p.codigo);
const clon = <T>(x: T): T => structuredClone(x);

// ---------- Recorrido del esquema de zod ----------

type Nodo = { _zod: { def: any; bag: any } };
function recorrer(raiz: Nodo, visita: (n: Nodo, clave?: string) => void): void {
  const visto = new Set<Nodo>();
  const ir = (n: Nodo, clave?: string) => {
    if (visto.has(n) && clave === undefined) return;
    visto.add(n);
    visita(n, clave);
    const d = n._zod.def;
    switch (d.type) {
      case "object":
        for (const [k, v] of Object.entries(d.shape)) ir(v as Nodo, k);
        break;
      case "array":
        ir(d.element);
        break;
      case "pipe":
        ir(d.in);
        ir(d.out);
        break;
      case "optional":
      case "nullable":
      case "default":
        ir(d.innerType);
        break;
      case "union":
        for (const o of d.options) ir(o);
        break;
    }
  };
  ir(raiz);
}

const checks = (n: Nodo): any[] => (n._zod.def.checks ?? []).map((c: any) => c._zod.def);
const tieneMax = (n: Nodo) => checks(n).some((c) => c.check === "max_length" || (c.check === "less_than" && c.value !== undefined));
const tieneMin = (n: Nodo) => checks(n).some((c) => c.check === "greater_than");

const RAICES = [EsquemaGuionVideo, EsquemaProyecto] as unknown as Nodo[];
function desenvolver(n: Nodo): Nodo {
  let d = n._zod.def;
  while (["optional", "nullable", "default"].includes(d.type)) {
    n = d.innerType;
    d = n._zod.def;
  }
  return n;
}

describe("esquema de guion y proyecto", () => {
  it("guion_valido_pasa", () => {
    expect(validarGuionVideo(GUION_FUTBOL).escenas).toHaveLength(3);
    const c = validarGuionVideo(GUION_COCINA);
    expect(c.escenas[1].base.tipo).toBe("mapa");
    expect(validarProyecto(proyectoBase()).escenas).toHaveLength(2);
  });

  it("sobra_un_campo", () => {
    for (const raiz of ["guion", "proyecto"] as const) {
      const casos: [any, (x: any) => any][] = [];
      const base = raiz === "guion" ? clon(GUION_FUTBOL) : proyectoBase();
      casos.push([clon(base), (x) => (x.ruta = "x")]);
      casos.push([clon(base), (x) => (x.escenas[0].ruta = "x")]);
      casos.push([clon(base), (x) => (x.escenas[0].base.ruta = "x")]);
      casos.push([clon(base), (x) => (x.opciones.ruta = "x")]);
      if (raiz === "proyecto") {
        casos.push([clon(base), (x) => (x.recursos[0].ruta = "x")]);
        casos.push([clon(base), (x) => (x.escenas[0].capa.ruta = "x")]);
        casos.push([clon(base), (x) => (x.musica.ruta = "x")]);
        casos.push([clon(base), (x) => (x.subtitulos.ruta = "x")]);
        casos.push([clon(base), (x) => (x.frases[0].ruta = "x")]);
      } else {
        casos.push([clon(base), (x) => (x.escenas[1].recurso.ruta = "x")]);
      }
      for (const [doc, tocar] of casos) {
        tocar(doc);
        const f = () => (raiz === "guion" ? validarGuionVideo(doc) : validarProyecto(doc));
        expect(codigos(f)).toContain("unrecognized_keys");
      }
    }
  });

  it("sin_campos_ruta", () => {
    const prohibidos = new Set(["ruta", "url", "path", "src", "archivo"]);
    const halladas: string[] = [];
    for (const raiz of RAICES)
      recorrer(raiz, (n) => {
        if (n._zod.def.type === "object") for (const k of Object.keys(n._zod.def.shape)) if (prohibidos.has(k.toLowerCase())) halladas.push(k);
      });
    expect(halladas).toEqual([]);
  });

  it("sin_cadena_sin_tope", () => {
    const fallos: string[] = [];
    const ESTILO = new Set(["fondo", "look", "estilo", "subtitulos", "clase", "ext", "region", "modo", "encuadre"]);
    for (const raiz of RAICES)
      recorrer(raiz, (n, clave) => {
        const t = n._zod.def.type;
        if (t === "string" && !tieneMax(n)) fallos.push(`cadena sin max (${clave ?? "?"})`);
        if (t === "array" && !tieneMax(n)) fallos.push(`array sin max (${clave ?? "?"})`);
        if (t === "number" && (!tieneMax(n) || !tieneMin(n))) fallos.push(`número sin rango (${clave ?? "?"})`);
        if (t === "object" && n._zod.def.catchall?._zod.def.type !== "never") fallos.push(`objeto no estricto (${clave ?? "raíz"})`);
        if (t === "object")
          for (const [k, v] of Object.entries(n._zod.def.shape))
            if (ESTILO.has(k) && desenvolver(v as Nodo)._zod.def.type !== "object" && desenvolver(v as Nodo)._zod.def.type !== "enum") fallos.push(`campo de estilo ${k} no es enum`);
      });
    expect([...new Set(fallos)]).toEqual([]);
  });

  it("ext_libre_rechazada", () => {
    for (const [clase, ext] of [["foto", "exe"], ["foto", "mp4"], ["clip", "jpg"], ["musica", "mp3"], ["foto", "JPG"], ["foto", "jpg/../x"]]) {
      const p = proyectoBase();
      p.recursos[0].clase = clase;
      p.recursos[0].ext = ext;
      p.escenas[0].capa = undefined;
      expect(problemasDe(() => validarProyecto(p)).length).toBeGreaterThan(0);
    }
    const ok = proyectoBase();
    ok.recursos.push({ id: "r-aaaaaaaaaaaaaaaa", clase: "musica", ext: "wav", nombreOriginal: "a.wav", ancho: 1, alto: 1, duracion: 30 });
    expect(validarProyecto(ok).recursos).toHaveLength(2);
  });

  it("limites_exactos", () => {
    const con = (n: number) => ({ ...clon(GUION_FUTBOL), escenas: Array.from({ length: n }, () => ({ frases: ["a"], base: { tipo: "cartel", texto: "x" } })) });
    expect(validarGuionVideo(con(LIMITES.escenas)).escenas).toHaveLength(90);
    expect(codigos(() => validarGuionVideo(con(LIMITES.escenas + 1)))).toContain("too_big");
    // La narración es la unión de las frases con un espacio.
    const narrar = (total: number) => {
      const frases: string[] = [];
      let resto = total;
      while (resto > 0) {
        const n = Math.min(resto, 400);
        frases.push("a".repeat(n));
        resto -= n + 1;
      }
      const g = clon(GUION_FUTBOL);
      g.escenas = [];
      for (let i = 0; i < frases.length; i += 6) g.escenas.push({ frases: frases.slice(i, i + 6), base: { tipo: "cartel", texto: "x" } } as any);
      return g;
    };
    const exacto = narrar(LIMITES.narracion);
    expect(exacto.escenas.flatMap((e: any) => e.frases).join(" ")).toHaveLength(3000);
    expect(validarGuionVideo(exacto)).toBeTruthy();
    const pasado = narrar(LIMITES.narracion + 1);
    expect(pasado.escenas.flatMap((e: any) => e.frases).join(" ")).toHaveLength(3001);
    expect(codigos(() => validarGuionVideo(pasado))).toContain("narracion_excedida");
    // Resto de topes
    const g = clon(GUION_FUTBOL);
    g.escenas[0].frases = Array(7).fill("a");
    expect(codigos(() => validarGuionVideo(g))).toContain("too_big");
    const t = clon(GUION_FUTBOL);
    t.titulo = "a".repeat(101);
    expect(codigos(() => validarGuionVideo(t))).toContain("too_big");
    const r = proyectoBase();
    r.recursos = Array.from({ length: 31 }, (_, i) => ({ id: `r-${String(i).padStart(16, "0")}`, clase: "foto", ext: "jpg", nombreOriginal: "a", ancho: 1, alto: 1, duracion: 0 }));
    r.escenas[0].capa = undefined;
    expect(codigos(() => validarProyecto(r))).toContain("too_big");
  });

  it("numero_no_finito", () => {
    for (const valor of [JSON.parse("1e400"), "12", null, NaN, 2e12, -2e12]) {
      const g = clon(GUION_FUTBOL);
      (g.escenas[1].base as any).valor = valor;
      expect(problemasDe(() => validarGuionVideo(g)).length).toBeGreaterThan(0);
    }
    const g = clon(GUION_FUTBOL);
    (g.escenas[1].base as any).valor = 1e12;
    expect(validarGuionVideo(g)).toBeTruthy();
    const p = proyectoBase();
    p.escenas[0].ajusteCorte = Infinity;
    expect(problemasDe(() => validarProyecto(p)).length).toBeGreaterThan(0);
    const q = proyectoBase();
    q.recursos[0].ancho = 8193;
    expect(problemasDe(() => validarProyecto(q)).length).toBeGreaterThan(0);
    const s = proyectoBase();
    s.recursos[0].ancho = 100.5;
    expect(problemasDe(() => validarProyecto(s)).length).toBeGreaterThan(0);
  });

  it("tiempos_crecientes", () => {
    const p = proyectoBase();
    p.frases[0].recorte = { inicio: 2, fin: 1 };
    expect(codigos(() => validarProyecto(p))).toContain("tiempos_no_crecientes");
    const q = proyectoBase();
    q.escenas[0].ajusteCorte = -1;
    expect(problemasDe(() => validarProyecto(q)).length).toBeGreaterThan(0);
    const r = proyectoBase();
    r.musica.inicio = -0.1;
    expect(problemasDe(() => validarProyecto(r)).length).toBeGreaterThan(0);
  });

  it("proto", () => {
    const g = JSON.parse(JSON.stringify(GUION_FUTBOL).replace(/^\{/, '{"__proto__":{"x":1},'));
    expect(codigos(() => validarGuionVideo(g))).toContain("unrecognized_keys");
    const anidado = clon(GUION_FUTBOL) as any;
    anidado.escenas[0].base = JSON.parse('{"tipo":"cartel","texto":"x","__proto__":{"x":1}}');
    expect(codigos(() => validarGuionVideo(anidado))).toContain("unrecognized_keys");
    expect(problemasDe(() => validarGuionVideo(JSON.parse('{"__proto__":{"x":1}}'))).length).toBeGreaterThan(0);
    expect(problemasDe(() => validarProyecto(JSON.parse('{"__proto__":{"x":1}}'))).length).toBeGreaterThan(0);
    expect(({} as any).x).toBeUndefined();
  });

  it("color_malo_rechazado", () => {
    // El proyecto no tiene campos de color (viven en el perfil): cualquier color se rechaza en todos los niveles.
    const malo = "red;background:url(//x)";
    const sitios: ((p: any) => void)[] = [
      (p) => (p.color = malo),
      (p) => (p.escenas[0].color = malo),
      (p) => (p.escenas[0].base.color = malo),
      (p) => (p.escenas[0].capa.color = malo),
      (p) => (p.opciones.color = malo),
      (p) => (p.subtitulos.color = malo),
      (p) => (p.escenas[0].base = { tipo: "cartel", texto: "x", colorFondo: malo }),
    ];
    for (const poner of sitios) {
      const p = proyectoBase();
      poner(p);
      expect(codigos(() => validarProyecto(p))).toContain("unrecognized_keys");
    }
    // Y como valor de un campo de estilo, que es un enum.
    for (const campo of ["fondo", "look"]) {
      const p = proyectoBase();
      p.opciones[campo] = malo;
      expect(problemasDe(() => validarProyecto(p)).length).toBeGreaterThan(0);
    }
    const q = proyectoBase();
    q.subtitulos.estilo = malo;
    expect(problemasDe(() => validarProyecto(q)).length).toBeGreaterThan(0);
  });

  it("texto_control", () => {
    for (const malo of ["a\u202Eb", "a\u0000", "a\u2066b", "a\u2069b", "a\u0085b", "a\u009Fb", "a\nb", "a\ud800b", "a\u007Fb"]) {
      const g = clon(GUION_FUTBOL);
      g.titulo = malo;
      expect(codigos(() => validarGuionVideo(g))).toContain("texto_inseguro");
      const p = proyectoBase();
      p.frases[0].texto = malo;
      expect(codigos(() => validarProyecto(p))).toContain("texto_inseguro");
    }
  });

  it("texto_control_unicode: invisibles, bidi, etiquetas, separadores y no-caracteres (M2)", () => {
    const malos = [
      "a\u200Eb", "a\u200Fb", "a\u061Cb", // LRM, RLM, ALM
      "a\u{E0041}b", "a\u{E0001}b", "a\u{E007F}b", // etiquetas (ASCII smuggling)
      "a\u200Bb", "a\u200Cb", "a\u200Db", "a\u2060b", "a\u00ADb", "a\uFEFFb", // ZWSP, ZWNJ, ZWJ suelto, WJ, SHY, BOM
      "a\u2028b", "a\u2029b", // separadores de línea y de párrafo
      "a\uFFF9b", "a\uFFFAb", "a\uFFFBb", // anotaciones interlineales
      "a\uFFFEb", "a\uFFFFb", "a\uFDD0b", "a\u{1FFFE}b", "a\u{10FFFF}b", // no-caracteres
      "a\uE000b", "a\u{F0000}b", // uso privado
      "\u200D", "\u200Da", "a\u200D", "👨\u200D\u200D👩", "👨\u200Da", "a\u200D👩", // ZWJ fuera de una secuencia emoji
    ];
    for (const malo of malos) {
      const g = clon(GUION_FUTBOL);
      g.titulo = malo;
      expect({ malo, c: codigos(() => validarGuionVideo(g)) }).toEqual({ malo, c: expect.arrayContaining(["texto_inseguro"]) });
      const p = proyectoBase();
      p.frases[0].texto = malo;
      expect(codigos(() => validarProyecto(p))).toContain("texto_inseguro");
    }
  });

  it("los emoji con ZWJ y VS16 legítimos siguen pasando (M2)", () => {
    // Decisión: se rechaza todo Cf salvo U+200D entre dos Extended_Pictographic (con VS16 o modificador de tono
    // en medio). Las etiquetas U+E0020–E007F (banderas de Inglaterra o Escocia) se rechazan: son el vector del smuggling.
    for (const bueno of ["👨\u200D👩\u200D👧", "❤\uFE0F\u200D🔥", "🏳\uFE0F\u200D🌈", "👩\u{1F3FD}\u200D🚀", "👍🏽", "Gol ⚽ ¡vamos! ñ é 日本"]) {
      const g = clon(GUION_FUTBOL);
      g.titulo = bueno;
      expect({ bueno, titulo: validarGuionVideo(g).titulo }).toEqual({ bueno, titulo: bueno.normalize("NFC") });
    }
  });

  it("texto_nfc_tope: el máximo se mide tras NFC (L1)", () => {
    // U+FB2C se normaliza a 3 caracteres: 14 * 3 = 42 > 40.
    const g = clon(GUION_FUTBOL) as any;
    g.escenas[0].base = { tipo: "cartel", texto: "\uFB2C".repeat(14) };
    expect(codigos(() => validarGuionVideo(g))).toContain("too_big");
    g.escenas[0].base.texto = "\uFB2C".repeat(13); // 39
    expect(validarGuionVideo(g).escenas[0].base).toMatchObject({ texto: "\uFB2C".normalize("NFC").repeat(13) });
    const p = proyectoBase();
    p.frases[0].texto = "\u{1D160}".repeat(LIMITES.fraseChars / 4); // 2 -> 6 unidades: 600 > 400
    expect(codigos(() => validarProyecto(p))).toContain("too_big");
  });

  it("texto_nfc", () => {
    const g = clon(GUION_FUTBOL);
    g.titulo = "Cafe\u0301";
    expect(validarGuionVideo(g).titulo).toBe("Caf\u00e9");
  });

  it("script_pasa_como_texto", () => {
    const g = clon(GUION_FUTBOL);
    g.titulo = "<script>alert(1)</script>";
    g.escenas[0].frases = ["{{TITULO}} <img src=x onerror=alert(1)>"];
    expect(validarGuionVideo(g).titulo).toBe("<script>alert(1)</script>");
  });

  it("error_sin_valor", () => {
    const CENTINELA = "SECRETO-9f3a";
    const g = clon(GUION_FUTBOL) as any;
    g.titulo = `${CENTINELA}\u202E`;
    g.gancho = 42;
    g.escenas[0].base = { tipo: CENTINELA };
    g.escenas[1].base.valor = CENTINELA;
    g[CENTINELA] = 1;
    g.opciones.fondo = CENTINELA;
    let err: ErrorEsquema | undefined;
    try {
      validarGuionVideo(g);
    } catch (e) {
      err = e as ErrorEsquema;
    }
    expect(err).toBeInstanceOf(ErrorEsquema);
    expect(JSON.stringify(err!.problemas)).not.toContain(CENTINELA);
    expect(err!.message).not.toContain(CENTINELA);
    expect(err!.problemas.length).toBeGreaterThan(3);
    for (const p of err!.problemas) expect(Object.keys(p).sort()).toEqual(["codigo", "ruta"]);
  });

  it("mapa_fuera_de_atlas", () => {
    for (const nombre of ["Atlantis", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(resolverZona("mundo", nombre).zona).toBeUndefined();
      expect(resolverZona("europa", nombre).zona).toBeUndefined();
      const g = clon(GUION_COCINA) as any;
      g.escenas[1].base = { tipo: "mapa", region: "mundo", destacar: [nombre] };
      expect(codigos(() => validarGuionVideo(g))).toContain("zona_fuera_de_atlas");
    }
    const g = clon(GUION_COCINA) as any;
    g.escenas[1].base = { tipo: "mapa", region: "mundo", destacar: ["Alemania", "Brazil"] };
    expect(validarGuionVideo(g)).toBeTruthy();
    g.escenas[1].base = { tipo: "mapa", region: "narnia", destacar: [] };
    expect(problemasDe(() => validarGuionVideo(g)).length).toBeGreaterThan(0);
  });

  it("tunel_rechazado", () => {
    expect(TIPOS_ESCENA_FASE1).toEqual(["cifra", "barras", "mapa", "cartel", "titulo3d"]);
    const g = clon(GUION_FUTBOL) as any;
    g.escenas[0].base = { tipo: "tunel" };
    expect(problemasDe(() => validarGuionVideo(g)).length).toBeGreaterThan(0);
    const p = proyectoBase();
    p.escenas[0].base = { tipo: "tunel" };
    expect(problemasDe(() => validarProyecto(p)).length).toBeGreaterThan(0);
  });

  it("recurso_id_regex", () => {
    for (const id of ["../x", "C:\\x", "a:b", "r-0123456789ABCDEF", "r-123", "", "r-0123456789abcdef/"]) {
      const p = proyectoBase();
      p.recursos[0].id = id;
      p.escenas[0].capa.recursoId = id;
      expect(problemasDe(() => validarProyecto(p)).length).toBeGreaterThan(0);
    }
    for (const id of ["../x", "C:\\x", "a:b", "video1", "..\\x", "CON"]) {
      const p = proyectoBase();
      p.id = id;
      expect(problemasDe(() => validarProyecto(p)).length).toBeGreaterThan(0);
    }
    const p = proyectoBase();
    p.escenas[0].fraseIds = ["../x"];
    expect(problemasDe(() => validarProyecto(p)).length).toBeGreaterThan(0);
    const q = proyectoBase();
    q.perfilId = "../defecto";
    expect(problemasDe(() => validarProyecto(q)).length).toBeGreaterThan(0);
  });

  it("referencias_cruzadas", () => {
    const p = proyectoBase();
    p.escenas[0].fraseIds = ["f9"];
    expect(codigos(() => validarProyecto(p))).toContain("referencia_inexistente");
    const q = proyectoBase();
    q.escenas[0].capa.recursoId = "r-ffffffffffffffff";
    expect(codigos(() => validarProyecto(q))).toContain("referencia_inexistente");
    const r = proyectoBase();
    r.escenas[1].id = "e1";
    expect(codigos(() => validarProyecto(r))).toContain("id_duplicado");
    const s = proyectoBase();
    s.escenas[0].base = { tipo: "titulo3d", texto: "HOLA" };
    s.escenas[0].capa.modo = "detras";
    expect(codigos(() => validarProyecto(s))).toContain("capa_detras_no_permitida");
    const t = proyectoBase();
    t.aspecto = "16:9";
    expect(problemasDe(() => validarProyecto(t)).length).toBeGreaterThan(0);
  });

  it("barras_longitud_de_series", () => {
    const g = clon(GUION_COCINA) as any;
    g.escenas[0].base.series[0].valores = [1];
    expect(codigos(() => validarGuionVideo(g))).toContain("serie_longitud");
    const h = clon(GUION_COCINA) as any;
    h.escenas[0].base.series = { Patata: [1, 2], Cebolla: [1, 2] };
    expect(problemasDe(() => validarGuionVideo(h)).length).toBeGreaterThan(0);
  });

  it("titulo3d_solo_ascii", () => {
    const g = clon(GUION_FUTBOL) as any;
    g.escenas[2].base.texto = "ÁGUA";
    expect(codigos(() => validarGuionVideo(g))).toContain("titulo3d_caracteres");
    g.escenas[2].base.texto = "A".repeat(13);
    expect(problemasDe(() => validarGuionVideo(g)).length).toBeGreaterThan(0);
  });

  describe("url_en_texto", () => {
    // Lo que `urlsDeRed` marcaría en una composición: el esquema lo rechaza en el texto.
    const MUESTRAS = [
      "https://ejemplo.com/a",
      "HTTPS://EJEMPLO.COM",
      "ws://host:8080",
      "wss://host",
      "file:///etc/passwd",
      "FILE:C:/x",
      "file:\\\\srv\\x",
      "//cdn.ejemplo.com/x.js",
      "mira //host/x",
      "\\\\host\\share",
      "https:ejemplo.com",
      "http:\\\\x",
      "Http:\\x",
      "https:/ejemplo.com",
      "http:\\x",
      "(//host)",
      "\"//host\"",
      "ver https&colon;//host",
      "http&#58;//host",
    ];
    const SEGURAS = ["ejemplo.com", "Nota: lo vimos ayer", "50 // 100", "a/b", "https", "El 12:30 llegó", "<script>x</script>"];

    /** Lo que la composición ve de un texto: escapado en el HTML y como JSON en el script. */
    const composicionMarca = (texto: string): boolean => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esquema-url-"));
      try {
        fs.writeFileSync(path.join(dir, "t.html"), `<p>${escaparHtml(texto)}</p>`);
        fs.writeFileSync(path.join(dir, "t.json"), `{"t":${jsonParaScript(texto)}}`);
        fs.writeFileSync(path.join(dir, "t.js"), `const t = ${jsonParaScript(texto)};`);
        return urlsDeRed(dir).length > 0;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const esquemaRechaza = (texto: string): boolean => {
      const g = clon(GUION_FUTBOL);
      g.titulo = texto;
      try {
        validarGuionVideo(g);
        return false;
      } catch (e) {
        return (e as ErrorEsquema).problemas.some((p) => p.codigo === "url_en_texto");
      }
    };
    // Divergencias de la revisión de seguridad (M1): el texto crudo no se marca, el escapado sí.
    const DIVERGENTES = ["<//host", ">//host", "<//h", ">//h", "&constructor;//h", "&valueOf;//h", "&toString;//h", "&hasOwnProperty;//h", "&__proto__;//h", "a<//h", "&lt;//h"];

    it("todo texto que la composición marcaría una vez escapado lo rechaza el esquema (M1)", () => {
      for (const m of [...MUESTRAS, ...DIVERGENTES, ...SEGURAS]) {
        const marcada = composicionMarca(m);
        if (marcada) expect({ m, rechazada: esquemaRechaza(m) }).toEqual({ m, rechazada: true });
        if (SEGURAS.includes(m)) expect({ m, rechazada: esquemaRechaza(m) }).toEqual({ m, rechazada: false });
      }
      for (const m of MUESTRAS) expect({ m, marcada: composicionMarca(m) }).toEqual({ m, marcada: true });
      for (const m of DIVERGENTES) expect({ m, marcada: composicionMarca(m) || hallazgosDeRed(m, "x.html").length > 0, rechazada: esquemaRechaza(m) }).toEqual({ m, marcada: true, rechazada: true });
    });

    it("rechaza esquemas genéricos y peligrosos, y deja pasar los usos normales (L2)", () => {
      for (const m of ["ftp://host", "FTP://host/x", "javascript://x", "javascript:alert(1)", "JavaScript:x", "data:text/html,x", "blob:x", "vbscript:x", "sftp://h", "x:////host", "z+y.w-v://h", "x:\\\\h", "mira ftp://h", "ftp:x", "Blob:a", "data:text", "about:blank", "javascript:%61lert(1)", "javascript:(alert)(1)", "javascript:'x'", "data:,<b>x", "data:;base64,AAAA"]) {
        expect({ m, rechazada: esquemaRechaza(m) }).toEqual({ m, rechazada: true });
      }
      for (const m of ["Nota: lo vimos ayer", "10:30", "El 12:30 llegó", "Gol: 3", "Resultado:3-1", "Data: cinco filas", "Mundial:2026", "Hora 9:05", "a:b", "ftp", "Datos: 5", "Big data:2024", "FTP:21", "Blob:3", "data:5"]) {
        expect({ m, rechazada: esquemaRechaza(m) }).toEqual({ m, rechazada: false });
      }
    });

    it("nombreOriginal no admite rutas (L7)", () => {
      for (const malo of ["C:\\Users\\marc\\x.jpg", "/home/marc/x.jpg", "a/b.jpg", "a\\b.jpg", "D:x.jpg", "..", "a..b.jpg", "../x.jpg"]) {
        const p = proyectoBase();
        p.recursos[0].nombreOriginal = malo;
        expect({ malo, c: codigos(() => validarProyecto(p)) }).toEqual({ malo, c: expect.arrayContaining(["nombre_con_ruta"]) });
      }
      for (const bueno of ["estadio.jpg", "Foto final (2).png", "gol_1-2 ñ.webp", ""]) {
        const p = proyectoBase();
        p.recursos[0].nombreOriginal = bueno;
        expect(validarProyecto(p).recursos[0].nombreOriginal).toBe(bueno);
      }
    });

    it("entradas patológicas no cuestan tiempo cuadrático (M3)", () => {
      const grande = "http:".repeat(40_000); // 200 KB
      for (const [t, f] of [
        [grande, (x: string) => hallazgosDeRed(x, "t.html")],
        [grande, (x: string) => hallazgosDeRed(x, "t.json")],
        ["http:".repeat(8_000) + "a".repeat(100_000), (x: string) => hallazgosDeRed(x, "t.html")],
        [grande, (x: string) => recomendaciones({ gancho: x, escenas: [{ frases: [x] }] } as any)],
        [grande, (x: string) => recomendaciones({ escenas: Array.from({ length: 5000 }, () => ({ frases: [x.slice(0, 400)] })) } as any)],
      ] as [string, (x: string) => unknown][]) {
        const t0 = performance.now();
        f(t);
        expect(performance.now() - t0).toBeLessThan(2000);
      }
    });

    it("pendientes T1: http: con usuario largo, http:intranet y 200 KB lineal", () => {
      expect(hallazgosDeRed("http:" + "a".repeat(300) + "@evil.com", "t.html").length).toBe(1);
      expect(hallazgosDeRed("http:intranet", "t.html").length).toBe(1);
      const t0 = performance.now();
      hallazgosDeRed("http:".repeat(40_000), "t.html");
      expect(performance.now() - t0).toBeLessThan(2000);
    });

    it("pendientes T1: campos unidos prefijo + 0 + sufijo (M1)", () => {
      for (const base of [
        { tipo: "cifra", valor: 3, prefijo: "http:a", sufijo: ".es", decimales: 0 },
        { tipo: "cifra", valor: 3, prefijo: "http:", sufijo: ".es", decimales: 0 },
        { tipo: "barras", titulo: "T", periodos: ["a", "b"], series: [{ nombre: "x", valores: [1, 2] }, { nombre: "y", valores: [1, 2] }], prefijo: "http:", sufijo: ".es" },
      ]) {
        const g = clon(GUION_FUTBOL) as any;
        g.escenas[0].base = base;
        expect({ base, c: codigos(() => validarGuionVideo(g)) }).toEqual({ base, c: expect.arrayContaining(["url_en_texto"]) });
      }
    });

    it("pendientes T1: invisibles restantes y VS16 solo tras emoji (M2)", () => {
      for (const malo of ["a\uFE00b", "a\uFE0Eb", "a\u{E0100}b", "a\u{E01EF}b", "a\u034Fb", "a\u115Fb", "a\u1160b", "a\u3164b", "a\uFFA0b", "a\u2800b", "a\uFE0Fb", "👨\uFE0F\uFE0F", "1\uFE0F2\uFE0F", "#\uFE0Fa", "a\u180Bb", "a\u180Fb", "a\u17B4b", "a\u17B5b"]) {
        const g = clon(GUION_FUTBOL);
        g.titulo = malo;
        expect({ malo, c: codigos(() => validarGuionVideo(g)) }).toEqual({ malo, c: expect.arrayContaining(["texto_inseguro"]) });
      }
      for (const bueno of ["👨\u200D👩\u200D👧", "🏳\uFE0F\u200D🌈", "❤\uFE0F", "1\uFE0F\u20E3"]) {
        const g = clon(GUION_FUTBOL);
        g.titulo = bueno;
        expect(validarGuionVideo(g).titulo).toBe(bueno.normalize("NFC"));
      }
    });

    it("hallazgosDeRed sigue viendo los hosts largos razonables y no usa Object.prototype (M1, M3)", () => {
      expect(hallazgosDeRed("http:" + "a".repeat(60) + ".com", "t.html").length).toBe(1);
      expect(hallazgosDeRed("http:abc.com", "t.html").length).toBe(1);
      expect(hallazgosDeRed("&constructor;//h", "t.html").length).toBe(1);
    });

    it("cubre los cuatro casos de la R0-8 y todos los campos de texto", () => {
      for (const m of ["https:ejemplo.com", "http:\\\\x", "\\\\host", "HTTPS://X.COM"]) {
        const g = clon(GUION_FUTBOL) as any;
        g.escenas[0].frases = [m];
        expect(codigos(() => validarGuionVideo(g))).toContain("url_en_texto");
        const p = proyectoBase();
        p.frases[0].texto = m;
        expect(codigos(() => validarProyecto(p))).toContain("url_en_texto");
        const q = proyectoBase();
        q.recursos[0].nombreOriginal = m;
        expect(codigos(() => validarProyecto(q))).toContain("url_en_texto");
        const r = clon(GUION_FUTBOL) as any;
        r.escenas[0].base.texto = m;
        expect(codigos(() => validarGuionVideo(r))).toContain("url_en_texto");
      }
    });

    it("recomendaciones sugiere escribir el dominio sin esquema", () => {
      const g = clon(GUION_FUTBOL) as any;
      g.escenas[0].frases = ["Entra en https://ejemplo.com ya."];
      expect(recomendaciones(g).map((a) => a.codigo)).toContain("url_en_texto");
    });
  });
});

describe("recomendaciones", () => {
  it("avisa de cortes largos, gancho tardío y falta de bucle, sin bloquear", () => {
    const g = validarGuionVideo({
      ...clon(GUION_FUTBOL),
      escenas: [
        { frases: ["a".repeat(100)], base: { tipo: "cartel", texto: "x" } },
        { frases: ["Palabras sueltas."], base: { tipo: "cartel", texto: "y" } },
      ],
    });
    const c = recomendaciones(g).map((a) => a.codigo);
    expect(c).toContain("corte_largo");
    expect(c).toContain("gancho_tarde");
    expect(c).toContain("sin_bucle");
  });

  it("una pieza bien formada no da avisos de bucle ni de gancho", () => {
    const g = validarGuionVideo({
      ...clon(GUION_FUTBOL),
      gancho: "Dos goles",
      escenas: [
        { frases: ["Dos goles."], base: { tipo: "cartel", texto: "x" } },
        { frases: ["Y otra vez dos goles."], base: { tipo: "cartel", texto: "y" } },
      ],
    });
    const c = recomendaciones(g).map((a) => a.codigo);
    expect(c).not.toContain("gancho_tarde");
    expect(c).not.toContain("sin_bucle");
  });

  it("funciona con un proyecto y nunca lanza", () => {
    expect(Array.isArray(recomendaciones(validarProyecto(proyectoBase())))).toBe(true);
    for (const raro of [null, undefined, 7, {}, { escenas: 3 }, { escenas: [null, { frases: 4 }] }, { frases: [null], escenas: [{ fraseIds: [1] }] }]) {
      expect(() => recomendaciones(raro as any)).not.toThrow();
    }
  });
});

describe("descripcionEsquema", () => {
  it("nombra los límites, los tipos de escena y las listas cerradas", () => {
    const d = descripcionEsquema();
    for (const t of TIPOS_ESCENA_FASE1) expect(d).toContain(t);
    expect(d).toContain(String(LIMITES.escenas));
    expect(d).toContain("aurora");
    expect(d).toContain("espana");
    expect(d).not.toMatch(/tunel|fútbol|futbol/i);
  });
});
