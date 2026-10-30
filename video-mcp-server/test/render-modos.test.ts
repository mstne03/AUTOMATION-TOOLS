// D11 e I11: Compatible (HyperFrames → intermedio, segunda pasada con el codificador que elige el
// motor), Rápido con reserva explícita y registrada, y todo lo que decide el motor queda en el job.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video modos "));
  const registro = nodePath.join(dir, "llamadas.jsonl");
  const banderas = nodePath.join(dir, "banderas");
  nodeFs.mkdirSync(banderas);
  const script = nodePath.join(dir, "hyperframes-falso.mjs");
  // CLI falsa: `render` genera con el ffmpeg que le fija el motor un fichero del formato pedido y de la
  // duración de la composición. Banderas: falla_mp4, cuelga_mp4, libx264 (etiqueta simulada), sin_audio.
  nodeFs.writeFileSync(
    script,
    `import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(registro)}, JSON.stringify(a) + "\\n");
const b = (n) => fs.existsSync(path.join(${JSON.stringify(banderas)}, n));
if (a[0] === "check") { console.log(JSON.stringify({ ok: true })); process.exit(0); }
if (a[0] !== "render") process.exit(0);
const out = a[a.indexOf("-o") + 1];
const fmt = a.includes("--format") ? a[a.indexOf("--format") + 1] : "mp4";
const d = /id="root"[^>]*data-duration="([\\d.]+)"/.exec(fs.readFileSync(path.join(a[1], "index.html"), "utf8"))[1];
if (fmt === "mp4" && b("falla_mp4")) { console.error("Unrecognized option 'x264-params'"); process.exit(1); }
if (fmt === "mp4" && b("cuelga_mp4")) setInterval(() => {}, 1000);
else {
  const args = ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30"];
  if (!b("sin_audio")) args.push("-f", "lavfi", "-i", "sine");
  args.push("-t", d);
  if (fmt === "mov") args.push("-c:v", "prores_ks", "-profile:v", "0", "-c:a", "pcm_s16le");
  else if (fmt === "webm") args.push("-c:v", "libvpx-vp9", "-deadline", "realtime", "-c:a", "libopus");
  else {
    args.push("-c:v", "h264_mf", "-c:a", "aac");
    if (b("libx264")) args.push("-metadata:s:v:0", "encoder=Lavc61.19.101 libx264");
  }
  args.push(out);
  const r = spawnSync(process.env.HYPERFRAMES_FFMPEG_PATH, args, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
`,
  );
  const navegador = nodePath.join(dir, "nav", "chrome-headless-shell.exe");
  nodeFs.mkdirSync(nodePath.dirname(navegador));
  nodeFs.writeFileSync(navegador, "exe");
  process.env.VIDEO_HYPERFRAMES_BIN = script;
  process.env.VIDEO_STATE_DIR = nodePath.join(dir, "estado");
  process.env.HYPERFRAMES_BROWSER_PATH = navegador;
  process.env.VIDEO_FORZAR_SIN_GPU = "1";
  delete process.env.VIDEO_NAVEGADOR_MANIFIESTO;
  delete process.env.VIDEO_ENGINE_EMBEDDED;
  delete process.env.VIDEO_TIMEOUT_RENDER_S;
  return { dir, registro, banderas, script };
});

import { ErrorVideo } from "../src/paths.js";
import { ErrorNavegador, ejecutar, herramientasFfmpeg, sondear } from "../src/proceso.js";
import {
  ARGS_CODIFICADOR,
  CODIFICADORES,
  MODO_AUTOMATICO,
  dependencias,
  disparaReserva,
  elegirIntermedio,
  elegirModo,
  encolarRender,
  esperarJob,
  ErrorTiempo,
  revisarEncoders,
  ordenSegundaPasada,
  segundaPasada,
  sondearCodificadores,
  timeoutPasadaMs,
  type CodificadorH264,
} from "../src/render.js";
import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion } from "../src/alineacion.js";

const MiB = 1024 * 1024;
const h = herramientasFfmpeg(process.env.FFMPEG_DIR);
const sondeoReal = dependencias.sondear;

