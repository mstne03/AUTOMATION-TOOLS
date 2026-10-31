// I2 (c): el escáner de la composición ve URLs en todas sus formas, también en vendor, y no molesta con texto normal.
// Es aviso temprano: lo impone I2 (a) y (b). El límite (concatenación y escapes en JS) queda fijado abajo con un test.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { escribirPlan, NODE_MODULES, PLANTILLA_DIR, urlsDeRed, VENDOR_FIJADO } from "../src/composicion.js";
import { GUION_TODAS, GUION_TUNEL } from "../scripts/montar.mjs";
import { planDeGuion } from "./ayudas-plan.js";

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "urls-de-red-"));
afterAll(() => fs.rmSync(raiz, { recursive: true, force: true }));

let n = 0;
function escanear(rel: string, contenido: string | Buffer): string[] {
  const dir = path.join(raiz, String(n++));
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contenido);
  return urlsDeRed(dir);
}

const FILAS: [string, string][] = [
  // mayúsculas
  ["mayúsculas", '<img src="HTTP://x.test/a.png">'],
  ["mayúsculas", "<p>HtTpS://x.test</p>"],
  // entidades numéricas
  ["entidad decimal", '<img src="&#104;ttp://x.test/">'],
  ["entidad hexadecimal", '<img src="&#x68;ttp://x.test/">'],
  ["entidad sin punto y coma", '<img src="&#104ttp://x.test/">'],
  ["entidad con nombre", '<img src="https&colon;&sol;&sol;x.test">'],
  ["entidad de tabulador", '<img src="ht&Tab;tp://x.test">'],
  ["entidad de salto de línea", '<img src="ht&NewLine;tp://x.test">'],
  ["entidad numérica de tabulador", '<img src="ht&#9;tp://x.test">'],
  ["tabulador literal", '<img src="ht\ttp://x.test/">'],
  ["salto de línea literal", '<img src="ht\ntp://x.test/">'],
  ["C0 inicial", '<img src="&#1;//x.test">'],
  ["comma", '<img srcset="a.png 1x&comma;//x.test/b 2x">'],
  ["equals", "<meta content&equals;//x.test>"],
  ["semi", '<meta http-equiv="refresh" content="0&semi;//x.test/a">'],
  ["lbrack", '<img src="//&lbrack;::1]:9/">'],
  ["lsqb", '<img src="//&lsqb;::1]:9/">'],
  // //host
  ["//host en src", '<img src="//x.test/a">'],
  ["//host en url()", "<style>a{background:url(//x.test/a)}</style>"],
  ["UNC", '<img src="\\\\x.test\\a">'],
  ["UNC sin punto", '<img src="\\\\servidor\\c\\a">'],
  ["srcset", '<img srcset="a.png 1x, //x.test/b 2x">'],
  ["loopback", '<img src="//127.0.0.1:9/">'],
  ["localhost", '<img src="//localhost:9/">'],
  ["IPv6", '<img src="//[::1]:9/">'],
  ["sin punto", '<img src="//intranet/a">'],
  ["con usuario", '<img src="//user@x.test">'],
  ["con escape de URL", '<img src="//%78.test/a">'],
  ["entero", '<img src="//2130706433/a">'],
  ["internacional", '<img src="//例え.テスト/a">'],
  ["meta refresh sin url=", '<meta http-equiv="refresh" content="0;//x.test/a">'],
  ["tres barras", '<img src="///x.test/a">'],
  // esquemas
  ["ws", '<a href="ws://x.test">'],
  ["wss", '<a href="wss://x.test">'],
  ["file", '<a href="file:///C:/x">'],
  ["file sin barras", '<a href="file:C:/x">'],
  ["https sin barras", '<a href="https:x.test">'],
  ["usuario", '<a href="http://@x.test/">'],
  ["usuario sin barras", '<a href="https:@x.test">'],
  ["escape de URL", '<a href="http://%78.test/">'],
  ["ancho completo", '<a href="http://ｘ.test/">'],
  ["internacional", '<a href="http://例え.テスト/">'],
  ["guion bajo", '<a href="http://_x.test/">'],
  ["ws con escape", '<a href="ws://%78.test/">'],
  // CSS
  ["@import con comillas", '<style>@import "//x.test/a";</style>'],
  ["@import url", "<style>@import url(https://x.test/a);</style>"],
  ["escape CSS", "<style>a{background:url(\\68ttp://x.test/a)}</style>"],
  ["escape CSS de barras", "<style>a{background:url(\\2f\\2fx.test)}</style>"],
  // w3.org solo con la URL exacta
  ["w3 de otro dominio", '<a href="http://www.w3.org.evil.test/">'],
  ["w3 otra ruta", '<a href="http://www.w3.org/otra">'],
  ["w3 con sufijo", '<a href="http://www.w3.org/2000/svgx">'],
  ["w3 con ruta de más", '<a href="http://www.w3.org/2000/svg/x">'],
  // speculationrules
  ["speculationrules", '<script type="speculationrules">{}</script>'],
  ["SpeculationRules", '<script type="SpeculationRules">{}</script>'],
  ["speculationrules con entidad", "<script type=&#115;peculationrules>{}</script>"],
];

