/** Aviso de actualización encima del contenido: se comprueba una vez al arrancar; si hay una
 *  versión nueva, se avisa y solo se descarga e instala cuando el usuario confirma en un ConfirmDialog.
 *  Un fallo al comprobar (sin red, latest.json ausente) no muestra nada: no es un error para el usuario. */
import { useEffect, useState } from "react";
import s from "./UpdateBanner.module.css";
import { Button, ConfirmDialog } from "./ui";
import { checkForUpdate, installUpdate, type UpdateInfo } from "./updater";

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [estado, setEstado] = useState<"idle" | "instalando" | "error">("idle");
  const [error, setError] = useState("");
  const [confirmando, setConfirmando] = useState(false);

  useEffect(() => {
    checkForUpdate()
      .then(setUpdate)
      .catch((e: Error) => console.warn("No se pudo comprobar si hay actualización:", e.message));
  }, []);

  if (!update) return null;

  const instalar = async () => {
    setEstado("instalando");
    try {
      await installUpdate();
    } catch (e) {
      setEstado("error");
      setError((e as Error).message ?? String(e));
    }
  };

  return (
    <aside className={s.aviso} data-testid="update-banner" role="status">
      <span className={s.texto}>
        Hay una versión nueva: <strong>{update.version}</strong>
        {update.notes ? ` — ${update.notes}` : ""}
      </span>
      {estado === "instalando" ? (
        <span>Descargando e instalando…</span>
      ) : (
        <Button variant="primary" size="sm" onClick={() => setConfirmando(true)}>
          Instalar y reiniciar
        </Button>
      )}
      {estado === "error" && <span className={s.error}>No se pudo actualizar: {error}</span>}
      <ConfirmDialog
        open={confirmando}
        onOpenChange={setConfirmando}
        title={`Instalar SEO Studio ${update.version}`}
        description="Se descargará e instalará la nueva versión y la aplicación se reiniciará."
        confirmLabel="Instalar y reiniciar"
        onConfirm={instalar}
      />
    </aside>
  );
}
