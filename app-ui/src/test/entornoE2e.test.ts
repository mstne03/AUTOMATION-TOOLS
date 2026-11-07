import { describe, expect, it } from "vitest";
import { entornoSidecar } from "../../e2e/global-setup";

describe("entorno del sidecar en los E2E", () => {
  it("no_hereda_claves_reales", () => {
    const env = entornoSidecar(
      { PATH: "/bin", ELEVENLABS_API_KEY: "sk_real", ANTHROPIC_API_KEY: "sk-ant-real", GH_TOKEN: "ghp_real", HF_TOKEN: "hf_real", ELEVENLABS_VOICE_ID: "real" },
      { VIDEO_PRUEBAS_TTS_URL: "http://127.0.0.1:1234" },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.ELEVENLABS_API_KEY).not.toContain("real");
    expect(env.ELEVENLABS_VOICE_ID).toBe("voz-e2e");
    expect(env.VIDEO_PRUEBAS_TTS_URL).toBe("http://127.0.0.1:1234");
    expect(JSON.stringify(env)).not.toMatch(/sk_real|sk-ant-real|ghp_real|hf_real/);
  });
});
