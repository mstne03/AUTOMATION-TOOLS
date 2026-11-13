// T6: montaje de preview (`_composicion/r<n>/`) y de render (`_render/<job>/`) de un Proyecto, con voz por frases.
// Interfaces del plan: video_montar_preview {id, webgpu} → {carpeta, duracion, avisos, fondo}; video_renderizar con `modo`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const F = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "video montaje "));
  const registro = nodePath.join(dir, "llamadas.jsonl");
  const banderas = nodePath.join(dir, "banderas");
  nodeFs.mkdirSync(banderas);
  const script = nodePath.join(dir, "hyperframes-falso.mjs");
  const CLAVE = "sk-secreta-de-prueba";
  // CLI falsa (como la de render-modos) más dos sondas: `clave_en_composicion` si algún fichero de la carpeta
  // contiene la clave, y `en_render` si la carpeta que recibe está bajo `_render`.
  nodeFs.writeFileSync(
    script,
    `import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(registro)}, JSON.stringify(a) + "\\n");
const b = (n) => fs.existsSync(path.join(${JSON.stringify(banderas)}, n));
const marca = (n) => fs.writeFileSync(path.join(${JSON.stringify(banderas)}, n), "1");
const recorre = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? recorre(path.join(d, e.name)) : [path.join(d, e.name)]));
if (a[0] === "check" || a[0] === "render") {
  for (const f of recorre(a[1])) if (fs.readFileSync(f).includes(${JSON.stringify(CLAVE)})) marca("clave_en_composicion");
  if (a[1].split(path.sep).includes("_render")) marca("en_render");
}
if (a[0] === "check") { console.log(JSON.stringify({ ok: true })); process.exit(0); }
if (a[0] !== "render") process.exit(0);
const out = a[a.indexOf("-o") + 1];
const fmt = a.includes("--format") ? a[a.indexOf("--format") + 1] : "mp4";
const d = /id="root"[^>]*data-duration="([\\d.]+)"/.exec(fs.readFileSync(path.join(a[1], "index.html"), "utf8"))[1];
if (fmt === "mp4" && b("cuelga_mp4")) setInterval(() => {}, 1000);
else if (b("cuelga")) setInterval(() => {}, 1000);
else {
  const args = ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30", "-f", "lavfi", "-i", "sine", "-t", d];
  if (fmt === "mov") args.push("-c:v", "prores_ks", "-profile:v", "0", "-c:a", "pcm_s16le");
  else if (fmt === "webm") args.push("-c:v", "libvpx-vp9", "-deadline", "realtime", "-c:a", "libopus");
  else args.push("-c:v", "h264_mf", "-c:a", "aac");
  args.push(out);
  process.exit(spawnSync(process.env.HYPERFRAMES_FFMPEG_PATH, args, { stdio: "inherit" }).status ?? 1);
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
  return { dir, registro, banderas, CLAVE };
});

// Espía de `ejecutar`: la implementación real se conserva y se cuenta qué se lanza.
const lanzados: string[][] = [];
vi.mock("../src/proceso.js", async (orig) => {
  const m = await orig<typeof import("../src/proceso.js")>();
  return { ...m, ejecutar: (c: string, a: string[], o: Parameters<typeof m.ejecutar>[2]) => (lanzados.push([c, ...a]), m.ejecutar(c, a, o)) };
});

// Normalizaciones de voz (`loudnorm`) pedidas por el montaje: el espía envuelve a `normalizarVoz` y la deja correr.
const normalizaciones: unknown[][] = [];
const conc = { activas: 0, max: 0 };
vi.mock("../src/musica.js", async (orig) => {
  const m = await orig<typeof import("../src/musica.js")>();
  return {
    ...m,
    normalizarVoz: async (...a: Parameters<typeof m.normalizarVoz>) => {
      normalizaciones.push(a);
      conc.activas++;
      conc.max = Math.max(conc.max, conc.activas);
      try {
        return await m.normalizarVoz(...a);
      } finally {
        conc.activas--;
      }
    },
  };
});

import type { Config } from "../src/config.js";
import { ErrorVideo } from "../src/paths.js";
import { ErrorAlmacen, guionGuardar, proyectoCrear, proyectoGuardar, proyectoLeer } from "../src/proyecto.js";
import { perfilDuplicar, perfilGuardar, perfilesListar, type Perfil } from "../src/perfil.js";
import { ejecutar, herramientasFfmpeg, hfHome } from "../src/proceso.js";
import { dependencias, esperarJob } from "../src/render.js";
import { montarPreviewTool, renderizar, estadoRender } from "../src/herramientas.js";
import { ensamblarVoz, vozCoste, vozGenerar } from "../src/voz.js";
import { barrerRenderHuerfanos } from "../src/montaje.js";

const RAIZ = path.join(F.dir, "raiz");
const VOZ = "Vz12345678AB";
const cfg = (): Config => ({ elevenApiKey: F.CLAVE, elevenVoiceId: VOZ, elevenModelId: "eleven_multilingual_v2", videoRoot: RAIZ, musicaVolumen: 0.12, ffmpegDir: undefined });
const hijosPosibles = (() => {
  try {
    hfHome();
    return true;
  } catch {
    return false;
  }
})();
const ffmpeg = hijosPosibles ? herramientasFfmpeg(undefined) : null;
const requiere = it.skipIf(!ffmpeg);
let mp3 = Buffer.alloc(0);

beforeAll(async () => {
  fs.mkdirSync(RAIZ, { recursive: true });
  if (!ffmpeg) return;
  const ruta = path.join(F.dir, "base.mp3");
  const r = await ejecutar(ffmpeg.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "libmp3lame", ruta], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr);
  mp3 = fs.readFileSync(ruta);
  // Sin GPU real en la máquina de pruebas ni CLI de verdad: el sondeo de codificadores es el de h264_mf.
  dependencias.sondear = async () => ["h264_mf"];
}, 60_000);
afterAll(() => fs.rmSync(F.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
beforeEach(() => {
  lanzados.length = 0;
  normalizaciones.length = 0;
  conc.max = 0;
  for (const f of fs.readdirSync(F.banderas)) fs.rmSync(path.join(F.banderas, f));
  fs.rmSync(F.registro, { force: true });
});

function respuesta(texto: string): Response {
  const chars = [...texto];
  const cuerpo = {
    audio_base64: mp3.toString("base64"),
    alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.02), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.02) },
    normalized_alignment: null,
  };
  return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "x-character-count": String(chars.length) } });
}
const fetchFalso = (async (_u: unknown, init?: RequestInit) => respuesta((JSON.parse(String(init?.body ?? "{}")) as { text: string }).text)) as unknown as typeof fetch;

/** Proyecto de 2 escenas × 2 frases con la voz de un perfil propio. */
let serie = 0;
function nuevo(fondo = "aurora"): string {
  // La caché de voz es por texto: cada proyecto lleva frases propias para que el primer montaje sea en frío.
  const t = ++serie;
  const frases = (e: number) => [1, 2].map((k) => `Frase ${t} número ${e * 2 + k} del partido.`);
  const guion = {
    version: 1,
    titulo: "Cuatro frases",
    gancho: "Cuatro frases.",
    escenas: [0, 1].map((e) => ({ frases: frases(e), base: { tipo: "cartel", texto: `Escena ${e + 1}` } })),
    opciones: { fondo, look: "normal", subtitulos: "karaoke", destellos: [0] },
  };
  const { id: guionId } = guionGuardar(RAIZ, { guion });
  const { id: perfilId } = perfilDuplicar(RAIZ, { id: "defecto" });
  const p = perfilesListar(RAIZ).find((x) => "nombre" in x && x.id === perfilId) as Perfil;
  perfilGuardar(RAIZ, { id: perfilId, perfil: { ...p, voz: VOZ } });
  return proyectoCrear(RAIZ, { guionId, perfilId }).id;
}
const conVoz = async (id: string) => {
  const r = await vozGenerar(cfg(), { id, caracteresConfirmados: vozCoste(cfg(), id).caracteres, planConfirmado: vozCoste(cfg(), id).plan }, fetchFalso);
  expect(r.fallo).toBeUndefined();
};
const editar = (id: string, f: (p: any) => void) => {
  const { proyecto } = proyectoLeer(RAIZ, id);
  const p = JSON.parse(JSON.stringify(proyecto));
  f(p);
  proyectoGuardar(RAIZ, { id, revision: proyecto.revision, proyecto: p });
};
const preview = async (id: string, webgpu = false) => (await montarPreviewTool(cfg(), { id, webgpu })).datos as any;
const hijos = (id: string, sub: string) => (fs.existsSync(path.join(RAIZ, id, sub)) ? fs.readdirSync(path.join(RAIZ, id, sub)).sort() : []);
const ffmpegLanzado = () => lanzados.filter(([c]) => /ffmpeg|ffprobe/i.test(path.basename(c)));

describe("T6 · preview en `_composicion/r<n>/`", () => {
  requiere("montar_preview_forma: { carpeta: r<n>, duracion, avisos, fondo } y la composición escrita", async () => {
    const id = nuevo();
    await conVoz(id);
    const r = await preview(id, false);
    expect(r.carpeta).toBe("r1");
    expect(r.duracion).toBeGreaterThan(1);
    expect(Array.isArray(r.avisos)).toBe(true);
    expect(r.fondo).toEqual({ pedido: "aurora", usado: "css" });
    expect(fs.existsSync(path.join(RAIZ, id, "_composicion", "r1", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(RAIZ, id, "_composicion", "r1", "assets", "voz.wav"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(RAIZ);
  });

  requiere("con webgpu: el fondo pedido es el usado", async () => {
    const id = nuevo();
    await conVoz(id);
    expect((await preview(id, true)).fondo).toEqual({ pedido: "aurora", usado: "aurora" });
  });

  requiere("el contador es del motor y borra las anteriores salvo la última", async () => {
    const id = nuevo();
    await conVoz(id);
    const cs: string[] = [];
    for (let k = 0; k < 4; k++) cs.push((await preview(id)).carpeta);
    expect(cs).toEqual(["r1", "r2", "r3", "r4"]);
    expect(hijos(id, "_composicion")).toEqual(["r3", "r4"]);
  });

  requiere("una tool con `id` que no es un proyecto válido se rechaza", async () => {
    await expect(montarPreviewTool(cfg(), { id: "../x", webgpu: false })).rejects.toThrow();
  });

  requiere("voz_pendiente_lista: sin voces, error tipado con los ids de las frases que faltan", async () => {
    const id = nuevo();
    const e = await montarPreviewTool(cfg(), { id, webgpu: false }).catch((x) => x);
    expect(e).toBeInstanceOf(ErrorAlmacen);
    expect(e.codigo).toBe("voz_pendiente");
    const { proyecto } = proyectoLeer(RAIZ, id);
    expect(e.problemas.map((p: any) => p.ruta).sort()).toEqual(proyecto.frases.map((f) => f.id).sort());
    expect(hijos(id, "_composicion")).toEqual([]);
  });

  requiere("clave_en_composicion: ni la clave de ElevenLabs ni su texto aparecen en `_composicion`", async () => {
    const id = nuevo();
    await conVoz(id);
    await preview(id);
    const recorre = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? recorre(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of recorre(path.join(RAIZ, id, "_composicion"))) expect(fs.readFileSync(f).includes(F.CLAVE), f).toBe(false);
  });
});

describe("T6 · audio normalizado en caché por hash", () => {
  requiere("edicion_texto_no_normaliza y montaje_edicion_rapido: cambiar un texto que no se narra no repite loudnorm ni lanza ffmpeg", async () => {
    const id = nuevo();
    await conVoz(id);
    await preview(id);
    expect(normalizaciones).toHaveLength(1); // el primer montaje sí normaliza
    normalizaciones.length = 0;
    lanzados.length = 0;
    editar(id, (p) => (p.escenas[0].base = { tipo: "cartel", texto: "Otro cartel distinto" }));
    const t0 = performance.now();
    await preview(id);
    const ms = performance.now() - t0;
    expect(normalizaciones).toHaveLength(0);
    expect(ffmpegLanzado()).toEqual([]);
    expect(ms).toBeLessThan(1000);
    expect(hijos(id, "voz").filter((n) => n.startsWith("normalizada-"))).toHaveLength(1);
  });

  requiere("cambiar la narración sí vuelve a normalizar (otro hash)", async () => {
    const id = nuevo();
    await conVoz(id);
    await preview(id);
    editar(id, (p) => (p.frases[0].texto = "Una frase nueva del partido."));
    await conVoz(id);
    lanzados.length = 0;
    normalizaciones.length = 0;
    await preview(id);
    expect(normalizaciones).toHaveLength(1);
  });
});

describe("T6 · render en `_render/<job>/`", () => {
  requiere("render_no_pisa_preview: la preview montada no se toca y `_render/<job>` se borra al acabar", async () => {
    const id = nuevo();
    await conVoz(id);
    await preview(id);
    const antes = fs.readFileSync(path.join(RAIZ, id, "_composicion", "r1", "index.html"), "utf8");
    const r = await renderizar(cfg(), { id, modo: "compatible" });
    const job = await esperarJob((r.datos as any).job_id, 200);
    expect(job.estado, job.error).toBe("terminado");
    expect(fs.existsSync(path.join(F.banderas, "en_render"))).toBe(true);
    expect(fs.readFileSync(path.join(RAIZ, id, "_composicion", "r1", "index.html"), "utf8")).toBe(antes);
    expect(hijos(id, "_composicion")).toEqual(["r1"]);
    expect(hijos(id, "_render")).toEqual([]);
    expect(fs.existsSync(path.join(RAIZ, id, "video.mp4"))).toBe(true);
  }, 120_000);

  requiere("clave_en_composicion: tampoco en `_render` mientras se renderiza", async () => {
    const id = nuevo();
    await conVoz(id);
    const job = await esperarJob(((await renderizar(cfg(), { id, modo: "compatible" })).datos as any).job_id, 200);
    expect(job.estado, job.error).toBe("terminado");
    expect(fs.existsSync(path.join(F.banderas, "clave_en_composicion"))).toBe(false);
  }, 120_000);

  requiere("fondo_degradado_visible: sin GPU, `reserva` dice qué fondo se sustituyó y el job lo registra", async () => {
    const id = nuevo("aurora");
    await conVoz(id);
    const job = await esperarJob(((await renderizar(cfg(), { id, modo: "compatible" })).datos as any).job_id, 200);
    expect(job.estado, job.error).toBe("terminado");
    expect(job.reserva).toMatch(/Fondo aurora sustituido por el degradado CSS/);
    expect(job.fondo).toEqual({ pedido: "aurora", usado: "css" });
    const e = estadoRender({ job_id: job.job_id }).datos as any;
    expect(e.fondo).toEqual({ pedido: "aurora", usado: "css" });
    expect(e.reserva).toMatch(/degradado CSS/);
  }, 120_000);

  requiere("modo_llega_a_job: el modo pedido sale en el job y condiciona el render", async () => {
    const id = nuevo("ninguno");
    await conVoz(id);
    const job = await esperarJob(((await renderizar(cfg(), { id, modo: "compatible" })).datos as any).job_id, 200);
    expect(job.estado, job.error).toBe("terminado");
    expect(job.modoPedido).toBe("compatible");
    expect(job.modo).toBe("compatible");
    expect((estadoRender({ job_id: job.job_id }).datos as any).modoPedido).toBe("compatible");
    const formatos = fs.readFileSync(F.registro, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]).filter((a) => a[0] === "render").map((a) => a[a.indexOf("--format") + 1]);
    expect(formatos).toEqual(["mov"]);
    expect(job.reserva).toBeUndefined(); // fondo «ninguno»: nada que sustituir
  }, 120_000);

  requiere("modo_invalido: se rechaza antes de montar nada", async () => {
    const id = nuevo();
    await conVoz(id);
    await expect(renderizar(cfg(), { id, modo: "turbo" as never })).rejects.toThrow(ErrorVideo);
    await expect(renderizar(cfg(), { id, modo: "turbo" as never })).rejects.toThrow(/modo/);
    expect(hijos(id, "_render")).toEqual([]);
  });

  requiere("voz_pendiente en el render: error tipado con la lista, sin job", async () => {
    const id = nuevo();
    const e = await renderizar(cfg(), { id, modo: "auto" }).catch((x) => x);
    expect(e).toBeInstanceOf(ErrorAlmacen);
    expect(e.codigo).toBe("voz_pendiente");
    expect(e.problemas.length).toBe(4);
  });

  requiere("timeout_sin_procesos: un render que cuelga acaba en error y no deja `_render/<job>`", async () => {
    const id = nuevo("ninguno");
    await conVoz(id);
    fs.writeFileSync(path.join(F.banderas, "cuelga"), "1");
    process.env.VIDEO_TIMEOUT_RENDER_S = "3";
    try {
      const job = await esperarJob(((await renderizar(cfg(), { id, modo: "compatible" })).datos as any).job_id, 200);
      expect(job.estado).toBe("error");
      expect(job.error).toMatch(/tiempo máximo/);
    } finally {
      delete process.env.VIDEO_TIMEOUT_RENDER_S;
    }
    expect(hijos(id, "_render")).toEqual([]);
    expect(fs.existsSync(path.join(RAIZ, id, "video.mp4"))).toBe(false);
  }, 120_000);
});

describe("T6 · correcciones de la re-revisión", () => {
  requiere("LOW-R2: dos ensamblados concurrentes del mismo proyecto no dejan un WAV truncado ni temporales", async () => {
    const id = nuevo();
    await conVoz(id);
    const [a, b, c] = await Promise.all([ensamblarVoz(cfg(), id), ensamblarVoz(cfg(), id), ensamblarVoz(cfg(), id)]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    const info = await (await import("../src/proceso.js")).sondear(ffmpeg!.ffprobe, a);
    expect(info.duracion).toBeGreaterThan(3.5); // 4 frases de 1 s: un WAV truncado dura menos
    expect(hijos(id, "voz").filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  requiere("LOW-N2: renders y previews serializan la preparación (nunca dos normalizaciones a la vez)", async () => {
    const ids = [nuevo("ninguno"), nuevo("ninguno"), nuevo("ninguno")];
    for (const id of ids) await conVoz(id);
    conc.max = 0;
    const [r1, r2, p3] = await Promise.all([renderizar(cfg(), { id: ids[0], modo: "compatible" }), renderizar(cfg(), { id: ids[1], modo: "compatible" }), preview(ids[2])]);
    expect(conc.max).toBe(1);
    for (const r of [r1, r2]) expect((await esperarJob((r.datos as any).job_id, 200)).estado).toBe("terminado");
    expect(p3.carpeta).toBe("r1");
  }, 180_000);

  const enlace = it.skipIf(!ffmpeg || process.platform !== "win32");
  enlace("L-2: `_composicion` y `_render` que son junction fallan cerrado y no se escribe fuera", async () => {
    for (const sub of ["_composicion", "_render"]) {
      const id = nuevo("ninguno");
      await conVoz(id);
      const fuera = fs.mkdtempSync(path.join(F.dir, "fuera "));
      fs.writeFileSync(path.join(fuera, "intocable.txt"), "x");
      fs.symlinkSync(fuera, path.join(RAIZ, id, sub), "junction");
      if (sub === "_composicion") await expect(montarPreviewTool(cfg(), { id, webgpu: false })).rejects.toThrow(/enlace/);
      else {
        const job = await esperarJob(((await renderizar(cfg(), { id, modo: "compatible" })).datos as any).job_id, 100);
        expect(job.estado).toBe("error");
        expect(job.error).toMatch(/enlace/);
      }
      expect(fs.readdirSync(fuera)).toEqual(["intocable.txt"]);
    }
  }, 120_000);

  it("L-7: al arrancar se borran las `_render/<job>` huérfanas y solo esas", () => {
    const id = "video777";
    const base = path.join(RAIZ, id, "_render");
    const mk = (n: string, pid?: number, edadMin = 0) => {
      const d = path.join(base, n);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "index.html"), "x");
      if (pid !== undefined) fs.writeFileSync(path.join(d, ".motor"), String(pid));
      const t = new Date(Date.now() - edadMin * 60_000);
      fs.utimesSync(d, t, t);
    };
    mk("job-muerto", 2_000_000_000);
    mk("job-vivo", process.pid);
    mk("job-reciente-sin-marca", undefined, 1);
    mk("job-viejo-sin-marca", undefined, 60);
    // L-7a: una marca vacía o ilegible (escritura a medias de otro motor) no prueba nada: manda la edad.
    mk("job-marca-vacia-reciente", undefined, 1);
    fs.writeFileSync(path.join(base, "job-marca-vacia-reciente", ".motor"), "");
    mk("job-marca-basura-reciente", undefined, 1);
    fs.writeFileSync(path.join(base, "job-marca-basura-reciente", ".motor"), "no-es-un-pid");
    mk("job-marca-vacia-vieja", undefined, 60);
    fs.writeFileSync(path.join(base, "job-marca-vacia-vieja", ".motor"), "");
    const t = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(path.join(base, "job-marca-vacia-vieja"), t, t);
    const fuera = path.join(F.dir, "ajeno");
    fs.mkdirSync(fuera, { recursive: true });
    fs.writeFileSync(path.join(fuera, "a.txt"), "x");
    barrerRenderHuerfanos(RAIZ);
    expect(hijos(id, "_render")).toEqual(["job-marca-basura-reciente", "job-marca-vacia-reciente", "job-reciente-sin-marca", "job-vivo"]);
    expect(fs.readdirSync(fuera)).toEqual(["a.txt"]);
  });

  const conEnlace = it.skipIf(process.platform !== "win32");
  conEnlace("L-7: el barrido de `_render/` no entra en enlaces (ni `_render` ni un `<job>` que sean junction)", () => {
    const fuera = fs.mkdtempSync(path.join(F.dir, "ajeno-enlace "));
    for (const n of ["job-dentro.txt"]) fs.writeFileSync(path.join(fuera, n), "x");
    fs.mkdirSync(path.join(fuera, "job-viejo"));
    // 1) `_render` entero es una junction hacia una carpeta con un «job» viejo sin marca.
    const a = path.join(RAIZ, "video771");
    fs.mkdirSync(a, { recursive: true });
    fs.symlinkSync(fuera, path.join(a, "_render"), "junction");
    // 2) `_render` real con un `<job>` que es una junction hacia una carpeta con contenido.
    const objetivo = fs.mkdtempSync(path.join(F.dir, "objetivo "));
    fs.writeFileSync(path.join(objetivo, "intocable.txt"), "x");
    fs.mkdirSync(path.join(RAIZ, "video772", "_render"), { recursive: true });
    fs.symlinkSync(objetivo, path.join(RAIZ, "video772", "_render", "job-enlace"), "junction");
    const viejo = new Date(Date.now() - 60 * 60_000);
    for (const d of [fuera, path.join(fuera, "job-viejo"), objetivo]) fs.utimesSync(d, viejo, viejo);
    barrerRenderHuerfanos(RAIZ);
    expect(fs.readdirSync(fuera).sort()).toEqual(["job-dentro.txt", "job-viejo"]);
    expect(fs.readdirSync(objetivo)).toEqual(["intocable.txt"]);
  });
});
