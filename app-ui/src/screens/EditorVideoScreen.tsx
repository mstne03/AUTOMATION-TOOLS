/** Ruta `/video/:id`: carga el proyecto en el store del editor y monta el marco. Al salir cierra la
 *  preview (`DELETE …/preview`) y reinicia el editor, que guarda en segundo plano lo pendiente. */
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useClient } from "../api/context";
import { Spinner, Estado } from "../ui";
import { cargar, reiniciarEditor, vincularCliente } from "../state/editor";
import { Editor } from "../video/Editor";
import { sinRutas } from "./MotorVideo";

type Carga =
  | { id: string; estado: "cargando" | "listo" }
  | { id: string; estado: "error"; mensaje: string };

export function EditorVideoScreen() {
  const { id = "" } = useParams();
  const client = useClient();
  const [carga, setCarga] = useState<Carga>({ id, estado: "cargando" });

  useEffect(() => {
    let vivo = true;
    vincularCliente(client);
    setCarga({ id, estado: "cargando" });
    client
      .videoProyecto(id)
      .then((p) => {
        if (!vivo) return;
        cargar(p);
        setCarga({ id, estado: "listo" });
      })
      .catch((e: unknown) => {
        if (vivo)
          setCarga({
            id,
            estado: "error",
            mensaje: sinRutas(
              e instanceof Error ? e.message : "No se pudo abrir el proyecto.",
            ),
          });
      });
    return () => {
      vivo = false;
      reiniciarEditor();
      // La preview es un recurso del sidecar: si no se cierra, no pasa nada grave (caduca al cerrar la app).
      void Promise.resolve(client.videoPreviewCerrar(id)).catch(
        () => undefined,
      );
    };
  }, [id, client]);

  if (carga.id !== id || carga.estado === "cargando") return <Spinner />;
  if (carga.estado === "error") {
    return (
      <div data-testid="editor-error" role="alert">
        <Estado as="div" error>
          {carga.mensaje}
        </Estado>
      </div>
    );
  }
  return <Editor />;
}
