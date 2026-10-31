// I12: ningún byte de GSAP llega al producto, ni por dependencia, ni por composición, ni por la prueba de GPU.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SERVER_ROOT } from "../src/raiz.js";
import { GUION_TODAS, GUION_TUNEL } from "../scripts/montar.mjs";
import { planDeGuion } from "./ayudas-plan.js";

vi.mock("../src/proceso.js", async (orig) => {
  const m = await orig<typeof import("../src/proceso.js")>();
  return { ...m, ejecutar: vi.fn() };
});

const leer = (f: string) => fs.readFileSync(path.join(SERVER_ROOT, f), "utf8");

describe("sin GSAP (I12)", () => {
  it("package.json y package-lock.json no lo traen", () => {
    expect(JSON.parse(leer("package.json")).dependencies).not.toHaveProperty("gsap");
    const lock = JSON.parse(leer("package-lock.json"));
    expect(lock.packages[""].dependencies).not.toHaveProperty("gsap");
    expect(lock.packages).not.toHaveProperty(["node_modules/gsap"]);
    expect(leer("package-lock.json")).not.toMatch(/gsap/i);
  });

  it.each([
    ["GUION_TODAS", GUION_TODAS],
    ["GUION_TUNEL", GUION_TUNEL],
  ])("%s: ningún fichero del plan lo nombra ni lo lleva", (_, guion) => {
    const { p } = planDeGuion(guion, 0.12);
    const FUERA = /gsap\.|gsap@|gsap\.min|__timelines/i;
    for (const [rel, contenido] of Object.entries(p.archivos)) {
      expect(rel).not.toMatch(FUERA);
      expect(contenido, rel).not.toMatch(FUERA);
    }
    for (const c of p.copias) expect(c.destino).not.toMatch(FUERA);
  });

  it("el catálogo solo conserva el lock y las dos licencias, y nada versionado carga de un CDN (I2, I12)", () => {
    const git = (...a: string[]) => execFileSync("git", ["ls-files", ...a], { cwd: SERVER_ROOT, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
    expect(git("catalogo").sort()).toEqual(["catalogo/compositions/assets/fonts/Geist-OFL.txt", "catalogo/compositions/assets/fonts/OFL.txt", "catalogo/hyperframes.lock.json"]);
    for (const f of git("plantilla", "catalogo")) {
      if (/\.woff2$/.test(f)) continue;
      expect(leer(f), f).not.toMatch(/jsdelivr|cdnjs|unpkg|gsap@/i);
    }
  });

  it("src/composicion.ts y src/capacidades.ts no lo contienen", () => {
    for (const f of ["src/composicion.ts", "src/capacidades.ts"]) expect(leer(f), f).not.toMatch(/gsap/i);
  });

  // La premisa original era que un <script src="assets/gsap…"> disparaba rewriteUnresolvableGsapToCdn; no es así, exige
  // /dist/ en la ruta (R0 C12). El riesgo real: un script a un fichero que ya no existe, o una raíz sin data-no-timeline
  // que deja de ser válida, y entonces webgpu:false sustituye el fondo en silencio.
  it("la prueba de GPU no carga GSAP y su raíz lleva data-no-timeline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sin-gsap-"));
    vi.stubEnv("VIDEO_STATE_DIR", dir);
    try {
      vi.resetModules();
      const { probarGpu } = await import("../src/capacidades.js");
      const { ejecutar } = await import("../src/proceso.js");
      let index = "";
      let assets: string[] = [];
      vi.mocked(ejecutar).mockImplementation(async (_c: string, args: string[]) => {
        const carpeta = args[args.indexOf("render") + 1];
        index = fs.readFileSync(path.join(carpeta, "index.html"), "utf8");
        assets = fs.readdirSync(path.join(carpeta, "assets"));
        return { code: 1, stdout: "", stderr: "" };
      });
      await probarGpu({ dir: "x", ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
      expect(index).toMatch(/<div id="root" data-composition-id="main" data-no-timeline/);
      expect(index).not.toMatch(/<script src="assets\/gsap|__timelines/);
      expect(assets).toEqual(["shaders.iife.js"]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
