// Recursos del usuario (T7): foto, clip y música entran por la bandeja (`<estado>/video/bandeja/<32hex>.bin`, que escribe el
// comando nativo de T13), se identifican por sus bytes, se miden con los límites de I15 ANTES de decodificar y se
// normalizan con el ffmpeg LGPL del bundle. Lo que ve HyperFrames, la preview y el análisis es solo lo ya normalizado:
//   foto  → PNG, lado ≤ 3840 · clip → MP4 H.264 sin audio, ≤ 60 fps · música → M4A AAC.
// La UI nunca manda rutas (I6) y el nombre del usuario es solo texto de la interfaz: ni nombra ficheros ni llega a la composición.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { nombreRecursoSeguro, RECURSO_ID_RE, type Proyecto } from "./esquema.js";
import { log } from "./log.js";
import { carpetaDeSalida } from "./montaje.js";
import { ErrorVideo, borrarArbol, carpetaVideo, comprobarRecurso, copiarRecurso, escribirAtomico } from "./paths.js";
import { argsEntrada, ejecutar, herramientasFfmpeg, mensajeSinFfmpeg, pasaPorEnlace, sondear, type Herramientas, type InfoMedio } from "./proceso.js";
import { ARGS_CODIFICADOR, dependencias, ordenSegundaPasada } from "./render.js";
import { ErrorAlmacen, esquema, leerJson, proyectoCambiarRecursos, proyectoLeer } from "./proyecto.js";

const MiB = 1024 * 1024;

/** Límites de I15. Se aplican a los bytes, a la cabecera y a lo que dice ffprobe, siempre antes de decodificar o codificar. */
export const LIMITES_MEDIO = {
  foto: { bytes: 50 * MiB, lado: 8192, pixeles: 40_000_000 },
  clip: { bytes: 500 * MiB, segundos: 60, lado: 4096, fps: 60 },
  musica: { bytes: 100 * MiB, segundos: 15 * 60 },
} as const;
/** Lado máximo de la foto normalizada. */
const LADO_FOTO = 3840;
/** ffprobe lee cabeceras e índices (moov); más tiempo que esto es un fichero hostil. */
// 4 min por codificación y sin reintento tras un timeout: el peor caso queda por debajo del plazo del backend (420 s).
const TIMEOUT_CODIFICAR_MS = 4 * 60_000;
/** Fotograma fijo de fondo de los clips horizontales (M-D7): pequeño, porque se desenfoca. */
const ANCHO_FONDO = 540;

export type Clase = "foto" | "clip" | "musica";
export type TipoMedio = "png" | "jpeg" | "webp" | "mp4" | "matroska" | "wav" | "mp3" | "ogg" | "flac";
export const BANDEJA_RE = /^[0-9a-f]{32}$/;
export const PISTA_ID_RE = /^m-[0-9a-f]{16}$/;

export interface AvisoRecurso {
  codigo: string;
  mensaje: string;
}
type Recurso = Proyecto["recursos"][number];

// ---------- Rutas ----------

/**
 * `<dirname(VIDEO_ROOT)>/bandeja`: con `VIDEO_ROOT = <estado>/video/proyectos` es `<estado>/video/bandeja`,
 * donde la escribe el comando nativo de Rust (T13, `lib.rs`). Contrato compartido con Rust y el backend (R2-1).
 */
export const carpetaBandeja = (raiz: string): string => path.join(path.dirname(path.resolve(raiz)), "bandeja");
/** `<dirname(VIDEO_ROOT)>/video/musica`: la biblioteca de pistas (`m-<16hex>.m4a` y su `.json`). */
export const carpetaMusica = (raiz: string): string => path.join(path.dirname(path.resolve(raiz)), "video", "musica");
const carpetaRecursos = (raiz: string, id: string): string => path.join(carpetaVideo(raiz, id), "recursos");

// ---------- Identificación por bytes ----------

const ascii = (b: Buffer, desde: number, hasta: number): string => b.toString("latin1", desde, hasta);

/**
 * El formato sale de los bytes iniciales, nunca del nombre. Una lista HLS, un `ffconcat`, un script o cualquier texto no
 * empiezan por ninguna de estas firmas y no se abren: son justo lo que haría que ffmpeg leyera otros ficheros o la red.
 */