describe("urlsDeRed: lo que tiene que encontrar (I2 c)", () => {
  it.each(FILAS)("%s: %s", (_, html) => {
    const r = escanear("index.html", html);
    expect(r.length, html).toBeGreaterThan(0);
    expect(r[0].startsWith("index.html: ")).toBe(true);
  });

  it.each(["a.js", "a.mjs", "a.json", "a.svg", "a.css", "A.JS"])("mira %s", (f) => {
    expect(escanear(f, '{"u":"https://x.test/a"}')[0]).toContain(`${f}: `);
  });

  it.each(["a.js", "a.mjs", "a.json"])("//host entre comillas en %s", (f) => {
    expect(escanear(f, '{"u":"//x.test/a"}')[0]).toContain(`${f}: `);
    expect(escanear(f, "f('//x.test/a')").length).toBeGreaterThan(0);
    expect(escanear(f, "f(`//x.test/a`)").length).toBeGreaterThan(0);
  });

  it("speculationrules en un .js", () => {
    expect(escanear("a.js", 's.type = "speculationrules";')[0]).toContain("a.js: ");
  });

  it("mira dentro de vendor y de carpetas con punto", () => {
    expect(escanear("assets/vendor/x.js", 'fetch("https://x.test")')[0]).toContain("assets/vendor/x.js: ");
    expect(escanear(".oculta/a.html", '<img src="https://x.test">')[0]).toContain(".oculta/a.html: ");
  });

  it("un punto de código no válido no tumba el escáner", () => {
    expect(escanear("a.html", "<p>&#x110000;&#xD800;&#0;&#99999999999999999999;</p>")).toEqual([]);
  });
});

describe("urlsDeRed: lo que no tiene que molestar", () => {
  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    '<html xmlns="HTTP://WWW.W3.ORG/1999/xhtml">',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"></svg>',
    "<p>The file: report</p>",
    "<p>y/o</p>",
    "<p>w//x.y</p>",
    "<p>nombre@dominio.test</p>",
    "<p>http:2 y ws:2</p>",
    "<p>profile:/x</p>",
    "<p>news:foo</p>",
    "<p>&amp;#104;ttp://x</p>",
  ])("%s", (html) => {
    expect(escanear("index.html", html)).toEqual([]);
  });

  it.each(["// comentario.js", "//comentario.js", "a = 1; //x.y", 'var s = "//";', "b = a\n//x.y"])("en un .js: %s", (js) => {
    expect(escanear("a.js", js)).toEqual([]);
  });

  // ponytail de urlsDeRed: aviso temprano, no barrera. Si esto empieza a detectarse, se actualiza el límite.
  it.each(['fetch("ht" + "tp://x.test/")', 'fetch("\\x68ttp://x.test/")', 'fetch("\\u0068ttp://x.test/")'])("límite fijado: no se detecta en JS %s", (js) => {
    expect(escanear("a.js", js)).toEqual([]);
  });
});

describe("VENDOR_FIJADO", () => {
  const ORIGENES: Record<string, string> = {
    "assets/vendor/shaders.iife.js": path.join(PLANTILLA_DIR, "vendor", "shaders.iife.js"),
    "assets/vendor/three184/three.module.js": path.join(NODE_MODULES, "three", "build", "three.module.js"),
    "assets/vendor/three184/three.core.js": path.join(NODE_MODULES, "three", "build", "three.core.js"),
    "assets/vendor/three184/addons/loaders/FontLoader.js": path.join(NODE_MODULES, "three", "examples", "jsm", "loaders", "FontLoader.js"),
    "assets/vendor/three184/addons/geometries/TextGeometry.js": path.join(NODE_MODULES, "three", "examples", "jsm", "geometries", "TextGeometry.js"),
    "assets/vendor/three147.min.js": path.join(NODE_MODULES, "three147", "build", "three.min.js"),
    "assets/gsap.min.js": path.join(NODE_MODULES, "gsap", "dist", "gsap.min.js"),
    "assets/fonts/Geist-Bold.typeface.json": path.join(PLANTILLA_DIR, "fuentes", "3d", "Geist-Bold.typeface.json"),
  };

  it("coincide con el SHA-256 de cada origen copiado", () => {
    const real = Object.fromEntries(Object.entries(ORIGENES).map(([rel, o]) => [rel, crypto.createHash("sha256").update(fs.readFileSync(o)).digest("hex")]));
    expect(VENDOR_FIJADO).toEqual(real);
  });

  it("sin alterar se salta; con un byte cambiado se escanea entero", () => {
    const rel = "assets/vendor/three184/three.core.js";
    const original = fs.readFileSync(ORIGENES[rel]);
    expect(escanear(rel, original)).toEqual([]);
    const alterado = Buffer.concat([original, Buffer.from(" ")]);
    expect(escanear(rel, alterado).length).toBeGreaterThan(0);
  });

  it("three.module.js con un byte cambiado en la ruta fijada no se salta", () => {
    const rel = "assets/vendor/three184/three.module.js";
    const alterado = fs.readFileSync(ORIGENES[rel]);
    alterado[alterado.length - 1] ^= 1;
    fs.mkdirSync(path.join(raiz, "fijado", path.dirname(rel)), { recursive: true });
    const conUrl = Buffer.concat([alterado, Buffer.from('\nfetch("https://x.test/");\n')]);
    expect(escanear(rel, conUrl).some((h) => h.includes("https://x.test/"))).toBe(true);
  });
});

describe("falso positivo real", () => {
  it.each([
    ["GUION_TODAS", GUION_TODAS],
    ["GUION_TUNEL", GUION_TUNEL],
  ])("%s: urlsDeRed da [] sobre la composición escrita", (_, guion) => {
    const { p } = planDeGuion(guion, 0.12);
    const jpg = path.join(raiz, "foto.jpg");
    fs.writeFileSync(jpg, "");
    const dir = path.join(raiz, String(n++));
    // Las fotos del plan son rutas ficticias; las copias reales son las del motor.
    escribirPlan(dir, { ...p, copias: p.copias.map((c) => (c.origen.startsWith("C:\\x\\") ? { ...c, origen: jpg } : c)) });
    expect(urlsDeRed(dir)).toEqual([]);
  });
});
