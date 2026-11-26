// `rendimiento_180s` (T21, Step 3): proyecto de 90 escenas (≈ 180 s, el máximo). Mide montar la preview (con voz en frío y
// en caliente), `check` y seek en la preview, y aserta cada fase contra el timeout que se aplica de verdad. No renderiza
// el MP4. Necesita el CfT (check y seek), así que va tras VIDEO_MEDIR=1 como rendimiento.test.ts:
//   VIDEO_MEDIR=1 VIDEO_E2E_FFMPEG=<bin LGPL> VIDEO_E2E_NAVEGADOR=<carpeta con chrome-headless-shell-win64> npx vitest run test/rendimiento-180s.test.ts
//
// Timeouts (citados en docs/video-fase1/T21-fidelidad-rendimiento.md):
//  · montar: `video_montar_preview` va por `_llamar` sin timeout propio → 120 s (timeout_llamada de MotorProceso,
//    app-backend/app_backend/video.py:209); al vencer, el motor se reinicia.
//  · check: TIMEOUT_CHECK_MS = 600 s (video-mcp-server/src/render.ts:19).
//  · seek: el código no pone timeout; el objetivo del plan (riesgos abiertos) es ≤ 2 s por cambio.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const ACTIVO = process.env.VIDEO_MEDIR === "1" && process.platform === "win32";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const base = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video 180s ")));
  process.env.VIDEO_STATE_DIR = nodePath.join(base, "estado");
  if (process.env.VIDEO_E2E_FFMPEG) process.env.FFMPEG_DIR = process.env.VIDEO_E2E_FFMPEG;
  if (process.env.VIDEO_E2E_NAVEGADOR) process.env.HYPERFRAMES_BROWSER_PATH = nodePath.join(process.env.VIDEO_E2E_NAVEGADOR, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  delete process.env.VIDEO_NAVEGADOR_MANIFIESTO;
  process.env.VIDEO_FORZAR_SIN_GPU = "1";
  delete process.env.VIDEO_HYPERFRAMES_BIN;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  return { base };
});

import { montarPreviewTool } from "../src/herramientas.js";
import { TIMEOUT_CHECK_MS, comprobarComposicion } from "../src/render.js";
import { abrirPreview, configDe, elevenLabsSimulado, exigirEntorno, proyectoConVoz } from "./ayudas-aceptacion.js";

const ESCENAS = 90;
const TIMEOUT_MONTAR_S = 120; // app-backend/app_backend/video.py:209
const TIMEOUT_CHECK_S = TIMEOUT_CHECK_MS / 1000;
const OBJETIVO_SEEK_MS = 2000; // plan, «Riesgos abiertos»: recargar/saltar ≤ 2 s
const SEEKS = [0.5, 30, 60, 90, 120, 150, 175];

afterAll(() => {
  fs.rmSync(F.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

describe.runIf(ACTIVO)("rendimiento_180s: 90 escenas", () => {
  it("montar, check y seek caben en sus timeouts", async () => {
    const { ffmpegDir, navegador } = exigirEntorno();
    const raiz = path.join(F.base, "videos");
    fs.mkdirSync(raiz, { recursive: true });
    const cfg = configDe(raiz, ffmpegDir);
    // 1,95 s de voz por frase × 90 ≈ 175 s: bajo el máximo de 180 s.
    const id = await proyectoConVoz(cfg, ESCENAS, await elevenLabsSimulado(ffmpegDir, F.base, 1.95), "r");

    const montar = async () => {
      const t0 = performance.now();
      const r = (await montarPreviewTool(cfg, { id, webgpu: false })).datos as { carpeta: string; duracion: number };
      return { s: (performance.now() - t0) / 1000, ...r };
    };
    const frio = await montar(); // loudnorm de ~175 s + escribir 90 subcomposiciones
    const caliente = await montar(); // la voz normalizada ya está en caché (cambio de texto/escena)
    const dir = path.join(raiz, id, "_composicion", caliente.carpeta);

    const t0 = performance.now();
    const check = await comprobarComposicion(dir, false);
    const checkS = (performance.now() - t0) / 1000;

    const p = await abrirPreview(navegador, dir, ESCENAS);
    let seeks: number[];
    let carga: number;
    try {
      carga = p.cargaMs;
      seeks = [];
      for (const t of SEEKS) seeks.push(await p.seek(t));
    } finally {
      await p.cerrar();
    }
    const maxSeek = Math.max(...seeks);

    const fila = (fase: string, v: string, lim: string, ok: boolean) => `  ${fase.padEnd(26)} ${v.padStart(10)}   ${lim.padStart(16)}   ${ok ? "cabe" : "NO CABE"}`;
    const tabla = [
      `[medida] 90 escenas, voz ${frio.duracion.toFixed(1)} s de vídeo:`,
      fila("montar (voz en frío)", `${frio.s.toFixed(1)} s`, `${TIMEOUT_MONTAR_S} s`, frio.s <= TIMEOUT_MONTAR_S),
      fila("montar (voz en caché)", `${caliente.s.toFixed(1)} s`, `${TIMEOUT_MONTAR_S} s`, caliente.s <= TIMEOUT_MONTAR_S),
      fila("check (CLI, sin GPU)", `${checkS.toFixed(1)} s`, `${TIMEOUT_CHECK_S} s`, checkS <= TIMEOUT_CHECK_S),
      fila("carga de la preview", `${(carga / 1000).toFixed(1)} s`, "sin timeout", true),
      fila("seek máximo", `${maxSeek.toFixed(0)} ms`, `${OBJETIVO_SEEK_MS} ms`, maxSeek <= OBJETIVO_SEEK_MS),
      `  seeks (ms) a ${SEEKS.join(", ")} s: ${seeks.map((x) => x.toFixed(0)).join(", ")}`,
    ].join("\n");
    process.stderr.write(`${tabla}\n`);
    if (process.env.VIDEO_E2E_MEDIDAS) fs.appendFileSync(process.env.VIDEO_E2E_MEDIDAS, `${tabla}\n`);

    expect(frio.duracion).toBeGreaterThan(150);
    expect(check.errores, "check con errores").toEqual([]);
    expect(frio.s, "montar en frío").toBeLessThanOrEqual(TIMEOUT_MONTAR_S);
    expect(caliente.s, "montar en caché").toBeLessThanOrEqual(TIMEOUT_MONTAR_S);
    expect(checkS, "check").toBeLessThanOrEqual(TIMEOUT_CHECK_S);
    expect(maxSeek, "seek").toBeLessThanOrEqual(OBJETIVO_SEEK_MS);
  }, 30 * 60_000);
});

it.skipIf(ACTIVO)("rendimiento_180s: se salta sin VIDEO_MEDIR=1", () => {
  expect(ACTIVO).toBe(false);
});