afterAll(() => {
  try {
    fs.rmSync(F.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* temporal del SO */
  }
});

describe("decisiones puras", () => {
  it("ordenSegundaPasada: GPU en orden y h264_mf siempre al final", () => {
    expect(ordenSegundaPasada([])).toEqual(["h264_mf"]);
    expect(ordenSegundaPasada(["h264_amf", "h264_nvenc"])).toEqual(["h264_nvenc", "h264_amf", "h264_mf"]);
    expect(ordenSegundaPasada(["h264_mf", "h264_qsv"])).toEqual(["h264_qsv", "h264_mf"]);
  });

  it("elegirIntermedio: mov si cabe, webm si no, y error con los MB si ni eso", () => {
    expect(elegirIntermedio(10 * 1024 * MiB, 60)).toBe("mov");
    expect(elegirIntermedio(800 * MiB, 60)).toBe("webm");
    expect(() => elegirIntermedio(100 * MiB, 60)).toThrow(/MB/);
    expect(() => elegirIntermedio(100 * MiB, 60)).toThrow(ErrorVideo);
  });

  it("ningún argumento de codificador usa libx264, libopenh264 ni x264-params (I11)", () => {
    const todo = JSON.stringify(ARGS_CODIFICADOR);
    expect(todo).not.toMatch(/libx264|libopenh264|x264-params/);
    expect(Object.keys(ARGS_CODIFICADOR).sort()).toEqual([...CODIFICADORES].sort());
  });

  it("Automático es Compatible por defecto (codificador predecible)", () => {
    expect(MODO_AUTOMATICO).toBe("compatible");
    expect(elegirModo("auto", [])).toBe("compatible");
    expect(elegirModo("auto", ["h264_nvenc", "h264_mf"])).toBe("compatible");
  });

  it("Rápido solo con un codificador de GPU (h264_mf no cuenta)", () => {
    expect(elegirModo("rapido", ["h264_mf"])).toBe("compatible");
    expect(elegirModo("rapido", ["h264_amf", "h264_mf"])).toBe("rapido");
    expect(elegirModo("compatible", ["h264_nvenc"])).toBe("compatible");
  });

  it("timeoutPasadaMs: 5 min + 40 s por segundo de vídeo; la variable de pruebas solo fuera del integrado", () => {
    expect(timeoutPasadaMs(50, {})).toBe(2_300_000);
    expect(timeoutPasadaMs(180, {})).toBe(7_500_000);
    expect(timeoutPasadaMs(50, { VIDEO_TIMEOUT_RENDER_S: "2" })).toBe(2000);
    expect(timeoutPasadaMs(50, { VIDEO_TIMEOUT_RENDER_S: "99999999999" })).toBe(2_147_483_647);
    expect(timeoutPasadaMs(50, { VIDEO_TIMEOUT_RENDER_S: "abc" })).toBe(2_300_000);
    expect(timeoutPasadaMs(50, { VIDEO_TIMEOUT_RENDER_S: "2", VIDEO_ENGINE_EMBEDDED: "1" })).toBe(2_300_000);
  });

  it("revisarEncoders: un ffmpeg con libx264, libx265 o libopenh264 no es el LGPL del bundle", () => {
    const listado = " V....D h264_mf   H264 via MediaFoundation\n V....D h264_nvenc   NVIDIA\n V....D libx264   libx264 H.264\n";
    expect(revisarEncoders(listado, false)).toEqual({ presentes: ["h264_nvenc", "h264_mf"], prohibidos: ["libx264"] });
    expect(() => revisarEncoders(listado, true)).toThrow(/no es el LGPL del bundle/);
    expect(() => revisarEncoders(" V....D libopenh264  OpenH264\n", true)).toThrow(ErrorVideo);
    expect(() => revisarEncoders(" V....D libx264rgb  libx264 RGB\n", true)).toThrow(/libx264rgb/);
    expect(revisarEncoders(" V....D h264_amf  AMD\n", true)).toEqual({ presentes: ["h264_amf"], prohibidos: [] });
  });

  it("la reserva Rápido→Compatible no salta por navegador, disco ni timeout", () => {
    expect(disparaReserva(new ErrorNavegador("x"))).toBe(false);
    expect(disparaReserva(new ErrorVideo("disco"))).toBe(false);
    expect(disparaReserva(new ErrorTiempo("x"))).toBe(false);
    expect(disparaReserva(new Error("Unrecognized option 'x264-params'"))).toBe(true);
  });
});

describe.skipIf(!h)("ffmpeg real", () => {
  it.runIf(process.platform === "win32")("sondearCodificadores encuentra h264_mf y cachea el resultado", async () => {
    const a = await sondearCodificadores(h!);
    expect(a).toContain("h264_mf");
    for (const c of a) expect(CODIFICADORES).toContain(c);
    expect(await sondearCodificadores(h!)).toBe(a);
  }, 120000);

  it.runIf(process.platform === "win32")("segundaPasada convierte un intermedio ProRes en un H.264 válido", async () => {
    const inter = path.join(F.dir, "inter.mov");
    const salida = path.join(F.dir, "salida.mp4");
    const r = await ejecutar(h!.ffmpeg, [
      "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30", "-f", "lavfi", "-i", "sine", "-t", "2",
      "-c:v", "prores_ks", "-profile:v", "4", "-c:a", "pcm_s16le", inter,
    ], { timeoutMs: 60000 });
    expect(r.code).toBe(0);
    const p = await segundaPasada(h!, inter, "mov", salida, "h264_mf", 120000);
    expect(p.code).toBe(0);
    const info = await sondear(h!.ffprobe, salida);
    expect(info.codecVideo).toBe("h264");
    expect(info.fpsMedio).toBe(30);
    expect(info.tieneAudio).toBe(true);
    expect(info.codificador).toMatch(/h264_mf$/);
    // Modo estricto del MP4 propio: paquetes contados y una pista de cada.
    const estricto = await sondear(h!.ffprobe, salida, { soloMp4: true });
    expect(estricto.nbPaquetes).toBe(estricto.nbFrames);
    expect([estricto.pistasVideo, estricto.pistasAudio]).toEqual([1, 1]);
    // Un MP4 truncado no pasa, aunque ffprobe saliera con 0.
    const truncado = path.join(F.dir, "truncado.mp4");
    const b = fs.readFileSync(salida);
    fs.writeFileSync(truncado, b.subarray(0, Math.floor(b.length / 2)));
    await expect(sondear(h!.ffprobe, truncado, { soloMp4: true })).rejects.toThrow(/ffprobe no puede leer/);
    // Un fichero que no es mp4 con esa extensión tampoco.
    const falso = path.join(F.dir, "falso.mp4");
    fs.writeFileSync(falso, "esto no es un mp4");
    await expect(sondear(h!.ffprobe, falso, { soloMp4: true })).rejects.toThrow(/ffprobe no puede leer/);
  }, 120000);
});

const GUION = `---
titulo: Modos
gancho: Hook line.
---
[1] One two three.
[2] Four five.
[3] Six seven.
[4] Eight.
[5] Nine ten.
[6] Eleven twelve.
`;

const RAIZ = path.join(F.dir, "videos");
const llamadas = (): string[][] =>
  fs.existsSync(F.registro) ? fs.readFileSync(F.registro, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
const renders = () => llamadas().filter((l) => l[0] === "render");
const bandera = (n: string) => fs.writeFileSync(path.join(F.banderas, n), "");

async function prepararVideo(id: string) {
  const dir = path.join(RAIZ, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "guion.md"), GUION);
  const ff = async (args: string[]) => {
    const r = await ejecutar(h!.ffmpeg, ["-y", "-v", "error", ...args], { timeoutMs: 60000 });
    if (r.code !== 0) throw new Error(r.stderr);
  };
  for (let n = 1; n <= 6; n++) await ff(["-f", "lavfi", "-i", "color=c=0x1f5c3a:s=108x192:d=1", "-frames:v", "1", path.join(dir, `img${n}.jpg`)]);
  // AAC en ADTS con nombre .mp3: ffmpeg detecta el formato por contenido y el ffmpeg LGPL no trae LAME.
  await ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-c:a", "aac", "-f", "adts", path.join(dir, "voz.mp3")]);
  const guion = parsearGuion(GUION);
  const chars = [...guion.narracion];
  const paso = 3.6 / chars.length;
  const palabras = procesarAlineacion({
    narracion: guion.narracion,
    bloques: guion.bloques,
    alineacion: {
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => 0.2 + i * paso),
      character_end_times_seconds: chars.map((_, i) => 0.2 + (i + 1) * paso),
    },
    duracionAudio: 4,
    hashNarracion: guion.hash,
  });
  fs.writeFileSync(path.join(dir, "palabras.json"), JSON.stringify(palabras));
}

