/** Diálogo nativo para elegir el vídeo. Lo abre Rust (`elegir_video` en src-tauri/src/lib.rs)
 *  con tauri-plugin-dialog, así el WebView sigue sin permisos más allá de `core:default`.
 *  Fuera de Tauri (E2E, `pnpm dev`) no hay diálogo: devuelve null y la ruta se escribe a mano.
 *  Es comodidad, no control de acceso: el sidecar valida la ruta con `resolve_allowed`. */
import { invoke } from "@tauri-apps/api/core";

const enTauri = () => "__TAURI_INTERNALS__" in window;

/** Ruta elegida, o null si se cancela o no estamos en Tauri. */
export async function elegirVideo(dirInicial: string): Promise<string | null> {
  if (!enTauri()) return null;
  return invoke<string | null>("elegir_video", { dirInicial });
}
