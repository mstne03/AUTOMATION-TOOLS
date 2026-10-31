/** Modo de render (Automático / Rápido / Compatible). Hasta que fase 1 lo cablee a la tool de render
 *  va en localStorage (try/catch: puede estar bloqueado). No es confiable: quien lo consuma valida el enum. */
import { create } from "zustand";

export type RenderModo = "auto" | "rapido" | "compatible";

const CLAVE = "seo-studio.render-modo";
const validos: RenderModo[] = ["auto", "rapido", "compatible"];

function leer(): RenderModo {
  try {
    const v = localStorage.getItem(CLAVE) as RenderModo | null;
    return v && validos.includes(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

export const useRenderModo = create<{ modo: RenderModo }>(() => ({ modo: leer() }));

export function setRenderModo(m: RenderModo) {
  try {
    localStorage.setItem(CLAVE, m);
  } catch {
    /* sin almacenamiento: vale solo para esta sesión */
  }
  useRenderModo.setState({ modo: m });
}
