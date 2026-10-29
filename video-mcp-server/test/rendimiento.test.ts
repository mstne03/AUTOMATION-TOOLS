// Medida de --workers en la ruta mov (puerta VIDEO_MEDIR=1). No aserta tiempos: dependen de la máquina
// y de su carga; imprime la tabla. Ejecutar con la máquina sin otra carga:
//   VIDEO_MEDIR=1 VIDEO_E2E_NAVEGADOR=<carpeta con chrome-headless-shell-win64> VIDEO_E2E_FFMPEG=<bin LGPL> npx vitest run test/rendimiento.test.ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ACTIVO = process.env.VIDEO_MEDIR === "1" && process.platform === "win32";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const base = nodeFs.realpathSync.native(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video medir ")));
  const raizNav = nodePath.join(base, "video", "navegador", "medida");
  process.env.VIDEO_STATE_DIR = nodePath.join(base, "video", "estado");
  if (process.env.VIDEO_E2E_FFMPEG) process.env.FFMPEG_DIR = process.env.VIDEO_E2E_FFMPEG;
  process.env.HYPERFRAMES_BROWSER_PATH = nodePath.join(raizNav, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  process.env.VIDEO_NAVEGADOR_MANIFIESTO = nodePath.join(raizNav, "MANIFIESTO-SHA256.json");
  process.env.VIDEO_FORZAR_SIN_GPU = "1";
  delete process.env.VIDEO_HYPERFRAMES_BIN;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  return { base, raizNav };
});

import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion } from "../src/alineacion.js";
import { ejecutar, herramientasFfmpeg } from "../src/proceso.js";
import { HYPERFRAMES_BIN, montarComposicion, prepararRender } from "../src/render.js";

const DURACION_VOZ = 15;
const WORKERS: (number | undefined)[] = [undefined, 2, 4, 6, 8];

describe.runIf(ACTIVO)("rendimiento de --workers (ruta mov)", () => {
  const raiz = path.join(F.base, "videos");
  let composicion = "";
  let duracion = 0;

  beforeAll(async () => {
    fs.cpSync(path.join(process.env.VIDEO_E2E_NAVEGADOR!, "chrome-headless-shell-win64"), path.join(F.raizNav, "chrome-headless-shell-win64"), {
      recursive: true,
      filter: (s) => path.basename(s) !== "debug.log",
    });
    const ficheros: Record<string, string> = {};
    const recorrer = (rel: string) => {
      for (const e of fs.readdirSync(path.join(F.raizNav, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) recorrer(r);
        else ficheros[r] = crypto.createHash("sha256").update(fs.readFileSync(path.join(F.raizNav, ...r.split("/")))).digest("hex");
      }
    };
    recorrer("");
    fs.writeFileSync(process.env.VIDEO_NAVEGADOR_MANIFIESTO!, JSON.stringify({ version: "medida", ficheros }));

    const h = herramientasFfmpeg(process.env.FFMPEG_DIR)!;
    const dir = path.join(raiz, "video040");
    fs.mkdirSync(dir, { recursive: true });
    const guion = `---\ntitulo: Medida\ngancho: Hook line.\n---\n[1] One two three.\n[2] Four five.\n[3] Six seven.\n[4] Eight.\n[5] Nine ten.\n[6] Eleven twelve.\n`;
    fs.writeFileSync(path.join(dir, "guion.md"), guion);
    for (let n = 1; n <= 6; n++) {
      await ejecutar(h.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=s=1080x1920:d=1`, "-frames:v", "1", path.join(dir, `img${n}.jpg`)], { timeoutMs: 60000 });
    }
    await ejecutar(h.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=220:duration=${DURACION_VOZ}`, "-c:a", "aac", "-f", "adts", path.join(dir, "voz.mp3")], {
      timeoutMs: 60000,
    });
    const g = parsearGuion(guion);
    const chars = [...g.narracion];
    const paso = (DURACION_VOZ - 0.4) / chars.length;
    fs.writeFileSync(
      path.join(dir, "palabras.json"),
      JSON.stringify(
        procesarAlineacion({
          narracion: g.narracion,
          bloques: g.bloques,
          alineacion: {
            characters: chars,
            character_start_times_seconds: chars.map((_, i) => 0.2 + i * paso),
            character_end_times_seconds: chars.map((_, i) => 0.2 + (i + 1) * paso),
          },
          duracionAudio: DURACION_VOZ,
          hashNarracion: g.hash,
        }),
      ),
    );
    const o = { raiz, musica: false, musicaVolumen: 0.12 };
    const prep = await prepararRender("video040", o);
    composicion = prep.rutas.composicion;
    duracion = (await montarComposicion(prep, composicion, o)).duracion;
  }, 300000);

  afterAll(() => {
    try {
      fs.rmSync(F.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      /* temporal del SO */
    }
  });

  it("tabla workers · segundos · s por s de vídeo", async () => {
    const filas: string[] = [];
    for (const w of WORKERS) {
      const salida = path.join(F.base, `medida-${w ?? "auto"}.mov`);
      const args = [HYPERFRAMES_BIN, "render", composicion, "-o", salida, "--fps", "30", "--format", "mov"];
      if (w) args.push("--workers", String(w));
      const t0 = performance.now();
      const r = await ejecutar(process.execPath, args, { timeoutMs: 3_600_000 });
      const s = (performance.now() - t0) / 1000;
      expect(r.code).toBe(0);
      filas.push(`${String(w ?? "auto").padEnd(5)} · ${s.toFixed(1).padStart(7)} s · ${(s / duracion).toFixed(2)} s/s`);
      fs.rmSync(salida, { force: true });
    }
    process.stderr.write(`[medida] --workers con ${duracion.toFixed(2)} s de vídeo:\n${filas.join("\n")}\n`);
    if (process.env.VIDEO_E2E_MEDIDAS) fs.appendFileSync(process.env.VIDEO_E2E_MEDIDAS, `workers (${duracion.toFixed(2)} s):\n${filas.join("\n")}\n`);
  }, 7_200_000);
});

it.skipIf(ACTIVO)("rendimiento: se salta sin VIDEO_MEDIR=1", () => {
  expect(ACTIVO).toBe(false);
});
