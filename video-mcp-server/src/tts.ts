// Cliente de ElevenLabs: text-to-speech con timestamps por carácter. Nunca registra la API key.
import type { AlineacionCaracteres } from "./alineacion.js";
import { log, ocultarClave } from "./log.js";
import { esIntegrado } from "./proceso.js";

export const URL_BASE_ELEVENLABS = "https://api.elevenlabs.io";

export interface RespuestaTts {
  audio: Buffer;
  /** JSON crudo devuelto por la API, sin el audio. */
  crudo: { alignment: AlineacionCaracteres | null; normalized_alignment: AlineacionCaracteres | null };
  alineacion: AlineacionCaracteres;
  /** Caracteres facturados según la cabecera de la respuesta; undefined si no viene. */
  caracteresFacturados?: number;
  requestId?: string;
}

export class ErrorElevenLabs extends Error {}

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
async function leerCuerpo(res: Response, tope: number, clave: string): Promise<string> {
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

export async function sintetizarConTimestamps(opts: {
  texto: string;
  apiKey: string;
  voiceId: string;
  modelId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RespuestaTts> {
  const url = `${URL_BASE_ELEVENLABS}/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
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

  const cuerpo = await leerCuerpo(res, res.ok ? MAX_RESPUESTA_TTS : MAX_ERROR_TTS, opts.apiKey);
  if (!res.ok) {
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
        : " Revisa ELEVENLABS_VOICE_ID (la voz no existe en esta cuenta).",
      422: integrado ? " Revisa el modelo de voz en Ajustes de SEO Studio y el texto enviado." : " Revisa ELEVENLABS_MODEL_ID y el texto enviado.",
      429: " Límite de uso o de concurrencia alcanzado; espera y vuelve a intentarlo.",
    };
    const pista = pistas[res.status] ?? "";
    throw new ErrorElevenLabs(`ElevenLabs respondió ${res.status}: ${ocultarClave(detalle, opts.apiKey)}.${pista}`);
  }

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
  const cabecera = res.headers.get("x-character-count") ?? res.headers.get("character-cost");
  const caracteresFacturados = cabecera && Number.isFinite(Number(cabecera)) ? Number(cabecera) : undefined;
  return {
    audio,
    crudo: {
      alignment: problemaA === null ? (j.alignment as AlineacionCaracteres) : null,
      normalized_alignment: problemaN === null ? (j.normalized_alignment as AlineacionCaracteres) : null,
    },
    alineacion,
    caracteresFacturados,
    requestId: res.headers.get("request-id") ?? undefined,
  };
}
