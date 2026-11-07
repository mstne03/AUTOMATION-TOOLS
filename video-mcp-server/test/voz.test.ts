// T5: voz por frases. ElevenLabs siempre simulado (fetch inyectado): ninguna prueba toca la red. El audio de prueba
// es un MP3 de verdad generado con el ffmpeg local, porque el motor lo sondea con ffprobe antes de guardarlo (I15).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { ejecutar, herramientasFfmpeg, hfHome, sondear } from "../src/proceso.js";
import { ErrorAlmacen, guionGuardar, proyectoCrear, proyectoGuardar, proyectoLeer } from "../src/proyecto.js";
import {
  MUESTRA_CARACTERES,
  ensamblarVoz,
  hashFrase,
  silencios,
  vozCoste,
  vozForma,
  vozGenerar as vozGenerarReal,
  vozMuestra as vozMuestraReal,
  cabeceraMp3Valida,
  carpetaMuestras,
  planMuestra,
  vozQuitarSilencios,
  voces,
} from "../src/voz.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "video voz "));
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

const CLAVE = "sk-secreta-de-prueba";
const VOZ = "Vz12345678AB";
let RAIZ = "";
let n = 0;
const cfg = (): Config => ({
  elevenApiKey: CLAVE,
  elevenVoiceId: VOZ,
  elevenModelId: "eleven_multilingual_v2",
  videoRoot: RAIZ,
  musicaVolumen: 0.12,
  ffmpegDir: undefined,
});

// Los hijos del motor solo se lanzan donde `hfHome()` acepta la ruta (hoy, Windows: rechaza las rutas POSIX). Donde no, las
// pruebas que necesitan ffmpeg se saltan, como el resto de la batería con ffmpeg real, en vez de fallar por el entorno.
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
let mp3: Buffer = Buffer.alloc(0);
beforeAll(async () => {
  if (!ffmpeg) return;
  const ruta = path.join(BASE, "base.mp3");
  const r = await ejecutar(ffmpeg.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "libmp3lame", ruta], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr);
  mp3 = fs.readFileSync(ruta);
}, 60_000);

// La confirmación lleva el plan que mostró `vozCoste`; las pruebas lo piden en vivo salvo que fijen el suyo.
const vozGenerar = (c: Config, a: any, f?: typeof fetch) => vozGenerarReal(c, { planConfirmado: vozCoste(c, a.id, a.frases).plan, ...a }, f);
const vozMuestra = (c: Config, a: any, f?: typeof fetch) => vozMuestraReal(c, { planConfirmado: planMuestra(c.elevenModelId, a.voiceId), ...a }, f);
// Las negativas que fallan antes de ffprobe (cabecera, red) solo necesitan que los binarios existan, no que hfHome() acepte la ruta.
const hayBinarios = herramientasFfmpeg(undefined);
const sinSonda = it.skipIf(!hayBinarios);

const clon = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** 4 escenas de 3 frases: 12 frases distintas (f1…f12). */
function guion12(): any {
  const frases = (e: number) => [1, 2, 3].map((k) => `Frase número ${e * 3 + k} del partido.`);
  return {
    version: 1,
    titulo: "Doce frases",
    gancho: "Doce frases.",
    escenas: [0, 1, 2, 3].map((e) => ({ frases: frases(e), base: { tipo: "cartel", texto: `Escena ${e + 1}` } })),
    opciones: { fondo: "aurora", look: "normal", subtitulos: "karaoke", destellos: [0] },
  };
}

function nuevo(): string {
  const { id: guionId } = guionGuardar(RAIZ, { guion: guion12() });
  return proyectoCrear(RAIZ, { guionId, perfilId: "defecto" }).id;
}

function editar(id: string, f: (p: any) => void): void {
  const { proyecto } = proyectoLeer(RAIZ, id);
  const p = clon(proyecto) as any;
  f(p);
  proyectoGuardar(RAIZ, { id, revision: proyecto.revision, proyecto: p });
}

interface Opc {
  audio?: Buffer;
  paso?: number;
  desplazamiento?: number;
  manipular?: (c: any) => void;
}
function respuesta(texto: string, o: Opc = {}): Response {
  const chars = [...texto];
  const paso = o.paso ?? 0.02;
  const d = o.desplazamiento ?? 0;
  const cuerpo: any = {
    audio_base64: (o.audio ?? mp3).toString("base64"),
    alignment: {
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => d + i * paso),
      character_end_times_seconds: chars.map((_, i) => d + (i + 1) * paso),
    },
    normalized_alignment: null,
  };
  o.manipular?.(cuerpo);
  return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "x-character-count": String(chars.length) } });
}

type Falso = ReturnType<typeof falso>;
function falso(comportamiento: (texto: string, llamada: number) => Response | Promise<Response> = (t) => respuesta(t)) {
  const textos: string[] = [];
  const urls: string[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    const t = (JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "";
    textos.push(t);
    return comportamiento(t, textos.length);
  });
  return Object.assign(f, { textos, urls }) as typeof f & { textos: string[]; urls: string[] };
}
const comoFetch = (f: Falso) => f as unknown as typeof fetch;

