// Voz por frases (T5, D7). Cada frase se sintetiza aparte y se guarda direccionada por su contenido:
//   voz/<sha256(voiceId|modelo|texto)>.mp3 y .json (alineación y palabras de esa frase).
// El mp3 se escribe primero y el json al final: la frase existe si está el json. Así un lote cortado a mitad conserva
// lo hecho, reintentar factura solo lo que falta, cambiar una frase paga una frase y reordenar no paga nada.
// El gasto exige los caracteres que el cliente mostró (I10): si el cálculo del servidor es otro, no se llama.
// ElevenLabs y el audio que devuelve son entrada no confiable (D7, I15): ver tts.ts y el sondeo de `generarUna`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { procesarAlineacion, validarPalabras, type ResultadoAlineacion } from "./alineacion.js";
import type { Config } from "./config.js";
import { log, ocultarClave } from "./log.js";
import { argsEntrada, ejecutar, herramientasFfmpeg, mensajeSinFfmpeg, sondear, type Herramientas } from "./proceso.js";
import { ErrorAlmacen, proyectoGuardar, proyectoLeer } from "./proyecto.js";
import { ErrorVideo, carpetaVideo, comprobarCarpeta, escribirAtomico } from "./paths.js";
import type { Proyecto } from "./esquema.js";
import { ErrorElevenLabs, MAX_AUDIO_TTS, listarVocesElevenLabs, sintetizarConTimestamps } from "./tts.js";

export const VOICE_ID_RE = /^[A-Za-z0-9]{10,40}$/;
/** Hueco entre palabras que cuenta como silencio. */
export const SILENCIO_MIN_S = 0.25;
/** Margen que se deja a cada lado de la voz al recortar un silencio. */
const MARGEN_RECORTE_S = 0.1;
/** Picos de la forma de onda que salen al editor. */
export const MAX_PICOS = 2000;
/** Texto fijo de la muestra de una voz (M-D3): 60 caracteres, así el coste que ve la persona es siempre el mismo. */
export const MUESTRA_TEXTO = "Hola, esta es una muestra de mi voz para tus vídeos del día.";
export const MUESTRA_CARACTERES = MUESTRA_TEXTO.length;
const MAX_JSON_FRASE = 4 * 1024 * 1024;
const MAX_VOCES = 200;
const WAV_FORMA_HZ = 8000;

const esquema = (mensaje: string, codigo: string, ruta = ""): ErrorAlmacen => new ErrorAlmacen("esquema", mensaje, [{ ruta, codigo }]);

/** Nombre en disco de una frase: depende de la voz, del modelo y del texto, y de nada más (ni del id ni del orden). */
export function hashFrase(voiceId: string, modelo: string, texto: string): string {
  return createHash("sha256").update(`${voiceId}|${modelo}|${texto}`).digest("hex");
}

// ---------- Contexto ----------

interface Contexto {
  proyecto: Proyecto;
  dir: string;
  voiceId: string;
  modelo: string;
}

function voiceIdDe(cfg: Config): string {
  if (!cfg.elevenVoiceId) throw new ErrorAlmacen("sin_configurar", "Elige la voz de ElevenLabs en Ajustes de SEO Studio.");
  if (!VOICE_ID_RE.test(cfg.elevenVoiceId)) throw esquema("El identificador de la voz no es válido.", "voice_id_invalido", "voiceId");
  return cfg.elevenVoiceId;
}

function carpetaVoz(cfg: Config, proyecto: Proyecto): string {
  const dirProyecto = carpetaVideo(cfg.videoRoot, proyecto.id);
  const dir = path.join(dirProyecto, "voz");
  try {
    comprobarCarpeta(dirProyecto);
    fs.mkdirSync(dir, { recursive: true });
    comprobarCarpeta(dir);
  } catch (e) {
    if (e instanceof ErrorVideo) throw esquema(e.message, "enlace_no_permitido");
    throw e;
  }
  return dir;
}

function contexto(cfg: Config, id: string): Contexto {
  const { proyecto } = proyectoLeer(cfg.videoRoot, id);
  return { proyecto, dir: carpetaVoz(cfg, proyecto), voiceId: voiceIdDe(cfg), modelo: cfg.elevenModelId };
}

// ---------- Fichero por frase ----------

interface FraseHecha {
  hash: string;
  texto: string;
  duracion: number;
  palabras: ResultadoAlineacion;
}