const IDS = ["video020", "video021", "video022", "video023", "video024", "video025"];
const o = (modo?: "auto" | "rapido" | "compatible") => ({ raiz: RAIZ, musica: false, musicaVolumen: 0.12, modo });
const GPU_SIMULADA = async (): Promise<CodificadorH264[]> => ["h264_nvenc", "h264_mf"];

describe.skipIf(!h || process.platform !== "win32")("job de render con la CLI falsa", () => {
  beforeAll(async () => {
    for (const id of IDS) await prepararVideo(id);
  }, 120000);
  afterEach(() => {
    fs.rmSync(F.registro, { force: true });
    for (const n of fs.readdirSync(F.banderas)) fs.rmSync(path.join(F.banderas, n));
    dependencias.sondear = sondeoReal;
    delete process.env.VIDEO_TIMEOUT_RENDER_S;
  });

  it("Compatible (por defecto) registra modo, intermedio y codificador, y borra el intermedio", async () => {
    const j = await esperarJob((await encolarRender(IDS[0], o())).job_id, 200);
    expect(j.error).toBeUndefined();
    expect(j.estado).toBe("terminado");
    expect(j.modo).toBe("compatible");
    expect(j.intermedio).toBe("mov");
    expect(CODIFICADORES).toContain(j.codificador);
    expect(j.avisos.some((a) => a.startsWith("Codificador: ") && a.includes("modo Compatible"))).toBe(true);
    const [r] = renders();
    expect(r).toContain("--format");
    expect(r[r.indexOf("--format") + 1]).toBe("mov");
    expect(r).not.toContain("--gpu");
    expect(fs.readdirSync(path.join(RAIZ, IDS[0])).filter((n) => n.includes("intermedio"))).toEqual([]);
    expect(fs.existsSync(j.mp4)).toBe(true);
  }, 120000);

  it("Rápido que falla se repite una vez en Compatible y lo registra", async () => {
    dependencias.sondear = GPU_SIMULADA;
    bandera("falla_mp4");
    const j = await esperarJob((await encolarRender(IDS[1], o("rapido"))).job_id, 200);
    expect(j.estado).toBe("terminado");
    const formatos = renders().map((r) => r[r.indexOf("--format") + 1]);
    expect(formatos).toEqual(["mp4", "mov"]);
    expect(j.modo).toBe("compatible");
    expect(j.reserva).toMatch(/Rápido falló/);
    expect(j.avisos.some((a) => /Rápido falló/.test(a))).toBe(true);
  }, 120000);

  it("Rápido con un MP4 de libx264: no se entrega, se repite en Compatible y se registra", async () => {
    dependencias.sondear = GPU_SIMULADA;
    bandera("libx264");
    const j = await esperarJob((await encolarRender(IDS[2], o("rapido"))).job_id, 200);
    expect(j.estado).toBe("terminado");
    expect(j.reserva).toMatch(/libx264/);
    expect(j.codificador).not.toBe("libx264");
    expect(CODIFICADORES).toContain(j.codificador);
    const info = await sondear(h!.ffprobe, j.mp4);
    expect(info.codificador).not.toMatch(/libx264/);
  }, 120000);

  it("Rápido con timeout: error legible y sin reserva", async () => {
    dependencias.sondear = GPU_SIMULADA;
    bandera("cuelga_mp4");
    process.env.VIDEO_TIMEOUT_RENDER_S = "3";
    const j = await esperarJob((await encolarRender(IDS[3], o("rapido"))).job_id, 200);
    expect(j.estado).toBe("error");
    expect(j.error).toMatch(/tiempo máximo/);
    expect(j.reserva).toBeUndefined();
    expect(renders()).toHaveLength(1);
  }, 120000);

  it("un MP4 sin audio hace fallar el job y no deja MP4", async () => {
    bandera("sin_audio");
    const j = await esperarJob((await encolarRender(IDS[4], o())).job_id, 200);
    expect(j.estado).toBe("error");
    expect(j.error).toMatch(/audio/);
    expect(fs.existsSync(j.mp4)).toBe(false);
    expect(fs.readdirSync(path.join(RAIZ, IDS[4])).filter((n) => /intermedio|renderizando/.test(n))).toEqual([]);
  }, 120000);

  it("un ffmpeg que no es el del bundle (integrado) hace fallar el job antes del render", async () => {
    dependencias.sondear = async () => {
      throw new ErrorVideo("El ffmpeg no es el LGPL del bundle (trae libx264).");
    };
    const j = await esperarJob((await encolarRender(IDS[5], o())).job_id, 200);
    expect(j.estado).toBe("error");
    expect(j.error).toMatch(/LGPL/);
    expect(renders()).toHaveLength(0);
  }, 120000);
});
