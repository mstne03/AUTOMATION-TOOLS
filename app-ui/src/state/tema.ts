/** Preferencia de tema: sistema (por defecto), claro u oscuro. Mientras el sidecar no la persista
 *  va en localStorage (con try/catch: puede estar bloqueado). Se aplica como data-theme en <html>;
 *  sin atributo, tokens.css sigue a prefers-color-scheme. */
import { create } from "zustand";

export type Tema = "system" | "light" | "dark";

const CLAVE = "seo-studio.tema";
const validos: Tema[] = ["system", "light", "dark"];

function leer(): Tema {
  try {
    const v = localStorage.getItem(CLAVE) as Tema | null;
    return v && validos.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function aplicarTema(t: Tema) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export const useTema = create<{ tema: Tema }>(() => ({ tema: leer() }));

export function setTema(t: Tema) {
  try {
    localStorage.setItem(CLAVE, t);
  } catch {
    /* sin almacenamiento: el tema vale solo para esta sesión */
  }
  useTema.setState({ tema: t });
  aplicarTema(t);
}

/** Aplica la preferencia guardada al arrancar (antes de pintar, para evitar el parpadeo). */
export const iniciarTema = () => aplicarTema(useTema.getState().tema);
