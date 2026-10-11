import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { ESTADO } from "./global-setup";

export default async function globalTeardown() {
  const g = (globalThis as { __e2e?: { mock: Server } }).__e2e;
  g?.mock.close();
  if (!existsSync(ESTADO)) return;
  const { sidecar, vite } = JSON.parse(readFileSync(ESTADO, "utf8")) as { sidecar: number; vite: number };
  for (const pid of [sidecar, vite]) {
    try {
      // shell:true envuelve el proceso en cmd.exe: hay que matar el árbol entero.
      if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
      else process.kill(-pid, "SIGTERM");
    } catch {
      /* ya no existe */
    }
  }
  unlinkSync(ESTADO);
}
