// T7: recursos normalizados (foto → PNG, clip → MP4 H.264 sin audio, música → M4A AAC) con los límites de I15 antes de decodificar.
// Los fixtures hostiles se generan aquí con el ffmpeg del entorno y solo con encoders que el build LGPL trae (png, aac, h264_*):
// si no hay ningún codificador H.264, los tests de clips FALLAN (I11), no se saltan.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Espía de `ejecutar`: la implementación real se conserva y se cuenta qué se lanza (los límites tienen que cortar ANTES de ffmpeg).
const lanzados: string[][] = [];
vi.mock("../src/proceso.js", async (orig) => {
  const m = await orig<typeof import("../src/proceso.js")>();
  return { ...m, ejecutar: (c: string, a: string[], o: Parameters<typeof m.ejecutar>[2]) => (lanzados.push([c, ...a]), m.ejecutar(c, a, o)) };
});

import type { Config } from "../src/config.js";
import { nombreRecursoSeguro } from "../src/esquema.js";
import { ErrorAlmacen, guionGuardar, proyectoCrear, proyectoGuardar, proyectoLeer } from "../src/proyecto.js";
import { ejecutar, herramientasFfmpeg } from "../src/proceso.js";
import {
  LIMITES_MEDIO,
  borrarRecurso,
  carpetaBandeja,
  dimensionesImagen,
  identificarMedio,
  importarRecurso,
  musicaImportar,
  musicaListar,
} from "../src/recursos.js";
import { recursoBorrarTool, recursoImportarTool } from "../src/herramientas-proyecto.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "video recursos "));
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

const ffmpeg = herramientasFfmpeg(undefined);
const requiere = it.skipIf(!ffmpeg);
const ffLanzados = () => lanzados.filter((l) => /ffmpeg|ffprobe/i.test(path.basename(l[0])));

let RAIZ = "";
let n = 0;
const cfg = (): Config => ({ elevenApiKey: undefined, elevenVoiceId: undefined, elevenModelId: "m", videoRoot: RAIZ, musicaVolumen: 0.12, ffmpegDir: undefined });
beforeEach(() => {
  RAIZ = path.join(BASE, `caso${++n}`, "proyectos");
  fs.mkdirSync(RAIZ, { recursive: true });
  lanzados.length = 0;
});

const GUION = {
  version: 1,
  titulo: "La final",
  gancho: "Dos goles.",
  escenas: [
    { frases: ["Minuto noventa."], base: { tipo: "cartel", texto: "Minuto 90" } },
    { frases: ["Llegó el empate."], base: { tipo: "cifra", valor: 1, prefijo: "", sufijo: " gol", decimales: 0 } },
    { frases: ["Y el final."], base: { tipo: "titulo3d", texto: "FIN" } },
  ],
  opciones: { fondo: "aurora", look: "normal", subtitulos: "karaoke", destellos: [0] },
};
const crearProyecto = (): string => {
  const { id: guionId } = guionGuardar(RAIZ, { guion: JSON.parse(JSON.stringify(GUION)) });
  return proyectoCrear(RAIZ, { guionId, perfilId: "defecto" }).id;
};

/** Deja `datos` en la bandeja como lo haría el comando nativo (T13): `<estado>/video/bandeja/<32hex>.bin`. */
let contador = 0;
function bandeja(datos: Buffer | string): string {
  const dir = carpetaBandeja(RAIZ);
  fs.mkdirSync(dir, { recursive: true });
  const id = (++contador).toString(16).padStart(32, "0");
  fs.writeFileSync(path.join(dir, `${id}.bin`), datos);
  return id;
}
const enBandeja = (id: string) => fs.existsSync(path.join(carpetaBandeja(RAIZ), `${id}.bin`));

async function falla(p: Promise<unknown> | (() => unknown)): Promise<ErrorAlmacen> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorAlmacen);
    return e as ErrorAlmacen;
  }
  throw new Error("se esperaba un ErrorAlmacen");
}
const codigos = (e: ErrorAlmacen) => e.problemas.map((p) => p.codigo);

// ---------- Fixtures ----------

