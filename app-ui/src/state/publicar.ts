/** Estado de la pantalla Publicar: ruta, transcripción, borrador y el job de transcripción
 *  viven en un store para sobrevivir a cambiar de pantalla (UI-01). La conversación del agente
 *  de esta pantalla es la "publicar" de state/conversations.ts. */
import { create } from "zustand";
import type { Client } from "../api/client";
import { limpiarConversacion } from "./conversations";
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

/** La transcripción en curso; «Descartar» la anula. */
let intento: object | null = null;

/** Crea el job de transcripción y espera a que acabe en el store de jobs (sondeo compartido).
 *  Solo escribe el resultado si sigue siendo la transcripción en curso: tras «Descartar» u otra
 *  transcripción, la anterior se ignora al terminar (SEO-90). El sidecar no cancela jobs, así que la
 *  descartada termina igualmente en segundo plano. */
export async function transcribir(client: Client) {
  // Hasta que el sidecar devuelve el id, la vigente se reconoce por este testigo.
  const testigo = {};
  intento = testigo;
  let id: string | null = null;
  const vigente = () => intento === testigo && (id === null || usePublicar.getState().jobId === id);
  parchar({ transcribiendo: true, errorTranscripcion: null, jobId: null });
  try {
    const creado = await client.createJob("transcribe", { file: usePublicar.getState().path.trim() });
    if (!vigente()) return;
    id = creado.id;
    parchar({ jobId: creado.id });
    seguirJob(client, creado);
    const j = await esperarJob(creado.id);
    if (!vigente()) return;
    if (j.status === "failed") throw new Error(j.error ?? "La transcripción ha fallado.");
    // El job devuelve el resultado de transcribe_local_video: el texto va en full_text.
    const texto = (j.result as { full_text?: string } | null)?.full_text;
    if (typeof texto !== "string") throw new Error("La transcripción no devolvió texto.");
    parchar({ transcripcion: texto });
  } catch (e) {
    if (vigente()) parchar({ errorTranscripcion: (e as Error).message });
  } finally {
    if (vigente()) parchar({ transcribiendo: false });
  }
}

/** Descartar: borra ruta, transcripción, borrador y la conversación del agente de esta pantalla. */
export function descartar() {
  intento = null;
  usePublicar.setState(inicial(), true);
  limpiarConversacion("publicar");
}

/** Solo para tests. */
export function reiniciarPublicar() {
  intento = null;
  usePublicar.setState(inicial(), true);
}
