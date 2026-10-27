/** Guiones (docs/pantallas.md → Guiones): escribir un guion, revisar uno propio o diagnosticar la
 *  retención de un vídeo publicado. Cada modo tiene su estado en state/guiones.ts y su propia
 *  conversación con el agente, así que cambiar de modo o de pantalla no pierde nada. */
import { Activity, ListChecks, PenLine } from "lucide-react";
import { Diagnosticar } from "../guiones/Diagnosticar";
import { Escribir } from "../guiones/Escribir";
import s from "../guiones/Guiones.module.css";
import { Revisar } from "../guiones/Revisar";
import { setModo, useGuiones, type Modo } from "../state/guiones";
import { SegmentedControl } from "../ui";

const MODOS: Record<Modo, () => React.JSX.Element> = { escribir: Escribir, revisar: Revisar, diagnosticar: Diagnosticar };

export function GuionesScreen() {
  const modo = useGuiones((st) => st.modo);
  const Panel = MODOS[modo];
  return (
    <div className={s.pantalla}>
      <header className={s.cabecera}>
        <h1 className={s.titulo}>Guiones</h1>
        <SegmentedControl
          aria-label="Modo"
          data-testid="guiones-modos"
          value={modo}
          onChange={setModo}
          options={[
            { value: "escribir", label: "Escribir", icon: PenLine },
            { value: "revisar", label: "Revisar", icon: ListChecks },
            { value: "diagnosticar", label: "Diagnosticar", icon: Activity },
          ]}
        />
      </header>
      <Panel />
    </div>
  );
}