const F = path.join(BASE, "fixtures");
const fx = (nombre: string) => path.join(F, nombre);
async function ff(args: string[]): Promise<void> {
  const r = await ejecutar(ffmpeg!.ffmpeg, ["-y", "-v", "error", ...args], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`ffmpeg falló: ${r.stderr.slice(-300)}`);
}
/** Primer codificador H.264 que funcione aquí (de los que admite el motor). Ninguno: error visible, no skip. */
async function h264(): Promise<string> {
  for (const c of ["h264_nvenc", "h264_amf", "h264_qsv", "h264_mf"]) {
    const r = await ejecutar(ffmpeg!.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=5:d=1", "-c:v", c, "-f", "null", "-"], { timeoutMs: 60_000 });
    if (r.code === 0) return c;
  }
  throw new Error("Ningún codificador H.264 LGPL (h264_nvenc, h264_amf, h264_qsv, h264_mf) funciona en esta máquina: no se pueden generar clips de prueba (I11).");
}

const TABLA_CRC = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const zlibCrc32 = (b: Buffer): number => (b.reduce((c, x) => TABLA_CRC[(c ^ x) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

/** PNG de 1 píxel cuya cabecera IHDR dice `ancho`×`alto`: basta para probar los límites, que se leen antes de decodificar. */
function pngMentiroso(ancho: number, alto: number): Buffer {
  const trozo = (tipo: string, datos: Buffer) => {
    const t = Buffer.concat([Buffer.from(tipo, "latin1"), datos]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(datos.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlibCrc32(t));
    return Buffer.concat([len, t, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo("IHDR", ihdr), trozo("IDAT", Buffer.alloc(8)), trozo("IEND", Buffer.alloc(0))]);
}

let cod = "";
beforeAll(async () => {
  fs.mkdirSync(F, { recursive: true });
  if (!ffmpeg) return;
  await ff(["-f", "lavfi", "-i", "testsrc2=s=200x300", "-frames:v", "1", fx("pequena.png")]);
  await ff(["-f", "lavfi", "-i", "testsrc2=s=1080x1920", "-frames:v", "1", fx("buena.png")]);
  await ff(["-f", "lavfi", "-i", "testsrc2=s=5000x600", "-frames:v", "1", fx("ancha.png")]);
  await ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "aac", "-f", "mp4", fx("tono.m4a")]);
  await ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "pcm_s16le", "-ar", "22050", fx("tono.wav")]);
  await ff(["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1000", "-c:a", "aac", "-b:a", "16k", "-f", "mp4", fx("larga.m4a")]);
  cod = await h264();
  await ff(["-f", "lavfi", "-i", "testsrc2=s=270x480:r=30:d=1", "-f", "lavfi", "-i", "sine=duration=1", "-c:v", cod, "-c:a", "aac", "-shortest", fx("vertical.mp4")]);
  await ff(["-f", "lavfi", "-i", "testsrc2=s=480x270:r=30:d=1", "-c:v", cod, fx("horizontal.mp4")]);
  await ff(["-f", "lavfi", "-i", "testsrc2=s=270x480:r=120:d=1", "-c:v", cod, fx("fps120.mp4")]);
  // Dos horas reales a 1 fps (7200 fotogramas de 320×240): unos segundos de codificación.
  await ff(["-f", "lavfi", "-i", "color=c=red:s=320x240:r=1:d=7200", "-c:v", cod, fx("dos_horas.mp4")]);
}, 300_000);

// ---------- Identificación por bytes ----------

describe("identificarMedio (bytes iniciales, nunca la extensión)", () => {
  const b = (...x: (number | string)[]) => Buffer.concat(x.map((v) => (typeof v === "string" ? Buffer.from(v, "latin1") : Buffer.from([v]))));
  it("reconoce cada formato admitido", () => {
    expect(identificarMedio(pngMentiroso(1, 1))).toBe("png");
    expect(identificarMedio(b(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toBe("jpeg");
    expect(identificarMedio(b("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toBe("webp");
    expect(identificarMedio(b("RIFF", 0, 0, 0, 0, "WAVEfmt "))).toBe("wav");
    expect(identificarMedio(b(0, 0, 0, 0x18, "ftypisom", 0, 0, 2, 0))).toBe("mp4");
    expect(identificarMedio(b(0, 0, 0, 0x18, "ftypM4A ", 0, 0, 0, 0))).toBe("mp4");
    expect(identificarMedio(b("ID3", 4, 0))).toBe("mp3");
    expect(identificarMedio(b("OggS", 0, 2))).toBe("ogg");
    expect(identificarMedio(b("fLaC", 0, 0))).toBe("flac");
    expect(identificarMedio(b(0x1a, 0x45, 0xdf, 0xa3, 0x9f))).toBe("matroska");
  });
  it("no reconoce listas HLS, de concatenación, scripts ni texto", () => {
    for (const t of ["#EXTM3U\n#EXTINF:1,\nfile:///c:/secreto.png\n", "ffconcat version 1.0\nfile 'x.mp4'\n", "<html></html>", "MZ\x90\x00", ""]) {
      expect(identificarMedio(Buffer.from(t, "latin1")), JSON.stringify(t)).toBeUndefined();
    }
  });
});

describe("dimensionesImagen (cabeceras, sin decodificar)", () => {
  it("PNG, JPEG (SOF) y WebP (VP8X, VP8L, VP8)", () => {
    expect(dimensionesImagen(pngMentiroso(20000, 30000), "png")).toEqual({ ancho: 20000, alto: 30000 });
    const sof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x4e, 0x20, 0x4e, 0x20, 1, 1, 0x11, 0, 0xff, 0xd9]);
    expect(dimensionesImagen(sof, "jpeg")).toEqual({ ancho: 20000, alto: 20000 });
    const vp8x = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8X", "latin1"), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0x0f, 0x27, 0x00, 0x1f, 0x4e, 0x00])]);
    expect(dimensionesImagen(vp8x, "webp")).toEqual({ ancho: 10000, alto: 20000 });
  });
  it("cabecera truncada o sin SOF: undefined (se rechaza)", () => {
    expect(dimensionesImagen(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "jpeg")).toBeUndefined();
    expect(dimensionesImagen(pngMentiroso(1, 1).subarray(0, 20), "png")).toBeUndefined();
  });
});

describe("nombreRecursoSeguro", () => {
  it("solo el nombre, recortado y sin rutas", () => {
    expect(nombreRecursoSeguro("C:\\Users\\Marc\\foto.png")).toBe("foto.png");
    expect(nombreRecursoSeguro("../../etc/passwd")).toBe("passwd");
    expect(nombreRecursoSeguro("a".repeat(500)).length).toBe(120);
    expect(nombreRecursoSeguro("x\u202Eexe.png")).toBe("recurso");
    expect(nombreRecursoSeguro("http://malo.example/x.png")).toBe("x.png"); // solo la última parte
    expect(nombreRecursoSeguro(42)).toBe("recurso");
  });
});

// ---------- Importar ----------

describe("foto", () => {
  requiere("foto_pequena_avisa: PNG normalizado, en recursos/ y registrado con la revisión siguiente", async () => {
    const id = crearProyecto();
    const antes = proyectoLeer(RAIZ, id).proyecto.revision;
    const b = bandeja(fs.readFileSync(fx("pequena.png")));
    const r = await importarRecurso(cfg(), { id, bandejaId: b, clase: "foto", nombreOriginal: "estadio.jpg" });
    expect(r.recurso).toMatchObject({ clase: "foto", ext: "png", nombreOriginal: "estadio.jpg", ancho: 200, alto: 300, duracion: 0 });
    expect(r.recurso.id).toMatch(/^r-[0-9a-f]{16}$/);
    expect(r.avisos.map((a) => a.codigo)).toContain("foto_pequena");
    expect(r.revision).toBe(antes + 1);
    const fichero = path.join(RAIZ, id, "recursos", `${r.recurso.id}.png`);
    expect(identificarMedio(fs.readFileSync(fichero).subarray(0, 64))).toBe("png");
    expect(proyectoLeer(RAIZ, id).proyecto.recursos).toEqual([r.recurso]);
    expect(enBandeja(b)).toBe(false);
    expect(fs.readdirSync(path.join(RAIZ, id, "recursos"))).toEqual([`${r.recurso.id}.png`]); // sin restos de trabajo
  }, 60_000);

  requiere("una foto de 1080×1920 no avisa; una de 5000×600 baja a 3840 de lado", async () => {
    const id = crearProyecto();
    const buena = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("buena.png"))), clase: "foto" });
    expect(buena.avisos.map((a) => a.codigo)).not.toContain("foto_pequena");
    expect(buena.recurso).toMatchObject({ ancho: 1080, alto: 1920 });
    const ancha = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("ancha.png"))), clase: "foto" });
    expect(ancha.recurso.ancho).toBe(3840);
    expect(ancha.recurso.alto).toBeGreaterThanOrEqual(460);
    expect(ancha.recurso.alto).toBeLessThanOrEqual(461);
  }, 60_000);

  it("png_20000: la cabecera dice 20000×20000 y se rechaza sin lanzar ffmpeg ni ffprobe", async () => {
    const id = crearProyecto();
    const b = bandeja(pngMentiroso(20000, 20000));
    const e = await falla(importarRecurso(cfg(), { id, bandejaId: b, clase: "foto" }));
    expect(codigos(e)).toContain("limite_excedido");
    expect(ffLanzados()).toEqual([]);
    expect(enBandeja(b)).toBe(false);
    expect(proyectoLeer(RAIZ, id).proyecto.recursos).toEqual([]);
  });

  it("más de 40 Mpx (8000×6000) o más de 8192 px de lado: rechazadas antes de decodificar", async () => {
    const id = crearProyecto();
    for (const [w, h] of [[8000, 6000], [8193, 10]]) {
      const e = await falla(importarRecurso(cfg(), { id, bandejaId: bandeja(pngMentiroso(w, h)), clase: "foto" }));
      expect(codigos(e), `${w}x${h}`).toContain("limite_excedido");
    }
    expect(ffLanzados()).toEqual([]);
  });

  it("una foto de más de 50 MB se rechaza por tamaño, antes de decodificar", async () => {
    const id = crearProyecto();
    const grande = Buffer.concat([pngMentiroso(10, 10), Buffer.alloc(LIMITES_MEDIO.foto.bytes)]);
    const e = await falla(importarRecurso(cfg(), { id, bandejaId: bandeja(grande), clase: "foto" }));
    expect(e.codigo).toBe("demasiado_grande");
    expect(ffLanzados()).toEqual([]);
  });
});

