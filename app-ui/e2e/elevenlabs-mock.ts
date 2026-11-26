/** ElevenLabs falso para los E2E de vídeo. Sirve `POST /v1/text-to-speech/<voz>/with-timestamps`
 *  con un MP3 mudo y una alineación uniforme por carácter (T5). Exige `xi-api-key` y cuenta las
 *  llamadas y los caracteres, para comprobar que reintentar no refactura (`GET /__llamadas`).
 *  Solo escucha en 127.0.0.1; la URL se pasa al sidecar en `VIDEO_PRUEBAS_TTS_URL`. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const SEGUNDOS_POR_CARACTER = 0.06;
/** Un fotograma MPEG-1 capa III de 128 kbit/s a 44,1 kHz mide 417 bytes y dura 26,12 ms. */
const BYTES_FOTOGRAMA = 417;
const SEGUNDOS_FOTOGRAMA = 1152 / 44100;

/** MP3 mudo de `segundos`: cabecera válida y datos a cero. */
export function mp3Mudo(segundos: number): Buffer {
  const n = Math.max(1, Math.ceil(segundos / SEGUNDOS_FOTOGRAMA));
  const f = Buffer.alloc(BYTES_FOTOGRAMA);
  f.set([0xff, 0xfb, 0x90, 0x00]);
  return Buffer.concat(Array.from({ length: n }, () => f));
}

export interface ElevenLabsMock {
  url: string;
  server: Server;
  /** Llamadas de síntesis atendidas y caracteres facturados desde el arranque. */
  llamadas: () => { sintesis: number; caracteres: number };
}

export interface OpcionesMock {
  /** Si devuelve un estado HTTP, la síntesis falla con él (p. ej. 429 en la frase 7). */
  fallar?: (n: number) => number | null;
}

export async function startElevenLabsMock(opciones: OpcionesMock = {}): Promise<ElevenLabsMock> {
  let sintesis = 0;
  let caracteres = 0;
  const server = createServer((req, res) => {
    const json = (estado: number, cuerpo: unknown) => {
      res.writeHead(estado, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cuerpo));
    };
    if (req.method === "GET" && req.url === "/__llamadas") return json(200, { sintesis, caracteres });
    if (req.method !== "POST" || !/^\/v1\/text-to-speech\/[^/]+\/with-timestamps(\?|$)/.test(req.url ?? "")) return json(404, { detail: "No existe." });
    if (!req.headers["xi-api-key"]) return json(401, { detail: { status: "invalid_api_key", message: "Falta la clave." } });
    let cuerpo = "";
    req.on("data", (d) => {
      cuerpo += d;
      if (cuerpo.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      let texto = "";
      try {
        texto = String((JSON.parse(cuerpo) as { text?: unknown }).text ?? "");
      } catch {
        return json(422, { detail: "Cuerpo no válido." });
      }
      if (!texto) return json(422, { detail: "Texto vacío." });
      const n = ++sintesis;
      const estado = opciones.fallar?.(n) ?? null;
      if (estado) return json(estado, { detail: { status: "mock_error", message: "Fallo simulado." } });
      caracteres += texto.length;
      const chars = [...texto];
      json(200, {
        audio_base64: mp3Mudo(chars.length * SEGUNDOS_POR_CARACTER).toString("base64"),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_, i) => +(i * SEGUNDOS_POR_CARACTER).toFixed(3)),
          character_end_times_seconds: chars.map((_, i) => +((i + 1) * SEGUNDOS_POR_CARACTER).toFixed(3)),
        },
        normalized_alignment: null,
      });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  server.unref(); // no retiene el proceso de Playwright si el teardown no lo cierra
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, llamadas: () => ({ sintesis, caracteres }) };
}
