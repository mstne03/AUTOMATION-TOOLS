// I4 (parte motor): antes de cada invocación de la CLI, el árbol del navegador tiene que ser exactamente
// el del manifiesto (mismos ficheros, mismos SHA-256), sin enlaces y en su ruta fija.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const base = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video manifiesto ")));
  const script = nodePath.join(base, "hyperframes-falso.mjs");
  const registro = nodePath.join(base, "llamadas.jsonl");
  nodeFs.writeFileSync(script, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(registro)}, "x\\n");`);
  process.env.VIDEO_HYPERFRAMES_BIN = script;
  process.env.VIDEO_STATE_DIR = nodePath.join(base, "video", "estado");
  return { base, script, registro };
});

import { ejecutar, ErrorNavegador, verificarNavegador } from "../src/proceso.js";

const VERSION = "156.0.8078.73";
const NAVEGADORES = path.join(F.base, "video", "navegador");
const RAIZ = path.join(NAVEGADORES, VERSION);
const EXE_REL = "chrome-headless-shell-win64/chrome-headless-shell.exe";
const EXE = path.join(RAIZ, ...EXE_REL.split("/"));
const MANIFIESTO = path.join(RAIZ, "MANIFIESTO-SHA256.json");
const sha = (b: string | Buffer) => crypto.createHash("sha256").update(b).digest("hex");

const FICHEROS: Record<string, string> = {
  [EXE_REL]: "exe",
  "chrome-headless-shell-win64/a.dll": "dll",
  "chrome-headless-shell-win64/resources.pak": "pak",
  "chrome-headless-shell-win64/locales/es.pak": "es",
  "chrome-headless-shell-win64/datos.json": "{}",
};

function escribirManifiesto(m: unknown, ruta = MANIFIESTO): void {
  fs.writeFileSync(ruta, JSON.stringify(m));
}

function crear(raiz = RAIZ, version = VERSION): Record<string, string> {
  fs.rmSync(NAVEGADORES, { recursive: true, force: true });
  const ficheros: Record<string, string> = {};
  for (const [rel, contenido] of Object.entries(FICHEROS)) {
    const p = path.join(raiz, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contenido);
    ficheros[rel] = sha(contenido);
  }
  escribirManifiesto({ version, ficheros }, path.join(raiz, "MANIFIESTO-SHA256.json"));
  return ficheros;
}

const integrado = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  VIDEO_ENGINE_EMBEDDED: "1",
  HYPERFRAMES_BROWSER_PATH: EXE,
  VIDEO_NAVEGADOR_MANIFIESTO: MANIFIESTO,
  ...extra,
});

const NO_SUPERA = /no supera la comprobación[\s\S]*vuelve a descargarlo en Ajustes/;

beforeEach(() => {
  crear();
});
afterAll(() => {
  try {
    fs.rmSync(F.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* temporal del SO */
  }
});

describe("verificarNavegador", () => {
  it("manifiesto correcto: pasa", async () => {
    await expect(verificarNavegador(integrado())).resolves.toBeUndefined();
  });

  it("exe con un byte cambiado: rechazado y la CLI no se lanza", async () => {
    fs.writeFileSync(EXE, "exE");
    await expect(verificarNavegador(integrado())).rejects.toThrow(/no coincide/);
    const antes = { ...process.env };
    Object.assign(process.env, integrado());
    try {
      fs.rmSync(F.registro, { force: true });
      await expect(ejecutar(process.execPath, [F.script, "render", F.base])).rejects.toBeInstanceOf(ErrorNavegador);
      expect(fs.existsSync(F.registro)).toBe(false);
    } finally {
      for (const k of ["VIDEO_ENGINE_EMBEDDED", "HYPERFRAMES_BROWSER_PATH", "VIDEO_NAVEGADOR_MANIFIESTO"]) {
        if (antes[k] === undefined) delete process.env[k];
        else process.env[k] = antes[k];
      }
    }
  });

  it("una .dll añadida: rechazada", async () => {
    fs.writeFileSync(path.join(RAIZ, "chrome-headless-shell-win64", "extra.dll"), "x");
    await expect(verificarNavegador(integrado())).rejects.toThrow(/extra\.dll no está en el manifiesto/);
  });

  it("una .DLL añadida en mayúsculas: rechazada", async () => {
    fs.writeFileSync(path.join(RAIZ, "chrome-headless-shell-win64", "EXTRA.DLL"), "x");
    await expect(verificarNavegador(integrado())).rejects.toThrow(/no está en el manifiesto/);
  });

  it("un .exe o un .json añadidos: rechazados", async () => {
    fs.writeFileSync(path.join(RAIZ, "otro.exe"), "x");
    await expect(verificarNavegador(integrado())).rejects.toThrow(/otro\.exe no está en el manifiesto/);
    fs.rmSync(path.join(RAIZ, "otro.exe"));
    fs.writeFileSync(path.join(RAIZ, "chrome-headless-shell-win64", "locales", "x.json"), "{}");
    await expect(verificarNavegador(integrado())).rejects.toThrow(/x\.json no está en el manifiesto/);
  });

  it("un .pak o un .json modificados: rechazados", async () => {
    fs.writeFileSync(path.join(RAIZ, "chrome-headless-shell-win64", "resources.pak"), "PAK");
    await expect(verificarNavegador(integrado())).rejects.toThrow(/resources\.pak no coincide/);
    crear();
    fs.writeFileSync(path.join(RAIZ, "chrome-headless-shell-win64", "datos.json"), '{"a":1}');
    await expect(verificarNavegador(integrado())).rejects.toThrow(/datos\.json no coincide/);
  });

  it("el debug.log que Chrome escribe junto a su exe se tolera; en otra carpeta, no", async () => {
    fs.writeFileSync(path.join(RAIZ, "chrome-headless-shell-win64", "debug.log"), "[1029/221208.123:ERROR] x");
    await expect(verificarNavegador(integrado())).resolves.toBeUndefined();
    fs.writeFileSync(path.join(RAIZ, "chrome-headless-shell-win64", "locales", "debug.log"), "x");
    await expect(verificarNavegador(integrado())).rejects.toThrow(/debug\.log no está en el manifiesto/);
  });

  it("una .dll listada y borrada: rechazada", async () => {
    fs.rmSync(path.join(RAIZ, "chrome-headless-shell-win64", "a.dll"));
    await expect(verificarNavegador(integrado())).rejects.toThrow(/falta/);
  });

  it("integrado sin manifiesto o sin navegador: error legible", async () => {
    await expect(verificarNavegador(integrado({ VIDEO_NAVEGADOR_MANIFIESTO: "" }))).rejects.toThrow(/descárgalo en Ajustes/);
    await expect(verificarNavegador(integrado({ HYPERFRAMES_BROWSER_PATH: "" }))).rejects.toThrow(/descárgalo en Ajustes/);
  });

  it("exe no listado o fuera de la carpeta de la versión: rechazado", async () => {
    const otro = path.join(RAIZ, "chrome-headless-shell-win64", "otro.exe");
    fs.copyFileSync(EXE, otro);
    const ficheros = { ...crearManifiestoDe(), "chrome-headless-shell-win64/otro.exe": sha("exe") };
    escribirManifiesto({ version: VERSION, ficheros });
    await expect(verificarNavegador(integrado({ HYPERFRAMES_BROWSER_PATH: otro }))).rejects.toThrow(NO_SUPERA);
    const fuera = path.join(F.base, "chrome-headless-shell.exe");
    fs.writeFileSync(fuera, "exe");
    await expect(verificarNavegador(integrado({ HYPERFRAMES_BROWSER_PATH: fuera }))).rejects.toThrow(NO_SUPERA);
  });

  it.each([
    ["../x.dll", sha("x")],
    ["C:/x.dll", sha("x")],
    ["/x.dll", sha("x")],
    ["a\\x.dll", sha("x")],
    ["chrome-headless-shell-win64/a.dll", "no-es-hex"],
  ])("manifiesto con la entrada %s → %s: rechazado", async (clave, valor) => {
    escribirManifiesto({ version: VERSION, ficheros: { ...crearManifiestoDe(), [clave]: valor } });
    await expect(verificarNavegador(integrado())).rejects.toThrow(NO_SUPERA);
  });

  it("manifiesto con dos claves que solo difieren en mayúsculas: rechazado", async () => {
    escribirManifiesto({ version: VERSION, ficheros: { ...crearManifiestoDe(), "chrome-headless-shell-win64/A.dll": sha("dll") } });
    await expect(verificarNavegador(integrado())).rejects.toThrow(NO_SUPERA);
  });

  it("manifiesto que no es JSON o sin ficheros: rechazado", async () => {
    fs.writeFileSync(MANIFIESTO, "{");
    await expect(verificarNavegador(integrado())).rejects.toThrow(NO_SUPERA);
    escribirManifiesto({ version: VERSION, ficheros: {} });
    await expect(verificarNavegador(integrado())).rejects.toThrow(NO_SUPERA);
  });

  it.runIf(process.platform === "win32")("una unión (junction) dentro de la carpeta del navegador: rechazada", async () => {
    const destino = path.join(F.base, "destino");
    fs.mkdirSync(destino, { recursive: true });
    fs.symlinkSync(destino, path.join(RAIZ, "chrome-headless-shell-win64", "enlace"), "junction");
    await expect(verificarNavegador(integrado())).rejects.toThrow(/enlace/);
  });

  it.runIf(process.platform === "win32")("la carpeta de la versión alcanzada por una unión: rechazada", async () => {
    const alias = path.join(F.base, "video", "navegador-alias");
    fs.rmSync(alias, { recursive: true, force: true });
    fs.symlinkSync(NAVEGADORES, alias, "junction");
    const env = integrado({
      HYPERFRAMES_BROWSER_PATH: path.join(alias, VERSION, ...EXE_REL.split("/")),
      VIDEO_NAVEGADOR_MANIFIESTO: path.join(alias, VERSION, "MANIFIESTO-SHA256.json"),
    });
    await expect(verificarNavegador(env)).rejects.toThrow(NO_SUPERA);
  });

  it("integrado: la carpeta de la versión tiene que estar en <estado>/video/navegador", async () => {
    const otraRaiz = path.join(F.base, "otro-sitio", VERSION);
    crear(otraRaiz);
    const env = integrado({
      HYPERFRAMES_BROWSER_PATH: path.join(otraRaiz, ...EXE_REL.split("/")),
      VIDEO_NAVEGADOR_MANIFIESTO: path.join(otraRaiz, "MANIFIESTO-SHA256.json"),
    });
    await expect(verificarNavegador(env)).rejects.toThrow(NO_SUPERA);
    // En desarrollo no se exige esa ruta (el resto de reglas sí).
    await expect(verificarNavegador({ ...env, VIDEO_ENGINE_EMBEDDED: "" })).resolves.toBeUndefined();
    fs.rmSync(path.join(F.base, "otro-sitio"), { recursive: true, force: true });
  });

  it("la carpeta de la versión se llama como la versión del manifiesto", async () => {
    escribirManifiesto({ version: "155.0.0.0", ficheros: crearManifiestoDe() });
    await expect(verificarNavegador(integrado())).rejects.toThrow(NO_SUPERA);
  });

  it("el exe está exactamente en chrome-headless-shell-win64/chrome-headless-shell.exe", async () => {
    const otro = path.join(RAIZ, "chrome-headless-shell-win64", "locales", "chrome-headless-shell.exe");
    fs.copyFileSync(EXE, otro);
    escribirManifiesto({ version: VERSION, ficheros: { ...crearManifiestoDe(), "chrome-headless-shell-win64/locales/chrome-headless-shell.exe": sha("exe") } });
    await expect(verificarNavegador(integrado({ HYPERFRAMES_BROWSER_PATH: otro }))).rejects.toThrow(NO_SUPERA);
  });

  it("desarrollo sin manifiesto: basta con que el navegador exista", async () => {
    await expect(verificarNavegador({ HYPERFRAMES_BROWSER_PATH: EXE })).resolves.toBeUndefined();
    await expect(verificarNavegador({ HYPERFRAMES_BROWSER_PATH: path.join(F.base, "no.exe") })).rejects.toThrow(/descárgalo en Ajustes/);
  });
});

function crearManifiestoDe(): Record<string, string> {
  return Object.fromEntries(Object.entries(FICHEROS).map(([k, v]) => [k, sha(v)]));
}