describe("clip", () => {
  requiere("MP4 H.264 sin audio: el audio se descarta y el codificador queda registrado", async () => {
    const id = crearProyecto();
    const r = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("vertical.mp4"))), clase: "clip", nombreOriginal: "gol.mov" });
    expect(r.recurso).toMatchObject({ clase: "clip", ext: "mp4", ancho: 270, alto: 480 });
    expect(r.recurso.duracion).toBeGreaterThan(0.8);
    const fichero = path.join(RAIZ, id, "recursos", `${r.recurso.id}.mp4`);
    const j = JSON.parse((await ejecutar(ffmpeg!.ffprobe, ["-v", "error", "-print_format", "json", "-show_streams", fichero], { timeoutMs: 30_000 })).stdout);
    expect(j.streams.map((s: { codec_type: string }) => s.codec_type)).toEqual(["video"]);
    expect(j.streams[0].codec_name).toBe("h264");
    expect(r.codificador).toMatch(/^h264_(nvenc|amf|qsv|mf)$/);
    // Nunca libx264: el motor solo nombra encoders LGPL.
    expect(ffLanzados().some((l) => l.includes("libx264"))).toBe(false);
  }, 120_000);

  requiere("un clip horizontal deja además el fotograma fijo para el fondo desenfocado (M-D7)", async () => {
    const id = crearProyecto();
    const r = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("horizontal.mp4"))), clase: "clip" });
    const dir = path.join(RAIZ, id, "recursos");
    expect(fs.readdirSync(dir).sort()).toEqual([`${r.recurso.id}.fondo.png`, `${r.recurso.id}.mp4`]);
    borrarRecurso(cfg(), { id, recursoId: r.recurso.id });
    expect(fs.readdirSync(dir)).toEqual([]);
  }, 120_000);

  requiere("clip_2h: dura unas 2 horas y se rechaza por duración", async () => {
    const id = crearProyecto();
    const e = await falla(importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("dos_horas.mp4"))), clase: "clip" }));
    expect(codigos(e)).toContain("limite_excedido");
    expect(fs.readdirSync(path.join(RAIZ, id, "recursos"))).toEqual([]);
  }, 60_000);

  requiere("120 fps: rechazado por la tasa de fotogramas", async () => {
    const id = crearProyecto();
    const e = await falla(importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("fps120.mp4"))), clase: "clip" }));
    expect(codigos(e)).toContain("limite_excedido");
  }, 60_000);

  requiere("sin_codificador_h264: si ningún codificador funciona, error visible y nada a medias (I11)", async () => {
    const id = crearProyecto();
    const bd = bandeja(fs.readFileSync(fx("vertical.mp4")));
    const e = await falla(importarRecurso(cfg(), { id, bandejaId: bd, clase: "clip" }, { candidatos: async () => ["h264_que_no_existe"] }));
    expect(codigos(e)).toContain("sin_codificador");
    expect(fs.readdirSync(path.join(RAIZ, id, "recursos"))).toEqual([]);
    expect(proyectoLeer(RAIZ, id).proyecto.recursos).toEqual([]);
  }, 60_000);
});

