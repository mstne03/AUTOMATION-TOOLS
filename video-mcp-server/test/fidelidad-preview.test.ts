// CA4 `fotogramas_fijos_ssim` (T21): la preview (iframe sandbox con la CSP real, seek del runtime) y el MP4 del motor
// real (CfT + ffmpeg LGPL, h264_mf, ElevenLabs simulado) enseñan lo mismo en 5 instantes fijos: SSIM ≥ 0,99 con el
// filtro `ssim` de ffmpeg. Fondo CSS (sin WebGPU): WebGPU en WebView2 es la prueba manual M2. Falla, no salta, si faltan
// FFMPEG_DIR o el navegador.
//   VIDEO_E2E_FFMPEG=<bin LGPL> VIDEO_E2E_NAVEGADOR=<carpeta con chrome-headless-shell-win64> npx vitest run test/fidelidad-preview.test.ts
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const base = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video fidelidad ")));
  process.env.VIDEO_STATE_DIR = nodePath.join(base, "estado");
  if (process.env.VIDEO_E2E_FFMPEG) process.env.FFMPEG_DIR = process.env.VIDEO_E2E_FFMPEG;
  // Sin manifiesto (no integrado) el motor acepta el navegador tal cual.
  if (process.env.VIDEO_E2E_NAVEGADOR) process.env.HYPERFRAMES_BROWSER_PATH = nodePath.join(process.env.VIDEO_E2E_NAVEGADOR, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  delete process.env.VIDEO_NAVEGADOR_MANIFIESTO;
  process.env.VIDEO_FORZAR_SIN_GPU = "1";
  delete process.env.VIDEO_HYPERFRAMES_BIN;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  delete process.env.VIDEO_TIMEOUT_RENDER_S;
  return { base };
});

import { montarPreviewTool, renderizar } from "../src/herramientas.js";
import { ejecutar } from "../src/proceso.js";
import { HYPERFRAMES_BIN, esperarJob, ultimasLineasUtiles } from "../src/render.js";
import { abrirPreview, configDe, elevenLabsSimulado, exigirEntorno, fotogramaDe, proyectoConVoz, ssimDe } from "./ayudas-aceptacion.js";

const INSTANTES = [2, 5, 8, 11, 14];
const UMBRAL = 0.99;
const RAIZ = path.join(F.base, "videos");

afterAll(() => {
  fs.rmSync(F.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

describe("CA4 · fotogramas_fijos_ssim", () => {
  const ssim: { t: number; v: number }[] = [];
  const ssimSinPerdida: { t: number; v: number }[] = [];
  const medida = (t: number) => ssim.find((x) => x.t === t)?.v;

  beforeAll(async () => {
    const { ffmpegDir, navegador } = exigirEntorno();
    fs.mkdirSync(RAIZ, { recursive: true });
    const cfg = configDe(RAIZ, ffmpegDir);
    // 6 escenas × 3,2 s de voz ≈ 19,6 s: cubre los instantes hasta 14 s con margen antes de la cola.
    const id = await proyectoConVoz(cfg, 6, await elevenLabsSimulado(ffmpegDir, F.base, 3.2), "fid", process.env.VIDEO_E2E_FONDO);

    // Preview: lo que monta la UI (webgpu=false → degradado CSS) servido con su CSP.
    const { carpeta } = (await montarPreviewTool(cfg, { id, webgpu: false })).datos as { carpeta: string };
    const dirPreview = path.join(RAIZ, id, "_composicion", carpeta);
    const p = await abrirPreview(navegador, dirPreview);
    const png = (t: number) => path.join(F.base, `preview-${t}.png`);
    try {
      for (const t of INSTANTES) {
        await p.seek(t);
        fs.writeFileSync(png(t), await p.captura());
      }
    } finally {
      await p.cerrar();
    }

    // Render real (h264_mf): el mismo proyecto, modo auto.
    const job = await esperarJob(((await renderizar(cfg, { id, musica: false, modo: "auto" })).datos as { job_id: string }).job_id, 1000);
    if (job.estado !== "terminado") throw new Error(`Render fallido: ${job.error}\n${ultimasLineasUtiles(job).join("\n")}`);
    const mp4 = job.mp4;
    for (const t of INSTANTES) {
      const ref = path.join(F.base, `mp4-${t}.png`);
      await fotogramaDe(ffmpegDir, mp4, t, ref);
      ssim.push({ t, v: await ssimDe(ffmpegDir, png(t), ref) });
      // VIDEO_E2E_CONSERVAR=<carpeta>: deja los pares preview/MP4 para mirarlos cuando el SSIM baja.
      if (process.env.VIDEO_E2E_CONSERVAR) {
        fs.mkdirSync(process.env.VIDEO_E2E_CONSERVAR, { recursive: true });
        for (const n of [`preview-${t}.png`, `mp4-${t}.png`]) fs.copyFileSync(path.join(F.base, n), path.join(process.env.VIDEO_E2E_CONSERVAR, n));
      }
    }

    // Control: la misma composición con el mismo motor de render, pero sin pérdida (PNG). Separa la fidelidad de la
    // preview de la pérdida del codificador H.264 (h264_mf a 12 Mbps).
    const pngs = path.join(F.base, "render-png");
    const r = await ejecutar(process.execPath, [HYPERFRAMES_BIN, "render", dirPreview, "-o", pngs, "--fps", "30", "--format", "png-sequence"], { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new Error(`render sin pérdida (código ${r.code}): ${(r.stderr || r.stdout).slice(-800)}`);
    for (const t of INSTANTES) {
      const ref = path.join(pngs, `frame_${String(Math.round(t * 30) + 1).padStart(6, "0")}.png`);
      ssimSinPerdida.push({ t, v: await ssimDe(ffmpegDir, png(t), ref) });
      if (process.env.VIDEO_E2E_CONSERVAR) fs.copyFileSync(ref, path.join(process.env.VIDEO_E2E_CONSERVAR, `sinperdida-${t}.png`));
    }
    const fila = (t: number) => `  ${String(t).padStart(2)} s · MP4 ${ssim.find((x) => x.t === t)!.v.toFixed(5)} · render sin pérdida ${ssimSinPerdida.find((x) => x.t === t)!.v.toFixed(5)}`;
    const tabla = INSTANTES.map(fila).join("\n");
    process.stderr.write(`[medida] SSIM de la preview (${job.modo ?? "?"}, fondo ${JSON.stringify(job.fondo)}):\n${tabla}\n`);
    if (process.env.VIDEO_E2E_MEDIDAS) fs.appendFileSync(process.env.VIDEO_E2E_MEDIDAS, `fidelidad:\n${tabla}\n`);
  }, 20 * 60_000);

  for (const t of INSTANTES) {
    it(`a ${t} s la preview y el render sin pérdida coinciden (SSIM ≥ ${UMBRAL})`, () => {
      const v = ssimSinPerdida.find((x) => x.t === t)?.v;
      expect(v, `no hay medida a ${t} s`).toBeDefined();
      expect(v!).toBeGreaterThanOrEqual(UMBRAL);
    });
    it(`a ${t} s la preview y el MP4 coinciden (SSIM ≥ ${UMBRAL})`, () => {
      expect(medida(t), `no hay medida a ${t} s`).toBeDefined();
      expect(medida(t)!).toBeGreaterThanOrEqual(UMBRAL);
    });
  }
});
