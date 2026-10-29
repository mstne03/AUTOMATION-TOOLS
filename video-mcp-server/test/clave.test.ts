// La clave de ElevenLabs no llega a los hijos del motor, y el aviso de voz dice lo que falta de verdad.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAVES_PERMITIDAS, entornoConFfmpeg } from "../src/proceso.js";
import { mensajeFaltanParaVoz } from "../src/herramientas.js";

afterEach(() => vi.unstubAllEnvs());

describe("entornoConFfmpeg", () => {
  it("no pasa ELEVENLABS_API_KEY a HyperFrames, Chrome ni ffmpeg", () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "xi-secreta");
    const env = entornoConFfmpeg({ dir: "C:\\ff", ffmpeg: "", ffprobe: "" }, { ELEVENLABS_API_KEY: "xi-extra" });
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    // El entorno es la lista blanca de I5: ni lo que pase el llamador ni el PATH del usuario.
    for (const k of Object.keys(env)) expect(CLAVES_PERMITIDAS.has(k), k).toBe(true);
    expect(env.PATH).not.toContain("C:\\ff");
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