describe("música", () => {
  requiere("recurso de clase música: M4A AAC; y biblioteca con video_musica_importar / _listar", async () => {
    const id = crearProyecto();
    const r = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("tono.wav"))), clase: "musica", nombreOriginal: "tono.mp3" });
    expect(r.recurso).toMatchObject({ clase: "musica", ext: "m4a", alto: 1, ancho: 1 });
    expect(r.recurso.duracion).toBeGreaterThan(1.8);
    const p = await musicaImportar(cfg(), { bandejaId: bandeja(fs.readFileSync(fx("tono.m4a"))), nombreOriginal: "ritmo.m4a" });
    expect(p.pista).toMatchObject({ nombre: "ritmo.m4a" });
    expect(p.pista.id).toMatch(/^m-[0-9a-f]{16}$/);
    const lista = musicaListar(cfg());
    expect(lista.pistas.map((x) => x.id)).toEqual([p.pista.id]);
    expect(Object.keys(lista.pistas[0]).sort()).toEqual(["duracion", "id", "nombre"]); // sin rutas (I6)
  }, 120_000);

  requiere("más de 15 minutos: rechazada por duración", async () => {
    const e = await falla(musicaImportar(cfg(), { bandejaId: bandeja(fs.readFileSync(fx("larga.m4a"))) }));
    expect(codigos(e)).toContain("limite_excedido");
  }, 60_000);
});