function ficheroNormal(ruta: string, tope: number): boolean {
  try {
    const st = fs.lstatSync(ruta);
    return st.isFile() && st.nlink === 1 && st.size > 0 && st.size <= tope;
  } catch {
    return false;
  }
}

/** La frase hecha, o null si falta algo o no cuadra: lo que no se puede leer se trata como pendiente, nunca como válido. */
function leerFrase(dir: string, hash: string): FraseHecha | null {
  const mp3 = path.join(dir, `${hash}.mp3`);
  const json = path.join(dir, `${hash}.json`);
  if (!ficheroNormal(mp3, MAX_AUDIO_TTS) || !ficheroNormal(json, MAX_JSON_FRASE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(json, "utf8")) as { version?: number; hash?: unknown; texto?: unknown; duracion?: unknown; palabras?: unknown };
    if (j.version !== 1 || j.hash !== hash || typeof j.texto !== "string" || typeof j.duracion !== "number" || !Number.isFinite(j.duracion) || !(j.duracion > 0)) return null;
    return { hash, texto: j.texto, duracion: j.duracion, palabras: validarPalabras(j.palabras) };
  } catch {
    return null;
  }
}

// ---------- Coste ----------

interface Plan {
  /** Frases sin voz (con las repetidas), en el orden del proyecto. */
  pendientes: string[];
  /** Una entrada por texto distinto: es lo que se llama y se factura. */
  unicas: { hash: string; texto: string; fraseId: string }[];
  caracteres: number;
}

function planear(ctx: Contexto, solo?: readonly string[]): Plan {
  let frases = ctx.proyecto.frases;
  if (solo) {
    const ids = new Set(frases.map((f) => f.id));
    const malo = solo.find((id) => typeof id !== "string" || !ids.has(id));
    if (malo !== undefined) throw esquema("Hay una frase que no existe en el proyecto.", "frase_inexistente", "frases");
    const quieren = new Set(solo);
    frases = frases.filter((f) => quieren.has(f.id));
  }
  const pendientes: string[] = [];
  const unicas = new Map<string, { hash: string; texto: string; fraseId: string }>();
  for (const f of frases) {
    const hash = hashFrase(ctx.voiceId, ctx.modelo, f.texto);
    if (leerFrase(ctx.dir, hash)) continue;
    pendientes.push(f.id);
    if (!unicas.has(hash)) unicas.set(hash, { hash, texto: f.texto, fraseId: f.id });
  }
  const lista = [...unicas.values()];
  return { pendientes, unicas: lista, caracteres: lista.reduce((s, u) => s + u.texto.length, 0) };
}

export function vozCoste(cfg: Config, id: string): { pendientes: string[]; caracteres: number; voz: { voiceId: string; modelo: string } } {
  const ctx = contexto(cfg, id);
  const p = planear(ctx);
  return { pendientes: p.pendientes, caracteres: p.caracteres, voz: { voiceId: ctx.voiceId, modelo: ctx.modelo } };
}

// ---------- Generar ----------

const enCurso = new Set<string>();

function exigirCoste(esperado: number, confirmados: unknown): void {
  if (typeof confirmados !== "number" || !Number.isInteger(confirmados) || confirmados !== esperado) {
    throw new ErrorAlmacen("coste_cambiado", `El coste ha cambiado: ahora son ${esperado} caracteres. Vuelve a revisarlo antes de confirmar.`, [
      { ruta: "caracteresConfirmados", codigo: "coste_cambiado" },
    ]);
  }
}

function requerirClave(cfg: Config): string {
  if (!cfg.elevenApiKey) throw new ErrorAlmacen("sin_configurar", "Añade tu clave de ElevenLabs en Ajustes de SEO Studio.");
  return cfg.elevenApiKey;
}

function requerirFfmpegVoz(cfg: Config): Herramientas {
  const h = herramientasFfmpeg(cfg.ffmpegDir);
  if (!h) throw new ErrorVideo(mensajeSinFfmpeg());
  return h;
}

