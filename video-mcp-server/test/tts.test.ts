// D7 (SPEC-video.md): la respuesta de ElevenLabs es entrada no confiable. Sin red: fetch simulado.
import { describe, expect, it, vi } from "vitest";
import { ErrorElevenLabs, MAX_AUDIO_TTS, MAX_RESPUESTA_TTS, URL_BASE_ELEVENLABS, baseElevenLabs, sintetizarConTimestamps } from "../src/tts.js";

const CLAVE = "sk-secreta-de-prueba";
const TEXTO = "Hola mundo.";

function alineacion(texto = TEXTO, paso = 0.05) {
  const chars = [...texto];
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * paso),
    character_end_times_seconds: chars.map((_, i) => (i + 1) * paso),
  };
}

const cuerpo = (extra: Record<string, unknown> = {}) => ({
  audio_base64: Buffer.from("audio").toString("base64"),
  alignment: alineacion(),
  normalized_alignment: null,
  ...extra,
});

const respuesta = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200 });

async function llamar(fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return sintetizarConTimestamps({ texto: TEXTO, apiKey: CLAVE, voiceId: "voz", modelId: "m", fetchImpl: fetchImpl as unknown as typeof fetch });
}

describe("sintetizarConTimestamps: respuesta hostil o rota (D7)", () => {
  it("una respuesta buena pasa, y los tiempos iguales son normales", async () => {
    const al = alineacion();
    al.character_start_times_seconds[1] = al.character_start_times_seconds[0]; // dos caracteres con el mismo inicio
    al.character_end_times_seconds[1] = al.character_end_times_seconds[0] + 0.05;
    const r = await llamar(async () => respuesta(cuerpo({ alignment: al })));
    expect(r.alineacion.characters).toHaveLength(TEXTO.length);
    expect(r.audio.toString()).toBe("audio");
  });

  const rechazos: [string, () => unknown, RegExp][] = [
    [
      "null en los tiempos",
      () => {
        const al = alineacion();
        (al.character_start_times_seconds as unknown[])[3] = null;
        return cuerpo({ alignment: al });
      },
      /no es válida.*finito/,
    ],
    [
      "longitudes distintas",
      () => {
        const al = alineacion();
        al.character_end_times_seconds.pop();
        return cuerpo({ alignment: al });
      },
      /longitudes distintas/,
    ],
    [
      "más de 2 × los caracteres enviados (10^6)",
      () => {
        const n = 1_000_000;
        return cuerpo({
          alignment: { characters: new Array(n).fill("a"), character_start_times_seconds: new Array(n).fill(0), character_end_times_seconds: new Array(n).fill(0) },
        });
      },
      /no es válida.*para 11 enviados/,
    ],
    [
      "tiempos que retroceden",
      () => {
        const al = alineacion();
        al.character_start_times_seconds[5] = al.character_start_times_seconds[4] - 0.001;
        return cuerpo({ alignment: al });
      },
      /retroceden/,
    ],
    [
      "tiempo negativo",
      () => {
        const al = alineacion();
        al.character_start_times_seconds[0] = -0.5;
        return cuerpo({ alignment: al });
      },
      /negativo/,
    ],
    [
      "fin antes que inicio",
      () => {
        const al = alineacion();
        al.character_end_times_seconds[2] = al.character_start_times_seconds[2] - 0.01;
        return cuerpo({ alignment: al });
      },
      /negativo o acaba antes/,
    ],
    ["audio de más de 10 MB", () => cuerpo({ audio_base64: Buffer.alloc(MAX_AUDIO_TTS + 1024).toString("base64") }), /pasa de 10 MB/],
    ["sin alineación", () => cuerpo({ alignment: null }), /no trae alineación/],
  ];
  for (const [nombre, hacer, esperado] of rechazos) {
    it(`rechaza ${nombre} con un ErrorElevenLabs legible`, async () => {
      const p = llamar(async () => respuesta(hacer()));
      await expect(p).rejects.toBeInstanceOf(ErrorElevenLabs);
      await expect(llamar(async () => respuesta(hacer()))).rejects.toThrow(esperado);
    });
  }

  it("un cuerpo troceado, sin content-length, que pasa del tope se corta al pasarlo", async () => {
    let enviados = 0;
    const trozo = new Uint8Array(1024 * 1024).fill(97);
    const flujo = new ReadableStream<Uint8Array>({
      pull(c) {
        enviados++;
        c.enqueue(trozo);
        if (enviados > MAX_RESPUESTA_TTS / trozo.length + 50) c.close(); // si no se corta, acaba con 50 MB de más
      },
    });
    const res = new Response(flujo, { status: 200 });
    expect(res.headers.get("content-length")).toBeNull();
    await expect(llamar(async () => res)).rejects.toThrow(/pasa de 20 MB/);
    expect(enviados).toBeLessThan(MAX_RESPUESTA_TTS / trozo.length + 5); // dejó de leer en el tope
  });

  it("un content-length declarado por encima del tope se rechaza sin leer", async () => {
    const res = new Response("x", { status: 200, headers: { "content-length": String(MAX_RESPUESTA_TTS + 1) } });
    await expect(llamar(async () => res)).rejects.toThrow(/pasa de 20 MB/);
  });

  it("el cuerpo de un error también tiene tope", async () => {
    const grande = "e".repeat(2 * 1024 * 1024);
    await expect(llamar(async () => new Response(grande, { status: 500 }))).rejects.toThrow(/pasa de 1 MB/);
  });

  it("no sigue redirecciones: fetch con redirect=error, para no llevar xi-api-key a otro origen", async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => respuesta(cuerpo()));
    await llamar(f);
    expect(f.mock.calls[0][1]?.redirect).toBe("error");
    const g = vi.fn(async () => {
      throw new TypeError(`fallo con ${CLAVE}`);
    });
    const e = await llamar(g).catch((x: Error) => x);
    expect(e).toBeInstanceOf(ErrorElevenLabs);
    expect((e as Error).message).not.toContain(CLAVE);
  });
});