const carpetaVoz = (id: string) => path.join(RAIZ, id, "voz");
const ficherosVoz = (id: string) => (fs.existsSync(carpetaVoz(id)) ? fs.readdirSync(carpetaVoz(id)) : []);

beforeEach(() => {
  RAIZ = path.join(BASE, `caso${++n}`, "proyectos");
  fs.mkdirSync(RAIZ, { recursive: true });
});
afterEach(() => vi.restoreAllMocks());


describe("coste y fichero por frase", () => {
  it("el coste lista las frases sin voz y suma sus caracteres", () => {
    const id = nuevo();
    const c = vozCoste(cfg(), id);
    expect(c.pendientes).toEqual(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"]);
    const esperado = proyectoLeer(RAIZ, id).proyecto.frases.reduce((s, f) => s + f.texto.length, 0);
    expect(c.caracteres).toBe(esperado);
    expect(c.voz).toEqual({ voiceId: VOZ, modelo: "eleven_multilingual_v2" });
  });

  requiere("el nombre del fichero es sha256(voiceId|modelo|texto) y la frase existe si está el json", async () => {
    const id = nuevo();
    const c = vozCoste(cfg(), id);
    const f = falso();
    await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: "Frase número 1 del partido.".length }, comoFetch(f));
    const hash = createHash("sha256").update(`${VOZ}|eleven_multilingual_v2|Frase número 1 del partido.`).digest("hex");
    expect(hashFrase(VOZ, "eleven_multilingual_v2", "Frase número 1 del partido.")).toBe(hash);
    expect(ficherosVoz(id).sort()).toEqual([`${hash}.json`, `${hash}.mp3`]);
    expect(vozCoste(cfg(), id).pendientes).not.toContain("f1");
    // Sin el json, el mp3 suelto no cuenta como frase hecha.
    fs.rmSync(path.join(carpetaVoz(id), `${hash}.json`));
    expect(vozCoste(cfg(), id).pendientes).toContain("f1");
    expect(c.pendientes).toHaveLength(12);
  });
});