export function identificarMedio(b: Buffer): TipoMedio | undefined {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF") {
    if (ascii(b, 8, 12) === "WEBP") return "webp";
    if (ascii(b, 8, 12) === "WAVE") return "wav";
  }
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") return "mp4";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "matroska";
  if (b.length >= 4 && ascii(b, 0, 4) === "OggS") return "ogg";
  if (b.length >= 4 && ascii(b, 0, 4) === "fLaC") return "flac";
  if (b.length >= 3 && (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))) return "mp3";
  return undefined;
}

const DEMUXER: Readonly<Record<TipoMedio, string>> = { png: "png_pipe", jpeg: "jpeg_pipe", webp: "webp_pipe", mp4: "mov", matroska: "matroska", wav: "wav", mp3: "mp3", ogg: "ogg", flac: "flac" };
const TIPOS_POR_CLASE: Readonly<Record<Clase, readonly TipoMedio[]>> = {
  foto: ["png", "jpeg", "webp"],
  clip: ["mp4", "matroska"],
  musica: ["mp4", "wav", "mp3", "ogg", "flac"],
};

/** Ancho y alto que declara la cabecera de la imagen, sin decodificar nada. `undefined` si no se pueden leer. */
export function dimensionesImagen(b: Buffer, tipo: TipoMedio): { ancho: number; alto: number } | undefined {
  const dim = (ancho: number, alto: number) => (ancho > 0 && alto > 0 ? { ancho, alto } : undefined);
  if (tipo === "png") return b.length >= 24 && ascii(b, 12, 16) === "IHDR" ? dim(b.readUInt32BE(16), b.readUInt32BE(20)) : undefined;
  if (tipo === "webp") {
    const trozo = ascii(b, 12, 16);
    if (trozo === "VP8X" && b.length >= 30) return dim(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    if (trozo === "VP8L" && b.length >= 25 && b[20] === 0x2f) return dim(1 + (b[21] | ((b[22] & 0x3f) << 8)), 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)));
    if (trozo === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return dim(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    return undefined;
  }
  if (tipo === "jpeg") {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return undefined;
      const m = b[i + 1];
      if (m === 0xff) {
        i++; // relleno
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return dim(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      if (m === 0xd9 || m === 0xda) return undefined; // fin o datos de imagen sin haber visto el SOF
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

// ---------- Errores ----------

const sinFormato = (): ErrorAlmacen => esquema("El archivo no es una foto, un clip ni un audio que SEO Studio admita.", "formato_no_admitido", "clase");
const limite = (que: string): ErrorAlmacen => esquema(`El archivo supera el límite: ${que}.`, "limite_excedido", "clase");

/** Un error de `paths` (enlace, hardlink, tamaño) como error tipado del almacén. */
function dePaths(e: unknown): unknown {
  if (!(e instanceof ErrorVideo)) return e;
  if (/pesa más/.test(e.message)) return new ErrorAlmacen("demasiado_grande", e.message);
  if (/enlace|fichero normal/.test(e.message)) return esquema(e.message, "enlace_no_permitido", "bandejaId");
  if (/ha cambiado|No puedo leer/.test(e.message)) return esquema(e.message, "fichero_no_valido", "bandejaId");
  return e; // p. ej. falta ffmpeg: el anfitrión lo reconoce por el texto
}

const sinEnlace = (dir: string): boolean => {
  try {
    return !pasaPorEnlace(dir);
  } catch {
    return false; // ruta de red o dispositivo: no
  }
};

// ---------- Bandeja ----------

/**
 * Consume una entrada de la bandeja: valida el id, rechaza enlaces y la renombra a un nombre privado (rename es atómico:
 * de dos peticiones a la vez gana una). Devuelve la ruta privada; quien la llama la borra siempre al acabar.
 */
function reclamarBandeja(raiz: string, bandejaId: unknown, maxBytes: number): string {
  if (typeof bandejaId !== "string" || !BANDEJA_RE.test(bandejaId)) throw esquema("El identificador de la bandeja no es válido.", "bandeja_id_invalido", "bandejaId");
  const dir = carpetaBandeja(raiz);
  if (!fs.existsSync(dir)) throw new ErrorAlmacen("no_encontrado", "No existe esa entrada de la bandeja.");
  if (!sinEnlace(dir)) throw esquema("La carpeta de la bandeja es un enlace o pasa por uno.", "enlace_no_permitido", "bandejaId");
  const origen = path.join(dir, `${bandejaId}.bin`);
  try {
    comprobarRecurso(origen);
  } catch (e) {
    if (!fs.existsSync(origen) && !isLink(origen)) throw new ErrorAlmacen("no_encontrado", "No existe esa entrada de la bandeja.");
    quitar(origen); // un enlace plantado en la bandeja se quita (solo el enlace, nunca su destino)
    throw dePaths(e);
  }
  if (fs.lstatSync(origen).size > maxBytes) {
    quitar(origen);
    throw new ErrorAlmacen("demasiado_grande", `El archivo pesa más de ${maxBytes / MiB} MB.`);
  }
  limpiarUsosHuerfanos(dir, `${bandejaId}.bin`);
  const uso = path.join(dir, `${bandejaId}.uso-${randomBytes(6).toString("hex")}`);
  try {
    fs.renameSync(origen, uso);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ErrorAlmacen("no_encontrado", "Esa entrada de la bandeja ya se usó.");
    quitar(origen); // un solo uso también si el rename falla (EBUSY, permisos)
    throw e;
  }
  return uso;
}
/**
 * Lo que lleva más de una hora en la bandeja es de una importación que murió a medias (L-2) o que nadie reclamó (A27-3):
 * `.uso-*`, `.bin` sin reclamar y `.parcial` de una copia nativa cortada. Son copias privadas del usuario de hasta 500 MB.
 */
function limpiarUsosHuerfanos(dir: string, salvo?: string): void {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === salvo || !e.isFile() || !/^[0-9a-f]{32}\.(uso-[0-9a-f]{12}|bin|parcial)$/.test(e.name)) continue;
      if (Date.now() - fs.statSync(path.join(dir, e.name)).mtimeMs > 3600_000) quitar(path.join(dir, e.name));
    }
  } catch {
    /* otra instancia la está limpiando */
  }
}
const isLink = (ruta: string): boolean => {
  try {
    fs.lstatSync(ruta);
    return true;
  } catch {
    return false;
  }
};
/** A27-3: una importación que falla antes de reclamar la entrada la retira igualmente (un solo uso, nada retenido). */
function descartarBandeja(raiz: string, bandejaId: unknown): void {
  if (typeof bandejaId !== "string" || !BANDEJA_RE.test(bandejaId)) return;
  const dir = carpetaBandeja(raiz);
  if (fs.existsSync(dir) && sinEnlace(dir)) quitar(path.join(dir, `${bandejaId}.bin`));
}
const quitar = (ruta: string): void => {
  try {
    fs.unlinkSync(ruta);
  } catch {
    /* ya no está */
  }
};

// ---------- Normalización ----------

export interface DepsRecursos {
  /** Codificadores H.264 a probar, por orden. Los tests lo sustituyen para forzar el fallo visible. */
  candidatos?: (h: Herramientas) => Promise<string[]>;
}

interface Normalizado {
  ext: "png" | "mp4" | "m4a";
  ancho: number;
  alto: number;
  duracion: number;
  avisos: AvisoRecurso[];
  codificador?: string;
  /** Rutas temporales, en la carpeta de trabajo: salida y, en clips horizontales, el fotograma fijo. */
  salida: string;
  fondo?: string;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const herramientas = (cfg: Config): Herramientas => {
  const h = herramientasFfmpeg(cfg.ffmpegDir);
  if (!h) throw new ErrorVideo(mensajeSinFfmpeg());
  return h;
};

async function ffmpegSalida(h: Herramientas, args: string[], cuando: string): Promise<void> {
  const r = await ejecutar(h.ffmpeg, ["-y", "-v", "error", "-nostdin", ...args], { timeoutMs: TIMEOUT_CODIFICAR_MS });
  if (r.timeout) throw esquema(`${cuando}: tardó demasiado y se canceló.`, "tiempo_excedido", "clase");
  if (r.code !== 0) throw esquema(`${cuando}: el archivo no se pudo leer o convertir.`, "archivo_danado", "clase");
}

async function normalizarFoto(h: Herramientas, entrada: string, tipo: TipoMedio, cabecera: Buffer, trabajo: string): Promise<Normalizado> {
  const L = LIMITES_MEDIO.foto;
  const d = dimensionesImagen(cabecera, tipo);
  if (!d) throw esquema("No se pudo leer el tamaño de la imagen.", "archivo_danado", "clase");
  if (d.ancho > L.lado || d.alto > L.lado) throw limite(`más de ${L.lado} píxeles de lado`);
  if (d.ancho * d.alto > L.pixeles) throw limite(`más de ${L.pixeles / 1e6} megapíxeles`);
  const salida = path.join(trabajo, "salida.png");
  const escala = `scale='min(${LADO_FOTO},iw)':'min(${LADO_FOTO},ih)':force_original_aspect_ratio=decrease`;
  await ffmpegSalida(h, ["-max_pixels", String(L.pixeles + 64 * L.lado), /* ffmpeg compara con el ancho redondeado a 64 */ ...argsEntrada(entrada, DEMUXER[tipo]), "-i", entrada, "-frames:v", "1", "-an", "-sn", "-vf", escala, "-c:v", "png", "-f", "image2", "-update", "1", salida], "Foto");
  const info = await sondear(h.ffprobe, salida);
  if (info.codecVideo !== "png" || !info.ancho || !info.alto) throw esquema("La foto normalizada no es válida.", "archivo_danado", "clase");
  const avisos: AvisoRecurso[] = [];
  if (info.ancho < 1080 || info.alto < 1920) avisos.push({ codigo: "foto_pequena", mensaje: `La foto mide ${info.ancho}×${info.alto}, menos que 1080×1920: se verá borrosa.` });
  return { ext: "png", ancho: info.ancho, alto: info.alto, duracion: 0, avisos, salida };
}

async function normalizarClip(h: Herramientas, entrada: string, tipo: TipoMedio, trabajo: string, deps: DepsRecursos): Promise<Normalizado> {
  const L = LIMITES_MEDIO.clip;
  const info = await sondear(h.ffprobe, entrada, { demuxer: DEMUXER[tipo], maxPixeles: L.lado * L.lado }).catch(() => {
    throw esquema("El clip no se pudo leer.", "archivo_danado", "clase");
  });
  if (!info.pistasVideo || !info.ancho || !info.alto) throw esquema("El archivo no tiene vídeo.", "sin_video", "clase");
  if (info.ancho > L.lado || info.alto > L.lado) throw limite(`más de ${L.lado} píxeles de lado`);
  const fps = Math.max(info.fps ?? 0, info.fpsMedio ?? 0);
  if (fps > L.fps + 0.01) throw limite(`más de ${L.fps} fotogramas por segundo`);
  const dur = Math.max(info.duracion ?? 0, info.duracionVideo ?? 0);
  if (!(dur > 0)) throw esquema("No se pudo saber cuánto dura el clip.", "archivo_danado", "clase");
  if (dur > L.segundos + 0.05) throw limite(`más de ${L.segundos} s`);

  const salida = path.join(trabajo, "salida.mp4");
  const candidatos = await (deps.candidatos ?? (async (herr) => ordenSegundaPasada(await dependencias.sondear(herr))))(h);
  const fallidos: string[] = [];
  const cfr = String(Math.min(L.fps, Math.max(1, Math.round(fps || 30))));
  for (const cod of candidatos) {
    const extra = (ARGS_CODIFICADOR as Record<string, string[] | undefined>)[cod] ?? [];
    try {
      // -an/-sn/-dn: el audio, los subtítulos y los datos del clip se descartan. -t acota lo que diga el contenedor. CFR para que el seek caiga exacto.
      await ffmpegSalida(
        h,
        ["-max_pixels", String(L.lado * L.lado), ...argsEntrada(entrada, DEMUXER[tipo]), "-i", entrada, "-map", "0:v:0", "-an", "-sn", "-dn", "-t", String(L.segundos + 1), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-fps_mode", "cfr", "-r", cfr, "-c:v", cod, ...extra, "-movflags", "+faststart", "-f", "mp4", salida],
        `Clip con ${cod}`,
      );
      if (fallidos.length) log.info(`Clip: ${fallidos.join(", ")} falló; se usó ${cod}.`);
      log.info(`Clip normalizado con ${cod}.`);
      return await verificarClip(h, salida, cod, trabajo, fallidos);
    } catch (e) {
      if (!(e instanceof ErrorAlmacen) || e.problemas[0]?.codigo !== "archivo_danado") throw e;
      fallidos.push(cod);
      log.warn(`Clip: la codificación con ${cod} falló.`);
      fs.rmSync(salida, { force: true });
    }
  }
  throw esquema(`Ningún codificador H.264 pudo convertir el clip (${fallidos.join(", ") || "ninguno disponible"}).`, "sin_codificador", "clase");
}

async function verificarClip(h: Herramientas, salida: string, cod: string, trabajo: string, fallidos: string[]): Promise<Normalizado> {
  const L = LIMITES_MEDIO.clip;
  const info = await sondear(h.ffprobe, salida);
  if (info.codecVideo !== "h264" || info.pistasAudio || !info.ancho || !info.alto || !(info.duracion! > 0) || info.duracion! > L.segundos + 0.5) {
    throw esquema("El clip normalizado no cumple el formato (H.264, sin audio, ≤ 60 s).", "archivo_danado", "clase");
  }
  const avisos: AvisoRecurso[] = [];
  if (fallidos.length) avisos.push({ codigo: "codificador_reserva", mensaje: `${fallidos.join(", ")} no pudo; el clip se codificó con ${cod}.` });
  let fondo: string | undefined;
  if (info.ancho > info.alto) {
    // M-D7: el fondo desenfocado es un fotograma fijo (el CSS `filter: blur()` lo desenfoca); `boxblur` y `gblur` no están en el build LGPL.
    fondo = path.join(trabajo, "fondo.png");
    await ffmpegSalida(h, [...argsEntrada(salida), "-i", salida, "-frames:v", "1", "-vf", `scale=${ANCHO_FONDO}:-2`, "-c:v", "png", "-f", "image2", "-update", "1", fondo], "Fondo del clip");
    avisos.push({ codigo: "clip_horizontal", mensaje: "El clip es horizontal: se verá sobre un fondo desenfocado." });
  }
  return { ext: "mp4", ancho: info.ancho, alto: info.alto, duracion: r3(info.duracion!), avisos, codificador: cod, salida, fondo };
}

async function normalizarMusica(h: Herramientas, entrada: string, tipo: TipoMedio, trabajo: string): Promise<Normalizado> {
  const L = LIMITES_MEDIO.musica;
  // La carátula de una pista (MP3, FLAC, M4A) es un fotograma de vídeo: mismo tope que el de un clip.
  const info: InfoMedio = await sondear(h.ffprobe, entrada, { demuxer: DEMUXER[tipo], maxPixeles: LIMITES_MEDIO.clip.lado ** 2 }).catch(() => {
    throw esquema("El audio no se pudo leer.", "archivo_danado", "clase");
  });
  if (!info.pistasAudio) throw esquema("El archivo no tiene audio.", "sin_audio", "clase");
  const dur = info.duracion ?? 0;
  if (!(dur > 0)) throw esquema("No se pudo saber cuánto dura el audio.", "archivo_danado", "clase");
  if (dur > L.segundos + 0.5) throw limite(`más de ${L.segundos / 60} minutos`);
  const salida = path.join(trabajo, "salida.m4a");
  await ffmpegSalida(h, ["-max_pixels", String(LIMITES_MEDIO.clip.lado ** 2), ...argsEntrada(entrada, DEMUXER[tipo]), "-i", entrada, "-vn", "-sn", "-dn", "-map", "0:a:0", "-t", String(L.segundos + 1), "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", salida], "Audio");
  const fin = await sondear(h.ffprobe, salida);
  if (!fin.pistasAudio || fin.pistasVideo || !(fin.duracion! > 0)) throw esquema("El audio normalizado no es válido.", "archivo_danado", "clase");
  return { ext: "m4a", ancho: 1, alto: 1, duracion: r3(fin.duracion!), avisos: [], salida };
}

/** Lee los primeros bytes de un fichero ya copiado y privado. */
function cabeceraDe(ruta: string): Buffer {
  const fd = fs.openSync(ruta, "r");
  try {
    const b = Buffer.alloc(256 * 1024);
    return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Carpetas `.imp-*` de importaciones que murieron a medias (más de una hora): se limpian al empezar otra. */
function limpiarRestos(destino: string): void {
  for (const e of fs.readdirSync(destino, { withFileTypes: true })) {
    if (e.isDirectory() && !e.isSymbolicLink() && e.name.startsWith(".imp-")) {
      try {
        if (Date.now() - fs.statSync(path.join(destino, e.name)).mtimeMs > 3600_000) borrarArbol(path.join(destino, e.name));
      } catch {
        /* otra instancia la está borrando */
      }
    }
  }
}

/**
 * Del `.bin` de la bandeja al fichero normalizado `<nombre>.<ext>` dentro de `destino`. Todo el trabajo ocurre en una carpeta
 * privada `.imp-*` de `destino` y el resultado entra con un rename (atómico): nunca queda un fichero a medias a la vista.
 */
async function importarA(cfg: Config, bandejaId: unknown, clase: Clase, destino: string, nombre: string, deps: DepsRecursos): Promise<Normalizado & { publicados: string[] }> {
  if (!Object.hasOwn(TIPOS_POR_CLASE, clase as string)) {
    descartarBandeja(cfg.videoRoot, bandejaId);
    throw esquema("La clase no es foto, clip ni musica.", "clase_invalida", "clase");
  }
  const maxBytes = LIMITES_MEDIO[clase].bytes;
  const uso = reclamarBandeja(cfg.videoRoot, bandejaId, maxBytes);
  let trabajo = "";
  try {
    carpetaDeSalida(destino); // crea la carpeta y falla cerrado si es un enlace o pasa por uno
    limpiarRestos(destino);
    trabajo = path.join(destino, `.imp-${randomBytes(6).toString("hex")}`);
    fs.mkdirSync(trabajo);
    const entrada = path.join(trabajo, "entrada.bin");
    copiarRecurso(uso, entrada, maxBytes); // abre una sola vez: fichero normal, un solo enlace, bajo el tope
    const cabecera = cabeceraDe(entrada);
    const tipo = identificarMedio(cabecera);
    if (!tipo) throw sinFormato();
    if (!TIPOS_POR_CLASE[clase].includes(tipo)) throw esquema(`El archivo es ${tipo} y se pidió ${clase}.`, "clase_distinta", "clase");
    const h = herramientas(cfg);
    const n = clase === "foto" ? await normalizarFoto(h, entrada, tipo, cabecera, trabajo) : clase === "clip" ? await normalizarClip(h, entrada, tipo, trabajo, deps) : await normalizarMusica(h, entrada, tipo, trabajo);
    const publicados: string[] = [];
    const destinoFinal = path.join(destino, `${nombre}.${n.ext}`);
    fs.renameSync(n.salida, destinoFinal);
    publicados.push(destinoFinal);
    if (n.fondo) {
      const f = path.join(destino, `${nombre}.fondo.png`);
      fs.renameSync(n.fondo, f);
      publicados.push(f);
    }
    return { ...n, publicados };
  } catch (e) {
    throw dePaths(e);
  } finally {
    quitar(uso);
    if (trabajo) borrarArbol(trabajo);
  }
}

// ---------- Recursos del proyecto ----------

const idRecurso = (): string => `r-${randomBytes(8).toString("hex")}`;

export interface ResultadoImportar {
  recurso: Recurso;
  avisos: AvisoRecurso[];
  revision: number;
  codificador?: string;
}

/**
 * `video_recurso_importar`: normaliza lo que hay en la bandeja y lo añade a `recursos` del proyecto (revisión + 1). El fichero
 * se llama por el id, nunca por el nombre del usuario; si el proyecto no admite el recurso (p. ej. ya hay 30), el fichero se retira.
 */
export async function importarRecurso(
  cfg: Config,
  a: { id: string; bandejaId: unknown; clase: Clase; nombreOriginal?: unknown },
  deps: DepsRecursos = {},
): Promise<ResultadoImportar> {
  try {
    proyectoLeer(cfg.videoRoot, a.id); // id válido, proyecto existente y válido
  } catch (e) {
    descartarBandeja(cfg.videoRoot, a.bandejaId);
    throw e;
  }
  const rid = idRecurso();
  const n = await importarA(cfg, a.bandejaId, a.clase, carpetaRecursos(cfg.videoRoot, a.id), rid, deps);
  const recurso: Recurso = { id: rid, clase: a.clase, ext: n.ext, nombreOriginal: nombreRecursoSeguro(a.nombreOriginal), ancho: n.ancho, alto: n.alto, duracion: n.duracion };
  try {
    const { revision } = proyectoCambiarRecursos(cfg.videoRoot, a.id, (p) => [...p.recursos, recurso]);
    return { recurso, avisos: n.avisos, revision, ...(n.codificador ? { codificador: n.codificador } : {}) };
  } catch (e) {
    for (const f of n.publicados) borrarArbol(f);
    throw e;
  }
}

/** `video_recurso_borrar`: `en_uso` si una escena lo usa como capa; si no, sale de `recursos` (revisión + 1) y se borran sus ficheros. */
export function borrarRecurso(cfg: Config, a: { id: string; recursoId: unknown }): { revision: number } {
  if (typeof a.recursoId !== "string" || !RECURSO_ID_RE.test(a.recursoId)) throw esquema("El id del recurso no es válido.", "recurso_id_invalido", "recursoId");
  const rid = a.recursoId;
  let quitado: Recurso | undefined;
  const { revision } = proyectoCambiarRecursos(cfg.videoRoot, a.id, (p) => {
    quitado = p.recursos.find((r) => r.id === rid);
    if (!quitado) throw new ErrorAlmacen("no_encontrado", "No existe ese recurso en el proyecto.");
    if (p.escenas.some((e) => e.capa?.recursoId === rid)) throw new ErrorAlmacen("en_uso", "El recurso está en uso en una escena.", [{ ruta: "escenas", codigo: "recurso_en_uso" }]);
    return p.recursos.filter((r) => r.id !== rid);
  });
  const dir = carpetaRecursos(cfg.videoRoot, a.id);
  if (!sinEnlace(dir)) throw esquema("La carpeta de recursos es un enlace o pasa por uno.", "enlace_no_permitido", "recursoId");
  for (const f of [`${rid}.${quitado!.ext}`, `${rid}.fondo.png`]) {
    if (fs.existsSync(path.join(dir, f))) borrarArbol(path.join(dir, f));
  }
  return { revision };
}

// ---------- Biblioteca de música ----------

export interface Pista {
  id: string;
  nombre: string;
  duracion: number;
}

/** `video_musica_importar`: la pista entra como M4A en la biblioteca (`m-<16hex>.m4a` y su `.json`), disponible para todos los proyectos. */
export async function musicaImportar(cfg: Config, a: { bandejaId: unknown; nombreOriginal?: unknown }, deps: DepsRecursos = {}): Promise<{ pista: Pista }> {
  const id = `m-${randomBytes(8).toString("hex")}`;
  const dir = carpetaMusica(cfg.videoRoot);
  const n = await importarA(cfg, a.bandejaId, "musica", dir, id, deps);
  const pista: Pista = { id, nombre: nombreRecursoSeguro(a.nombreOriginal), duracion: n.duracion };
  try {
    escribirAtomico(path.join(dir, `${id}.json`), JSON.stringify(pista));
  } catch (e) {
    for (const f of n.publicados) borrarArbol(f);
    throw e;
  }
  return { pista };
}

/** `video_musica_listar`: id, nombre y duración. Nunca rutas (I6). */
export function musicaListar(cfg: Config): { pistas: Pista[] } {
  const dir = carpetaMusica(cfg.videoRoot);
  if (!fs.existsSync(dir) || !sinEnlace(dir)) return { pistas: [] };
  const pistas: Pista[] = [];
  for (const nombre of fs.readdirSync(dir)) {
    const m = /^(m-[0-9a-f]{16})\.json$/.exec(nombre);
    if (!m || !fs.existsSync(path.join(dir, `${m[1]}.m4a`))) continue;
    try {
      const j = leerJson(path.join(dir, nombre)) as Partial<Pista>;
      if (j.id === m[1] && typeof j.nombre === "string" && typeof j.duracion === "number") pistas.push({ id: j.id, nombre: nombreRecursoSeguro(j.nombre), duracion: j.duracion });
    } catch {
      /* un .json ilegible no tumba la lista */
    }
  }
  return { pistas: pistas.sort((x, y) => x.nombre.localeCompare(y.nombre) || x.id.localeCompare(y.id)) };
}
