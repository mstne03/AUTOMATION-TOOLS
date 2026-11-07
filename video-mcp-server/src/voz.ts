// Voz por frases (T5, D7). Cada frase se sintetiza aparte y se guarda direccionada por su contenido:
//   voz/<sha256(voiceId|modelo|texto)>.mp3 y .json (alineación y palabras de esa frase).
// El mp3 se escribe primero y el json al final: la frase existe si está el json. Así un lote cortado a mitad conserva
// lo hecho, reintentar factura solo lo que falta, cambiar una frase paga una frase y reordenar no paga nada.
// El gasto exige los caracteres que el cliente mostró (I10): si el cálculo del servidor es otro, no se llama.
// ElevenLabs y el audio que devuelve son entrada no confiable (D7, I15): ver tts.ts y el sondeo de `generarUna`.
import { createHash, randomBytes } from "node:crypto";
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

/**
 * ¿Empieza por una cabecera MP3 de verdad? `ID3` o el sync de trama MPEG (11 bits a 1: 0xFF y 0xE0 en el segundo byte).
 * Se exige antes de ffprobe: un texto como `ffconcat version 1.0…` que ffprobe aún acepte como mp3 no puede llegar nunca
 * al demuxer `concat` del ensamblado.
 */
export function cabeceraMp3Valida(b: Buffer): boolean {
  if (b.length < 4) return false;
  // Una lista de concatenación escondida tras un tag ID3 vacío se abriría como `concat` dentro del ensamblado.
  if (b.toString("latin1").toLowerCase().includes("ffconcat")) return false;
  let ini = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    // Tag ID3v2: 10 bytes de cabecera + tamaño synchsafe (4 x 7 bits) + pie opcional. Tras él tiene que venir una trama.
    if (b.length < 14 || ((b[6] | b[7] | b[8] | b[9]) & 0x80) !== 0) return false;
    const tam = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
    ini = 10 + tam + (b[5] & 0x10 ? 10 : 0);
  }
  return ini + 1 < b.length && b[ini] === 0xff && (b[ini + 1] & 0xe0) === 0xe0;
}

// ---------- Fallos ya cobrados ----------

interface MarcaFallo {
  intentos: number;
  caracteres: number;
}

/**
 * Marca `voz/<hash>.fallo`: ElevenLabs cobró esa frase y el audio se descartó. Mientras exista, reintentar exige una
 * confirmación expresa (`reintentarFacturadas`) además del coste. Si el fichero existe pero no se puede leer, cuenta
 * igual (falla cerrado). Se borra cuando la frase se guarda.
 */
function leerMarca(dir: string, hash: string): MarcaFallo | null {
  const fallo = leerFallo(dir, hash);
  // Marca de vuelo huérfana: el motor cayó entre la llamada a ElevenLabs y el registro del resultado; pudo cobrarse.
  let vuelo = false;
  if (!propiasEnVuelo.has(path.join(dir, hash))) {
    try {
      fs.lstatSync(rutaVuelo(dir, hash));
      vuelo = true;
    } catch {
      /* sin marca */
    }
  }
  if (!vuelo) return fallo;
  return { intentos: (fallo?.intentos ?? 0) + 1, caracteres: fallo?.caracteres ?? 0 };
}

/** Llamadas en vuelo de ESTE proceso: su marca no es huérfana (otra petición concurrente recibe «conflicto», no «refacturada»). */
const propiasEnVuelo = new Set<string>();

const rutaVuelo = (dir: string, hash: string): string => path.join(dir, `${hash}.vuelo`);

/** Se escribe antes de llamar a ElevenLabs; si falla, no se llama. */
function marcarVuelo(dir: string, hash: string): void {
  escribirAtomico(rutaVuelo(dir, hash), JSON.stringify({ version: 1, hash, inicio: new Date().toISOString() }));
  propiasEnVuelo.add(path.join(dir, hash));
}

function quitarVuelo(dir: string, hash: string): void {
  propiasEnVuelo.delete(path.join(dir, hash));
  try {
    fs.rmSync(rutaVuelo(dir, hash), { force: true });
  } catch (e) {
    log.error(`no se pudo borrar la marca de vuelo de ${hash}: ${(e as Error).message}`);
  }
}

