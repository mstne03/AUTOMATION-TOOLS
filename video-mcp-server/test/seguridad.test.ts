// Huecos de seguridad del motor: árbol de procesos, opciones de la CLI, enlaces simbólicos y timeout de render.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// El motor lee VIDEO_HYPERFRAMES_BIN al cargar el módulo: hay que fijarlo antes de los imports.
const SIMULADA = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video seg cli "));
  const script = nodePath.join(dir, "hyperframes-falso.mjs");
  const registro = nodePath.join(dir, "llamadas.jsonl");
  nodeFs.writeFileSync(
    script,
    `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(registro)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const sub = process.argv[2];
if (sub === "catalog") { console.log(JSON.stringify({ total: 0, results: [] })); process.exit(0); }
if (sub === "check") { console.log(JSON.stringify({ ok: true })); process.exit(0); }
setInterval(() => {}, 1000); // render: se cuelga
`,
  );
  process.env.VIDEO_HYPERFRAMES_BIN = script;
  process.env.VIDEO_TIMEOUT_RENDER_S = "2";
  process.env.VIDEO_FORZAR_SIN_GPU = "1";
  return { dir, script, registro };
});

import type { Config } from "../src/config.js";
import { catalogo } from "../src/herramientas.js";
import { ErrorVideo, imagenesValidadas } from "../src/paths.js";
import { ejecutar, herramientasFfmpeg } from "../src/proceso.js";
import { encolarRender, esperarJob } from "../src/render.js";
import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion } from "../src/alineacion.js";

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "video seg "));
afterAll(() => {
  // En Windows un handle recién liberado puede dar EPERM un instante: reintenta y no falla por la limpieza.
  for (const d of [RAIZ, SIMULADA.dir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      /* carpeta temporal del SO */
    }
  }
});

const cfg: Config = {
  elevenApiKey: "sk-secreta-de-prueba",
  elevenVoiceId: "voz123",
  elevenModelId: "eleven_multilingual_v2",
  videoRoot: RAIZ,
  browserPath: undefined,
  musicaVolumen: 0.12,
  ffmpegDir: undefined,
};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
function sigueVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("árbol de procesos", () => {
  it("mata el árbol de procesos al vencer el timeout", async () => {
    const pidFile = path.join(RAIZ, "nieto.pid");
    const nieto = `setInterval(()=>{},1e3)`;
    const padre = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const n = spawn(process.execPath, ["-e", ${JSON.stringify(nieto)}], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(n.pid));
      setInterval(()=>{},1e3);`;
    let pid = 0;
    try {
      const r = await ejecutar(process.execPath, ["-e", padre], { timeoutMs: 1500 });
      expect(r.timeout).toBe(true);
      expect(r.code).toBeNull();
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      // Margen corto para que el SO termine de retirar el proceso.
      for (let i = 0; i < 10 && sigueVivo(pid); i++) await esperar(100);
      expect(sigueVivo(pid)).toBe(false);
    } finally {
      if (pid && sigueVivo(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* ya muerto */
        }
      }
    }
  });
});

const MALICIOSA = "--output=C:\\x";

describe("catálogo", () => {
  it("una consulta que empieza por -- no se interpreta como opción", async () => {
    fs.rmSync(SIMULADA.registro, { force: true });
    await catalogo(cfg, { consulta: MALICIOSA }).catch(() => {});
    const llamadas = fs.readFileSync(SIMULADA.registro, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(llamadas[0]).toContain(`--query=${MALICIOSA}`);
    expect(llamadas[0]).not.toContain("--query");
  });
});

function puedeCrearSymlink(): boolean {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "video sym "));
  try {
    fs.writeFileSync(path.join(base, "a.txt"), "x");
    fs.symlinkSync(path.join(base, "a.txt"), path.join(base, "b.txt"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

describe("imágenes", () => {
  it.skipIf(!puedeCrearSymlink())("un enlace simbólico fuera de la carpeta del vídeo se rechaza", () => {
    const dirVideo = path.join(RAIZ, "video001");
    const fuera = path.join(RAIZ, "fuera");
    fs.mkdirSync(dirVideo, { recursive: true });
    fs.mkdirSync(fuera, { recursive: true });
    fs.writeFileSync(path.join(fuera, "secreto.jpg"), "no soy una foto del vídeo");
    fs.symlinkSync(path.join(fuera, "secreto.jpg"), path.join(dirVideo, "img1.jpg"));
    expect(() => imagenesValidadas(dirVideo)).toThrow(ErrorVideo);
  });

  it("las imágenes normales pasan la validación", () => {
    const dir = path.join(RAIZ, "video002");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "img1.jpg"), "x");
    expect(imagenesValidadas(dir).imagenes[0]?.nombre).toBe("img1.jpg");
  });
});

const GUION = `---
titulo: Seguridad
gancho: Hook line.
---
[1] One two three.
[2] Four five.
[3] Six seven.
[4] Eight.
[5] Nine ten.
[6] Eleven twelve.
`;

describe("timeout de render", () => {
  const ID1 = "video010";
  const ID2 = "video011";
  const h = herramientasFfmpeg(undefined);

  async function prepararVideo(id: string) {
    const dir = path.join(RAIZ, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "guion.md"), GUION);
    const ff = async (args: string[]) => {
      const r = await ejecutar(h!.ffmpeg, ["-y", "-v", "error", ...args], { timeoutMs: 60000 });
      if (r.code !== 0) throw new Error(r.stderr);
    };
    for (let n = 1; n <= 6; n++) await ff(["-f", "lavfi", "-i", "color=c=0x1f5c3a:s=108x192:d=1", "-frames:v", "1", path.join(dir, `img${n}.jpg`)]);
    await ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-c:a", "libmp3lame", path.join(dir, "voz.mp3")]);
    const guion = parsearGuion(GUION);
    const chars = [...guion.narracion];
    const paso = 5.6 / chars.length;
    const palabras = procesarAlineacion({
      narracion: guion.narracion,
      bloques: guion.bloques,
      alineacion: {
        characters: chars,
        character_start_times_seconds: chars.map((_, i) => 0.2 + i * paso),
        character_end_times_seconds: chars.map((_, i) => 0.2 + (i + 1) * paso),
      },
      duracionAudio: 6,
      hashNarracion: guion.hash,
    });
    fs.writeFileSync(path.join(dir, "palabras.json"), JSON.stringify(palabras));
  }

  beforeAll(async () => {
    if (!h) return;
    await prepararVideo(ID1);
    await prepararVideo(ID2);
  }, 60000);

  it.skipIf(!herramientasFfmpeg(undefined))("un render que supera VIDEO_TIMEOUT_RENDER_S falla con mensaje legible y la cola sigue", async () => {
    const o = { raiz: RAIZ, musica: false, musicaVolumen: 0.12 };
    const j1 = await esperarJob((await encolarRender(ID1, o)).job_id, 200);
    expect(j1.estado).toBe("error");
    expect(j1.error).toMatch(/superó el tiempo máximo de render/);
    const j2 = await esperarJob((await encolarRender(ID2, o)).job_id, 200);
    expect(j2.estado).not.toBe("en_cola");
    expect(j2.estado).toBe("error");
  }, 60000);
});
