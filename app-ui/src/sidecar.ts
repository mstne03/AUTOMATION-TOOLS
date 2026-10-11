/** Dónde está el sidecar. Dentro de Tauri lo da Rust; en el navegador (tests E2E con
 *  Playwright, `pnpm dev` a secas) se lee de variables VITE_* solo de desarrollo. */
import { invoke } from "@tauri-apps/api/core";

export interface SidecarInfo {
  port: number;
  token: string;
}

const enTauri = () => "__TAURI_INTERNALS__" in window;

export async function sidecarInfo(): Promise<SidecarInfo> {
  if (enTauri()) return invoke<SidecarInfo>("sidecar_info");
  const port = Number(import.meta.env.VITE_SIDECAR_PORT);
  const token = import.meta.env.VITE_SIDECAR_TOKEN as string | undefined;
  if (!port || !token) {
    throw new Error("Fuera de Tauri hacen falta VITE_SIDECAR_PORT y VITE_SIDECAR_TOKEN.");
  }
  return { port, token };
}
