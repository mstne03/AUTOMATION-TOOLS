// Aceptación de la fase 1 del motor (T21: CA1, CA5, CA7, CA8). Pesado y solo Windows: motor real (CfT + ffmpeg LGPL del
// bundle), ElevenLabs simulado (fetch inyectado: ninguna llamada sale a la red) y `h264_mf` como codificador.
//   VIDEO_E2E_FFMPEG=<bin LGPL> VIDEO_E2E_NAVEGADOR=<carpeta con chrome-headless-shell-win64> npm run render:aceptacion
// Si falta el ffmpeg, el navegador o no es Windows, FALLA (no se salta): una aceptación que no corre no acepta nada.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SENTINELA = ["xi", "centinela", "aceptacion", "7c1e9d3b5a"].join("-"); // falsa, troceada para gitleaks

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const base = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video acept ")));
  const raizNav = nodePath.join(base, "video", "navegador", "aceptacion");
  process.env.VIDEO_STATE_DIR = nodePath.join(base, "video", "estado");
  const ffmpeg = process.env.VIDEO_E2E_FFMPEG || process.env.FFMPEG_DIR;
  if (ffmpeg) process.env.FFMPEG_DIR = ffmpeg;
  process.env.HYPERFRAMES_BROWSER_PATH = nodePath.join(raizNav, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  process.env.VIDEO_NAVEGADOR_MANIFIESTO = nodePath.join(raizNav, "MANIFIESTO-SHA256.json");
  // CA8: sin GPU. Y la clave centinela, en el entorno del motor como la pondría el anfitrión (CA7).
  process.env.VIDEO_FORZAR_SIN_GPU = "1";
  process.env.ELEVENLABS_API_KEY = ["xi", "centinela", "aceptacion", "7c1e9d3b5a"].join("-"); // falsa, troceada para gitleaks
  delete process.env.VIDEO_HYPERFRAMES_BIN;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  delete process.env.VIDEO_TIMEOUT_RENDER_S;
  delete process.env.VIDEO_PRUEBAS_TTS_URL;
  return { base, raizNav };
});

import { SERVER_ROOT } from "../src/raiz.js";
import type { Config } from "../src/config.js";
import { gpuForzadaApagada } from "../src/capacidades.js";
import { estadoRender, renderizar } from "../src/herramientas.js";
import { log } from "../src/log.js";
import { montarProyecto, prepararProyecto } from "../src/montaje.js";
import { perfilDuplicar, perfilGuardar } from "../src/perfil.js";
import { entornoHijo, ejecutar, herramientasFfmpeg, sondear, verificarNavegador, type InfoMedio } from "../src/proceso.js";
import { guionGuardar, proyectoCrear } from "../src/proyecto.js";
import { dependencias, elegirModo, esperarJob, obtenerJob, ordenSegundaPasada, verificarMp4, type Job } from "../src/render.js";
import { vozCoste, vozGenerar } from "../src/voz.js";
import futbol from "./fixtures-guiones/futbol.json";
import cocina from "./fixtures-guiones/cocina.json";

const RAIZ = path.join(F.base, "videos");
const DIR_ESTADO = process.env.VIDEO_STATE_DIR!;
const DIR_PERFILES = path.join(F.base, "video", "perfiles");
const DURACION_FRASE = 2.5;
const FRASES = [
  { nombre: "futbol", fixture: futbol },
  { nombre: "cocina", fixture: cocina },
];

interface Caso {
  id: string;
  job?: Job;
  info?: InfoMedio;
  /** Duración que planifica el montaje (la que `verificarMp4` exige al MP4). */
  esperada?: number;
  composicion?: string;
  respuestas: string[];
  args: unknown[];
  ms: number;
}
const casos: Record<string, Caso> = {};
const medidas: string[] = [];
function medida(texto: string): void {
  medidas.push(texto);
  process.stderr.write(`[aceptacion] ${texto}\n`);
}

const cfg = (): Config => ({
  elevenApiKey: SENTINELA,
  elevenVoiceId: undefined,
  elevenModelId: "eleven_multilingual_v2",
  videoRoot: RAIZ,
  musicaVolumen: 0.12,
  ffmpegDir: process.env.FFMPEG_DIR,
});

const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function generarManifiesto(): void {
  const ficheros: Record<string, string> = {};
  const recorrer = (rel: string) => {
    for (const e of fs.readdirSync(path.join(F.raizNav, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) recorrer(r);
      else if (r !== "MANIFIESTO-SHA256.json") ficheros[r] = sha(path.join(F.raizNav, ...r.split("/")));
    }
  };
  recorrer("");
  fs.writeFileSync(process.env.VIDEO_NAVEGADOR_MANIFIESTO!, JSON.stringify({ version: "aceptacion", ficheros }));
}

function ficheros(dir: string, salta: (p: string) => boolean = () => false): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return salta(p) ? [] : e.isDirectory() ? ficheros(p, salta) : [p];
  });
}

