import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { generarVoz, guardarGuion, listar } from "../src/herramientas.js";
import { ErrorGuion, hashNarracion } from "../src/guion.js";

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "video tools "));
afterAll(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

const cfg: Config = {
  elevenApiKey: "sk-secreta-de-prueba",
  elevenVoiceId: "voz123",
  elevenModelId: "eleven_multilingual_v2",
  videoRoot: RAIZ,
  browserPath: undefined,
  musicaVolumen: 0.12,
  ffmpegDir: undefined,
};

const GUION = `---
titulo: Test
gancho: Hook line.
---
[1] One two three.
[2] Four five.
[3] Six seven.
[4] Eight.
[5] Nine ten.
[6] Eleven twelve.
`;

function respuestaFalsa(texto: string) {
  const chars = [...texto];
  const cuerpo = {
    audio_base64: Buffer.from("no es un mp3 real").toString("base64"),
    alignment: {
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => i * 0.06),
      character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.06),
    },
    normalized_alignment: null,
  };
  return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "x-character-count": String(texto.length) } });
}

describe("herramientas", () => {
  it("guardar_guion valida antes de escribir y no pisa sin sobrescribir", () => {
    expect(() => guardarGuion(cfg, { contenido: "sin frontmatter" })).toThrow(ErrorGuion);
    expect(fs.readdirSync(RAIZ)).toEqual([]);

    const r = guardarGuion(cfg, { contenido: GUION });
    expect(r.datos.id).toBe("video001");
    expect(fs.existsSync(path.join(RAIZ, "video001", "guion.md"))).toBe(true);
    expect(() => guardarGuion(cfg, { id: "video001", contenido: GUION })).toThrow(/sobrescribir=true/);
    expect(listar(cfg).datos.siguienteId).toBe("video002");
  });

  it("generar_voz no vuelve a llamar a ElevenLabs si ya hay voz", async () => {
    const fetchFalso = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string; model_id: string };
      expect(body.model_id).toBe("eleven_multilingual_v2");
      return respuestaFalsa(body.text);
    });

    const r1 = await generarVoz(cfg, { id: "video001" }, fetchFalso as unknown as typeof fetch);
    expect(r1.datos.llamadaApi).toBe(true);
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFalso.mock.calls[0];
    expect(String(url)).toBe("https://api.elevenlabs.io/v1/text-to-speech/voz123/with-timestamps?output_format=mp3_44100_128");
    expect((init?.headers as Record<string, string>)["xi-api-key"]).toBe("sk-secreta-de-prueba");

    const dir = path.join(RAIZ, "video001");
    const palabras = JSON.parse(fs.readFileSync(path.join(dir, "palabras.json"), "utf8"));
    expect(palabras.hashNarracion).toBe(hashNarracion("One two three. Four five. Six seven. Eight. Nine ten. Eleven twelve."));
    expect(palabras.segmentos).toHaveLength(6);
    expect(fs.existsSync(path.join(dir, "alineacion.json"))).toBe(true);

    const r2 = await generarVoz(cfg, { id: "video001" }, fetchFalso as unknown as typeof fetch);
    expect(r2.datos.llamadaApi).toBe(false);
    expect(fetchFalso).toHaveBeenCalledTimes(1);

    // Cambiar el guion avisa de que la voz hay que regenerarla.
    const g = guardarGuion(cfg, { id: "video001", contenido: GUION.replace("Eight.", "Eight and more."), sobrescribir: true });
    expect(String(g.texto)).toMatch(/regenerar la voz/);
  });

  it("los errores de la API no exponen la API key", async () => {
    guardarGuion(cfg, { id: "video003", contenido: GUION });
    const fetchError = vi.fn(async () => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "bad key sk-secreta-de-prueba" } }), { status: 401 }));
    await expect(generarVoz(cfg, { id: "video003" }, fetchError as unknown as typeof fetch)).rejects.toThrow(/401[\s\S]*ELEVENLABS_API_KEY/);
    await expect(generarVoz(cfg, { id: "video003" }, fetchError as unknown as typeof fetch)).rejects.not.toThrow(/sk-secreta/);
    expect(fs.existsSync(path.join(RAIZ, "video003", "voz.mp3"))).toBe(false);
  });
});