// ---------- Negativas de formato ----------

describe("formato", () => {
  it("mp4_que_es_hls_o_concat: listas que referencian ficheros ajenos no se abren (ffmpeg no se lanza)", async () => {
    const id = crearProyecto();
    const secreto = path.join(BASE, "secreto.png");
    fs.writeFileSync(secreto, pngMentiroso(1, 1));
    const hls = `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nfile:///${secreto.replace(/\\/g, "/")}\n#EXT-X-ENDLIST\n`;
    const concat = `ffconcat version 1.0\nfile '${secreto.replace(/\\/g, "/")}'\n`;
    for (const contenido of [hls, concat, `\uFEFF${hls}`]) {
      for (const clase of ["clip", "foto", "musica"] as const) {
        const b = bandeja(contenido);
        const e = await falla(importarRecurso(cfg(), { id, bandejaId: b, clase, nombreOriginal: "video.mp4" }));
        expect(codigos(e), clase).toContain("formato_no_admitido");
        expect(enBandeja(b)).toBe(false);
      }
    }
    expect(ffLanzados()).toEqual([]);
    expect(fs.readdirSync(path.join(RAIZ, id, "recursos"))).toEqual([]);
  });

  requiere("extension_mentirosa: manda el contenido; el nombre solo es texto", async () => {
    const id = crearProyecto();
    // PNG de verdad con nombre .exe: se importa como PNG.
    const ok = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("pequena.png"))), clase: "foto", nombreOriginal: "foto.exe" });
    expect(ok.recurso.ext).toBe("png");
    // Texto con nombre .png: rechazado. PNG pedido como clip, WAV pedido como foto: rechazados.
    expect(codigos(await falla(importarRecurso(cfg(), { id, bandejaId: bandeja("no soy una imagen"), clase: "foto", nombreOriginal: "foto.png" })))).toContain("formato_no_admitido");
    expect(codigos(await falla(importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("pequena.png"))), clase: "clip", nombreOriginal: "x.mp4" })))).toContain("clase_distinta");
    expect(codigos(await falla(importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("tono.wav"))), clase: "foto", nombreOriginal: "x.png" })))).toContain("clase_distinta");
  }, 60_000);

  requiere("nombre_original_con_html: queda como texto de UI, recortado y sin rutas", async () => {
    const id = crearProyecto();
    const sucio = `<img src=x onerror=alert(1)>${"a".repeat(300)}.png`;
    const r = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("pequena.png"))), clase: "foto", nombreOriginal: sucio });
    expect(r.recurso.nombreOriginal.length).toBeLessThanOrEqual(120);
    const r2 = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("pequena.png"))), clase: "foto", nombreOriginal: "C:\\Users\\Marc\\..\\foto.png" });
    expect(r2.recurso.nombreOriginal).toBe("foto.png");
    // En disco el fichero se llama por el id, nunca por el nombre del usuario.
    expect(fs.readdirSync(path.join(RAIZ, id, "recursos")).every((f) => /^r-[0-9a-f]{16}\./.test(f))).toBe(true);
  }, 60_000);
});