describe("baseElevenLabs: VIDEO_PRUEBAS_TTS_URL no abre una salida de red nueva (I14)", () => {
  const MOCK = "http://127.0.0.1:5599";

  it("sin la variable, siempre api.elevenlabs.io", () => {
    expect(baseElevenLabs({})).toBe(URL_BASE_ELEVENLABS);
    expect(baseElevenLabs({ VIDEO_ENGINE_EMBEDDED: "1" })).toBe(URL_BASE_ELEVENLABS);
    expect(baseElevenLabs({ VIDEO_E2E: "1", VIDEO_PRUEBAS_TTS_URL: "" })).toBe(URL_BASE_ELEVENLABS);
  });

  it("la acepta con VIDEO_E2E=1, también integrado, y en desarrollo (no integrado)", () => {
    expect(baseElevenLabs({ VIDEO_ENGINE_EMBEDDED: "1", VIDEO_E2E: "1", VIDEO_PRUEBAS_TTS_URL: MOCK })).toBe(MOCK);
    expect(baseElevenLabs({ VIDEO_PRUEBAS_TTS_URL: MOCK })).toBe(MOCK);
    expect(baseElevenLabs({ VIDEO_PRUEBAS_TTS_URL: `${MOCK}/` })).toBe(MOCK);
  });

  it("integrado sin VIDEO_E2E=1 la rechaza (producto congelado)", () => {
    for (const e2e of [undefined, "0", "true", ""]) {
      expect(() => baseElevenLabs({ VIDEO_ENGINE_EMBEDDED: "1", VIDEO_E2E: e2e, VIDEO_PRUEBAS_TTS_URL: MOCK })).toThrow(ErrorElevenLabs);
    }
  });

  it("rechaza cualquier otro host, puerto, esquema o ruta", () => {
    const malas = [
      "https://api.elevenlabs.io",
      "http://api.elevenlabs.io:80",
      "http://localhost:5599",
      "http://127.0.0.1",
      "http://127.0.0.1:",
      "http://127.0.0.1:0",
      "http://127.0.0.1:99999",
      "https://127.0.0.1:5599",
      "http://127.0.0.2:5599",
      "http://127.0.0.1.evil.com:5599",
      "http://127.0.0.1:5599.evil.com",
      "http://127.0.0.1@evil.com:5599",
      "http://evil.com@127.0.0.1:5599",
      "http://user:pass@127.0.0.1:5599",
      "http://[::1]:5599",
      "http://0.0.0.0:5599",
      "http://127.0.0.1:5599/v1",
      "http://127.0.0.1:5599?x=1",
      "http://127.0.0.1:5599#x",
      "http://127.0.0.1:5599 http://evil.com",
      "  http://127.0.0.1:5599",
      "http://127.0.0.1:5599\\@evil.com",
      "//127.0.0.1:5599",
      "ftp://127.0.0.1:5599",
      "no es una url",
    ];
    for (const u of malas) {
      for (const base of [{ VIDEO_E2E: "1" }, {}]) {
        expect(() => baseElevenLabs({ ...base, VIDEO_PRUEBAS_TTS_URL: u }), u).toThrow(ErrorElevenLabs);
      }
    }
  });

  it("sintetizarConTimestamps llama al mock y a ningún otro host; con una URL mala no llama", async () => {
    const urls: string[] = [];
    const f = async (u: string | URL | Request) => (urls.push(String(u)), respuesta(cuerpo()));
    await sintetizarConTimestamps({ texto: TEXTO, apiKey: CLAVE, voiceId: "voz", modelId: "m", fetchImpl: f as unknown as typeof fetch, env: { VIDEO_PRUEBAS_TTS_URL: MOCK } });
    expect(urls).toEqual([`${MOCK}/v1/text-to-speech/voz/with-timestamps?output_format=mp3_44100_128`]);
    urls.length = 0;
    await expect(
      sintetizarConTimestamps({ texto: TEXTO, apiKey: CLAVE, voiceId: "voz", modelId: "m", fetchImpl: f as unknown as typeof fetch, env: { VIDEO_PRUEBAS_TTS_URL: "http://evil.example:5599" } }),
    ).rejects.toThrow(ErrorElevenLabs);
    expect(urls).toEqual([]);
  });
});