/** Sintetiza un texto y lo valida entero (D7, I15) antes de que nada llegue a disco. */
async function sintetizarValidado(
  cfg: Config,
  h: Herramientas,
  dir: string,
  hash: string,
  texto: string,
  voiceId: string,
  fetchImpl?: typeof fetch,
): Promise<{ audio: Buffer; duracion: number; facturados: number; requestId?: string; palabras: ResultadoAlineacion; crudo: unknown }> {
  const tts = await sintetizarConTimestamps({ texto, apiKey: cfg.elevenApiKey!, voiceId, modelId: cfg.elevenModelId, fetchImpl });
  const temporal = path.join(dir, `${hash}.tmp-${process.pid}.mp3`);
  try {
    fs.writeFileSync(temporal, tts.audio);
    const info = await sondear(h.ffprobe, temporal).catch((e: Error) => {
      throw new ErrorVideo(`El audio que devolvió ElevenLabs no es un MP3 válido; no guardo nada (${e.message.slice(0, 200)}).`);
    });
    if (!info.tieneAudio || !info.duracion || !(info.duracion > 0)) {
      throw new ErrorVideo("El audio que devolvió ElevenLabs no tiene pista de audio o no tiene duración; no guardo nada.");
    }
    const fin = tts.alineacion.character_end_times_seconds.at(-1) ?? 0;
    if (fin > info.duracion + 1) {
      throw new ErrorVideo(`La alineación de ElevenLabs acaba en ${fin.toFixed(1)} s y el audio dura ${info.duracion.toFixed(1)} s; no guardo nada.`);
    }
    const palabras = validarPalabras(
      procesarAlineacion({ narracion: texto, bloques: [{ n: 1, inicio: 0, fin: texto.length }], alineacion: tts.alineacion, duracionAudio: info.duracion, hashNarracion: hash }),
    );
    return { audio: tts.audio, duracion: info.duracion, facturados: tts.caracteresFacturados ?? texto.length, requestId: tts.requestId, palabras, crudo: tts.crudo };
  } finally {
    fs.rmSync(temporal, { force: true });
  }
}

export interface ResultadoGenerar {
  /** Llamadas hechas con éxito (una por texto distinto). */
  generadas: number;
  caracteresFacturados: number;
  fallo?: { fraseId: string; mensaje: string };
}

/**
 * Genera las frases sin voz, de una en una (el límite de concurrencia de ElevenLabs es bajo). Un fallo corta el lote y
 * se devuelve como `fallo`: lo ya hecho queda en disco y el reintento solo cobra lo que falta.
 */
export async function vozGenerar(
  cfg: Config,
  a: { id: string; frases?: string[]; caracteresConfirmados: number },
  fetchImpl?: typeof fetch,
): Promise<ResultadoGenerar> {
  const ctx = contexto(cfg, a.id);
  const plan = planear(ctx, a.frases);
  exigirCoste(plan.caracteres, a.caracteresConfirmados);
  if (!plan.unicas.length) return { generadas: 0, caracteresFacturados: 0 };
  requerirClave(cfg);
  const h = requerirFfmpegVoz(cfg);
  if (enCurso.has(ctx.proyecto.id)) throw new ErrorAlmacen("conflicto", "Ya se está generando la voz de este proyecto.");
  enCurso.add(ctx.proyecto.id);
  let generadas = 0;
  let caracteresFacturados = 0;
  try {
    for (const u of plan.unicas) {
      try {
        const r = await sintetizarValidado(cfg, h, ctx.dir, u.hash, u.texto, ctx.voiceId, fetchImpl);
        escribirAtomico(path.join(ctx.dir, `${u.hash}.mp3`), r.audio);
        escribirAtomico(
          path.join(ctx.dir, `${u.hash}.json`),
          JSON.stringify({ version: 1, hash: u.hash, generado: new Date().toISOString(), modelo: ctx.modelo, requestId: r.requestId, texto: u.texto, duracion: r.duracion, caracteresFacturados: r.facturados, crudo: r.crudo, palabras: r.palabras }),
        );
        generadas++;
        caracteresFacturados += r.facturados;
      } catch (e) {
        const crudo = e instanceof ErrorElevenLabs || e instanceof ErrorVideo ? (e as Error).message : "No se pudo guardar la voz de la frase.";
        if (!(e instanceof ErrorElevenLabs || e instanceof ErrorVideo)) log.error(`vozGenerar ${ctx.proyecto.id}: ${(e as Error).message}`);
        return { generadas, caracteresFacturados, fallo: { fraseId: u.fraseId, mensaje: ocultarClave(crudo, cfg.elevenApiKey) } };
      }
    }
    return { generadas, caracteresFacturados };
  } finally {
    enCurso.delete(ctx.proyecto.id);
  }
}

// ---------- Ensamblado ----------