// ---------- Bandeja ----------

describe("bandeja", () => {
  requiere("bandeja_un_solo_uso: la entrada se consume; usarla otra vez es no_encontrado", async () => {
    const id = crearProyecto();
    const b = bandeja(fs.readFileSync(fx("pequena.png")));
    await importarRecurso(cfg(), { id, bandejaId: b, clase: "foto" });
    expect(enBandeja(b)).toBe(false);
    expect((await falla(importarRecurso(cfg(), { id, bandejaId: b, clase: "foto" }))).codigo).toBe("no_encontrado");
  }, 60_000);

  requiere("dos importaciones a la vez de la misma entrada: solo una gana", async () => {
    const id = crearProyecto();
    const b = bandeja(fs.readFileSync(fx("pequena.png")));
    const r = await Promise.allSettled([importarRecurso(cfg(), { id, bandejaId: b, clase: "foto" }), importarRecurso(cfg(), { id, bandejaId: b, clase: "foto" })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(proyectoLeer(RAIZ, id).proyecto.recursos).toHaveLength(1);
  }, 60_000);

  it("bandeja_id_invalido: solo 32 hexadecimales en minúscula", async () => {
    const id = crearProyecto();
    for (const malo of ["../" + "a".repeat(29), "A".repeat(32), "a".repeat(31), "a".repeat(33), "a".repeat(32) + ".bin", "C:\\Users\\x\\foto.png", "", "a/".repeat(16), 7 as never, null as never]) {
      const e = await falla(importarRecurso(cfg(), { id, bandejaId: malo, clase: "foto" }));
      expect(codigos(e), String(malo)).toContain("bandeja_id_invalido");
    }
    expect(ffLanzados()).toEqual([]);
  });

  it("una entrada que no existe es no_encontrado; una clase o un proyecto malos, esquema o no_encontrado", async () => {
    const id = crearProyecto();
    expect((await falla(importarRecurso(cfg(), { id, bandejaId: "b".repeat(32), clase: "foto" }))).codigo).toBe("no_encontrado");
    expect((await falla(importarRecurso(cfg(), { id, bandejaId: bandeja("x"), clase: "exe" as never }))).codigo).toBe("esquema");
    expect((await falla(importarRecurso(cfg(), { id: "video999", bandejaId: bandeja("x"), clase: "foto" }))).codigo).toBe("no_encontrado");
    expect((await falla(importarRecurso(cfg(), { id: "../x", bandejaId: bandeja("x"), clase: "foto" }))).codigo).toBe("esquema");
  });
});

describe("enlaces (I6)", () => {
  it("symlink_hardlink_junction_rechazados: hardlink en la bandeja", async () => {
    const id = crearProyecto();
    const ajeno = path.join(BASE, "ajeno.png");
    fs.writeFileSync(ajeno, pngMentiroso(10, 10));
    fs.mkdirSync(carpetaBandeja(RAIZ), { recursive: true });
    const b = "c".repeat(32);
    fs.linkSync(ajeno, path.join(carpetaBandeja(RAIZ), `${b}.bin`));
    const e = await falla(importarRecurso(cfg(), { id, bandejaId: b, clase: "foto" }));
    expect(codigos(e)).toContain("enlace_no_permitido");
    expect(fs.existsSync(ajeno)).toBe(true); // no se toca el fichero ajeno
    expect(ffLanzados()).toEqual([]);
  });

  it("symlink_hardlink_junction_rechazados: la entrada es un enlace simbólico", async () => {
    const id = crearProyecto();
    const ajeno = path.join(BASE, "ajeno2.png");
    fs.writeFileSync(ajeno, pngMentiroso(10, 10));
    fs.mkdirSync(carpetaBandeja(RAIZ), { recursive: true });
    const b = "d".repeat(32);
    try {
      fs.symlinkSync(ajeno, path.join(carpetaBandeja(RAIZ), `${b}.bin`), "file");
    } catch (e) {
      // Windows sin modo desarrollador: crear un symlink exige privilegio. Se anota; el caso de la junction de abajo no lo necesita.
      console.warn(`symlink de fichero no creable aquí (${(e as NodeJS.ErrnoException).code}): caso no ejercitado`);
      return;
    }
    expect(codigos(await falla(importarRecurso(cfg(), { id, bandejaId: b, clase: "foto" })))).toContain("enlace_no_permitido");
    expect(fs.existsSync(ajeno)).toBe(true);
  });

  it("symlink_hardlink_junction_rechazados: la carpeta de la bandeja es una junction", async () => {
    const id = crearProyecto();
    const fuera = path.join(BASE, "fuera-bandeja");
    fs.mkdirSync(fuera, { recursive: true });
    const b = "e".repeat(32);
    fs.writeFileSync(path.join(fuera, `${b}.bin`), pngMentiroso(10, 10));
    fs.mkdirSync(path.dirname(carpetaBandeja(RAIZ)), { recursive: true });
    fs.symlinkSync(fuera, carpetaBandeja(RAIZ), "junction");
    expect(codigos(await falla(importarRecurso(cfg(), { id, bandejaId: b, clase: "foto" })))).toContain("enlace_no_permitido");
    expect(fs.existsSync(path.join(fuera, `${b}.bin`))).toBe(true); // ni se consume ni se borra lo de fuera
    expect(ffLanzados()).toEqual([]);
  });

  it("symlink_hardlink_junction_rechazados: recursos/ del proyecto es una junction: no se escribe fuera", async () => {
    const id = crearProyecto();
    const fuera = path.join(BASE, "fuera-recursos");
    fs.mkdirSync(fuera, { recursive: true });
    fs.rmSync(path.join(RAIZ, id, "recursos"), { recursive: true });
    fs.symlinkSync(fuera, path.join(RAIZ, id, "recursos"), "junction");
    const e = await falla(importarRecurso(cfg(), { id, bandejaId: bandeja(pngMentiroso(10, 10)), clase: "foto" }));
    expect(e.codigo).toBe("esquema");
    expect(codigos(e)).toContain("enlace_no_permitido");
    expect(fs.readdirSync(fuera)).toEqual([]);
  });
});

// ---------- Borrar ----------

describe("recurso_en_uso", () => {
  requiere("una escena con capa lo usa: en_uso y el fichero se conserva; sin capa se borra", async () => {
    const id = crearProyecto();
    const r = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("pequena.png"))), clase: "foto" });
    const { proyecto } = proyectoLeer(RAIZ, id);
    proyecto.escenas[0].capa = { recursoId: r.recurso.id, modo: "encima", encuadre: "zoom", entrada: 0, salida: 2 };
    proyectoGuardar(RAIZ, { id, revision: proyecto.revision, proyecto });
    const fichero = path.join(RAIZ, id, "recursos", `${r.recurso.id}.png`);

    expect((await falla(() => borrarRecurso(cfg(), { id, recursoId: r.recurso.id }))).codigo).toBe("en_uso");
    expect(fs.existsSync(fichero)).toBe(true);
    expect(proyectoLeer(RAIZ, id).proyecto.recursos).toHaveLength(1);

    const otra = proyectoLeer(RAIZ, id).proyecto;
    delete otra.escenas[0].capa;
    proyectoGuardar(RAIZ, { id, revision: otra.revision, proyecto: otra });
    const antes = proyectoLeer(RAIZ, id).proyecto.revision;
    const b = borrarRecurso(cfg(), { id, recursoId: r.recurso.id });
    expect(b.revision).toBe(antes + 1);
    expect(fs.existsSync(fichero)).toBe(false);
    expect(proyectoLeer(RAIZ, id).proyecto.recursos).toEqual([]);
  }, 60_000);

  it("un recurso que no existe es no_encontrado; un id malo, esquema", async () => {
    const id = crearProyecto();
    expect((await falla(() => borrarRecurso(cfg(), { id, recursoId: "r-" + "0".repeat(16) }))).codigo).toBe("no_encontrado");
    expect((await falla(() => borrarRecurso(cfg(), { id, recursoId: "../x" }))).codigo).toBe("esquema");
  });
});

