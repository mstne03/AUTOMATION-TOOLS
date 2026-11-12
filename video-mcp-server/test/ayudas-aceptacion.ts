// Ayudas de las pruebas de aceptación (T21): proyecto con ElevenLabs simulado (fetch inyectado), preview servida como la
// sirve la UI (servidor de capacidad + iframe sandbox + CSP real, scripts/sondear-preview.mjs) y SSIM con el ffmpeg LGPL.
// El entorno (FFMPEG_DIR, HYPERFRAMES_BROWSER_PATH, VIDEO_STATE_DIR…) lo fija cada test en `vi.hoisted`, antes de importar src/.
import fs from "node:fs";
import path from "node:path";
import puppeteer, { type Frame, type Page } from "puppeteer-core";
import { flagsDeRed, servirComposicion } from "../scripts/sondear-preview.mjs";
import { entornoMinimo } from "../scripts/comparar-fotogramas.mjs";
import type { Config } from "../src/config.js";
import { ejecutar, herramientasFfmpeg } from "../src/proceso.js";
import { perfilDuplicar, perfilGuardar, perfilesListar, type Perfil } from "../src/perfil.js";
import { guionGuardar, proyectoCrear } from "../src/proyecto.js";
import { vozCoste, vozGenerar } from "../src/voz.js";

export const VOZ = "Vz12345678AB";

/** Entorno obligatorio: falla (no salta) si falta el ffmpeg LGPL o el Chrome for Testing. Nunca cae al PATH. */
export function exigirEntorno(): { ffmpegDir: string; navegador: string } {
  const ffmpegDir = process.env.FFMPEG_DIR ?? "";
  const navegador = process.env.HYPERFRAMES_BROWSER_PATH ?? "";
  if (!ffmpegDir || !fs.existsSync(path.join(ffmpegDir, "ffmpeg.exe"))) throw new Error("Falta FFMPEG_DIR (o VIDEO_E2E_FFMPEG): carpeta bin del ffmpeg LGPL del bundle.");
  if (!navegador || !fs.existsSync(navegador)) throw new Error("Falta VIDEO_E2E_NAVEGADOR: carpeta con chrome-headless-shell-win64 (Chrome for Testing).");
  return { ffmpegDir, navegador };
}

export const configDe = (raiz: string, ffmpegDir: string): Config => ({
  elevenApiKey: "sk-secreta-de-prueba",
  elevenVoiceId: VOZ,
  elevenModelId: "eleven_multilingual_v2",
  videoRoot: raiz,
  musicaVolumen: 0.12,
  ffmpegDir,
});

