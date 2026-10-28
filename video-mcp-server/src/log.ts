// Logs solo por stderr y a STATE_DIR/video.log: en un servidor stdio, stdout es del protocolo MCP.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./estado.js";

const LOG_DIR = STATE_DIR;
const LOG_FILE = path.join(LOG_DIR, "video.log");
// ponytail: una sola copia (video.log.1, que se pisa); más historial si algún día hace falta.
const MAX_LOG = 5 * 1024 * 1024;
let ficheroOk = true;

/** Sustituye la clave por *** en un texto (sin clave, lo deja igual). */
export function ocultarClave(texto: string, clave: string | undefined): string {
  return clave ? texto.split(clave).join("***") : texto;
}

function rotar(): void {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_LOG) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* sin fichero todavía */
  }
}

function escribir(nivel: string, partes: unknown[]): void {
  const texto = partes
    .map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  // La clave se lee en cada línea: el anfitrión la pasa por el entorno y nunca debe acabar en un log.
  const linea = ocultarClave(`${new Date().toISOString()} [${nivel}] ${texto}\n`, process.env.ELEVENLABS_API_KEY?.trim());
  process.stderr.write(linea);
  if (!ficheroOk) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotar();
    fs.appendFileSync(LOG_FILE, linea);
  } catch {
    ficheroOk = false;
  }
}

export const log = {
  info: (...p: unknown[]) => escribir("info", p),
  warn: (...p: unknown[]) => escribir("warn", p),
  error: (...p: unknown[]) => escribir("error", p),
};
