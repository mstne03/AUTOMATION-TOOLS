// Criterio G1: el motor no nombra ninguna temática ni la marca original, y funciona embebido.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cargarConfig, cargarDotenv } from "../src/config.js";

const RAIZ = path.resolve(import.meta.dirname, "..");

function listar(dir: string, ext: string): string[] {
  const base = path.join(RAIZ, dir);
  const salida: string[] = [];
  const recorrer = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "vendor" || e.name === "fuentes") continue; // código y fuentes de terceros
        recorrer(p);
      } else if (e.name.endsWith(ext)) salida.push(path.relative(RAIZ, p));
    }
  };
  recorrer(base);
  return salida;
}

function lineas(f: string): { n: number; texto: string }[] {
  return fs.readFileSync(path.join(RAIZ, f), "utf8").split(/\r?\n/).map((texto, i) => ({ n: i + 1, texto }));
}

const PROHIBIDO = /\b(f[uú]tbol\w*|footy\w*|jugador\w*|futbolista\w*|gol(es)?)\b/i;

describe("motor genérico (G1)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("la expresión de la guarda no confunde «golpe» (opción legítima de escena)", () => {
    expect(PROHIBIDO.test("golpe: kicks")).toBe(false);
    expect(PROHIBIDO.test("un gol de falta")).toBe(true);
    expect(PROHIBIDO.test("FOOTY_ROOT")).toBe(true);
  });

  it("nada del núcleo nombra una temática ni la marca footy", () => {
    const ficheros = [...listar("src", ".ts"), ...listar("plantilla", ".html"), ...listar("plantilla", ".json")];
    expect(ficheros.length).toBeGreaterThan(10);
    const hallazgos = ficheros.flatMap((f) => lineas(f).filter((l) => PROHIBIDO.test(l.texto)).map((l) => `${f}:${l.n}`));
    expect(hallazgos).toEqual([]);
  });

  it("con VIDEO_ENGINE_EMBEDDED=1 no lee .env; sin ella, sí", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video dotenv "));
    try {
      fs.writeFileSync(path.join(dir, ".env"), "ELEVENLABS_VOICE_ID=desde-env\n");
      const embebido: NodeJS.ProcessEnv = { VIDEO_ENGINE_EMBEDDED: "1" };
      cargarDotenv(embebido, dir);
      expect(cargarConfig(embebido).elevenVoiceId).toBeUndefined();
      const suelto: NodeJS.ProcessEnv = {};
      cargarDotenv(suelto, dir);
      expect(cargarConfig(suelto).elevenVoiceId).toBe("desde-env");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cargarConfig lee VIDEO_ROOT y tiene una raíz por defecto en Vídeos", () => {
    expect(cargarConfig({ VIDEO_ROOT: path.join(os.tmpdir(), "x") }).videoRoot).toBe(path.join(os.tmpdir(), "x"));
    expect(cargarConfig({}).videoRoot).toBe(path.join(os.homedir(), "Videos", "SEO Studio"));
  });

  it("logs y cachés van a VIDEO_STATE_DIR", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video estado "));
    try {
      vi.stubEnv("VIDEO_STATE_DIR", dir);
      const { STATE_DIR } = await import("../src/estado.js");
      expect(STATE_DIR).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sin VIDEO_STATE_DIR el estado cae en SERVER_ROOT/logs", async () => {
    vi.stubEnv("VIDEO_STATE_DIR", "");
    const { STATE_DIR } = await import("../src/estado.js");
    expect(STATE_DIR).toBe(path.join(RAIZ, "logs"));
  });

  it("estado en ruta con acentos", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "video acentos "));
    const dir = path.join(base, "José Pérez", "estado");
    try {
      vi.stubEnv("VIDEO_STATE_DIR", dir);
      const { log } = await import("../src/log.js");
      log.info("hola desde una ruta con acentos");
      expect(fs.readFileSync(path.join(dir, "video.log"), "utf8")).toContain("hola desde una ruta con acentos");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("video.log rota a video.log.1 pasados 5 MB y oculta la clave de ElevenLabs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video log "));
    try {
      vi.stubEnv("VIDEO_STATE_DIR", dir);
      vi.stubEnv("ELEVENLABS_API_KEY", "sk-clave-que-no-debe-salir");
      const fichero = path.join(dir, "video.log");
      fs.writeFileSync(path.join(dir, "video.log.1"), "copia anterior");
      fs.writeFileSync(fichero, "x".repeat(5 * 1024 * 1024 + 1));
      const { log } = await import("../src/log.js");
      log.warn("fallo con sk-clave-que-no-debe-salir dentro");
      expect(fs.statSync(path.join(dir, "video.log.1")).size).toBe(5 * 1024 * 1024 + 1); // la anterior se pisa
      const nuevo = fs.readFileSync(fichero, "utf8");
      expect(nuevo).toMatch(/^\S+ \[warn\] fallo con \*\*\* dentro\n$/);
      log.info("otra");
      expect(fs.existsSync(fichero) && fs.readFileSync(fichero, "utf8").split("\n").length).toBe(3); // no rota por debajo
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("integrado solo usa el ffmpeg de FFMPEG_DIR, nunca uno del PATH o de winget", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "video ffmpeg "));
    const exe = process.platform === "win32" ? ".exe" : "";
    const delUsuario = path.join(base, "usuario");
    const bundle = path.join(base, "bundle");
    for (const d of [delUsuario, bundle]) {
      fs.mkdirSync(d);
      for (const n of ["ffmpeg", "ffprobe"]) fs.writeFileSync(path.join(d, n + exe), "");
    }
    try {
      vi.stubEnv("PATH", delUsuario);
      const { localizarFfmpegDir } = await import("../src/proceso.js");
      vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "");
      expect(localizarFfmpegDir(undefined)).toBe(delUsuario);
      vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "1");
      expect(localizarFfmpegDir(undefined)).toBeUndefined();
      expect(localizarFfmpegDir(bundle)).toBe(bundle);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
