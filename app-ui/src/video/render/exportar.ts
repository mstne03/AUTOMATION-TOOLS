/** Exportar el MP4: el diálogo de guardar y la copia los hace Rust (`exportar_mp4`, Task 13), así el
 *  WebView sigue con `core:default` (CLAUDE.md) y la UI no envía ni recibe ninguna ruta (I6): solo el
 *  id del proyecto. Cancelar el diálogo no es un error. Fuera de Tauri (E2E, `pnpm dev`) no existe. */
import { invoke } from "@tauri-apps/api/core";
import { enTauri } from "../../dialogo";

export async function exportarMp4(id: string): Promise<void> {
  if (!enTauri()) throw new Error("Exportar solo está disponible en la aplicación de escritorio.");
  await invoke("exportar_mp4", { id });
}
