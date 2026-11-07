/** Panel lateral del editor (D6, layout B): tres pestañas con lo que se edita de la escena
 *  seleccionada, los recursos del usuario y el perfil visual. Todo lo que cambia el proyecto pasa
 *  por `editar()` del store; el panel no guarda nada por su cuenta. Todo texto del proyecto o del
 *  servidor se pinta como texto (I1) y ninguna ruta sale de aquí ni se enseña (I6). */
import { useState } from "react";
import { SegmentedControl } from "../../ui";
import s from "./Panel.module.css";
import { PanelEscena } from "./PanelEscena";
import { PanelPerfil } from "./PanelPerfil";
import { PanelRecursos } from "./PanelRecursos";

type Pestana = "escena" | "recursos" | "perfil";
const PESTANAS: { value: Pestana; label: string }[] = [
  { value: "escena", label: "Escena" },
  { value: "recursos", label: "Recursos" },
  { value: "perfil", label: "Perfil" },
];

export function Panel() {
  const [pestana, setPestana] = useState<Pestana>("escena");
  return (
    <div className={s.panel}>
      <SegmentedControl options={PESTANAS} value={pestana} onChange={setPestana} aria-label="Panel del editor" data-testid="panel-pestanas" />
      {pestana === "escena" && <PanelEscena />}
      {pestana === "recursos" && <PanelRecursos />}
      {pestana === "perfil" && <PanelPerfil />}
    </div>
  );
}
