import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { ESTADO } from "./global-setup";

export default async function globalTeardown() {
  const g = (globalThis as { __e2e?: { mock: Server } }).__e2e;
  g?.mock.close();
  if (!existsSync(ESTADO)) return;
  const { stateDir, sidecar, vite } = JSON.parse(readFileSync(ESTADO, "utf8")) as {
    stateDir?: string;
    sidecar?: number;
    vite?: number;
  };
  for (const pid of [sidecar, vite]) {
    if (!pid) continue;
    try {
      // shell:true envuelve el proceso en cmd.exe: hay que matar el árbol entero.
      if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      else process.kill(-pid, "SIGTERM");
    } catch {
      /* ya no existe */
    }
  }
  // Después de matar el sidecar: en Windows sus ficheros abiertos (KB, modelo) bloquean el borrado.
  // Los reintentos cubren los instantes en que el SO aún no ha liberado los handles.
  if (stateDir) {
    try {
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (e) {
      console.warn(`[e2e] No se pudo borrar el estado ${stateDir}: ${(e as Error).message}`);
    }
  }
  unlinkSync(ESTADO);
}
