/** Actualizaciones: el trabajo (consultar latest.json, verificar la firma, instalar) lo hace
 *  Rust (`update_check` / `update_install` en src-tauri/src/lib.rs). Fuera de Tauri no hay
 *  updater: `checkForUpdate` devuelve null y la UI no muestra nada. */
import { invoke } from "@tauri-apps/api/core";

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

const enTauri = () => "__TAURI_INTERNALS__" in window;

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!enTauri()) return null;
  return invoke<UpdateInfo | null>("update_check");
}

export async function installUpdate(): Promise<void> {
  await invoke("update_install");
}
