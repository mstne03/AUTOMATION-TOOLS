// I1: el tema se valida entero al cargar. Un valor malo se rechaza con su clave y sin repetir el valor; un campo
// opcional ausente usa el valor por defecto.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cargarTema, escribirPlan, PLANTILLA_DIR, validarTema, type Tema } from "../src/composicion.js";
import { plan } from "./ayudas-plan.js";

type Suelto = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clonar = (t: unknown): Suelto => JSON.parse(JSON.stringify(t));
const base = (): Suelto => clonar(JSON.parse(fs.readFileSync(path.join(PLANTILLA_DIR, "tema.json"), "utf8")));

describe("validarTema (I1)", () => {
  it("plantilla/tema.json pasa, y cargarTema valida", () => {
    expect(validarTema(base())).toEqual(cargarTema());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tema-"));
    try {
      fs.writeFileSync(path.join(dir, "tema.json"), JSON.stringify({ ...base(), extra: 1 }));
      expect(() => cargarTema(dir)).toThrow(/Tema no válido/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rechaza un color malo al cargar", () => {
    const t = base();
    t.colores.acento = "red;background:url(//x)";
    expect(() => validarTema(t)).toThrow(/colores\.acento/);
  });

  it("el mensaje lleva la clave, nunca el valor", () => {
    const t = base();
    t.colores.acento = "SECRETO";
    expect(() => validarTema(t)).toThrow(expect.objectContaining({ message: expect.not.stringContaining("SECRETO") }));
  });

  it.each(["#12345", "#1234567", "#ggg", "#fff\n", "red", "", 0])("rechaza el color %j", (c) => {
    const t = base();
    t.colores.fondo = c;
    expect(() => validarTema(t)).toThrow(/colores\.fondo/);
  });

  it.each(["#abc", "#abcd", "#AABBCC", "#aabbccdd"])("acepta el color %s", (c) => {
    const t = base();
    t.colores.fondo = c;
    expect(validarTema(t).colores.fondo).toBe(c);
  });

  const MALOS: [string, (t: Suelto) => void, RegExp][] = [
    ["familia desconocida", (t) => (t.fuentes.titulos.familia = "Comic Sans"), /fuentes\.titulos/],
    ["archivo con ruta", (t) => (t.fuentes.titulos.archivo = "../x.woff2"), /fuentes\.titulos/],
    ["archivo de otra familia", (t) => (t.fuentes.titulos.archivo = "inter-tight-latin-800-normal.woff2"), /fuentes\.titulos/],
    ["peso 0", (t) => (t.fuentes.subtitulos.peso = 0), /fuentes\.subtitulos/],
    ["peso de otra cara", (t) => (t.fuentes.subtitulos.peso = 400), /fuentes\.subtitulos/],
    ["falta subtitulos", (t) => delete t.fuentes.subtitulos, /fuentes\.subtitulos/],
    ["clave desconocida en fuentes.mono", (t) => (t.fuentes.mono.x = 1), /fuentes\.mono/],
    ["paleta con un color no válido", (t) => (t.paletaTunel = ["#fff", "red"]), /paletaTunel\.1/],
    ["paleta vacía", (t) => (t.paletaTunel = []), /paletaTunel/],
    ["paleta enorme", (t) => (t.paletaTunel = Array(65).fill("#fff")), /paletaTunel/],
    ["tamaño NaN", (t) => (t.tamanos.gancho = NaN), /tamanos\.gancho/],
    ["tamaño 1e308 (colgaría tamanoGancho)", (t) => (t.tamanos.gancho = 1e308), /tamanos\.gancho/],
    ["tamaño no entero", (t) => (t.tamanos.subtitulo = 80.5), /tamanos\.subtitulo/],
    ["tamaño pequeño", (t) => (t.tamanos.subtituloMinimo = 7), /tamanos\.subtituloMinimo/],
    ["mínimo por encima de la base", (t) => (t.tamanos.ganchoMinimo = 200), /tamanos\.ganchoMinimo/],
    ["mínimo de subtítulo por encima", (t) => (t.tamanos.subtituloMinimo = 100), /tamanos\.subtituloMinimo/],
    ["opacidad fuera de rango", (t) => (t.degradado.opacidad = 1.5), /degradado\.opacidad/],
    ["mayusculas no booleano", (t) => (t.subtitulos.mayusculas = "si"), /subtitulos\.mayusculas/],
    ["clave desconocida en colores", (t) => (t.colores.otro = "#fff"), /colores/],
    ["clave desconocida en la raíz", (t) => (t.otra = 1), /Tema no válido/],
    ["clave desconocida en tamanos", (t) => (t.tamanos.otro = 1), /tamanos/],
    ["clave desconocida en subtitulos", (t) => (t.subtitulos.otro = 1), /subtitulos/],
    ["clave desconocida en degradado", (t) => (t.degradado.otro = 1), /degradado/],
    ["__proto__ en colores", (t) => Object.defineProperty(t.colores, "__proto__", { value: 1, enumerable: true }), /colores/],
  ];
  it.each(MALOS)("rechaza %s", (_, tocar, re) => {
    const t = base();
    tocar(t);
    expect(() => validarTema(t)).toThrow(re);
  });

  it("no acepta algo que no sea un objeto", () => {
    expect(() => validarTema(null)).toThrow(/Tema no válido/);
    expect(() => validarTema("x")).toThrow(/Tema no válido/);
  });

  it("sin contorno, secundario ni paletaTunel pasa y el plan usa los valores por defecto", () => {
    const t = base();
    delete t.colores.contorno;
    delete t.colores.secundario;
    delete t.paletaTunel;
    const tema = validarTema(t);
    const conTema = planPara(tema, "escenas:\n  6:\n    tipo: tunel");
    expect(conTema.archivos["index.html"]).toContain("--contorno: #000000;");
    expect(conTema.archivos["compositions/bloque6.html"]).toContain(`${tema.colores.acento},#1F7A3A,${tema.colores.texto}`);
  });

  it("un plan con tema malo lanza antes de escribir nada", () => {
    const t = base();
    t.colores.acento = "url(//x)";
    const dir = path.join(os.tmpdir(), `tema-sin-escribir-${process.pid}`);
    expect(() => {
      const p = planPara(t as Tema);
      escribirPlan(dir, p);
    }).toThrow(/colores\.acento/);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

const planPara = (tema: Tema, fm = "") => plan(fm, 0.06, undefined, undefined, undefined, tema).p;
