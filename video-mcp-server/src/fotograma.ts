// Extrae un fotograma del mp4 como PNG reducido a 540×960.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ejecutar, type Herramientas } from "./proceso.js";

const TIMEOUT_FOTOGRAMA_MS = 30_000;

/**
 * Pasa por `ejecutar` (entorno por lista blanca, timeout que mata el árbol y barrido): el PNG va a un
 * fichero temporal porque `ejecutar` recoge la salida como texto.
 */
export async function extraerFotograma(h: Herramientas, mp4: string, segundo: number): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-fotograma-"));
  const png = path.join(dir, "fotograma.png");
  try {
    const r = await ejecutar(
      h.ffmpeg,
      ["-v", "error", "-protocol_whitelist", "file", "-ss", segundo.toFixed(3), "-f", "mp4", "-i", mp4, "-frames:v", "1", "-vf", "scale=540:960", "-c:v", "png", "-f", "image2", png],
      { timeoutMs: TIMEOUT_FOTOGRAMA_MS },
    );
    const datos = r.code === 0 && fs.existsSync(png) ? fs.readFileSync(png) : Buffer.alloc(0);
    if (!datos.length) {
      const motivo = r.timeout ? `superó ${TIMEOUT_FOTOGRAMA_MS / 1000} s` : r.stderr.trim().slice(0, 300) || "sin datos";
      throw new Error(`ffmpeg no pudo extraer el fotograma del segundo ${segundo}: ${motivo}`);
    }
    return datos;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