/** Voz simulada de ElevenLabs: un MP3 real de 2,5 s por frase y una alineación repartida por sus caracteres. */
function fetchSimulado(mp3: Buffer) {
  const llamadas: { url: string; clave: string | null }[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    llamadas.push({ url: String(url), clave: new Headers(init?.headers).get("xi-api-key") });
    const texto = (JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "";
    const chars = [...texto];
    const paso = (DURACION_FRASE - 0.2) / chars.length;
    const cuerpo = {
      audio_base64: mp3.toString("base64"),
      alignment: {
        characters: chars,
        character_start_times_seconds: chars.map((_, i) => 0.1 + i * paso),
        character_end_times_seconds: chars.map((_, i) => 0.1 + (i + 1) * paso),
      },
      normalized_alignment: null,
    };
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "x-character-count": String(chars.length) } });
  };
  return { f: f as unknown as typeof fetch, llamadas };
}

async function ff(args: string[]): Promise<void> {
  const h = herramientasFfmpeg(process.env.FFMPEG_DIR)!;
  const r = await ejecutar(h.ffmpeg, ["-y", "-v", "error", ...args], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(r.stderr);
}

describe("aceptación del motor (CA1, CA5, CA7, CA8)", () => {
  beforeAll(async () => {
    expect(process.platform, "la aceptación del motor solo corre en Windows").toBe("win32");
    expect(process.env.FFMPEG_DIR, "Define VIDEO_E2E_FFMPEG (o FFMPEG_DIR) con el bin del ffmpeg LGPL del bundle").toBeTruthy();
    expect(herramientasFfmpeg(process.env.FFMPEG_DIR), "ffmpeg/ffprobe no encontrados en FFMPEG_DIR").toBeTruthy();
    const nav = process.env.VIDEO_E2E_NAVEGADOR;
    expect(nav, "Define VIDEO_E2E_NAVEGADOR con la carpeta que contiene chrome-headless-shell-win64").toBeTruthy();
    fs.cpSync(path.join(nav!, "chrome-headless-shell-win64"), path.join(F.raizNav, "chrome-headless-shell-win64"), {
      recursive: true,
      filter: (s) => path.basename(s) !== "debug.log",
    });
    generarManifiesto();
    await verificarNavegador();
    // CA8: sondeo de codificadores vacío = una máquina sin ninguno de GPU; solo queda h264_mf.
    dependencias.sondear = async () => [];

    fs.mkdirSync(RAIZ, { recursive: true });
    const mp3 = path.join(F.base, "voz-base.mp3");
    await ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${DURACION_FRASE}`, "-c:a", "libmp3lame", "-b:a", "128k", mp3]);
    const falso = fetchSimulado(fs.readFileSync(mp3));
    for (const { nombre, fixture } of FRASES) {
      const { id: perfilId } = perfilDuplicar(RAIZ, { id: "defecto", nombre: fixture.perfil.nombre });
      perfilGuardar(RAIZ, { id: perfilId, perfil: fixture.perfil });
      const { id: guionId } = guionGuardar(RAIZ, { guion: fixture.guion });
      const { id } = proyectoCrear(RAIZ, { guionId, perfilId });
      const c = vozCoste(cfg(), id);
      const v = await vozGenerar(cfg(), { id, caracteresConfirmados: c.caracteres, planConfirmado: c.plan }, falso.f);
      expect(v.fallo, `voz de ${nombre}`).toBeUndefined();
      casos[nombre] = { id, respuestas: [JSON.stringify(c), JSON.stringify(v)], args: [], ms: 0 };
    }
    // El simulado se usó de verdad y recibió la clave (por cabecera, hacia ElevenLabs simulado); nada fue a otro sitio.
    expect(falso.llamadas.length).toBe(FRASES.reduce((s, x) => s + x.fixture.guion.escenas.flatMap((e) => e.frases).length, 0));
    expect(falso.llamadas.every((l) => l.url.startsWith("https://api.elevenlabs.io/") && l.clave === SENTINELA)).toBe(true);
  }, 600000);

  afterAll(() => {
    for (const m of medidas) process.stderr.write(`[aceptacion] ${m}\n`);
    try {
      fs.rmSync(F.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      /* temporal del SO */
    }
  });

  // ---------- CA1 ----------
  describe("CA1 dos_temas_dos_perfiles", () => {
    it.each(FRASES.map((x) => x.nombre))("renderiza %s con el motor real y h264_mf", async (nombre) => {
      const c = casos[nombre];
      const t0 = performance.now();
      const args = { id: c.id };
      c.args.push(args);
      const r = await renderizar(cfg(), args);
      c.respuestas.push(JSON.stringify(r));
      const job = await esperarJob((r.datos as { job_id: string }).job_id, 500);
      c.ms = performance.now() - t0;
      c.job = job;
      c.respuestas.push(JSON.stringify(estadoRender({ job_id: job.job_id })));
      medida(`CA1 ${nombre}: ${job.estado} en ${(c.ms / 1000).toFixed(1)} s, ${job.duracion?.toFixed(2)} s de vídeo, ${job.codificador}`);
      expect(job.error).toBeUndefined();
      expect(job.estado).toBe("terminado");
      expect(job.codificador).toBe("h264_mf");
      expect(fs.existsSync(job.mp4)).toBe(true);
      expect(fs.statSync(job.mp4).size).toBeGreaterThan(10_000);
      expect(job.duracion!).toBeGreaterThan(9);
      expect(job.duracion!).toBeLessThan(16);
      // Composición que el mismo proyecto genera (el job borra la suya al acabar): para CA5 (duración) y CA7.
      const prep = await prepararProyecto(c.id, { cfg: cfg() });
      c.composicion = path.join(F.base, `composicion-${nombre}`);
      c.esperada = montarProyecto(prep, c.composicion, false).duracion;
    }, 900000);

    it("los dos MP4 son distintos y cada uno lleva la paleta y la fuente de su perfil", () => {
      const html = (n: string) => fs.readFileSync(path.join(casos[n].composicion!, "index.html"), "utf8").toLowerCase();
      expect(sha(casos.futbol.job!.mp4)).not.toBe(sha(casos.cocina.job!.mp4));
      const css = (n: string) => ficheros(casos[n].composicion!).filter((p) => /\.(html|css|js)$/.test(p)).map((p) => fs.readFileSync(p, "utf8").toLowerCase()).join("\n");
      expect(css("futbol")).toContain(futbol.perfil.colores.acento.toLowerCase());
      expect(css("cocina")).toContain(cocina.perfil.colores.acento.toLowerCase());
      expect(css("futbol")).not.toContain(cocina.perfil.colores.acento.toLowerCase());
      expect(css("cocina")).not.toContain(futbol.perfil.colores.acento.toLowerCase());
      expect(html("futbol")).toContain("anton");
      expect(html("cocina")).toContain("inter tight");
    });

    it("src/ y plantilla/ no contienen literales de tema de los fixtures (grep)", () => {
      const temas: Record<string, RegExp> = {
        fútbol: /\b(f[uú]tbol|portero|bal[oó]n|penaltis?|delantero|[aá]rbitro|estadio)\b/i,
        cocina: /\b(receta|sart[eé]n|tortilla|cebolla|patatas?|ingredientes?|horno|cocina)\b/i,
      };
      const textuales = /\.(ts|js|mjs|html|css|json|md)$/i;
      const hallazgos: string[] = [];
      for (const dir of ["src", "plantilla"]) {
        for (const f of ficheros(path.join(SERVER_ROOT, dir)).filter((p) => textuales.test(p))) {
          const txt = fs.readFileSync(f, "utf8");
          for (const [tema, re] of Object.entries(temas)) {
            const m = re.exec(txt);
            if (m) hallazgos.push(`${path.relative(SERVER_ROOT, f)}: «${m[0]}» (${tema})`);
          }
        }
      }
      expect(hallazgos).toEqual([]);
    });
  });

  // ---------- CA5 ----------
  describe("CA5 verificarMp4", () => {
    it.each(FRASES.map((x) => x.nombre))("%s: 1080×1920, 30 fps, duración y audio", async (nombre) => {
      const c = casos[nombre];
      const h = herramientasFfmpeg(process.env.FFMPEG_DIR)!;
      const info = await sondear(h.ffprobe, c.job!.mp4, { soloMp4: true });
      c.info = info;
      expect(info.ancho).toBe(1080);
      expect(info.alto).toBe(1920);
      expect(info.fps).toBeCloseTo(30, 1);
      expect(info.tieneAudio).toBe(true);
      expect(info.pistasAudio).toBe(1);
      expect(Math.abs((info.duracionVideo ?? 0) - c.esperada!)).toBeLessThanOrEqual(0.1);
      expect(Math.abs((info.duracionAudio ?? 0) - c.esperada!)).toBeLessThanOrEqual(0.1);
      expect(() => verificarMp4(info, c.esperada!, "h264_mf")).not.toThrow();
    });

    it("un MP4 sin audio falla", async () => {
      const h = herramientasFfmpeg(process.env.FFMPEG_DIR)!;
      const mudo = path.join(F.base, "mudo.mp4");
      const d = casos.futbol.esperada!;
      await ff(["-f", "lavfi", "-i", `testsrc2=s=1080x1920:r=30:d=${d}`, "-c:v", "h264_mf", "-pix_fmt", "yuv420p", "-an", mudo]);
      const info = await sondear(h.ffprobe, mudo, { soloMp4: true });
      expect(info.tieneAudio).toBe(false);
      expect(() => verificarMp4(info, d, "h264_mf")).toThrow(/sin pista de audio/);
    });
  });

  // ---------- CA7 ----------
  describe("CA7 clave_ausente", () => {
    it("la clave centinela no está en el log, las respuestas, los args, los jobs, la composición ni los entornos de los hijos", () => {
      // Control del barrido: lo que el motor escribe con la clave en un log sale tapado.
      log.warn(`control del barrido: ${SENTINELA}`);
      const log1 = path.join(DIR_ESTADO, "video.log");
      expect(fs.readFileSync(log1, "utf8")).toContain("control del barrido: ***");

      const hay = (b: Buffer | string) => b.includes(SENTINELA);
      const enDisco = [
        ...ficheros(RAIZ),
        ...ficheros(DIR_PERFILES),
        ...ficheros(DIR_ESTADO),
        ...Object.values(casos).flatMap((c) => ficheros(c.composicion!)),
      ].filter((p) => hay(fs.readFileSync(p)));
      expect(enDisco).toEqual([]);
      expect(ficheros(DIR_ESTADO).some((p) => p.endsWith("video.log"))).toBe(true);
      expect(Object.values(casos).every((c) => ficheros(c.composicion!).length > 5)).toBe(true);

      for (const c of Object.values(casos)) {
        expect(c.respuestas.filter(hay), `respuestas de ${c.id}`).toEqual([]);
        expect(JSON.stringify(c.args), `args de ${c.id}`).not.toContain(SENTINELA);
        expect(JSON.stringify(obtenerJob(c.job!.job_id)), `job de ${c.id}`).not.toContain(SENTINELA);
        expect(c.respuestas.length).toBeGreaterThanOrEqual(4); // el barrido vio de verdad las respuestas del render
      }

      // La clave sigue en el entorno del motor (la usa la voz), pero no en el de ningún hijo.
      expect(process.env.ELEVENLABS_API_KEY).toBe(SENTINELA);
      const env = entornoHijo();
      expect(Object.keys(env).some((k) => /eleven|api_key|anthropic/i.test(k))).toBe(false);
      expect(JSON.stringify(env)).not.toContain(SENTINELA);
    });
  });

  // ---------- CA8 ----------
  describe("CA8 sin_webgpu_y_sin_gpu", () => {
    it("VIDEO_FORZAR_SIN_GPU=1 y sondeo vacío: se elige h264_mf y la reserva se ve", async () => {
      expect(gpuForzadaApagada()).toBe(true);
      expect(await dependencias.sondear(herramientasFfmpeg(process.env.FFMPEG_DIR)!)).toEqual([]);
      expect(ordenSegundaPasada([])).toEqual(["h264_mf"]);
      expect(elegirModo("auto", [])).toBe("compatible");
      expect(elegirModo("rapido", [])).toBe("compatible");
    });

    it("el vídeo con fondo WebGPU sale con el degradado CSS y el job lo dice (nunca en silencio)", () => {
      const j = casos.futbol.job!;
      expect(j.fondo).toEqual({ pedido: "aurora", usado: "css" });
      expect(j.reserva).toMatch(/degradado CSS/);
      expect(j.avisos.some((a) => /degradado CSS/.test(a))).toBe(true);
      expect(j.modo).toBe("compatible");
      expect(j.codificador).toBe("h264_mf");
      const r = estadoRender({ job_id: j.job_id });
      expect(r.texto).toMatch(/Reserva: .*degradado CSS/);
      expect((r.datos as { reserva: string }).reserva).toMatch(/degradado CSS/);
    });

    it("el fondo sin shader no necesita reserva y también sale con h264_mf", () => {
      const j = casos.cocina.job!;
      expect(j.fondo).toEqual({ pedido: "gradiente", usado: "gradiente" });
      expect(j.reserva).toBeUndefined();
      expect(j.codificador).toBe("h264_mf");
    });
  });
});