/** Frases en el orden en que se narran: el de las escenas; las que ninguna escena usa, al final. */
function ordenNarracion(p: Proyecto): Proyecto["frases"] {
  const porId = new Map(p.frases.map((f) => [f.id, f]));
  const vistas = new Set<string>();
  const orden: Proyecto["frases"] = [];
  for (const id of p.escenas.flatMap((e) => e.fraseIds)) {
    const f = porId.get(id);
    if (f && !vistas.has(id)) {
      vistas.add(id);
      orden.push(f);
    }
  }
  for (const f of p.frases) if (!vistas.has(f.id)) orden.push(f);
  return orden;
}

const seg = (x: number): string => x.toFixed(3);

function pendienteDeVoz(ids: string[]): ErrorAlmacen {
  return new ErrorAlmacen(
    "voz_pendiente",
    `Faltan las voces de ${ids.length} frase(s): ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? "…" : ""}. Genera la voz antes.`,
    ids.map((ruta) => ({ ruta, codigo: "voz_pendiente" })),
  );
}

/**
 * Une las frases en `voz/ensamblada-<hash>.wav` con el demuxer `concat` y `inpoint`/`outpoint` por recorte. La lista la
 * escribe el motor solo con nombres hash y rutas relativas; el texto del guion no entra nunca. Se abre con
 * `-protocol_whitelist file` y `-format_whitelist concat,mp3`. El nombre depende del contenido de la lista: mismo
 * ensamblado, mismo fichero.
 */
export async function ensamblarVoz(cfg: Config, id: string): Promise<string> {
  const ctx = contexto(cfg, id);
  const hechas = ordenNarracion(ctx.proyecto).map((f) => ({ f, hecha: leerFrase(ctx.dir, hashFrase(ctx.voiceId, ctx.modelo, f.texto)) }));
  const faltan = hechas.filter((x) => !x.hecha).map((x) => x.f.id);
  if (faltan.length) throw pendienteDeVoz(faltan);
  const lineas = ["ffconcat version 1.0"];
  for (const { f, hecha } of hechas) {
    const d = hecha!;
    lineas.push(`file '${d.hash}.mp3'`);
    const r = f.recorte;
    if (r) {
      const inicio = Math.max(0, r.inicio);
      const fin = Math.min(d.duracion, r.fin);
      if (fin - inicio >= 0.05 && (inicio > 0 || fin < d.duracion)) {
        lineas.push(`inpoint ${seg(inicio)}`, `outpoint ${seg(fin)}`);
      }
    }
  }
  const contenido = `${lineas.join("\n")}\n`;
  const h = createHash("sha256").update(contenido).digest("hex").slice(0, 32);
  const lista = path.join(ctx.dir, `lista-${h}.ffconcat`);
  const wav = path.join(ctx.dir, `ensamblada-${h}.wav`);
  if (ficheroNormal(wav, Number.MAX_SAFE_INTEGER)) return wav;
  const ff = requerirFfmpegVoz(cfg);
  escribirAtomico(lista, contenido);
  const temporal = path.join(ctx.dir, `ensamblada-${h}.tmp-${process.pid}.wav`);
  try {
    const r = await ejecutar(
      ff.ffmpeg,
      ["-y", "-v", "error", ...argsEntrada(lista, undefined, ["mp3"]), "-i", lista, "-vn", "-c:a", "pcm_s16le", "-ar", "44100", "-f", "wav", temporal],
      { timeoutMs: 120_000 },
    );
    if (r.code !== 0) throw new ErrorVideo(`ffmpeg no pudo unir la voz: ${r.stderr.trim().slice(0, 300)}`);
    fs.renameSync(temporal, wav);
  } finally {
    fs.rmSync(temporal, { force: true });
  }
  // Se conserva el ensamblado anterior más reciente por si un montaje lo está leyendo; el resto se borra.
  const otros = fs
    .readdirSync(ctx.dir)
    .filter((n) => /^(ensamblada-[0-9a-f]{32}\.wav|lista-[0-9a-f]{32}\.ffconcat)$/.test(n) && !n.includes(h))
    .map((n) => ({ n, t: fs.statSync(path.join(ctx.dir, n)).mtimeMs }))
    .sort((x, y) => y.t - x.t);
  const guardar = new Set(otros.slice(0, 2).map((x) => x.n));
  for (const o of otros) if (!guardar.has(o.n)) fs.rmSync(path.join(ctx.dir, o.n), { force: true });
  return wav;
}

// ---------- Forma de onda ----------

