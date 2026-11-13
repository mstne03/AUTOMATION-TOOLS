import { describe, expect, it } from "vitest";
import { entornoSidecar } from "../../e2e/entorno";
import fuente from "../../e2e/entorno.ts?raw";

const extra = { APP_BACKEND_DIR: "/tmp/estado-e2e", VIDEO_PRUEBAS_TTS_URL: "http://127.0.0.1:1234" };

describe("entorno del sidecar en los E2E (lista blanca)", () => {
  it("no_hereda_ninguna_credencial", () => {
    const env = entornoSidecar(
      {
        PATH: "/bin",
        ELEVENLABS_KEY: "sk_real",
        ANTHROPIC_KEY: "sk-ant-real",
        AWS_SECRET_ACCESS_KEY: "aws_real",
        GH_PAT: "ghp_real",
        X_PASS: "pass_real",
        ELEVENLABS_API_KEY_DEV: "dev_real",
        HTTPS_PROXY: "http://usuario:clave_real@proxy:3128",
        UV_INDEX_URL: "https://usuario:indice_real@pypi.privado/simple",
      },
      extra,
    );
    expect(env.PATH).toBe("/bin");
    const claves = Object.keys(env);
    for (const k of ["ELEVENLABS_KEY", "ANTHROPIC_KEY", "AWS_SECRET_ACCESS_KEY", "GH_PAT", "X_PASS", "ELEVENLABS_API_KEY_DEV", "HTTPS_PROXY", "UV_INDEX_URL"]) {
      expect(claves).not.toContain(k); // ninguna, no «no todas a la vez»
    }
    expect(JSON.stringify(env)).not.toMatch(/_real/);
  });

  it("copia_las_variables_del_sistema_imprescindibles", () => {
    const env = entornoSidecar({ Path: "C:\\x", SystemRoot: "C:\\Windows", TEMP: "/t", HOME: "/h", UV_CACHE_DIR: "/c", LANG: "es" }, extra);
    expect(env).toMatchObject({ Path: "C:\\x", SystemRoot: "C:\\Windows", TEMP: "/t", HOME: "/h", UV_CACHE_DIR: "/c", LANG: "es" });
  });

  it("fuerza_las_variables_de_aislamiento", () => {
    const env = entornoSidecar({ APP_BACKEND_DIR: "/real", APP_BACKEND_SECRETS: "keyring", ANTHROPIC_API_KEY: "sk-ant-real", ELEVENLABS_API_KEY: "sk_real", ELEVENLABS_VOICE_ID: "real", APP_BACKEND_SIN_DOTENV: "0" }, extra);
    expect(env.APP_BACKEND_DIR).toBe("/tmp/estado-e2e");
    expect(env.APP_BACKEND_SECRETS).toBe("file");
    expect(env.ANTHROPIC_API_KEY).toBe(""); // vacía: el respaldo del backend no tapa el almacén
    expect(env.ELEVENLABS_API_KEY).toMatch(/falsa/);
    expect(env.ELEVENLABS_VOICE_ID).toBe("voz-e2e");
    expect(env.VIDEO_PRUEBAS_TTS_URL).toBe("http://127.0.0.1:1234");
    expect(env.APP_BACKEND_SIN_DOTENV).toBe("1");
    expect(JSON.stringify(env)).not.toMatch(/_real|real"/);
  });

  it("el_modulo_sigue_siendo_puro", () => {
    const src = fuente.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bprocess\b|node:|require\(/);
  });
});