/** MP3 sintético de `segundos` s y un `fetch` que responde como ElevenLabs con alineación uniforme. */
export async function elevenLabsSimulado(ffmpegDir: string, destino: string, segundos: number): Promise<typeof fetch> {
  const h = herramientasFfmpeg(ffmpegDir)!;
  const ruta = path.join(destino, "frase.mp3");
  const r = await ejecutar(h.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=220:duration=${segundos}`, "-c:a", "libmp3lame", ruta], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr);
  const mp3 = fs.readFileSync(ruta).toString("base64");
  return (async (_u: unknown, init?: RequestInit) => {
    const chars = [...(JSON.parse(String(init?.body ?? "{}")) as { text: string }).text];
    const cuerpo = {
      audio_base64: mp3,
      alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => (i * segundos) / chars.length), character_end_times_seconds: chars.map((_, i) => ((i + 1) * segundos) / chars.length) },
      normalized_alignment: null,
    };
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "x-character-count": String(chars.length) } });
  }) as unknown as typeof fetch;
}

/** Proyecto de `n` escenas de una frase (cartel/cifra alternos) con la voz ya generada. Fondo `aurora`: con webgpu=false sale el degradado CSS. */
export async function proyectoConVoz(cfg: Config, n: number, fetchFalso: typeof fetch, etiqueta: string, fondo = "aurora"): Promise<string> {
  const guion = {
    version: 1,
    titulo: "Aceptación",
    gancho: "Gancho de aceptación.",
    escenas: Array.from({ length: n }, (_, k) => ({
      // Corta: el esquema limita la narración a 3000 caracteres y 90 escenas ya rozan el tope.
      frases: [`Frase ${etiqueta} ${k + 1}.`],
      base: k === 0 ? { tipo: "mapa", region: "europa", destacar: ["Spain", "Italy"] } : k % 2 === 0 ? { tipo: "cifra", valor: 10 * (k + 1) } : { tipo: "cartel", texto: `Escena ${k + 1}` },
    })),
    opciones: { fondo, look: "normal", subtitulos: "karaoke", destellos: [0] },
  };
  const { id: guionId } = guionGuardar(cfg.videoRoot, { guion });
  const { id: perfilId } = perfilDuplicar(cfg.videoRoot, { id: "defecto" });
  const p = perfilesListar(cfg.videoRoot).find((x) => "nombre" in x && x.id === perfilId) as Perfil;
  perfilGuardar(cfg.videoRoot, { id: perfilId, perfil: { ...p, voz: VOZ } });
  const { id } = proyectoCrear(cfg.videoRoot, { guionId, perfilId });
  const c = vozCoste(cfg, id);
  const r = await vozGenerar(cfg, { id, caracteresConfirmados: c.caracteres, planConfirmado: c.plan }, fetchFalso);
  if (r.fallo) throw new Error(`La voz simulada falló: ${JSON.stringify(r.fallo)}`);
  return id;
}

export interface Preview {
  page: Page;
  frame: Frame;
  /** Segundos entre pedir la carga del marco y tener el runtime con todas las subcomposiciones. */
  cargaMs: number;
  /** Seek del runtime a `t` s y espera a que se pinte; devuelve los ms que tardó. */
  seek(t: number): Promise<number>;
  /** PNG del iframe de la composición (1080×1920) tal como está en ese instante. */
  captura(): Promise<Buffer>;
  cerrar(): Promise<void>;
}

/** Abre la composición como la abre la UI: iframe sandbox sin allow-same-origin, CSP real de la composición y runtime inyectado. */
export async function abrirPreview(navegador: string, dir: string, esperaSubcomposiciones = 1): Promise<Preview> {
  const s = await servirComposicion({ dir });
  const browser = await puppeteer.launch({
    executablePath: navegador,
    headless: true,
    pipe: true,
    env: entornoMinimo(),
    args: ["--autoplay-policy=no-user-gesture-required", ...flagsDeRed("parche", s.puerto)],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });
    const t0 = performance.now();
    await page.goto(`${s.base}__marco.html`, { waitUntil: "load" });
    const marco = page.mainFrame();
    // El marco de la harness trae margen de 8 px y borde de 2 px: fuera, para que el iframe empiece en (0, 0).
    await page.evaluate(() => {
      document.body.style.margin = "0";
      (document.querySelector("iframe") as HTMLElement).style.border = "0";
    });
    let frame: Frame | undefined;
    for (let i = 0; i < 300 && !frame; i++) {
      frame = page.frames().find((f) => f !== marco && f.url().endsWith("/index.html"));
      if (!frame) await new Promise((r) => setTimeout(r, 100));
    }
    if (!frame) throw new Error("el iframe de la composición no cargó");
    await frame.waitForFunction((n: number) => !!(window as any).__player && document.querySelectorAll("[data-composition-id]").length > n, { timeout: 120_000 }, esperaSubcomposiciones);
    const cargaMs = performance.now() - t0;
    const f = frame;
    return {
      page,
      frame: f,
      cargaMs,
      async seek(t: number) {
        const a = performance.now();
        await f.evaluate(async (x: number) => {
          (window as any).__player.seek(x);
          await new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok())));
        }, t);
        return performance.now() - a;
      },
      async captura() {
        return Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1080, height: 1920 } }));
      },
      async cerrar() {
        await browser.close();
        await s.cerrar();
      },
    };
  } catch (e) {
    await browser.close();
    await s.cerrar();
    throw e;
  }
}

/** SSIM (All) entre dos imágenes con el filtro `ssim` del ffmpeg LGPL. */
export async function ssimDe(ffmpegDir: string, a: string, b: string): Promise<number> {
  const h = herramientasFfmpeg(ffmpegDir)!;
  const r = await ejecutar(h.ffmpeg, ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"], { timeoutMs: 60_000 });
  const m = /SSIM[^\n]*All:([\d.]+)/.exec(r.stderr);
  if (r.code !== 0 || !m) throw new Error(`ssim: ${r.stderr.slice(-400)}`);
  return Number(m[1]);
}

/** PSNR medio (dB) entre dos imágenes con el filtro `psnr` del ffmpeg LGPL; `inf` (idénticas) cuenta como 99 dB. */
export async function psnrDe(ffmpegDir: string, a: string, b: string): Promise<number> {
  const h = herramientasFfmpeg(ffmpegDir)!;
  const r = await ejecutar(h.ffmpeg, ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { timeoutMs: 60_000 });
  const m = /PSNR[^\n]*average:(inf|[\d.]+)/.exec(r.stderr);
  if (r.code !== 0 || !m) throw new Error(`psnr: ${r.stderr.slice(-400)}`);
  return m[1] === "inf" ? 99 : Number(m[1]);
}

/** Fotograma del MP4 en el instante `t` (PNG). */
export async function fotogramaDe(ffmpegDir: string, mp4: string, t: number, salida: string): Promise<void> {
  const h = herramientasFfmpeg(ffmpegDir)!;
  const r = await ejecutar(h.ffmpeg, ["-y", "-v", "error", "-ss", String(t), "-i", mp4, "-frames:v", "1", salida], { timeoutMs: 60_000 });
  if (r.code !== 0 || !fs.existsSync(salida)) throw new Error(`fotograma a ${t} s: ${r.stderr}`);
}