/** Picos (0 a 1) de un WAV mono de 16 bits, en ≤ `MAX_PICOS` cajas. */
export function picosDeWav(wav: Buffer): { picos: number[]; muestras: number } {
  if (wav.length < 12 || wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") throw new ErrorVideo("ffmpeg no devolvió un WAV.");
  let pos = 12;
  let inicio = -1;
  let fin = 0;
  while (pos + 8 <= wav.length) {
    const nombre = wav.toString("latin1", pos, pos + 4);
    const tam = wav.readUInt32LE(pos + 4);
    if (nombre === "data") {
      inicio = pos + 8;
      // Por tubería ffmpeg no conoce la longitud y escribe 0xFFFFFFFF: se toma hasta el final.
      fin = tam === 0xffffffff || inicio + tam > wav.length ? wav.length : inicio + tam;
      break;
    }
    pos += 8 + tam + (tam % 2);
  }
  if (inicio < 0) throw new ErrorVideo("El WAV de la forma de onda no tiene datos.");
  const muestras = Math.floor((fin - inicio) / 2);
  if (muestras < 1) throw new ErrorVideo("La voz no tiene audio.");
  const cajas = Math.min(MAX_PICOS, muestras);
  const picos: number[] = [];
  for (let c = 0; c < cajas; c++) {
    const desde = Math.floor((c * muestras) / cajas);
    const hasta = Math.floor(((c + 1) * muestras) / cajas);
    let max = 0;
    for (let i = desde; i < hasta; i++) max = Math.max(max, Math.abs(wav.readInt16LE(inicio + i * 2)));
    picos.push(Math.round(Math.min(1, max / 32768) * 1000) / 1000);
  }
  return { picos, muestras };
}

export async function vozForma(cfg: Config, id: string): Promise<{ picos: number[]; segundos: number }> {
  const wav = await ensamblarVoz(cfg, id);
  const ff = requerirFfmpegVoz(cfg);
  const r = await ejecutar(ff.ffmpeg, ["-v", "error", ...argsEntrada(wav), "-i", wav, "-vn", "-f", "wav", "-ac", "1", "-ar", String(WAV_FORMA_HZ), "pipe:1"], {
    timeoutMs: 60_000,
    salidaBinaria: { maxBytes: 16 * 1024 * 1024 },
  });
  if (r.code !== 0 || !r.salida) throw new ErrorVideo(`ffmpeg no pudo sacar la forma de onda: ${r.stderr.trim().slice(0, 300)}`);
  const { picos, muestras } = picosDeWav(r.salida);
  return { picos, segundos: Math.round((muestras / WAV_FORMA_HZ) * 1000) / 1000 };
}

// ---------- Silencios ----------

const ms = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Huecos de más de 0,25 s entre palabras de la alineación, también antes de la primera y después de la última.
 * Sale de la alineación de ElevenLabs: el build de ffmpeg no lleva `silencedetect`.
 */
export function silencios(palabras: readonly { inicio: number; fin: number }[], duracion: number): { inicio: number; fin: number }[] {
  if (!palabras.length) return [];
  const huecos: { inicio: number; fin: number }[] = [];
  const hueco = (desde: number, hasta: number) => {
    if (hasta - desde > SILENCIO_MIN_S + 1e-9) huecos.push({ inicio: ms(desde), fin: ms(hasta) });
  };
  hueco(0, palabras[0].inicio);
  for (let i = 1; i < palabras.length; i++) hueco(palabras[i - 1].fin, palabras[i].inicio);
  hueco(palabras[palabras.length - 1].fin, duracion);
  return huecos;
}

/**
 * Recorta el silencio del principio y del final de una frase (con 0,1 s de margen) y lo guarda como `recorte` de la
 * frase en el proyecto. Los huecos del medio no se tocan: el demuxer `concat` solo recorta los extremos de cada fichero.
 */
export function vozQuitarSilencios(cfg: Config, id: string, fraseId: string): { recorte: { inicio: number; fin: number } } {
  const ctx = contexto(cfg, id);
  const frase = ctx.proyecto.frases.find((f) => f.id === fraseId);
  if (typeof fraseId !== "string" || !frase) throw esquema("La frase no existe en el proyecto.", "frase_inexistente", "fraseId");
  const hecha = leerFrase(ctx.dir, hashFrase(ctx.voiceId, ctx.modelo, frase.texto));
  if (!hecha) throw pendienteDeVoz([frase.id]);
  const ps = hecha.palabras.palabras;
  const huecos = silencios(ps, hecha.duracion);
  const inicioHueco = huecos.find((h) => h.inicio === 0);
  const finHueco = huecos.find((h) => h.fin === ms(hecha.duracion));
  const inicio = inicioHueco ? ms(Math.max(0, ps[0].inicio - MARGEN_RECORTE_S)) : 0;
  const fin = finHueco ? ms(Math.min(hecha.duracion, ps[ps.length - 1].fin + MARGEN_RECORTE_S)) : ms(hecha.duracion);
  if (!(fin > inicio)) throw esquema("La frase no tiene voz que conservar.", "recorte_vacio", "fraseId");
  const recorte = { inicio, fin };
  const copia = structuredClone(ctx.proyecto);
  copia.frases.find((f) => f.id === fraseId)!.recorte = recorte;
  proyectoGuardar(cfg.videoRoot, { id, revision: ctx.proyecto.revision, proyecto: copia });
  return { recorte };
}

// ---------- Catálogo y muestra (M-D3) ----------

/** Texto de la cuenta de ElevenLabs que acaba en la UI: sin controles ni marcas bidi, corto. */
const limpiar = (v: unknown, max: number): string =>
  typeof v === "string" ? v.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu, "").trim().slice(0, max) : "";

