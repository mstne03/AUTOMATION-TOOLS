/** Modo de render (Automático / Rápido / Compatible). La preferencia va en localStorage (try/catch:
 *  puede estar bloqueado) y se aplica al render: `POST /video/proyectos/{id}/render { modo }`. En la
 *  fase 1 Automático equivale a Compatible (SPEC-video D11, M-D6); lo resuelve el motor. No es
 *  confiable: quien lo consuma valida el enum. */
import { create } from "zustand";
import type { CapacidadesVideo } from "../api/types";

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

/** h264_mf (Media Foundation, software) no cuenta como GPU (M7). */
export const hayGpuDe = (cap: CapacidadesVideo | undefined) => !!cap?.codificadores?.some((c) => c.codificador !== "h264_mf");

/** «Rápido» sin codificador de GPU no se puede cumplir: lo que se enseña y se envía es Compatible. */
export const modoEfectivo = (modo: RenderModo, hayGpu: boolean): RenderModo => (modo === "rapido" && !hayGpu ? "compatible" : modo);
