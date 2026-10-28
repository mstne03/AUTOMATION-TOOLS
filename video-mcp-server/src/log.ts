// Logs solo por stderr y a STATE_DIR/video.log: en un servidor stdio, stdout es del protocolo MCP.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./estado.js";

const LOG_DIR = STATE_DIR;
const LOG_FILE = path.join(LOG_DIR, "video.log");
let ficheroOk = true;

function escribir(nivel: string, partes: unknown[]): void {
  const texto = partes
    .map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  const linea = `${new Date().toISOString()} [${nivel}] ${texto}\n`;
  process.stderr.write(linea);
  if (!ficheroOk) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
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
