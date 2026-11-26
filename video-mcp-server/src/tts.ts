// Cliente de ElevenLabs: text-to-speech con timestamps por carácter. Nunca registra la API key.
import type { AlineacionCaracteres } from "./alineacion.js";
import { log, ocultarClave } from "./log.js";
import { esIntegrado } from "./proceso.js";

export const URL_BASE_ELEVENLABS = "https://api.elevenlabs.io";

/**
 * Base de la API. `VIDEO_PRUEBAS_TTS_URL` solo sirve a los E2E para apuntar al mock y no abre ninguna salida de red
 * nueva (I14): se acepta con `VIDEO_E2E=1` o fuera del modo integrado (desarrollo), y solo si es exactamente
 * `http://127.0.0.1:<puerto>` (sin usuario, ruta, consulta ni otro host). Cualquier otra cosa es un error: con la
 * variable puesta no se cae en silencio a la API real. El backend congelado nunca la pasa.
 */
export function baseElevenLabs(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.VIDEO_PRUEBAS_TTS_URL;
  if (v === undefined || v === "") return URL_BASE_ELEVENLABS;
  if (esIntegrado(env) && env.VIDEO_E2E !== "1") {
    throw new ErrorElevenLabs("VIDEO_PRUEBAS_TTS_URL solo se admite con VIDEO_E2E=1 o en desarrollo; la ignoro y no llamo a ElevenLabs.");
  }
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(v);
  const puerto = m ? Number(m[1]) : 0;
  if (!m || puerto < 1 || puerto > 65535) {
    throw new ErrorElevenLabs("VIDEO_PRUEBAS_TTS_URL tiene que ser http://127.0.0.1:<puerto>; no llamo a ElevenLabs.");
  }
  return `http://127.0.0.1:${puerto}`;
}

export interface RespuestaTts {
  audio: Buffer;
  /** JSON crudo devuelto por la API, sin el audio. */
  crudo: { alignment: AlineacionCaracteres | null; normalized_alignment: AlineacionCaracteres | null };
  alineacion: AlineacionCaracteres;
  /** Caracteres facturados según la cabecera de la respuesta; undefined si no viene. */
  caracteresFacturados?: number;
  requestId?: string;
}

export class ErrorElevenLabs extends Error {
  /**
   * Caracteres que ElevenLabs ya cobró con un 200 aunque la respuesta se descarte después (audio demasiado grande,
   * alineación inválida, corte a medias). Ausente si el error llegó antes de que hubiera cobro.
   */
  facturados?: number;
}

/** Cuerpo de la respuesta (D7): ≤ 20 MB. */
export const MAX_RESPUESTA_TTS = 20 * 1024 * 1024;
/** Audio de una frase (D7, I15): ≤ 10 MB. */
export const MAX_AUDIO_TTS = 10 * 1024 * 1024;
/** Cuerpo de un error de la API: texto corto. */
const MAX_ERROR_TTS = 1024 * 1024;

const mb = (bytes: number) => `${bytes / 1024 / 1024} MB`;

/**
 * Lee el cuerpo por trozos con un contador y aborta al pasar el tope: `res.text()` primero lo guarda entero, y con
 * `transfer-encoding: chunked` no hay content-length que avise (A3: respuesta hostil).
 */
export async function leerCuerpo(res: Response, tope: number, clave: string): Promise<string> {
  const declarado = Number(res.headers.get("content-length"));
  const demasiado = () => new ErrorElevenLabs(`La respuesta de ElevenLabs pasa de ${mb(tope)}; la descarto y no guardo nada.`);
  if (Number.isFinite(declarado) && declarado > tope) {
    await res.body?.cancel().catch(() => undefined);
    throw demasiado();
  }
  if (!res.body) return "";
  const lector = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for (let r = await lector.read(); !r.done; r = await lector.read()) {
      total += r.value.length;
      if (total > tope) {
        await lector.cancel().catch(() => undefined);
        throw demasiado();
      }
      partes.push(r.value);
    }
  } catch (e) {
    if (e instanceof ErrorElevenLabs) throw e;
    throw new ErrorElevenLabs(`No se pudo leer la respuesta de ElevenLabs: ${ocultarClave((e as Error).message, clave)}`);
  }
  return Buffer.concat(partes).toString("utf8");
}

/**
 * Esquema de D7 para una alineación: mismas longitudes, ≤ 2 × los caracteres enviados, números finitos, ≥ 0,
 * no decrecientes y `fin ≥ inicio`. Dos caracteres con el mismo inicio son normales y pasan. Devuelve el motivo o null.
 * (El «≤ duración del audio + 1 s» lo comprueba quien ha sondeado el audio.)
 */
