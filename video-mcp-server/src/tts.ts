// Cliente de ElevenLabs: text-to-speech con timestamps por carácter. Nunca registra la API key.
import type { AlineacionCaracteres } from "./alineacion.js";
import { log } from "./log.js";

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

function ocultarClave(texto: string, clave: string): string {
  return clave ? texto.split(clave).join("***") : texto;
}

function esAlineacion(v: unknown): v is AlineacionCaracteres {
  const a = v as AlineacionCaracteres | null;
  return (
    !!a &&
    Array.isArray(a.characters) &&
    Array.isArray(a.character_start_times_seconds) &&
    Array.isArray(a.character_end_times_seconds) &&
    a.characters.length > 0
  );
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
    });
  } catch (e) {
    throw new ErrorElevenLabs(`No se pudo conectar con ElevenLabs: ${ocultarClave((e as Error).message, opts.apiKey)}`);
  }

  const cuerpo = await res.text();
  if (!res.ok) {
    let detalle = cuerpo.slice(0, 500);
    try {
      const j = JSON.parse(cuerpo) as { detail?: { status?: string; message?: string } | string };
      detalle = typeof j.detail === "string" ? j.detail : [j.detail?.status, j.detail?.message].filter(Boolean).join(": ") || detalle;
    } catch {
      /* cuerpo no JSON */
    }
    const pista =
      res.status === 401
        ? " Revisa ELEVENLABS_API_KEY en el .env del servidor."
        : res.status === 404
          ? " Revisa ELEVENLABS_VOICE_ID (la voz no existe en esta cuenta)."
          : res.status === 422
            ? " Revisa ELEVENLABS_MODEL_ID y el texto enviado."
            : res.status === 429
              ? " Límite de uso o de concurrencia alcanzado; espera y vuelve a intentarlo."
              : "";
    throw new ErrorElevenLabs(`ElevenLabs respondió ${res.status}: ${ocultarClave(detalle, opts.apiKey)}.${pista}`);
  }

  let j: { audio_base64?: string; alignment?: unknown; normalized_alignment?: unknown };
  try {
    j = JSON.parse(cuerpo);
  } catch {
    throw new ErrorElevenLabs("ElevenLabs devolvió una respuesta que no es JSON.");
  }
  if (!j.audio_base64) throw new ErrorElevenLabs("La respuesta de ElevenLabs no trae audio_base64.");
  const alineacion = esAlineacion(j.alignment) ? j.alignment : esAlineacion(j.normalized_alignment) ? j.normalized_alignment : null;
  if (!alineacion) throw new ErrorElevenLabs("La respuesta de ElevenLabs no trae alineación por carácter (alignment).");

  // Se registran las cabeceras de coste tal cual llegan (nunca la clave) para poder contrastarlas con el panel.
  const cabecerasCoste = [...res.headers.entries()].filter(([k]) => /charact|cost|credit|request-id/i.test(k));
  log.info(`ElevenLabs: ${opts.texto.length} caracteres enviados; cabeceras de coste: ${cabecerasCoste.map(([k, v]) => `${k}=${v}`).join(", ") || "ninguna"}`);
  const cabecera = res.headers.get("x-character-count") ?? res.headers.get("character-cost");
  const caracteresFacturados = cabecera && Number.isFinite(Number(cabecera)) ? Number(cabecera) : undefined;
  return {
    audio: Buffer.from(j.audio_base64, "base64"),
    crudo: {
      alignment: esAlineacion(j.alignment) ? j.alignment : null,
      normalized_alignment: esAlineacion(j.normalized_alignment) ? j.normalized_alignment : null,
    },
    alineacion,
    caracteresFacturados,
    requestId: res.headers.get("request-id") ?? undefined,
  };
}
