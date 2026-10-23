/** Estado de la pantalla Publicar: ruta, transcripción, borrador y el job de transcripción
 *  viven en un store para sobrevivir a cambiar de pantalla (UI-01). La conversación del agente
 *  de esta pantalla es la "publicar" de state/conversations.ts. */
import { create } from "zustand";
import type { Client } from "../api/client";
import { esperarJob, seguirJob } from "./jobs";

export interface Borrador {
  title: string;
  description: string;
  tags: string;
  privacy: "private" | "unlisted" | "public";
  publishAt: string;
}

export const borradorVacio: Borrador = { title: "", description: "", tags: "", privacy: "private", publishAt: "" };

interface EstadoPublicar {
  path: string;
  transcripcion: string | null;
  jobId: string | null;
  transcribiendo: boolean;
  errorTranscripcion: string | null;
  borrador: Borrador;
  esperandoBorrador: boolean;
}

const inicial = (): EstadoPublicar => ({
  path: "",
  transcripcion: null,
  jobId: null,
  transcribiendo: false,
  errorTranscripcion: null,
  borrador: borradorVacio,
  esperandoBorrador: false,
});

export const usePublicar = create<EstadoPublicar>(() => inicial());

const parchar = (p: Partial<EstadoPublicar>) => usePublicar.setState(p);
export const setPath = (path: string) => parchar({ path });
export const setTranscripcion = (transcripcion: string | null) => parchar({ transcripcion });
export const setEsperandoBorrador = (esperandoBorrador: boolean) => parchar({ esperandoBorrador });
export const parcharBorrador = (patch: Partial<Borrador>) =>
  usePublicar.setState((s) => ({ borrador: { ...s.borrador, ...patch } }));

/** Crea el job de transcripción y espera a que acabe en el store de jobs (sondeo compartido). */
export async function transcribir(client: Client) {
  parchar({ transcribiendo: true, errorTranscripcion: null });
  try {
    const creado = await client.createJob("transcribe", { file: usePublicar.getState().path.trim() });
    parchar({ jobId: creado.id });
    seguirJob(client, creado);
    const j = await esperarJob(creado.id);
    if (j.status === "failed") throw new Error(j.error ?? "La transcripción ha fallado.");
    // El job devuelve el resultado de transcribe_local_video: el texto va en full_text.
    const texto = (j.result as { full_text?: string } | null)?.full_text;
    if (typeof texto !== "string") throw new Error("La transcripción no devolvió texto.");
    parchar({ transcripcion: texto });
  } catch (e) {
    parchar({ errorTranscripcion: (e as Error).message });
  } finally {
    parchar({ transcribiendo: false });
  }
}

/** Solo para tests. */
export function reiniciarPublicar() {
  usePublicar.setState(inicial(), true);
}