function problemaAlineacion(v: unknown, enviados: number): string | null {
  const a = v as AlineacionCaracteres | null;
  if (!a || !Array.isArray(a.characters) || !Array.isArray(a.character_start_times_seconds) || !Array.isArray(a.character_end_times_seconds)) {
    return "faltan characters o sus tiempos";
  }
  const n = a.characters.length;
  if (n === 0) return "está vacía";
  if (a.character_start_times_seconds.length !== n || a.character_end_times_seconds.length !== n) return "characters y tiempos tienen longitudes distintas";
  if (n > 2 * enviados) return `trae ${n} caracteres para ${enviados} enviados`;
  let inicioPrevio = 0;
  let finPrevio = 0;
  for (let i = 0; i < n; i++) {
    const c = a.characters[i];
    const ini = a.character_start_times_seconds[i];
    const fin = a.character_end_times_seconds[i];
    if (typeof c !== "string" || c.length > 8) return `el carácter ${i} no es un texto corto`;
    if (typeof ini !== "number" || typeof fin !== "number" || !Number.isFinite(ini) || !Number.isFinite(fin)) return `el tiempo del carácter ${i} no es un número finito`;
    if (ini < 0 || fin < ini) return `el tiempo del carácter ${i} es negativo o acaba antes de empezar`;
    if (ini < inicioPrevio || fin < finPrevio) return `los tiempos retroceden en el carácter ${i}`;
    inicioPrevio = ini;
    finPrevio = fin;
  }
  return null;
}

/** Error legible de una respuesta no 2xx; la clave nunca sale en el texto. */
export function errorHttp(status: number, cuerpo: string, apiKey: string): ErrorElevenLabs {
  let detalle = cuerpo.slice(0, 500);
  try {
    const j = JSON.parse(cuerpo) as { detail?: { status?: string; message?: string } | string };
    detalle = typeof j.detail === "string" ? j.detail : [j.detail?.status, j.detail?.message].filter(Boolean).join(": ") || detalle;
  } catch {
    /* cuerpo no JSON */
  }
  const integrado = esIntegrado();
  const pistas: Record<number, string> = {
    401: integrado ? " Revisa tu clave de ElevenLabs en Ajustes de SEO Studio." : " Revisa ELEVENLABS_API_KEY en el .env del servidor.",
    404: integrado
      ? " La voz elegida no existe en esta cuenta; cámbiala en Ajustes de SEO Studio."
      : " Revisa la voz del perfil (no existe en esta cuenta).",
    422: integrado ? " Revisa el modelo de voz en Ajustes de SEO Studio y el texto enviado." : " Revisa ELEVENLABS_MODEL_ID y el texto enviado.",
    429: " Límite de uso o de concurrencia alcanzado; espera y vuelve a intentarlo.",
  };
  return new ErrorElevenLabs(`ElevenLabs respondió ${status}: ${ocultarClave(detalle, apiKey)}.${pistas[status] ?? ""}`);
}

