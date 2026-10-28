// Carga .env desde la carpeta del servidor (no desde el cwd) salvo en modo integrado.
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { SERVER_ROOT } from "./raiz.js";
import { log } from "./log.js";

/**
 * Modo integrado (VIDEO_ENGINE_EMBEDDED=1): el anfitrión pasa toda la configuración por el entorno
 * y el motor no lee ningún .env (la clave de ElevenLabs no puede venir de un fichero suelto).
 */
export function cargarDotenv(env: NodeJS.ProcessEnv = process.env, raiz: string = SERVER_ROOT): void {
  if (env.VIDEO_ENGINE_EMBEDDED === "1") return;
  dotenv.config({ path: path.join(raiz, ".env"), processEnv: env, quiet: true });
}

cargarDotenv();

// La CLI de HyperFrames envía telemetría anónima; su forma oficial de desactivarla es esta variable.
if (process.env.HYPERFRAMES_NO_TELEMETRY === undefined) process.env.HYPERFRAMES_NO_TELEMETRY = "1";
if (process.env.DO_NOT_TRACK === undefined) process.env.DO_NOT_TRACK = "1";
// Que la CLI no intente instalar skills ni abrir el navegador por su cuenta.
process.env.HYPERFRAMES_SKIP_SKILLS ??= "1";

export interface Config {
  elevenApiKey: string | undefined;
  elevenVoiceId: string | undefined;
  elevenModelId: string;
  videoRoot: string;
  browserPath: string | undefined;
  musicaVolumen: number;
  ffmpegDir: string | undefined;
}

function vacioAUndefined(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const volumenTexto = vacioAUndefined(env.VIDEO_MUSICA_VOLUMEN);
  let musicaVolumen = 0.12;
  if (volumenTexto !== undefined) {
    const v = Number(volumenTexto.replace(",", "."));
    if (Number.isFinite(v) && v >= 0 && v <= 1) musicaVolumen = v;
    else log.warn(`VIDEO_MUSICA_VOLUMEN="${volumenTexto}" no es un número entre 0 y 1; uso 0.12.`);
  }
  return {
    elevenApiKey: vacioAUndefined(env.ELEVENLABS_API_KEY),
    elevenVoiceId: vacioAUndefined(env.ELEVENLABS_VOICE_ID),
    elevenModelId: vacioAUndefined(env.ELEVENLABS_MODEL_ID) ?? "eleven_multilingual_v2",
    videoRoot: path.resolve(vacioAUndefined(env.VIDEO_ROOT) ?? path.join(os.homedir(), "Videos", "SEO Studio")),
    browserPath: vacioAUndefined(env.HYPERFRAMES_BROWSER_PATH),
    musicaVolumen,
    ffmpegDir: vacioAUndefined(env.FFMPEG_DIR),
  };
}

/** Variables que faltan para poder generar la voz. */
export function faltanParaVoz(c: Config): string[] {
  const faltan: string[] = [];
  if (!c.elevenApiKey) faltan.push("ELEVENLABS_API_KEY");
  if (!c.elevenVoiceId) faltan.push("ELEVENLABS_VOICE_ID");
  return faltan;
}

export const config = cargarConfig();
