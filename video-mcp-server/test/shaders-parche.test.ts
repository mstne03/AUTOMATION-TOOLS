// W2.6 (SEO-114): fija hash base, hash parcheado y ancla del glue de shaders. Sin navegador.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../src/raiz.js";
import { HASH_BASE, HASH_PARCHEADO, OE_NUEVO, OE_ORIGINAL, PARCHE_SHADERS, VENDOR } from "./shaders-comun.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const veces = (texto: string, x: string) => texto.split(x).length - 1;

describe("parche del glue de shaders (SEO-114)", () => {
  it("el vendor en disco tiene el SHA-256 parcheado", () => {
    expect(sha(fs.readFileSync(VENDOR))).toBe(HASH_PARCHEADO);
  });

  it("OE_NUEVO aparece exactamente una vez y OE_ORIGINAL ninguna", () => {
    const texto = fs.readFileSync(VENDOR, "utf8");
    expect(veces(texto, OE_NUEVO)).toBe(1);
    expect(veces(texto, OE_ORIGINAL)).toBe(0);
  });

  it("revertir shaders.iife.patch devuelve el hash upstream del lock", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, "catalogo", "hyperframes.lock.json"), "utf8")) as Record<string, string>;
    expect(HASH_BASE).toBe(lock["compositions/lib/shaders.iife.js"]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shaders-parche-"));
    try {
      const destino = path.join(tmp, "plantilla", "vendor", "shaders.iife.js");
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.copyFileSync(VENDOR, destino);
      // Como scripts/aplicar-parche.mjs: sin esto git apply, dentro de otro repo, se salta rutas en silencio.
      const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(tmp) };
      const r = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--reverse", PARCHE_SHADERS], { cwd: tmp, env, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const base = fs.readFileSync(destino);
      expect(sha(base)).toBe(HASH_BASE);
      expect(veces(base.toString("utf8"), OE_ORIGINAL)).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("el parche solo cambia una línea y no introduce red ni eval", () => {
    const lineas = fs.readFileSync(PARCHE_SHADERS, "utf8").split("\n");
    expect(lineas.filter((l) => l.startsWith("@@")).length).toBe(1);
    expect(lineas.filter((l) => l.startsWith("-") && !l.startsWith("---")).length).toBe(1);
    expect(lineas.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length).toBe(1);
    expect(OE_NUEVO).not.toMatch(/https?:|fetch\(|XMLHttpRequest|WebSocket|eval\(|new Function/);
  });

  it("__dbgShader y __hfReseekGpu no existen en plantilla/ ni src/", () => {
    const recorre = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? recorre(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const hallados = ["plantilla", "src"]
      .flatMap((d) => recorre(path.join(SERVER_ROOT, d)))
      .filter((f) => /__dbgShader|__hfReseekGpu/.test(fs.readFileSync(f, "latin1")));
    expect(hallados).toEqual([]);
  });
});
