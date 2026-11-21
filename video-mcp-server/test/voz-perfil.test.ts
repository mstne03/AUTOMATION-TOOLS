// La voz sale del perfil del proyecto, no de ELEVENLABS_VOICE_ID, y «falta la clave» y «falta la voz» son códigos distintos
// (`sin_clave`, `sin_voz`). Ninguna prueba necesita ffmpeg ni red: todo falla (o se calcula) antes de llamar a ElevenLabs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { PERFIL_DEFECTO, carpetaPerfiles, perfilDuplicar, perfilGuardar, perfilesListar, type Perfil } from "../src/perfil.js";
import { ErrorAlmacen, guionGuardar, proyectoCrear } from "../src/proyecto.js";
import { planMuestra, vozCoste, vozGenerar, vozMuestra } from "../src/voz.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "video vozperfil "));
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

const CLAVE = "sk-secreta-de-prueba";
let RAIZ = "";
let n = 0;
beforeEach(() => {
  RAIZ = path.join(BASE, `caso${++n}`, "proyectos");
  fs.mkdirSync(RAIZ, { recursive: true });
});
const cfg = (o: Partial<Config> = {}): Config =>
  ({ elevenApiKey: CLAVE, elevenVoiceId: undefined, elevenModelId: "eleven_multilingual_v2", videoRoot: RAIZ, musicaVolumen: 0.12, ffmpegDir: undefined, ...o }) as Config;

const guion = () => ({
  version: 1,
  titulo: "Dos frases",
  gancho: "Dos frases.",
  escenas: [{ frases: ["Primera frase del partido.", "Segunda frase del partido."], base: { tipo: "cartel", texto: "Escena 1" } }],
  opciones: { fondo: "aurora", look: "normal", subtitulos: "karaoke", destellos: [0] },
});
const proyectoCon = (perfilId: string): string => proyectoCrear(RAIZ, { guionId: guionSimple(), perfilId }).id;
const guionSimple = (): string => guionGuardar(RAIZ, { guion: guion() }).id;

/** Un perfil nuevo (copia de «defecto») con la voz indicada. */
function perfilConVoz(voz: string): string {
  const { id } = perfilDuplicar(RAIZ, { id: "defecto" });
  const p = perfilesListar(RAIZ).find((x) => "nombre" in x && x.id === id) as Perfil;
  perfilGuardar(RAIZ, { id, perfil: { ...p, voz } });
  return id;
}

function codigo(f: () => unknown): ErrorAlmacen {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorAlmacen);
    return e as ErrorAlmacen;
  }
  throw new Error("se esperaba un ErrorAlmacen");
}

const VOZ_A = "Aa12345678AB";
const VOZ_B = "Bb12345678CD";

describe("la voz sale del perfil del proyecto", () => {
  it("vozCoste usa la voz del perfil que referencia el proyecto", () => {
    const id = proyectoCon(perfilConVoz(VOZ_A));
    expect(vozCoste(cfg(), id).voz.voiceId).toBe(VOZ_A);
  });

  it("«defecto» trae la voz predefinida y no hace falta ELEVENLABS_VOICE_ID", () => {
    const id = proyectoCon("defecto");
    expect(vozCoste(cfg(), id).voz.voiceId).toBe(PERFIL_DEFECTO.voz);
  });

  it("ELEVENLABS_VOICE_ID no manda sobre el perfil", () => {
    const id = proyectoCon(perfilConVoz(VOZ_A));
    expect(vozCoste(cfg({ elevenVoiceId: VOZ_B }), id).voz.voiceId).toBe(VOZ_A);
    expect(vozCoste(cfg({ elevenVoiceId: VOZ_B }), id).plan).toBe(vozCoste(cfg(), id).plan);
  });

  it("un perfil que no existe falla de forma visible, sin caer a otra voz", () => {
    const id = proyectoCon("p-0123456789abcdef");
    expect(codigo(() => vozCoste(cfg({ elevenVoiceId: VOZ_B }), id)).codigo).toBe("no_encontrado");
  });

  it("un perfil sin voz válida da sin_voz, aunque haya ELEVENLABS_VOICE_ID", () => {
    const perfilId = perfilConVoz(VOZ_A);
    const ruta = path.join(carpetaPerfiles(RAIZ), `${perfilId}.json`);
    for (const mala of ["../etc", "corta", "", 7]) {
      const p = JSON.parse(fs.readFileSync(ruta, "utf8"));
      fs.writeFileSync(ruta, JSON.stringify({ ...p, voz: mala }));
      const id = proyectoCon(perfilId);
      expect(codigo(() => vozCoste(cfg({ elevenVoiceId: VOZ_B }), id)).codigo).toBe("sin_voz");
    }
  });

  it("cambiar la voz del perfil entre el coste y la generación da plan_cambiado y no llama", async () => {
    const perfilId = perfilConVoz(VOZ_A);
    const id = proyectoCon(perfilId);
    const c = vozCoste(cfg(), id);
    const p = perfilesListar(RAIZ).find((x) => "nombre" in x && x.id === perfilId) as Perfil;
    perfilGuardar(RAIZ, { id: perfilId, perfil: { ...p, voz: VOZ_B } });
    const f = vi.fn();
    await expect(vozGenerar(cfg(), { id, caracteresConfirmados: c.caracteres, planConfirmado: c.plan }, f as unknown as typeof fetch)).rejects.toMatchObject({
      codigo: "coste_cambiado",
      problemas: [{ ruta: "planConfirmado", codigo: "plan_cambiado" }],
    });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("códigos distintos: sin_clave y sin_voz", () => {
  it("vozGenerar sin clave da sin_clave", async () => {
    const id = proyectoCon("defecto");
    const c = vozCoste(cfg(), id);
    const f = vi.fn();
    await expect(
      vozGenerar(cfg({ elevenApiKey: undefined }), { id, caracteresConfirmados: c.caracteres, planConfirmado: c.plan }, f as unknown as typeof fetch),
    ).rejects.toMatchObject({ codigo: "sin_clave" });
    expect(f).not.toHaveBeenCalled();
  });

  it("vozMuestra sin clave da sin_clave", async () => {
    const f = vi.fn();
    await expect(
      vozMuestra(cfg({ elevenApiKey: undefined }), { voiceId: VOZ_A, caracteresConfirmados: 60, planConfirmado: planMuestra("eleven_multilingual_v2", VOZ_A) }, f as unknown as typeof fetch),
    ).rejects.toMatchObject({ codigo: "sin_clave" });
    expect(f).not.toHaveBeenCalled();
  });

  it("vozMuestra con el perfil usa la voz del perfil; sin voz ni perfil da sin_voz", async () => {
    const perfilId = perfilConVoz(VOZ_A);
    const f = vi.fn();
    await expect(
      vozMuestra(cfg({ elevenApiKey: undefined }), { perfilId, caracteresConfirmados: 60, planConfirmado: planMuestra("eleven_multilingual_v2", VOZ_A) }, f as unknown as typeof fetch),
    ).rejects.toMatchObject({ codigo: "sin_clave" }); // pasó el plan de la voz del perfil
    await expect(
      vozMuestra(cfg({ elevenVoiceId: VOZ_B }), { caracteresConfirmados: 60, planConfirmado: "x" }, f as unknown as typeof fetch),
    ).rejects.toMatchObject({ codigo: "sin_voz" });
    expect(f).not.toHaveBeenCalled();
  });
});
