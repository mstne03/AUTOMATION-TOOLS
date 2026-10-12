/** Aviso de actualización encima del contenido: se comprueba una vez al arrancar; si hay una
 *  versión nueva, se avisa y solo se descarga e instala cuando el usuario confirma. Un fallo al
 *  comprobar (sin red, latest.json ausente) no muestra nada: no es un error para el usuario. */
import { useEffect, useState } from "react";
import { checkForUpdate, installUpdate, type UpdateInfo } from "./updater";

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [estado, setEstado] = useState<"idle" | "instalando" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    checkForUpdate()
      .then(setUpdate)
      .catch((e: Error) => console.warn("No se pudo comprobar si hay actualización:", e.message));
  }, []);

  if (!update) return null;

  const instalar = async () => {
    if (!window.confirm(`Se descargará e instalará SEO Studio ${update.version}. La aplicación se reiniciará. ¿Continuar?`)) return;
    setEstado("instalando");
    try {
      await installUpdate();
    } catch (e) {
      setEstado("error");
      setError((e as Error).message ?? String(e));
    }
  };

  return (
    <aside className="update-banner" data-testid="update-banner" role="status">
      <span>
        Hay una versión nueva: <strong>{update.version}</strong>
        {update.notes ? ` — ${update.notes}` : ""}
      </span>
      {estado === "instalando" ? (
        <span>Descargando e instalando…</span>
      ) : (
        <button type="button" onClick={instalar}>Instalar y reiniciar</button>
      )}
      {estado === "error" && <span className="error">No se pudo actualizar: {error}</span>}
    </aside>
  );
}
