// La clave de ElevenLabs no llega a los hijos del motor, y el aviso de voz dice lo que falta de verdad.
import { afterEach, describe, expect, it, vi } from "vitest";
import { entornoHijo } from "../src/proceso.js";
import type { Config } from "../src/config.js";
import { catalogo, mensajeFaltanParaVoz, mensajeSinNavegador } from "../src/herramientas.js";

afterEach(() => vi.unstubAllEnvs());

describe("entornoHijo", () => {
  it("no pasa ELEVENLABS_API_KEY a HyperFrames, Chrome ni ffmpeg", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "xi-secreta");
    const env = entornoHijo();
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    // El entorno es la lista blanca de I5.
    expect(Object.keys(env)).not.toContain("ELEVENLABS_API_KEY");
  });
});

describe("mensajeSinNavegador (I11, I14)", () => {
  it("integrado remite a Ajustes y no propone ningún comando ni descarga de HyperFrames", () => {
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "1");
    const m = mensajeSinNavegador();
    expect(m).toMatch(/Ajustes de SEO Studio/);
    expect(m).not.toMatch(/npx|hyperframes|browser ensure/i);
  });
  it("suelto tampoco propone descargar con HyperFrames", () => {
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "");
    expect(mensajeSinNavegador()).not.toMatch(/npx|browser ensure/i);
  });
});

describe("catálogo en integrado (I14)", () => {
  it("la llamada directa también falla, sin lanzar la CLI", async () => {
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "1");
    await expect(catalogo({ ffmpegDir: undefined } as unknown as Config, { consulta: "map" })).rejects.toThrow(/no está disponible en SEO Studio/);
  });
});

describe("mensajeFaltanParaVoz", () => {
  it("en modo integrado solo pide lo que falta, desde Ajustes", () => {
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "1");
    expect(mensajeFaltanParaVoz(["ELEVENLABS_VOICE_ID"])).toBe("Elige la voz de ElevenLabs en Ajustes de SEO Studio.");
    expect(mensajeFaltanParaVoz(["ELEVENLABS_API_KEY"])).toBe("Añade tu clave de ElevenLabs en Ajustes de SEO Studio.");
  });

  it("suelto, remite al .env", () => {
    vi.stubEnv("VIDEO_ENGINE_EMBEDDED", "");
    expect(mensajeFaltanParaVoz(["ELEVENLABS_API_KEY"])).toMatch(/\.env del servidor/);
  });
});
