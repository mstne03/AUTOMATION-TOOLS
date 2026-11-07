/** Botón «Renderizar» de la cabecera del editor (`editor-render`): abre el diálogo de render del
 *  proyecto abierto. Lee el store del editor, sin props (contrato de la Task 16). */
import { Clapperboard } from "lucide-react";
import { useState } from "react";
import { useEditor } from "../../state/editor";
import { Button } from "../../ui";
import { RenderDialogo } from "./RenderDialogo";

export function RenderBoton() {
  const id = useEditor((e) => e.proyecto?.id);
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <Button variant="primary" size="sm" icon={Clapperboard} data-testid="editor-render" disabled={!id} onClick={() => setAbierto(true)}>
        Renderizar
      </Button>
      {/* Montado solo abierto: cada apertura empieza limpia (errores, bloqueo) y vuelve a mirar la voz. */}
      {abierto && id && <RenderDialogo id={id} onClose={() => setAbierto(false)} />}
    </>
  );
}
