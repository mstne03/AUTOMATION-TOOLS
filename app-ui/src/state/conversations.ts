/** Store de conversaciones, por encima del router: una conversación (y su stream SSE, y una
 *  aprobación pendiente) sobrevive a cambiar de pantalla (UI-01). Chat usa "chat:<n>" y Publicar
 *  "publicar". El reducer de turnos (chat/turno.ts) no cambia. Un turno a la vez por conversación
 *  (el sidecar responde 409 si hay otro). */
import { create } from "zustand";
import { ApiError, type Client } from "../api/client";
import type { Approval } from "../api/types";
import { reduceTurno, turnoVacio, type Turno } from "../chat/turno";
import { seguirJob } from "./jobs";

export type Mensaje = { role: "user"; text: string } | { role: "assistant"; turno: Turno };

export interface Conversacion {
  id: string;
  titulo: string;
  mensajes: Mensaje[];
  conversationId?: string;
  enStream: boolean;
}

interface Estado {
  conversaciones: Record<string, Conversacion>;
  /** ids "chat:<n>" en orden de creación (la lista de la barra lateral). */
  orden: string[];
  activa: string;
  contador: number;
}

const vacia = (id: string): Conversacion => ({ id, titulo: "", mensajes: [], enStream: false });
const inicial = (): Estado => ({ conversaciones: { "chat:1": vacia("chat:1") }, orden: ["chat:1"], activa: "chat:1", contador: 1 });

export const useConversaciones = create<Estado>(() => inicial());

/** Un AbortController por conversación en curso (no es estado serializable, va fuera del store). */
const abortos = new Map<string, AbortController>();

/** Selector estable para conversaciones que aún no existen (p. ej. "publicar" antes de usarla). */
const SIN_CONVERSACION = vacia("");
export const seleccionarConversacion = (id: string) => (s: Estado) => s.conversaciones[id] ?? SIN_CONVERSACION;

function parchar(id: string, fn: (c: Conversacion) => Conversacion) {
  useConversaciones.setState((s) => ({
    conversaciones: { ...s.conversaciones, [id]: fn(s.conversaciones[id] ?? vacia(id)) },
  }));
}

function actualizarTurno(id: string, fn: (t: Turno) => Turno) {
  parchar(id, (c) => {
    const ultimo = c.mensajes[c.mensajes.length - 1];
    if (ultimo?.role !== "assistant") return c;
    return { ...c, mensajes: [...c.mensajes.slice(0, -1), { role: "assistant", turno: fn(ultimo.turno) }] };
  });
}

/** Primeras palabras del primer mensaje. */
export function tituloDe(texto: string): string {
  const palabras = texto.trim().split(/\s+/).slice(0, 6).join(" ");
  return palabras.length > 40 ? palabras.slice(0, 39) + "…" : palabras;
}

export function nueva(): string {
  const n = useConversaciones.getState().contador + 1;
  const id = `chat:${n}`;
  useConversaciones.setState((s) => ({
    conversaciones: { ...s.conversaciones, [id]: vacia(id) },
    orden: [...s.orden, id],
    activa: id,
    contador: n,
  }));
  return id;
}

export function seleccionar(id: string) {
  if (id in useConversaciones.getState().conversaciones) useConversaciones.setState({ activa: id });
}

/** La UI no tiene (aún) un parámetro del sidecar para desactivar la KB: se le indica al agente en el mensaje. */
const SIN_KB = "\n\n(Indicación de la interfaz: en esta respuesta no uses las herramientas de la base de conocimiento.)";

export interface OpcionesEnvio {
  /** El usuario ha apagado "Usar KB": el texto visible no cambia, solo lo que recibe el agente. */
  sinKb?: boolean;
}

export async function enviar(client: Client, id: string, texto: string, opciones: OpcionesEnvio = {}) {
  const actual = useConversaciones.getState().conversaciones[id] ?? vacia(id);
  if (actual.enStream || !texto.trim()) return;
  parchar(id, (c) => ({
    ...c,
    titulo: c.titulo || tituloDe(texto),
    enStream: true,
    mensajes: [...c.mensajes, { role: "user", text: texto }, { role: "assistant", turno: turnoVacio() }],
  }));
  const abort = new AbortController();
  abortos.set(id, abort);
  try {
    for await (const ev of client.chat({ message: opciones.sinKb ? texto + SIN_KB : texto, conversation_id: actual.conversationId }, abort.signal)) {
      if (ev.type === "done") parchar(id, (c) => ({ ...c, conversationId: ev.conversation_id }));
      actualizarTurno(id, (t) => reduceTurno(t, ev));
      if (ev.type === "job_started") seguirJob(client, ev.job);
    }
  } catch (e) {
    const msg = e instanceof ApiError ? e.detail : (e as Error).message;
    actualizarTurno(id, (t) => reduceTurno(t, { type: "error", message: msg }));
  } finally {
    abortos.delete(id);
    parchar(id, (c) => ({ ...c, enStream: false }));
  }
}

export async function resolver(
  client: Client,
  id: string,
  approval: Approval,
  decision: "approve" | "reject",
  confirmId?: string,
) {
  const res = await client.resolveApproval(approval.id, decision, confirmId);
  actualizarTurno(id, (t) => reduceTurno(t, { type: "approval_resolved", approval: res }));
  return res;
}

export function cancelar(id: string) {
  abortos.get(id)?.abort();
}

/** Solo para tests. */
export function reiniciarConversaciones() {
  for (const a of abortos.values()) a.abort();
  abortos.clear();
  useConversaciones.setState(inicial(), true);
}