describe("facturación (CA3, Review Focus 2)", () => {
  requiere("una_frase_factura_una: cambiar una de 12 frases es 1 llamada y solo sus caracteres", async () => {
    const id = nuevo();
    const todo = vozCoste(cfg(), id);
    const f1 = falso();
    const r1 = await vozGenerar(cfg(), { id, caracteresConfirmados: todo.caracteres }, comoFetch(f1));
    expect(r1.generadas).toBe(12);
    expect(f1).toHaveBeenCalledTimes(12);
    expect(r1.fallo).toBeUndefined();
    expect(vozCoste(cfg(), id)).toMatchObject({ pendientes: [], caracteres: 0 });

    editar(id, (p) => (p.frases[4].texto = "Una frase distinta y nueva."));
    const c = vozCoste(cfg(), id);
    expect(c).toMatchObject({ pendientes: ["f5"], caracteres: "Una frase distinta y nueva.".length });
    const f2 = falso();
    const r2 = await vozGenerar(cfg(), { id, caracteresConfirmados: c.caracteres }, comoFetch(f2));
    expect(f2).toHaveBeenCalledTimes(1);
    expect(f2.textos).toEqual(["Una frase distinta y nueva."]);
    expect(r2).toMatchObject({ generadas: 1, caracteresFacturados: "Una frase distinta y nueva.".length });
  });

  requiere("reintento_no_refactura: un 429 en la frase 7 conserva 6 y el reintento llama solo por las restantes", async () => {
    const id = nuevo();
    const todo = vozCoste(cfg(), id);
    const f1 = falso((t, k) => (k === 7 ? new Response(JSON.stringify({ detail: { status: "too_many_requests", message: "lento" } }), { status: 429 }) : respuesta(t)));
    const r1 = await vozGenerar(cfg(), { id, caracteresConfirmados: todo.caracteres }, comoFetch(f1));
    expect(r1.generadas).toBe(6);
    expect(f1).toHaveBeenCalledTimes(7); // en serie y se corta en el primer fallo
    expect(r1.fallo).toMatchObject({ fraseId: "f7" });
    expect(r1.fallo?.mensaje).toMatch(/429/);
    expect(ficherosVoz(id)).toHaveLength(12); // 6 mp3 + 6 json, nada a medias
    const c = vozCoste(cfg(), id);
    expect(c.pendientes).toEqual(["f7", "f8", "f9", "f10", "f11", "f12"]);

    const f2 = falso();
    const r2 = await vozGenerar(cfg(), { id, caracteresConfirmados: c.caracteres }, comoFetch(f2));
    expect(f2).toHaveBeenCalledTimes(6);
    expect(f2.textos).toEqual([7, 8, 9, 10, 11, 12].map((k) => `Frase número ${k} del partido.`));
    expect(r2.generadas).toBe(6);
    expect(r2.caracteresFacturados).toBe(c.caracteres);
    expect(vozCoste(cfg(), id).pendientes).toEqual([]);
  });

  requiere("misma_frase_reutiliza: dos frases con el mismo texto son una sola llamada, y volver a un texto ya hecho no llama", async () => {
    const id = nuevo();
    editar(id, (p) => (p.frases[1].texto = p.frases[0].texto));
    const c = vozCoste(cfg(), id);
    expect(c.pendientes).toHaveLength(12); // son frases pendientes…
    const unica = proyectoLeer(RAIZ, id).proyecto.frases.reduce((s, f, i) => s + (i === 1 ? 0 : f.texto.length), 0);
    expect(c.caracteres).toBe(unica); // …pero el texto repetido se factura una vez
    const f = falso();
    const r = await vozGenerar(cfg(), { id, caracteresConfirmados: c.caracteres }, comoFetch(f));
    expect(f).toHaveBeenCalledTimes(11);
    expect(r.caracteresFacturados).toBe(unica);
    editar(id, (p) => (p.frases[1].texto = "Frase número 2 del partido."));
    expect(vozCoste(cfg(), id)).toMatchObject({ pendientes: ["f2"] });
    editar(id, (p) => (p.frases[1].texto = p.frases[0].texto));
    expect(vozCoste(cfg(), id).pendientes).toEqual([]);
  });

  requiere("reordenar_no_regenera: cambiar el orden de las frases no pide voz nueva", async () => {
    const id = nuevo();
    const f = falso();
    await vozGenerar(cfg(), { id, caracteresConfirmados: vozCoste(cfg(), id).caracteres }, comoFetch(f));
    editar(id, (p) => {
      p.frases.reverse();
      p.escenas.reverse();
    });
    expect(vozCoste(cfg(), id)).toMatchObject({ pendientes: [], caracteres: 0 });
    const f2 = falso();
    const r = await vozGenerar(cfg(), { id, caracteresConfirmados: 0 }, comoFetch(f2));
    expect(f2).toHaveBeenCalledTimes(0);
    expect(r).toMatchObject({ generadas: 0, caracteresFacturados: 0 });
  });

  it("coste_cambiado_no_llama: si los caracteres confirmados no son los del servidor, no hay ninguna llamada", async () => {
    const id = nuevo();
    const c = vozCoste(cfg(), id);
    const f = falso();
    for (const confirmados of [c.caracteres - 1, c.caracteres + 1, 0, -5, Number.NaN]) {
      await expect(vozGenerar(cfg(), { id, caracteresConfirmados: confirmados }, comoFetch(f))).rejects.toMatchObject({ codigo: "coste_cambiado" });
    }
    expect(f).toHaveBeenCalledTimes(0);
    expect(ficherosVoz(id)).toEqual([]);
    // Un subconjunto de frases cambia el coste: confirmar el total no vale.
    await expect(vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: c.caracteres }, comoFetch(f))).rejects.toBeInstanceOf(ErrorAlmacen);
    expect(f).toHaveBeenCalledTimes(0);
  });

  it("una frase que no existe, o un voiceId raro, se rechazan antes de llamar", async () => {
    const id = nuevo();
    const f = falso();
    await expect(vozGenerarReal(cfg(), { id, frases: ["f99"], caracteresConfirmados: 0, planConfirmado: "x" }, comoFetch(f))).rejects.toMatchObject({ codigo: "esquema" });
    for (const malo of ["../etc", "corta", "a/b/c/d/e/f/g/h", "x".repeat(41), "voz con espacios", "Vz12345678A?"]) {
      expect(() => vozCoste({ ...cfg(), elevenVoiceId: malo }, id)).toThrow(ErrorAlmacen);
    }
    expect(f).toHaveBeenCalledTimes(0);
  });
});

