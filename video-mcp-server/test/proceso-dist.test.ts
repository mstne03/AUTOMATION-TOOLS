// R2-M3: antes de cada CLI, el dist parcheado de HyperFrames tiene que cuadrar con los SHA-256 fijados. Detecta
// bundle sin parche, instalación rota y versión cambiada; es integridad, no autenticidad: el JSON vive junto al dist.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video dist "));
  const testigo = nodePath.join(dir, "testigo.txt");
  const cli = nodePath.join(dir, "hyperframes-falso.mjs");
  nodeFs.writeFileSync(cli, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(testigo)}, "lanzada");`);
  const navegador = nodePath.join(dir, "chrome-headless-shell.exe");
  nodeFs.writeFileSync(navegador, "exe");
  process.env.VIDEO_HYPERFRAMES_BIN = cli;
  process.env.VIDEO_STATE_DIR = nodePath.join(dir, "estado");
  process.env.HYPERFRAMES_BROWSER_PATH = navegador;
  delete process.env.VIDEO_NAVEGADOR_MANIFIESTO;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  return { dir, raiz: nodePath.join(dir, "motor"), testigo, cli, navegador };
});

vi.mock("../src/raiz.js", () => ({ SERVER_ROOT: F.raiz }));

import { ejecutar, ErrorNavegador, verificarDist } from "../src/proceso.js";
import { disparaReserva } from "../src/render.js";

const REAL = path.resolve(import.meta.dirname, "..");
const JSON_REL = path.join("patches", "hyperframes+0.8.206.sha256.json");
const HF_REL = path.join("node_modules", "hyperframes");
const fijados = JSON.parse(fs.readFileSync(path.join(REAL, JSON_REL), "utf8")) as { version: string; ficheros: Record<string, string>; sinParche: Record<string, string> };
const hf = (rel: string) => path.join(F.raiz, HF_REL, ...rel.split("/"));
const jsonCopia = path.join(F.raiz, JSON_REL);
const reescribir = (cambio: (j: Record<string, unknown>) => void) => {
  const j = JSON.parse(JSON.stringify(fijados)) as Record<string, unknown>;
  cambio(j);
  fs.writeFileSync(jsonCopia, JSON.stringify(j));
};

beforeEach(() => {
  fs.rmSync(F.raiz, { recursive: true, force: true });
  fs.rmSync(F.testigo, { force: true });
  for (const rel of [...Object.keys(fijados.ficheros), ...Object.keys(fijados.sinParche), "package.json"]) {
    fs.mkdirSync(path.dirname(hf(rel)), { recursive: true });
    fs.copyFileSync(path.join(REAL, HF_REL, ...rel.split("/")), hf(rel));
  }
  fs.mkdirSync(path.dirname(jsonCopia), { recursive: true });
  fs.copyFileSync(path.join(REAL, JSON_REL), jsonCopia);
});
afterAll(() => {
  fs.rmSync(F.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

const FALLO = /La instalación del motor de vídeo está incompleta \(.+\): reinstala SEO Studio\./;

describe("verificarDist", () => {
  it("fija 13 ficheros parcheados y bin/hyperframes.mjs", () => {
    expect(Object.keys(fijados.ficheros)).toHaveLength(13);
    expect(Object.keys(fijados.sinParche)).toEqual(["bin/hyperframes.mjs"]);
  });

  it("control: pasa con la copia íntegra y la CLI se lanza", async () => {
    await expect(verificarDist()).resolves.toBeUndefined();
    const r = await ejecutar(process.execPath, [F.cli, "check", F.dir]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(F.testigo)).toBe(true);
  });

  it("un byte cambiado en un chunk parcheado: error que nombra el fichero", async () => {
    fs.appendFileSync(hf("dist/chunk-K4MJX7SR.js"), "x");
    await expect(verificarDist()).rejects.toThrow(/dist\/chunk-K4MJX7SR\.js no coincide/);
    await expect(verificarDist()).rejects.toThrow(FALLO);
  });

  it("un byte cambiado en bin/hyperframes.mjs: error", async () => {
    fs.appendFileSync(hf("bin/hyperframes.mjs"), "x");
    await expect(verificarDist()).rejects.toThrow(/bin\/hyperframes\.mjs no coincide/);
  });

  it("falta seo-studio-cierre.js: error", async () => {
    fs.rmSync(hf("dist/seo-studio-cierre.js"));
    await expect(verificarDist()).rejects.toThrow(/falta dist\/seo-studio-cierre\.js/);
  });

  it("falta el JSON: error", async () => {
    fs.rmSync(jsonCopia);
    await expect(verificarDist()).rejects.toThrow(FALLO);
  });

  it("JSON ilegible: error", async () => {
    fs.writeFileSync(jsonCopia, "{");
    await expect(verificarDist()).rejects.toThrow(FALLO);
  });

  it("version distinta de la del package.json del paquete: error", async () => {
    reescribir((j) => (j.version = "0.8.207"));
    await expect(verificarDist()).rejects.toThrow(/0\.8\.207/);
    fs.writeFileSync(hf("package.json"), JSON.stringify({ version: "0.9.0" }));
    fs.copyFileSync(path.join(REAL, JSON_REL), jsonCopia);
    await expect(verificarDist()).rejects.toThrow(/0\.9\.0/);
  });

  // R0 M1: un JSON vacío no puede pasar.
  it.each<[string, (j: Record<string, unknown>) => void, RegExp]>([
    ["ficheros vacío", (j) => (j.ficheros = {}), /no lista ficheros/],
    ["sin ficheros", (j) => delete j.ficheros, /no lista ficheros/],
    ["sinParche vacío", (j) => (j.sinParche = {}), /no lista ficheros/],
    ["sin sinParche", (j) => delete j.sinParche, /no lista ficheros/],
    ["ficheros como lista", (j) => (j.ficheros = ["dist/cli.js"]), /no lista ficheros/],
    ["hash malo", (j) => ((j.ficheros as Record<string, string>)["dist/cli.js"] = "abc"), /hash no válido para dist\/cli\.js/],
    ["hash en mayúsculas", (j) => ((j.ficheros as Record<string, string>)["dist/cli.js"] = "A".repeat(64)), /hash no válido/],
    ["ruta con ..", (j) => ((j.ficheros as Record<string, string>)["../x.js"] = "0".repeat(64)), /ruta no válida/],
    ["ruta con \\", (j) => ((j.ficheros as Record<string, string>)["dist\\x.js"] = "0".repeat(64)), /ruta no válida/],
    ["ruta con :", (j) => ((j.ficheros as Record<string, string>)["C:/x.js"] = "0".repeat(64)), /ruta no válida/],
    ["ruta absoluta", (j) => ((j.ficheros as Record<string, string>)["/x.js"] = "0".repeat(64)), /ruta no válida/],
    ["sin cli.js", (j) => delete (j.ficheros as Record<string, string>)["dist/cli.js"], /no fija dist\/cli\.js/],
    ["sin el cierre", (j) => delete (j.ficheros as Record<string, string>)["dist/seo-studio-cierre.js"], /no fija dist\/seo-studio-cierre\.js/],
    ["sin el marcador", (j) => delete (j.ficheros as Record<string, string>)["dist/chunk-K4MJX7SR.js"], /no fija dist\/chunk-K4MJX7SR\.js/],
    ["sin el bin", (j) => ((j.sinParche as Record<string, string>) = { "dist/warmCheck.js": (j.ficheros as Record<string, string>)["dist/warmCheck.js"] }), /no fija bin\/hyperframes\.mjs/],
  ])("JSON con %s: error", async (_n, cambio, re) => {
    reescribir(cambio);
    await expect(verificarDist()).rejects.toThrow(re);
    await expect(verificarDist()).rejects.toThrow(FALLO);
  });
});

describe("ejecutar comprueba el dist antes de cada CLI", () => {
  it("con dist malo rechaza sin lanzar nada", async () => {
    fs.appendFileSync(hf("dist/cli.js"), "x");
    await expect(ejecutar(process.execPath, [F.cli, "check", F.dir])).rejects.toBeInstanceOf(ErrorNavegador);
    expect(fs.existsSync(F.testigo)).toBe(false);
  });

  it("con dist malo y sin navegador, sale el error del dist: es lo primero", async () => {
    fs.appendFileSync(hf("dist/cli.js"), "x");
    vi.stubEnv("HYPERFRAMES_BROWSER_PATH", "");
    try {
      await expect(ejecutar(process.execPath, [F.cli, "check", F.dir])).rejects.toThrow(FALLO);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("disparaReserva devuelve false para ese error", async () => {
    fs.appendFileSync(hf("dist/cli.js"), "x");
    const e = await verificarDist().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorNavegador);
    expect(disparaReserva(e)).toBe(false);
  });

  it("ffmpeg no pasa por esta comprobación: no es la CLI", async () => {
    fs.appendFileSync(hf("dist/cli.js"), "x");
    const r = await ejecutar(path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "cmd.exe"), ["/c", "exit", "0"]);
    expect(r.code).toBe(0);
  });
});