function leerFallo(dir: string, hash: string): MarcaFallo | null {
  const ruta = path.join(dir, `${hash}.fallo`);
  try {
    fs.lstatSync(ruta);
  } catch {
    return null;
  }
  try {
    if (ficheroNormal(ruta, 4096)) {
      const j = JSON.parse(fs.readFileSync(ruta, "utf8")) as { intentos?: unknown; caracteres?: unknown };
      const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e9;
      if (ok(j.intentos) && ok(j.caracteres)) return { intentos: j.intentos, caracteres: j.caracteres };
    }
  } catch {
    /* ilegible: cuenta como un intento */
  }
  return { intentos: 1, caracteres: 0 };
}

function anotarFallo(dir: string, hash: string, caracteres: number): void {
  const previa = leerFallo(dir, hash);
  const marca = { version: 1, hash, intentos: (previa?.intentos ?? 0) + 1, caracteres: (previa?.caracteres ?? 0) + caracteres };
  try {
    fs.rmSync(path.join(dir, `${hash}.fallo`), { force: true });
    escribirAtomico(path.join(dir, `${hash}.fallo`), JSON.stringify(marca));
  } catch (e) {
    log.error(`no se pudo anotar el fallo facturado de ${hash}: ${(e as Error).message}`);
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
  /** Textos distintos que ya se cobraron una vez y fallaron al validarse: reintentarlos se cobra otra vez. */
  fallidas: { hash: string; fraseId: string; intentos: number; caracteres: number; texto: string }[];
  /** Huella de lo que se va a generar: la voz, el modelo, los textos (por su hash) y las marcas de fallo. */
  plan: string;
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
  const fallidas = lista.flatMap((u) => {
    const m = leerMarca(ctx.dir, u.hash);
    return m ? [{ hash: u.hash, fraseId: u.fraseId, intentos: m.intentos, caracteres: m.caracteres, texto: u.texto }] : [];
  });
  const plan = createHash("sha256")
    .update(JSON.stringify([ctx.voiceId, ctx.modelo, lista.map((u) => u.hash).sort(), fallidas.map((u) => `${u.hash}:${u.intentos}`).sort()]))
    .digest("hex");
  return { pendientes, unicas: lista, caracteres: lista.reduce((s, u) => s + u.texto.length, 0), fallidas, plan };
}

export interface ResultadoCoste {
  pendientes: string[];
  caracteres: number;
  voz: { voiceId: string; modelo: string };
  /** Huella del contenido del plan: se devuelve en `planConfirmado` al generar. */
  plan: string;
  /** Frases cobradas que no se pudieron usar; generarlas otra vez las cobra de nuevo (`caracteresRefacturados`). */
  fallidasFacturadas: { fraseId: string; intentos: number; caracteresCobrados: number }[];
  caracteresRefacturados: number;
}

export function vozCoste(cfg: Config, id: string, frases?: readonly string[]): ResultadoCoste {
  const ctx = contexto(cfg, id);
  const p = planear(ctx, frases);
  return {
    pendientes: p.pendientes,
    caracteres: p.caracteres,
    voz: { voiceId: ctx.voiceId, modelo: ctx.modelo },
    plan: p.plan,
    fallidasFacturadas: p.fallidas.map((f) => ({ fraseId: f.fraseId, intentos: f.intentos, caracteresCobrados: f.caracteres })),
    caracteresRefacturados: p.fallidas.reduce((s, f) => s + f.texto.length, 0),
  };
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

/** La confirmación ata también el contenido: si cambió algo con el mismo total de caracteres, no se llama. */
function exigirPlan(esperado: string, confirmado: unknown): void {
  if (typeof confirmado !== "string" || confirmado !== esperado) {
    throw new ErrorAlmacen("coste_cambiado", "El contenido a generar ha cambiado desde que lo revisaste. Vuelve a revisarlo antes de confirmar.", [
      { ruta: "planConfirmado", codigo: "plan_cambiado" },
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

/** Fallo de validación después de que ElevenLabs cobrara: lleva los caracteres facturados. */
class ErrorTrasCobro extends ErrorVideo {
  constructor(
    mensaje: string,
    public facturados: number,
  ) {
    super(mensaje);
  }
}

const facturadosDe = (e: unknown): number | undefined =>
  e instanceof ErrorTrasCobro || e instanceof ErrorElevenLabs ? e.facturados : undefined;

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
  const facturados = tts.caracteresFacturados ?? texto.length;
  // Desde aquí la frase ya está cobrada: cualquier rechazo lleva `facturados`.
  const temporal = path.join(dir, `${hash}.tmp-${process.pid}-${randomBytes(6).toString("hex")}.mp3`);
  let creado = false;
  try {
    if (!cabeceraMp3Valida(tts.audio)) throw new ErrorVideo("El audio que devolvió ElevenLabs no empieza por una cabecera MP3 válida; no guardo nada.");
    const fd = fs.openSync(temporal, "wx");
    creado = true;
    try {
      fs.writeFileSync(fd, tts.audio);
    } finally {
      fs.closeSync(fd);
    }
    const info = await sondear(h.ffprobe, temporal).catch((e: Error) => {
      throw new ErrorVideo(`El audio que devolvió ElevenLabs no es un MP3 válido; no guardo nada (${e.message.slice(0, 200).split(temporal).join(path.basename(temporal))}).`);
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
    return { audio: tts.audio, duracion: info.duracion, facturados, requestId: tts.requestId, palabras, crudo: tts.crudo };
  } catch (e) {
    if (e instanceof ErrorTrasCobro) throw e;
    const msg = e instanceof ErrorVideo || e instanceof ErrorAlmacen ? e.message : "No se pudo validar la voz de la frase.";
    if (!(e instanceof ErrorVideo || e instanceof ErrorAlmacen)) log.error(`sintetizarValidado: ${(e as Error).message}`);
    throw new ErrorTrasCobro(msg, facturados);
  } finally {
    if (creado) fs.rmSync(temporal, { force: true });
  }
}

export interface ResultadoGenerar {
  /** Llamadas hechas con éxito (una por texto distinto). */
  generadas: number;
  caracteresFacturados: number;
  /** `facturada`: ElevenLabs cobró la frase y no se pudo usar; reintentarla se cobra otra vez. */
  fallo?: { fraseId: string; mensaje: string; facturada: boolean };
}

/**
 * Genera las frases sin voz, de una en una (el límite de concurrencia de ElevenLabs es bajo). Un fallo corta el lote y
 * se devuelve como `fallo`: lo ya hecho queda en disco y el reintento solo cobra lo que falta.
 */
export async function vozGenerar(
  cfg: Config,
  a: { id: string; frases?: string[]; caracteresConfirmados: number; planConfirmado: string; reintentarFacturadas?: boolean },
  fetchImpl?: typeof fetch,
): Promise<ResultadoGenerar> {
  const ctx = contexto(cfg, a.id);
  const plan = planear(ctx, a.frases);
  exigirCoste(plan.caracteres, a.caracteresConfirmados);
  exigirPlan(plan.plan, a.planConfirmado);
  if (plan.fallidas.length && a.reintentarFacturadas !== true) {
    const cuanto = plan.fallidas.reduce((s, f) => s + f.texto.length, 0);
    throw new ErrorAlmacen(
      "reintento_facturado",
      `${plan.fallidas.length} frase(s) ya se cobraron y no se pudieron usar; generarlas otra vez cobra ${cuanto} caracteres más. Confírmalo de forma expresa para reintentar.`,
      plan.fallidas.map((f) => ({ ruta: f.fraseId, codigo: "reintento_facturado" })),
    );
  }
  if (!plan.unicas.length) return { generadas: 0, caracteresFacturados: 0 };
  requerirClave(cfg);
  const h = requerirFfmpegVoz(cfg);
  if (enCurso.has(ctx.proyecto.id)) throw new ErrorAlmacen("conflicto", "Ya se está generando la voz de este proyecto.");
  enCurso.add(ctx.proyecto.id);
  let generadas = 0;
  let caracteresFacturados = 0;
  try {
    for (const u of plan.unicas) {
      let cobrado: number | undefined;
      try {
        marcarVuelo(ctx.dir, u.hash);
        const r = await sintetizarValidado(cfg, h, ctx.dir, u.hash, u.texto, ctx.voiceId, fetchImpl);
        cobrado = r.facturados;
        escribirAtomico(path.join(ctx.dir, `${u.hash}.mp3`), r.audio);
        escribirAtomico(
          path.join(ctx.dir, `${u.hash}.json`),
          JSON.stringify({ version: 1, hash: u.hash, generado: new Date().toISOString(), modelo: ctx.modelo, requestId: r.requestId, texto: u.texto, duracion: r.duracion, caracteresFacturados: r.facturados, crudo: r.crudo, palabras: r.palabras }),
        );
        fs.rmSync(path.join(ctx.dir, `${u.hash}.fallo`), { force: true });
        quitarVuelo(ctx.dir, u.hash);
        generadas++;
        caracteresFacturados += r.facturados;
      } catch (e) {
        const cobradoAqui = facturadosDe(e) ?? cobrado;
        if (cobradoAqui !== undefined) {
          caracteresFacturados += cobradoAqui;
          anotarFallo(ctx.dir, u.hash, cobradoAqui);
        }
        quitarVuelo(ctx.dir, u.hash); // la respuesta llegó (con o sin cobro anotado): ya no hay duda
        const crudo = e instanceof ErrorElevenLabs || e instanceof ErrorVideo ? (e as Error).message : "No se pudo guardar la voz de la frase.";
        if (!(e instanceof ErrorElevenLabs || e instanceof ErrorVideo)) log.error(`vozGenerar ${ctx.proyecto.id}: ${(e as Error).message}`);
        return { generadas, caracteresFacturados, fallo: { fraseId: u.fraseId, mensaje: ocultarClave(crudo, cfg.elevenApiKey), facturada: cobradoAqui !== undefined } };
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
 * `-protocol_whitelist file`, `-safe 1` y `-format_whitelist concat,mp3` (sin `ffconcat`: una frase no puede abrirse como lista). El nombre depende del contenido de la lista: mismo
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
      ["-y", "-v", "error", ...argsEntrada(lista, "concat", ["mp3"]), "-safe", "1", "-i", lista, "-vn", "-c:a", "pcm_s16le", "-ar", "44100", "-f", "wav", temporal],
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
export async function voces(cfg: Config, fetchImpl?: typeof fetch): Promise<{ voces: { id: string; nombre: string; idioma: string; planMuestra: string }[] }> {
  const crudo = (await listarVocesElevenLabs({ apiKey: requerirClave(cfg), fetchImpl })) as { voices?: unknown };
  const lista = Array.isArray(crudo?.voices) ? crudo.voices.slice(0, MAX_VOCES) : [];
  const salida: { id: string; nombre: string; idioma: string; planMuestra: string }[] = [];
  for (const v of lista as { voice_id?: unknown; name?: unknown; labels?: { language?: unknown } | null }[]) {
    if (typeof v?.voice_id !== "string" || !VOICE_ID_RE.test(v.voice_id)) continue;
    salida.push({ id: v.voice_id, nombre: limpiar(v.name, 80) || v.voice_id, idioma: limpiar(v.labels?.language, 20), planMuestra: planMuestra(cfg.elevenModelId, v.voice_id) });
  }
  return { voces: salida };
}

/**
 * Carpeta de las muestras: `muestras/` junto a `VIDEO_ROOT` (hermana, no dentro: no es un proyecto). En el producto
 * integrado `VIDEO_ROOT` es `<estado>/video/proyectos`, así que son `<estado>/video/muestras`; en desarrollo,
 * `~/Videos/muestras`. Se comprueba (sin enlaces) antes de leer o escribir nada.
 */
export function carpetaMuestras(cfg: Config): string {
  return path.join(path.dirname(path.resolve(cfg.videoRoot)), "muestras");
}

/** Huella de lo que confirma la persona al escuchar una voz: la voz, el modelo y el texto fijo. */
export function planMuestra(modelo: string, voiceId: string): string {
  return createHash("sha256").update(JSON.stringify(["muestra", voiceId, modelo, MUESTRA_TEXTO])).digest("hex");
}

const muestrasEnCurso = new Set<string>();

/**
 * Muestra de una voz: el texto fijo de 60 caracteres, generado con la clave de la persona y guardado por voz. Se
 * confirman 60 caracteres y la huella `planMuestra` (la lista de `video_voces` la trae); si ya está en caché no se
 * llama ni se factura (`caracteres: 0`). Un candado por voz evita cobrar dos veces con dos clics seguidos. Si una
 * muestra se cobró y no se pudo usar, reintentarla exige `reintentarFacturada: true`.
 */
export async function vozMuestra(
  cfg: Config,
  a: { voiceId: string; caracteresConfirmados: number; planConfirmado: string; reintentarFacturada?: boolean },
  fetchImpl?: typeof fetch,
): Promise<{ audioBase64: string; caracteres: number; cache: boolean }> {
  if (typeof a.voiceId !== "string" || !VOICE_ID_RE.test(a.voiceId)) throw esquema("El identificador de la voz no es válido.", "voice_id_invalido", "voiceId");
  exigirCoste(MUESTRA_CARACTERES, a.caracteresConfirmados);
  exigirPlan(planMuestra(cfg.elevenModelId, a.voiceId), a.planConfirmado);
  const dir = carpetaMuestras(cfg);
  const hash = hashFrase(a.voiceId, cfg.elevenModelId, MUESTRA_TEXTO);
  const ruta = path.join(dir, `${hash}.mp3`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    comprobarCarpeta(dir);
  } catch (e) {
    if (e instanceof ErrorVideo) throw esquema(e.message, "enlace_no_permitido");
    throw e;
  }
  if (ficheroNormal(ruta, MAX_AUDIO_TTS)) {
    const guardado = fs.readFileSync(ruta);
    if (cabeceraMp3Valida(guardado)) return { audioBase64: guardado.toString("base64"), caracteres: 0, cache: true };
  }
  requerirClave(cfg);
  const h = requerirFfmpegVoz(cfg);
  if (leerMarca(dir, hash) && a.reintentarFacturada !== true) {
    throw new ErrorAlmacen("reintento_facturado", `La muestra de esta voz ya se cobró (${MUESTRA_CARACTERES} caracteres) y no se pudo usar; reintentarla la cobra otra vez. Confírmalo de forma expresa.`, [
      { ruta: "voiceId", codigo: "reintento_facturado" },
    ]);
  }
  if (muestrasEnCurso.has(hash)) throw new ErrorAlmacen("conflicto", "Ya se está generando la muestra de esta voz.");
  muestrasEnCurso.add(hash);
  try {
    marcarVuelo(dir, hash);
    const r = await sintetizarValidado(cfg, h, dir, hash, MUESTRA_TEXTO, a.voiceId, fetchImpl);
    escribirAtomico(ruta, r.audio);
    fs.rmSync(path.join(dir, `${hash}.fallo`), { force: true });
    quitarVuelo(dir, hash);
    return { audioBase64: r.audio.toString("base64"), caracteres: MUESTRA_CARACTERES, cache: false };
  } catch (e) {
    const cobrado = facturadosDe(e);
    if (cobrado !== undefined) anotarFallo(dir, hash, cobrado);
    quitarVuelo(dir, hash);
    if (e instanceof ErrorElevenLabs || e instanceof ErrorVideo) {
      const msg = ocultarClave(e.message, cfg.elevenApiKey);
      if (cobrado !== undefined) throw new ErrorAlmacen("fallo_facturado", `${msg} ElevenLabs ya cobró ${cobrado} caracteres de esta muestra.`);
      throw new ErrorVideo(msg);
    }
    throw e;
  } finally {
    muestrasEnCurso.delete(hash);
  }
}
