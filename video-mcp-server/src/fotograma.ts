// Extrae un fotograma del mp4 como PNG reducido a 540×960.
import { spawn } from "node:child_process";
import type { Herramientas } from "./proceso.js";

export function extraerFotograma(h: Herramientas, mp4: string, segundo: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // ffmpeg escribe el PNG por stdout, que se recoge en binario.
    const hijo = spawn(
      h.ffmpeg,
      ["-v", "error", "-ss", segundo.toFixed(3), "-i", mp4, "-frames:v", "1", "-vf", "scale=540:960", "-f", "image2pipe", "-c:v", "png", "pipe:1"],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const trozos: Buffer[] = [];
    let error = "";
    hijo.stdout.on("data", (d: Buffer) => trozos.push(d));
    hijo.stderr.on("data", (d: Buffer) => (error += d.toString("utf8")));
    hijo.on("error", reject);
    hijo.on("close", (code) => {
      const datos = Buffer.concat(trozos);
      if (code !== 0 || datos.length === 0) {
        reject(new Error(`ffmpeg no pudo extraer el fotograma del segundo ${segundo}: ${error.trim().slice(0, 300) || "sin datos"}`));
      } else resolve(datos);
    });
  });
}