describe("tools", () => {
  requiere("video_recurso_importar y _borrar devuelven datos sin rutas", async () => {
    const id = crearProyecto();
    const r = await recursoImportarTool(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("pequena.png"))), clase: "foto", nombreOriginal: "a.png" });
    expect(JSON.stringify(r.datos)).not.toContain(BASE.replace(/\\/g, "\\\\"));
    const rid = (r.datos as { recurso: { id: string } }).recurso.id;
    expect(recursoBorrarTool(cfg(), { id, recursoId: rid }).texto).toMatch(/borrado/i);
  }, 60_000);
});

describe("cierres de la revisión 1 de seguridad (M-1, M-2, L-2, L-5)", () => {
  requiere("M-1: la foto y el clip se decodifican con -max_pixels (el decodificador no se fía de la cabecera)", async () => {
    const id = crearProyecto();
    await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("pequena.png"))), clase: "foto" });
    const f = ffLanzados().find((l) => l.includes("-frames:v") && l.includes("image2"));
    expect(f).toBeDefined();
    expect(Number(f![f!.indexOf("-max_pixels") + 1])).toBeGreaterThanOrEqual(LIMITES_MEDIO.foto.pixeles);
    expect(f!.indexOf("-max_pixels")).toBeLessThan(f!.indexOf("-i"));
    lanzados.length = 0;
    await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("vertical.mp4"))), clase: "clip" });
    const c = ffLanzados().find((l) => l.includes("-fps_mode"));
    expect(c![c!.indexOf("-max_pixels") + 1]).toBe(String(LIMITES_MEDIO.clip.lado ** 2));
  }, 60_000);

  it("M-1: ffmpeg rechaza un fotograma por encima de -max_pixels aunque la cabecera diga otra cosa", async () => {
    const r = await ejecutar(ffmpeg!.ffmpeg, ["-v", "error", "-max_pixels", "100", "-i", fx("pequena.png"), "-f", "null", "-"], { timeoutMs: 30_000 });
    expect(r.stderr).toMatch(/max pixel count/);
  });

  it("L-2: un .uso-* huérfano de más de una hora se limpia; uno reciente se respeta", async () => {
    const id = crearProyecto();
    const dir = carpetaBandeja(RAIZ);
    fs.mkdirSync(dir, { recursive: true });
    const viejo = path.join(dir, `${"a".repeat(32)}.uso-aaaaaaaaaaaa`);
    const nuevo = path.join(dir, `${"b".repeat(32)}.uso-bbbbbbbbbbbb`);
    fs.writeFileSync(viejo, "x");
    fs.writeFileSync(nuevo, "x");
    const hace2h = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(viejo, hace2h, hace2h);
    await falla(importarRecurso(cfg(), { id, bandejaId: bandeja(Buffer.from("no es un medio")), clase: "foto" })); // consume y limpia
    expect(fs.existsSync(viejo)).toBe(false);
    expect(fs.existsSync(nuevo)).toBe(true);
  });

  requiere("L-5: borrar un recurso con recursos/ convertido en enlace se rechaza y no toca el destino", async () => {
    const id = crearProyecto();
    const r = await importarRecurso(cfg(), { id, bandejaId: bandeja(fs.readFileSync(fx("pequena.png"))), clase: "foto" });
    const dir = path.join(RAIZ, id, "recursos");
    const ajeno = path.join(BASE, "ajeno-recursos");
    fs.mkdirSync(ajeno);
    fs.writeFileSync(path.join(ajeno, `${r.recurso.id}.png`), "intacto");
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(ajeno, dir, "junction");
    const e = await falla(() => borrarRecurso(cfg(), { id, recursoId: r.recurso.id }));
    expect(codigos(e)).toContain("enlace_no_permitido");
    expect(fs.readFileSync(path.join(ajeno, `${r.recurso.id}.png`), "utf8")).toBe("intacto");
    fs.rmdirSync(dir); // quita solo la junction
  });
});

describe("ffmpeg en CI", () => {
  it("en CI hay ffmpeg (si no, los tests de medios se saltarían en silencio)", () => {
    if (process.env.CI) expect(ffmpeg).not.toBeNull();
  });
});