describe("respuesta hostil: no se guarda nada (D7, I15)", () => {
  const casos: [string, Opc | ((t: string) => Response), RegExp?][] = [
    ["alineacion_nan_no_guarda", { manipular: (c) => (c.alignment.character_start_times_seconds[2] = null) }, /finito|válida/],
    ["retrocede_no_guarda", { manipular: (c) => (c.alignment.character_start_times_seconds[5] = 0) }, /retroceden|válida/],
    [
      "diez_a_la_seis_caracteres",
      {
        manipular: (c) => {
          const n = 1_000_000;
          c.alignment = { characters: new Array(n).fill("a"), character_start_times_seconds: new Array(n).fill(0), character_end_times_seconds: new Array(n).fill(0) };
        },
      },
      /caracteres|válida/,
    ],
    ["audio_grande_rechazado", { audio: Buffer.alloc(11 * 1024 * 1024, 7) }, /10 MB|pasa de/],
    ["no_mp3_rechazado", { audio: Buffer.from("esto no es un mp3, es texto") }, /MP3|mp3|leer/],
  ];
  for (const [nombre, opc, patron] of casos) {
    requiere(nombre, async () => {
      const id = nuevo();
      const f = falso((t) => (typeof opc === "function" ? opc(t) : respuesta(t, opc)));
      const r = await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: "Frase número 1 del partido.".length }, comoFetch(f));
      expect(r.generadas).toBe(0);
      expect(r.fallo).toMatchObject({ fraseId: "f1" });
      expect(r.fallo?.mensaje).toMatch(patron!);
      expect(ficherosVoz(id).filter((n) => !n.endsWith(".fallo"))).toEqual([]); // ni mp3, ni json, ni temporales (la marca de cobro sí)
      expect(vozCoste(cfg(), id).pendientes).toContain("f1");
    });
  }

  requiere("una alineación que acaba más de 1 s después del audio no se guarda", async () => {
    const id = nuevo();
    const f = falso((t) => respuesta(t, { paso: 0.2 })); // 27 caracteres × 0,2 s ≈ 5 s frente a 1 s de audio
    const r = await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: 27 }, comoFetch(f));
    expect(r.fallo?.mensaje).toMatch(/alineación/);
    expect(r.fallo?.facturada).toBe(true);
    expect(ficherosVoz(id).filter((n) => !n.endsWith(".fallo"))).toEqual([]);
  });

  requiere("clave_fuera_de_error: un 401 con la clave en el cuerpo no la deja salir", async () => {
    const id = nuevo();
    const f = falso(() => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: `La clave ${CLAVE} no vale` } }), { status: 401 }));
    const r = await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: "Frase número 1 del partido.".length }, comoFetch(f));
    expect(r.fallo?.mensaje).toMatch(/401/);
    expect(JSON.stringify(r)).not.toContain(CLAVE);
  });

  requiere("la petición lleva el voiceId codificado y no sigue redirecciones", async () => {
    const id = nuevo();
    const f = falso();
    await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: "Frase número 1 del partido.".length }, comoFetch(f));
    expect(f.urls[0]).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOZ}/with-timestamps?output_format=mp3_44100_128`);
    expect((f.mock.calls[0][1] as RequestInit).redirect).toBe("error");
  });
});

describe("ensamblado, forma de onda y silencios", () => {
  async function conVoz(): Promise<string> {
    const id = nuevo();
    const f = falso((t) => respuesta(t, { desplazamiento: 0.5 })); // medio segundo de silencio al principio de cada frase
    await vozGenerar(cfg(), { id, caracteresConfirmados: vozCoste(cfg(), id).caracteres }, comoFetch(f));
    return id;
  }

  requiere("ensamblarVoz: lista concat solo con hashes y rutas relativas, y un WAV de la suma de las frases", async () => {
    const id = await conVoz();
    editar(id, (p) => (p.frases[0].texto = "No debe entrar «'; rm -rf /» ni nada raro."));
    const f = falso((t) => respuesta(t));
    await vozGenerar(cfg(), { id, caracteresConfirmados: vozCoste(cfg(), id).caracteres }, comoFetch(f));
    const wav = await ensamblarVoz(cfg(), id);
    expect(path.dirname(wav)).toBe(carpetaVoz(id));
    expect(path.basename(wav)).toMatch(/^ensamblada-[0-9a-f]{16,64}\.wav$/);
    const listas = ficherosVoz(id).filter((x) => x.endsWith(".ffconcat"));
    expect(listas).toHaveLength(1);
    const lineas = fs.readFileSync(path.join(carpetaVoz(id), listas[0]), "utf8").split("\n").filter(Boolean);
    for (const l of lineas) expect(l).toMatch(/^(ffconcat version 1\.0|file '[0-9a-f]{64}\.mp3'|inpoint \d+(\.\d+)?|outpoint \d+(\.\d+)?)$/);
    expect(lineas.filter((l) => l.startsWith("file "))).toHaveLength(12);
    expect(fs.readFileSync(path.join(carpetaVoz(id), listas[0]), "utf8")).not.toMatch(/rm -rf|partido/);
    const info = await sondear(ffmpeg!.ffprobe, wav);
    expect(info.duracion).toBeGreaterThan(11.5);
    expect(info.duracion).toBeLessThan(12.5);
    // Misma entrada, mismo fichero: no se rehace.
    expect(await ensamblarVoz(cfg(), id)).toBe(wav);
  });

  requiere("ensamblarVoz con frases sin voz: voz_pendiente con la lista", async () => {
    const id = nuevo();
    await expect(ensamblarVoz(cfg(), id)).rejects.toMatchObject({ codigo: "voz_pendiente", problemas: expect.arrayContaining([{ ruta: "f1", codigo: "voz_pendiente" }]) });
  });

  requiere("vozForma: ≤ 2000 picos entre 0 y 1 y los segundos del conjunto", async () => {
    const id = await conVoz();
    const r = await vozForma(cfg(), id);
    expect(r.picos.length).toBeGreaterThan(10);
    expect(r.picos.length).toBeLessThanOrEqual(2000);
    expect(Math.min(...r.picos)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...r.picos)).toBeLessThanOrEqual(1);
    expect(Math.max(...r.picos)).toBeGreaterThan(0.05);
    expect(r.segundos).toBeGreaterThan(11.5);
    expect(r.segundos).toBeLessThan(12.5);
  });

  it("silencios: huecos de más de 0,25 s, incluidos el inicio y el final; 0,25 exactos no cuentan", () => {
    const palabras = [
      { inicio: 0.5, fin: 0.8 },
      { inicio: 1.05, fin: 1.3 }, // hueco 0,25: no
      { inicio: 1.7, fin: 2.0 }, // hueco 0,4: sí
    ];
    expect(silencios(palabras, 2.5)).toEqual([
      { inicio: 0, fin: 0.5 },
      { inicio: 1.3, fin: 1.7 },
      { inicio: 2.0, fin: 2.5 },
    ]);
    expect(silencios([], 1)).toEqual([]);
  });

  requiere("vozQuitarSilencios: recorta el hueco inicial y lo guarda en la frase del proyecto", async () => {
    const id = await conVoz();
    const antes = proyectoLeer(RAIZ, id).proyecto;
    const r = vozQuitarSilencios(cfg(), id, "f3");
    expect(r.recorte.inicio).toBeGreaterThan(0.3);
    expect(r.recorte.inicio).toBeLessThan(0.5);
    expect(r.recorte.fin).toBeGreaterThan(r.recorte.inicio);
    const despues = proyectoLeer(RAIZ, id).proyecto;
    expect(despues.revision).toBe(antes.revision + 1);
    expect(despues.frases.find((x) => x.id === "f3")?.recorte).toEqual(r.recorte);
    expect(despues.frases.find((x) => x.id === "f4")?.recorte).toBeUndefined();
    expect(() => vozQuitarSilencios(cfg(), id, "f99")).toThrow(ErrorAlmacen);
    // El recorte entra en el ensamblado (otra lista, otro WAV, más corto).
    const wav = await ensamblarVoz(cfg(), id);
    expect((await sondear(ffmpeg!.ffprobe, wav)).duracion).toBeLessThan(11.8);
  });

  it("vozQuitarSilencios sin voz de esa frase: voz_pendiente", () => {
    const id = nuevo();
    expect(() => vozQuitarSilencios(cfg(), id, "f1")).toThrow(expect.objectContaining({ codigo: "voz_pendiente" }));
  });
});

describe("catálogo de voces y muestra (M-D3)", () => {
  const catalogo = {
    voices: [
      { voice_id: "Aa1234567890", name: "Lucía", labels: { language: "es" }, preview_url: "https://storage.googleapis.com/x/preview.mp3" },
      { voice_id: "../malo", name: "Malo" },
      { voice_id: "Bb1234567890", name: "Marc", labels: { accent: "x" } },
    ],
  };

  it("video_voces: solo ids válidos, sin preview_url, y no descarga ninguna URL", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(catalogo), { status: 200 }));
    const r = await voces(cfg(), f as unknown as typeof fetch);
    expect(r.voces).toEqual([
      { id: "Aa1234567890", nombre: "Lucía", idioma: "es", planMuestra: planMuestra("eleven_multilingual_v2", "Aa1234567890") },
      { id: "Bb1234567890", nombre: "Marc", idioma: "", planMuestra: planMuestra("eleven_multilingual_v2", "Bb1234567890") },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/preview/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls as unknown[][])[0][0])).toBe("https://api.elevenlabs.io/v1/voices");
    expect(((f.mock.calls as unknown[][])[0][1] as RequestInit).redirect).toBe("error");
  });

  it("video_voces: 401 con la clave en el cuerpo no la filtra, y un cuerpo enorme se corta", async () => {
    const f401 = vi.fn(async () => new Response(`clave ${CLAVE} mala`, { status: 401 }));
    const e = await voces(cfg(), f401 as unknown as typeof fetch).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/401/);
    expect((e as Error).message).not.toContain(CLAVE);
    const grande = vi.fn(async () => new Response(Buffer.alloc(21 * 1024 * 1024, 32), { status: 200 }));
    await expect(voces(cfg(), grande as unknown as typeof fetch)).rejects.toThrow(/20 MB/);
  });

  requiere("video_voz_muestra: 60 caracteres fijos, coste confirmado, caché por voz", async () => {
    expect(MUESTRA_CARACTERES).toBe(60);
    const f = falso();
    await expect(vozMuestra(cfg(), { voiceId: VOZ, caracteresConfirmados: 59 }, comoFetch(f))).rejects.toMatchObject({ codigo: "coste_cambiado" });
    await expect(vozMuestra(cfg(), { voiceId: "../x", caracteresConfirmados: 60 }, comoFetch(f))).rejects.toMatchObject({ codigo: "esquema" });
    expect(f).toHaveBeenCalledTimes(0);
    const r1 = await vozMuestra(cfg(), { voiceId: VOZ, caracteresConfirmados: 60 }, comoFetch(f));
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.textos[0]).toHaveLength(60);
    expect(r1).toMatchObject({ caracteres: 60, cache: false });
    expect(Buffer.from(r1.audioBase64, "base64").equals(mp3)).toBe(true);
    const r2 = await vozMuestra(cfg(), { voiceId: VOZ, caracteresConfirmados: 60 }, comoFetch(f));
    expect(f).toHaveBeenCalledTimes(1); // de caché: sin segunda llamada
    expect(r2).toMatchObject({ caracteres: 0, cache: true, audioBase64: r1.audioBase64 });
  });
});

// ---------- Revisión de seguridad de T5 ----------

const TEXTO1 = "Frase número 1 del partido.";
const marcas = (id: string) => ficherosVoz(id).filter((n) => n.endsWith(".fallo"));
const basura = Buffer.from("esto no es un mp3, es texto");

describe("cabecera MP3 (antes de ffprobe)", () => {
  it("solo ID3 o sync de trama MPEG", () => {
    expect(cabeceraMp3Valida(Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.from([0xff, 0xfb, 0x90, 0x00])]))).toBe(true);
    expect(cabeceraMp3Valida(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"))).toBe(false); // tag sin trama detrás
    expect(cabeceraMp3Valida(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(true);
    expect(cabeceraMp3Valida(Buffer.from([0xff, 0xe3, 0x90, 0x00]))).toBe(true);
    expect(cabeceraMp3Valida(Buffer.from([0xff, 0xc0, 0x90, 0x00]))).toBe(false);
    expect(cabeceraMp3Valida(Buffer.from([0x00, 0xfb, 0x90, 0x00]))).toBe(false);
    expect(cabeceraMp3Valida(Buffer.from("ffconcat version 1.0\nfile 'x.mp3'\n"))).toBe(false);
    expect(cabeceraMp3Valida(Buffer.alloc(2, 0xff))).toBe(false);
  });

  it("ID3 vacío + ffconcat + tramas sin saltos de línea: rechazado (bypass verificado en ffmpeg 6.1.1)", () => {
    const trama = Buffer.alloc(64, 0xff);
    const atacante = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.from("ffconcat version 1.0\nfile 'otra.mp3'\n#"), trama]);
    expect(cabeceraMp3Valida(atacante)).toBe(false);
    // Aunque el tag declare un tamaño que cubra el texto, ffconcat en cualquier parte (y en cualquier caja) lo rechaza.
    const texto = "FFConcat version 1.0\nfile 'x.mp3'\n#";
    const tam = texto.length;
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, tam >> 7, tam & 0x7f]);
    expect(cabeceraMp3Valida(Buffer.concat([id3, Buffer.from(texto), trama]))).toBe(false);
    expect(cabeceraMp3Valida(Buffer.concat([trama, Buffer.from("xxFfCoNcAtxx")]))).toBe(false);
  });

  it("un MP3 legítimo con tag ID3 (relleno incluido) pasa", () => {
    const relleno = 300;
    const id3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, relleno >> 7, relleno & 0x7f]), Buffer.alloc(relleno)]);
    expect(cabeceraMp3Valida(Buffer.concat([id3, Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22])]))).toBe(true);
    // Tamaño synchsafe inválido (bit alto) o tag que no deja sitio a la trama: no.
    expect(cabeceraMp3Valida(Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x80, 0]), Buffer.alloc(8, 0xff)]))).toBe(false);
    expect(cabeceraMp3Valida(id3)).toBe(false);
  });

  sinSonda("un ffconcat disfrazado de mp3 se rechaza antes de ffprobe y no se guarda (pero se cobró)", async () => {
    const id = nuevo();
    const disfraz = Buffer.concat([Buffer.from("ffconcat version 1.0\nfile 'x.mp3'\n#"), mp3.length ? mp3 : Buffer.alloc(64, 0xff)]);
    const f = falso((t) => respuesta(t, { audio: disfraz }));
    const r = await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: TEXTO1.length }, comoFetch(f));
    expect(r.generadas).toBe(0);
    expect(r.fallo?.mensaje).toMatch(/cabecera MP3/);
    expect(ficherosVoz(id).filter((n) => !n.endsWith(".fallo"))).toEqual([]);
  });
});

describe("facturación tras un fallo de validación (Medium 1)", () => {
  sinSonda("el cobro con 200 se suma aunque el audio se descarte, y la frase queda marcada como facturada", async () => {
    const id = nuevo();
    const f = falso((t) => respuesta(t, { audio: basura }));
    const r = await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: TEXTO1.length }, comoFetch(f));
    expect(r).toMatchObject({ generadas: 0, caracteresFacturados: TEXTO1.length, fallo: { fraseId: "f1", facturada: true } });
    expect(marcas(id)).toHaveLength(1);
    const c = vozCoste(cfg(), id, ["f1"]);
    expect(c.pendientes).toEqual(["f1"]);
    expect(c.fallidasFacturadas).toEqual([{ fraseId: "f1", intentos: 1, caracteresCobrados: TEXTO1.length }]);
    expect(c.caracteresRefacturados).toBe(TEXTO1.length);
  });

  sinSonda("un 429 (sin cobro) no deja marca ni cuenta caracteres", async () => {
    const id = nuevo();
    const f = falso(() => new Response("{}", { status: 429 }));
    const r = await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: TEXTO1.length }, comoFetch(f));
    expect(r).toMatchObject({ generadas: 0, caracteresFacturados: 0, fallo: { facturada: false } });
    expect(marcas(id)).toEqual([]);
    expect(vozCoste(cfg(), id, ["f1"]).fallidasFacturadas).toEqual([]);
  });

  sinSonda("un fallo determinista repetido no se vuelve a cobrar sin confirmación expresa", async () => {
    const id = nuevo();
    const f1 = falso((t) => respuesta(t, { audio: basura }));
    await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: TEXTO1.length }, comoFetch(f1));
    expect(f1).toHaveBeenCalledTimes(1);

    // Mismo coste, mismo plan visto, sin reintentarFacturadas: no hay llamada.
    const c = vozCoste(cfg(), id, ["f1"]);
    const f2 = falso((t) => respuesta(t, { audio: basura }));
    await expect(vozGenerarReal(cfg(), { id, frases: ["f1"], caracteresConfirmados: c.caracteres, planConfirmado: c.plan }, comoFetch(f2))).rejects.toMatchObject({ codigo: "reintento_facturado" });
    await expect(vozGenerarReal(cfg(), { id, frases: ["f1"], caracteresConfirmados: c.caracteres, planConfirmado: c.plan, reintentarFacturadas: false }, comoFetch(f2))).rejects.toMatchObject({
      codigo: "reintento_facturado",
    });
    expect(f2).toHaveBeenCalledTimes(0);

    // Con la confirmación expresa se llama una vez, se vuelve a cobrar y se anota el segundo intento.
    const r = await vozGenerarReal(cfg(), { id, frases: ["f1"], caracteresConfirmados: c.caracteres, planConfirmado: c.plan, reintentarFacturadas: true }, comoFetch(f2));
    expect(f2).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ caracteresFacturados: TEXTO1.length, fallo: { facturada: true } });
    const c2 = vozCoste(cfg(), id, ["f1"]);
    expect(c2.fallidasFacturadas[0]).toMatchObject({ intentos: 2, caracteresCobrados: 2 * TEXTO1.length });
    expect(c2.plan).not.toBe(c.plan); // el plan visto antes ya no vale
    await expect(vozGenerarReal(cfg(), { id, frases: ["f1"], caracteresConfirmados: c.caracteres, planConfirmado: c.plan, reintentarFacturadas: true }, comoFetch(f2))).rejects.toMatchObject({ codigo: "coste_cambiado" });
    expect(f2).toHaveBeenCalledTimes(1);
  });

  requiere("si el reintento confirmado funciona, la frase se guarda y la marca desaparece", async () => {
    const id = nuevo();
    await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: TEXTO1.length }, comoFetch(falso((t) => respuesta(t, { audio: basura }))));
    expect(marcas(id)).toHaveLength(1);
    const r = await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: TEXTO1.length, reintentarFacturadas: true }, comoFetch(falso()));
    expect(r).toMatchObject({ generadas: 1, caracteresFacturados: TEXTO1.length });
    expect(marcas(id)).toEqual([]);
    expect(vozCoste(cfg(), id, ["f1"]).pendientes).toEqual([]);
  });

  requiere("audio que ffprobe no acepta pese a una cabecera válida: también se cobra y se marca", async () => {
    const id = nuevo();
    const falsoMp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(200, 1)]);
    const r = await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: TEXTO1.length }, comoFetch(falso((t) => respuesta(t, { audio: falsoMp3 }))));
    expect(r.fallo).toMatchObject({ facturada: true });
    expect(r.caracteresFacturados).toBe(TEXTO1.length);
    expect(ficherosVoz(id).filter((n) => /tmp/.test(n))).toEqual([]);
  });
});

describe("la confirmación ata el contenido", () => {
  it("cambiar el texto sin cambiar el total de caracteres invalida la confirmación", async () => {
    const id = nuevo();
    const visto = vozCoste(cfg(), id, ["f1"]);
    editar(id, (p) => (p.frases[0].texto = "Frase numero 1 del partido.")); // misma longitud
    const f = falso();
    expect(vozCoste(cfg(), id, ["f1"]).caracteres).toBe(visto.caracteres);
    await expect(vozGenerarReal(cfg(), { id, frases: ["f1"], caracteresConfirmados: visto.caracteres, planConfirmado: visto.plan }, comoFetch(f))).rejects.toMatchObject({ codigo: "coste_cambiado" });
    expect(f).toHaveBeenCalledTimes(0);
  });

  it("sin plan, o con otro tipo, no se llama; cambiar de voz cambia el plan", async () => {
    const id = nuevo();
    const f = falso();
    const total = vozCoste(cfg(), id).caracteres;
    for (const planConfirmado of [undefined, "", 7, "0".repeat(64)]) {
      await expect(vozGenerarReal(cfg(), { id, caracteresConfirmados: total, planConfirmado } as any, comoFetch(f))).rejects.toMatchObject({ codigo: "coste_cambiado" });
    }
    expect(f).toHaveBeenCalledTimes(0);
    expect(vozCoste({ ...cfg(), elevenVoiceId: "Ot12345678CD" }, id).plan).not.toBe(vozCoste(cfg(), id).plan);
  });

  it("la muestra también: otro plan, no se llama", async () => {
    const f = falso();
    await expect(vozMuestraReal(cfg(), { voiceId: VOZ, caracteresConfirmados: 60, planConfirmado: planMuestra("otro_modelo", VOZ) }, comoFetch(f))).rejects.toMatchObject({ codigo: "coste_cambiado" });
    await expect(vozMuestraReal(cfg(), { voiceId: VOZ, caracteresConfirmados: 60 } as any, comoFetch(f))).rejects.toMatchObject({ codigo: "coste_cambiado" });
    expect(f).toHaveBeenCalledTimes(0);
  });
});

describe("muestra: carpeta, candado y caché", () => {
  it("la carpeta de muestras es hermana de VIDEO_ROOT", () => {
    expect(carpetaMuestras(cfg())).toBe(path.join(path.dirname(RAIZ), "muestras"));
  });

  it("si muestras/ es un enlace, no se lee la caché ni se llama", async () => {
    const otra = path.join(path.dirname(RAIZ), "otra");
    fs.mkdirSync(otra, { recursive: true });
    const hash = hashFrase(VOZ, "eleven_multilingual_v2", "Hola, esta es una muestra de mi voz para tus vídeos del día.");
    fs.writeFileSync(path.join(otra, `${hash}.mp3`), Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]));
    fs.symlinkSync(otra, path.join(path.dirname(RAIZ), "muestras"), "junction");
    const f = falso();
    await expect(vozMuestra(cfg(), { voiceId: VOZ, caracteresConfirmados: 60 }, comoFetch(f))).rejects.toMatchObject({ codigo: "esquema", problemas: [{ codigo: "enlace_no_permitido", ruta: "" }] });
    expect(f).toHaveBeenCalledTimes(0);
  });

  sinSonda("dos clics seguidos sobre la misma voz son una sola llamada (candado)", async () => {
    let soltar!: () => void;
    const espera = new Promise<void>((r) => (soltar = r));
    const f = falso(async (t) => {
      await espera;
      return respuesta(t, { audio: basura });
    });
    const primera = vozMuestra(cfg(), { voiceId: VOZ, caracteresConfirmados: 60 }, comoFetch(f)).catch((e) => e);
    await expect(vozMuestra(cfg(), { voiceId: VOZ, caracteresConfirmados: 60 }, comoFetch(f))).rejects.toMatchObject({ codigo: "conflicto" });
    soltar();
    expect(await primera).toMatchObject({ codigo: "fallo_facturado" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  sinSonda("una muestra cobrada y descartada pide confirmación expresa para repetirse", async () => {
    const f = falso((t) => respuesta(t, { audio: basura }));
    await expect(vozMuestra(cfg(), { voiceId: VOZ, caracteresConfirmados: 60 }, comoFetch(f))).rejects.toMatchObject({ codigo: "fallo_facturado" });
    await expect(vozMuestra(cfg(), { voiceId: VOZ, caracteresConfirmados: 60 }, comoFetch(f))).rejects.toMatchObject({ codigo: "reintento_facturado" });
    expect(f).toHaveBeenCalledTimes(1);
    await expect(vozMuestra(cfg(), { voiceId: VOZ, caracteresConfirmados: 60, reintentarFacturada: true }, comoFetch(f))).rejects.toMatchObject({ codigo: "fallo_facturado" });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("marca de vuelo (facturación si el motor cae tras el 200)", () => {
  const HASH1 = () => hashFrase(VOZ, "eleven_multilingual_v2", TEXTO1);

  it("una marca de vuelo huérfana cuenta como posiblemente cobrada y exige reintentarFacturadas", async () => {
    const id = nuevo();
    fs.mkdirSync(carpetaVoz(id), { recursive: true });
    fs.writeFileSync(path.join(carpetaVoz(id), `${HASH1()}.vuelo`), "{}");
    const c = vozCoste(cfg(), id, ["f1"]);
    expect(c.fallidasFacturadas).toEqual([{ fraseId: "f1", intentos: 1, caracteresCobrados: 0 }]);
    expect(c.caracteresRefacturados).toBe(TEXTO1.length);
    const f = falso();
    await expect(vozGenerarReal(cfg(), { id, frases: ["f1"], caracteresConfirmados: c.caracteres, planConfirmado: c.plan }, comoFetch(f))).rejects.toMatchObject({ codigo: "reintento_facturado" });
    expect(f).not.toHaveBeenCalled();
  });

  sinSonda("la marca se escribe antes de llamar y se borra si la llamada no cobró", async () => {
    const id = nuevo();
    let vista = false;
    const f = falso(() => {
      vista = fs.existsSync(path.join(carpetaVoz(id), `${HASH1()}.vuelo`));
      return new Response("{}", { status: 429 });
    });
    const r = await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: TEXTO1.length }, comoFetch(f));
    expect(vista).toBe(true);
    expect(r.fallo?.facturada).toBe(false);
    expect(ficherosVoz(id).filter((n) => n.endsWith(".vuelo"))).toEqual([]);
    expect(vozCoste(cfg(), id, ["f1"]).fallidasFacturadas).toEqual([]);
  });

  sinSonda("tras un cobro con fallo de validación queda la marca de fallo y no la de vuelo", async () => {
    const id = nuevo();
    const f = falso((t) => respuesta(t, { audio: basura }));
    await vozGenerar(cfg(), { id, frases: ["f1"], caracteresConfirmados: TEXTO1.length }, comoFetch(f));
    expect(ficherosVoz(id).filter((n) => n.endsWith(".vuelo"))).toEqual([]);
    expect(vozCoste(cfg(), id, ["f1"]).fallidasFacturadas).toEqual([{ fraseId: "f1", intentos: 1, caracteresCobrados: TEXTO1.length }]);
  });
});