/** Catálogo de voces de la cuenta (`GET /v1/voices`): solo se lee el JSON; no se sigue ninguna URL de la respuesta (M-D3). */
export async function listarVocesElevenLabs(opts: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${baseElevenLabs(opts.env)}/v1/voices`, {
      method: "GET",
      headers: { "xi-api-key": opts.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
      redirect: "error",
    });
  } catch (e) {
    throw new ErrorElevenLabs(`No se pudo conectar con ElevenLabs: ${ocultarClave((e as Error).message, opts.apiKey)}`);
  }
  const cuerpo = await leerCuerpo(res, res.ok ? MAX_RESPUESTA_TTS : MAX_ERROR_TTS, opts.apiKey);
  if (!res.ok) throw errorHttp(res.status, cuerpo, opts.apiKey);
  try {
    return JSON.parse(cuerpo);
  } catch {
    throw new ErrorElevenLabs("ElevenLabs devolvió una respuesta que no es JSON.");
  }
}

/**
 * Caracteres facturados según la cabecera: solo un entero en [0, 10 × lo enviado]. Cualquier otra cosa (negativo,
 * fraccionario, NaN, enorme) se ignora y se avisa: se usará la estimación local (los caracteres enviados).
 */
export function caracteresDeCabecera(cabecera: string | null, enviados: number): number | undefined {
  if (cabecera === null || cabecera === "") return undefined;
  const n = /^\d{1,9}$/.test(cabecera.trim()) ? Number(cabecera) : Number.NaN;
  if (Number.isInteger(n) && n >= 0 && n <= 10 * enviados) return n;
  log.warn(`ElevenLabs devolvió un x-character-count no válido (${cabecera.slice(0, 40)}); uso la estimación local de ${enviados} caracteres.`);
  return undefined;
}

const idDePeticion = (v: string | null): string | undefined => (v !== null && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : undefined);

export async function sintetizarConTimestamps(opts: {
  texto: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<RespuestaTts> {
  const url = `${baseElevenLabs(opts.env)}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "xi-api-key": opts.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ text: opts.texto, model_id: opts.modelId }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180000),
      // I14: una redirección a otro origen se llevaría el xi-api-key.
      redirect: "error",
    });
  } catch (e) {
    throw new ErrorElevenLabs(`No se pudo conectar con ElevenLabs: ${ocultarClave((e as Error).message, opts.apiKey)}`);
  }

  if (!res.ok) throw errorHttp(res.status, await leerCuerpo(res, MAX_ERROR_TTS, opts.apiKey), opts.apiKey);

  // Con el 200 el servicio ya cobra: desde aquí, todo error lleva los caracteres facturados (Medium 1 de la revisión de T5).
  const cabecera = res.headers.get("x-character-count") ?? res.headers.get("character-cost");
  const caracteresFacturados = caracteresDeCabecera(cabecera, opts.texto.length);
  try {
    return await procesarRespuesta(res, opts, caracteresFacturados);
  } catch (e) {
    if (e instanceof ErrorElevenLabs) e.facturados = caracteresFacturados ?? opts.texto.length;
    throw e;
  }
}

async function procesarRespuesta(res: Response, opts: { texto: string; apiKey: string }, caracteresFacturados: number | undefined): Promise<RespuestaTts> {
  const cuerpo = await leerCuerpo(res, MAX_RESPUESTA_TTS, opts.apiKey);
  let j: { audio_base64?: string; alignment?: unknown; normalized_alignment?: unknown };
  try {
    j = JSON.parse(cuerpo);
  } catch {
    throw new ErrorElevenLabs("ElevenLabs devolvió una respuesta que no es JSON.");
  }
  if (typeof j.audio_base64 !== "string" || !j.audio_base64) throw new ErrorElevenLabs("La respuesta de ElevenLabs no trae audio_base64.");
  // Antes de decodificar: 4 caracteres base64 son 3 bytes.
  if (j.audio_base64.length > Math.ceil((MAX_AUDIO_TTS * 4) / 3) + 8) throw new ErrorElevenLabs(`El audio de ElevenLabs pasa de ${mb(MAX_AUDIO_TTS)}; no guardo nada.`);
  const audio = Buffer.from(j.audio_base64, "base64");
  if (!audio.length || audio.length > MAX_AUDIO_TTS) throw new ErrorElevenLabs(`El audio de ElevenLabs está vacío o pasa de ${mb(MAX_AUDIO_TTS)}; no guardo nada.`);
  const enviados = opts.texto.length;
  const problemaA = problemaAlineacion(j.alignment, enviados);
  const problemaN = problemaAlineacion(j.normalized_alignment, enviados);
  const alineacion = problemaA === null ? (j.alignment as AlineacionCaracteres) : problemaN === null ? (j.normalized_alignment as AlineacionCaracteres) : null;
  if (!alineacion) {
    if (j.alignment == null && j.normalized_alignment == null) throw new ErrorElevenLabs("La respuesta de ElevenLabs no trae alineación por carácter (alignment).");
    throw new ErrorElevenLabs(`La alineación de ElevenLabs no es válida (${j.alignment == null ? problemaN : problemaA}); no guardo nada.`);
  }

  // Se registran las cabeceras de coste tal cual llegan (nunca la clave) para poder contrastarlas con el panel.
  const cabecerasCoste = [...res.headers.entries()].filter(([k]) => /charact|cost|credit|request-id/i.test(k));
  log.info(`ElevenLabs: ${opts.texto.length} caracteres enviados; cabeceras de coste: ${cabecerasCoste.map(([k, v]) => `${k}=${v}`).join(", ") || "ninguna"}`);
  return {
    audio,
    crudo: {
      alignment: problemaA === null ? (j.alignment as AlineacionCaracteres) : null,
      normalized_alignment: problemaN === null ? (j.normalized_alignment as AlineacionCaracteres) : null,
    },
    alineacion,
    caracteresFacturados,
    requestId: idDePeticion(res.headers.get("request-id")),
  };
}
