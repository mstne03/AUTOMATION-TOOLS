/** Recarga de la preview a petición. Lo usa quien cambie algo que el guardado del proyecto no
 *  refleja en `revision` (p. ej. T18 tras guardar un perfil: `recargarPreview()`). `Preview` espera
 *  400 ms y reabre a través de `SesionPreview`. */
import { create } from "zustand";

export const usePreviewRecarga = create<{ contador: number }>(() => ({ contador: 0 }));

export function recargarPreview(): void {
  usePreviewRecarga.setState((s) => ({ contador: s.contador + 1 }));
}