/**
 * Voces de la cuenta. Solo ids, nombre e idioma: `preview_url` se descarta y nunca se pide (I14); para escuchar una
 * voz está `vozMuestra`, que la genera con la propia clave.
 */
export async function voces(cfg: Config, fetchImpl?: typeof fetch): Promise<{ voces: { id: string; nombre: string; idioma: string }[] }> {
  const crudo = (await listarVocesElevenLabs({ apiKey: requerirClave(cfg), fetchImpl })) as { voices?: unknown };
  const lista = Array.isArray(crudo?.voices) ? crudo.voices.slice(0, MAX_VOCES) : [];
  const salida: { id: string; nombre: string; idioma: string }[] = [];
  for (const v of lista as { voice_id?: unknown; name?: unknown; labels?: { language?: unknown } | null }[]) {
    if (typeof v?.voice_id !== "string" || !VOICE_ID_RE.test(v.voice_id)) continue;
    salida.push({ id: v.voice_id, nombre: limpiar(v.name, 80) || v.voice_id, idioma: limpiar(v.labels?.language, 20) });
  }
  return { voces: salida };
}

function carpetaMuestras(cfg: Config): string {
  return path.join(path.dirname(path.resolve(cfg.videoRoot)), "video", "muestras");
}

/**
 * Muestra de una voz: el texto fijo de 60 caracteres, generado con la clave de la persona y guardado por voz. Siempre
 * se confirman 60 caracteres (lo que muestra la UI); si ya está en caché no se llama ni se factura (`caracteres: 0`).
 */
export async function vozMuestra(
  cfg: Config,
  a: { voiceId: string; caracteresConfirmados: number },
  fetchImpl?: typeof fetch,
): Promise<{ audioBase64: string; caracteres: number; cache: boolean }> {
  if (typeof a.voiceId !== "string" || !VOICE_ID_RE.test(a.voiceId)) throw esquema("El identificador de la voz no es válido.", "voice_id_invalido", "voiceId");
  exigirCoste(MUESTRA_CARACTERES, a.caracteresConfirmados);
  const dir = carpetaMuestras(cfg);
  const hash = hashFrase(a.voiceId, cfg.elevenModelId, MUESTRA_TEXTO);
  const ruta = path.join(dir, `${hash}.mp3`);
  if (ficheroNormal(ruta, MAX_AUDIO_TTS)) return { audioBase64: fs.readFileSync(ruta).toString("base64"), caracteres: 0, cache: true };
  requerirClave(cfg);
  const h = requerirFfmpegVoz(cfg);
  fs.mkdirSync(dir, { recursive: true });
  try {
    comprobarCarpeta(dir);
  } catch (e) {
    if (e instanceof ErrorVideo) throw esquema(e.message, "enlace_no_permitido");
    throw e;
  }
  try {
    const r = await sintetizarValidado(cfg, h, dir, hash, MUESTRA_TEXTO, a.voiceId, fetchImpl);
    escribirAtomico(ruta, r.audio);
    return { audioBase64: r.audio.toString("base64"), caracteres: MUESTRA_CARACTERES, cache: false };
  } catch (e) {
    if (e instanceof ErrorElevenLabs || e instanceof ErrorVideo) throw new ErrorVideo(ocultarClave(e.message, cfg.elevenApiKey));
    throw e;
  }
}
