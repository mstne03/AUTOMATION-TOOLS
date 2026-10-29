/** Avisos efímeros: `toast({ title })` desde cualquier sitio (store pequeño, sin proveedor que
 *  pasar) y un único <Toaster/> montado en el AppShell. Radix anuncia cada aviso con role="status". */
import * as R from "@radix-ui/react-toast";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { create } from "zustand";
import s from "./Toaster.module.css";

export interface ToastOptions {
  title: string;
  description?: string;
  /** success (por defecto), warning (hecho, pero con algo que atender) o error; los dos últimos se
   *  quedan más tiempo. */
  tone?: "success" | "warning" | "error";
}

interface Aviso extends ToastOptions {
  id: number;
}

let contador = 0;
const useAvisos = create<{ avisos: Aviso[] }>(() => ({ avisos: [] }));

export function toast(o: ToastOptions) {
  useAvisos.setState((st) => ({ avisos: [...st.avisos, { ...o, id: ++contador }] }));
}

/** Solo para tests. */
export const reiniciarToasts = () => useAvisos.setState({ avisos: [] });

export function Toaster() {
  const avisos = useAvisos((st) => st.avisos);
  const quitar = (id: number) => useAvisos.setState((st) => ({ avisos: st.avisos.filter((a) => a.id !== id) }));
  return (
    <R.Provider swipeDirection="right" label="Avisos">
      {avisos.map((a) => (
        <R.Root key={a.id} className={s.toast} duration={a.tone && a.tone !== "success" ? 8000 : 3500} onOpenChange={(abierto) => !abierto && quitar(a.id)}>
          {a.tone === "error" ? (
            <CircleAlert aria-hidden className={s.error} size="1.15em" />
          ) : a.tone === "warning" ? (
            <TriangleAlert aria-hidden className={s.aviso} size="1.15em" />
          ) : (
            <CircleCheck aria-hidden className={s.ok} size="1.15em" />
          )}
          <div className={s.texto}>
            <R.Title className={s.titulo}>{a.title}</R.Title>
            {a.description && <R.Description className={s.descripcion}>{a.description}</R.Description>}
          </div>
        </R.Root>
      ))}
      <R.Viewport className={s.zona} />
    </R.Provider>
  );
}
