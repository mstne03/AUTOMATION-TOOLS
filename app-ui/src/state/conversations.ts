/** Store de conversaciones, por encima del router: una conversación (y su stream SSE, y una
 *  aprobación pendiente) sobrevive a cambiar de pantalla (UI-01). Chat usa "chat:<n>" y Publicar
 *  "publicar". El reducer de turnos (chat/turno.ts) no cambia. Un turno a la vez por conversación
 *  (el sidecar responde 409 si hay otro).
 *
 *  Los chats se guardan en el sidecar (SEO-100): al arrancar se carga la lista (`cargarLista`) y el
 *  contenido de cada uno al abrirlo (`abrir`), reproduciendo los eventos guardados con el reducer.
 *  Cada chat pertenece al perfil (canal) activo al crearlo; Publicar no se guarda. */
import { create } from "zustand";
import { ApiError, type Client } from "../api/client";
import type { Approval, ConversacionDetalle } from "../api/types";
import { reduceTurno, turnoVacio, type Turno } from "../chat/turno";
import { seguirJob } from "./jobs";

export type Mensaje = { role: "user"; text: string } | { role: "assistant"; turno: Turno };

export interface Conversacion {
  id: string;
  titulo: string;
  mensajes: Mensaje[];
  conversationId?: string;
  enStream: boolean;
  /** Perfil (canal) con el que se creó; sin él (aún sin enviar nada), se ve en todos. */
  perfil?: string | null;
  /** Guardada en el sidecar y aún sin descargar su contenido. */
  pendiente?: boolean;
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

export function nueva(perfil?: string): string {
  const n = useConversaciones.getState().contador + 1;
  const id = `chat:${n}`;
  useConversaciones.setState((s) => ({
    conversaciones: { ...s.conversaciones, [id]: { ...vacia(id), perfil } },
    orden: [...s.orden, id],
    activa: id,
    contador: n,
  }));
  return id;
}

export function seleccionar(id: string) {
  if (id in useConversaciones.getState().conversaciones) useConversaciones.setState({ activa: id });
}

export interface OpcionesEnvio {
  /** El usuario ha apagado "Usar KB": el sidecar se lo indica al agente; el texto visible no cambia. */
  sinKb?: boolean;
  /** Perfil activo: la conversación queda asociada a él al enviar el primer mensaje. */
  perfil?: string;
}

const INTERRUMPIDA = "La respuesta se interrumpió antes de terminar (se cerró la app o se cortó la conexión).";

/** Vuelve a montar los mensajes de una conversación guardada con el mismo reducer que el stream.
 *  Un turno sin done ni error se cortó: se marca como error, lo que cancela su propuesta pendiente. */
export function reproducir(turnos: ConversacionDetalle["turnos"]): Mensaje[] {
  return turnos.flatMap((t): Mensaje[] => {
    let turno = t.eventos.reduce(reduceTurno, turnoVacio());
    if (turno.estado === "streaming") turno = reduceTurno(turno, { type: "error", message: INTERRUMPIDA });
    return [
      { role: "user", text: t.texto },
      { role: "assistant", turno },
    ];
  });
}

/** Añade a la lista las conversaciones guardadas en el sidecar que aún no estén (al arrancar). */
export async function cargarLista(client: Client) {
  const lista = await client.listConversations();
  useConversaciones.setState((s) => {
    const conocidas = new Set(Object.values(s.conversaciones).map((c) => c.conversationId));
    const nuevas = lista.filter((r) => !conocidas.has(r.id));
    if (!nuevas.length) return s;
    const conversaciones = { ...s.conversaciones };
    for (const r of nuevas) {
      conversaciones[`chat:${r.id}`] = { id: `chat:${r.id}`, titulo: r.titulo, perfil: r.perfil, conversationId: r.id, mensajes: [], enStream: false, pendiente: true };
    }
    // Las guardadas son anteriores a las creadas en esta sesión: van delante, en orden de creación.
    return { conversaciones, orden: [...nuevas.map((r) => `chat:${r.id}`), ...s.orden] };
  });
}

/** Descarga el contenido de una conversación guardada la primera vez que se abre. */
export async function abrir(client: Client, id: string) {
  const c = useConversaciones.getState().conversaciones[id];
  if (!c?.pendiente || !c.conversationId) return;
  try {
    const d = await client.getConversation(c.conversationId);
    parchar(id, (actual) => ({ ...actual, titulo: d.titulo || actual.titulo, mensajes: reproducir(d.turnos), pendiente: false }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) quitar(id); // borrada desde otro sitio
    throw e;
  }
}

function quitar(id: string) {
  useConversaciones.setState((s) => {
    const { [id]: _quitada, ...conversaciones } = s.conversaciones;
    return { conversaciones, orden: s.orden.filter((o) => o !== id) };
  });
}

/** Conversaciones visibles con el perfil activo: las suyas y las que aún no tienen perfil. Sin perfil
 *  (ajustes aún cargando) solo las que no tienen: nunca se muestran ni se abren chats de otro canal. */
export function delPerfil(s: Pick<Estado, "orden" | "conversaciones">, perfil: string | undefined): string[] {
  return s.orden.filter((id) => {
    const p = s.conversaciones[id]?.perfil;
    return !p || p === perfil;
  });
}

/** Si la conversación activa es de otro perfil, pasa a la última del perfil nuevo (o a una vacía). */
export function alCambiarDePerfil(perfil: string) {
  const s = useConversaciones.getState();
  const activa = s.conversaciones[s.activa];
  if (!activa?.perfil || activa.perfil === perfil) return;
  const ultima = delPerfil(s, perfil).at(-1);
  if (ultima) useConversaciones.setState({ activa: ultima });
  else nueva(perfil);
}

/** Borra una conversación (en el sidecar, si ya estaba guardada) y, si era la activa, pasa a otra del
 *  perfil en uso (no del de la borrada: un chat aún sin perfil no puede abrir uno de otro canal). */
export async function borrar(client: Client, id: string, perfil: string | undefined) {
  const c = useConversaciones.getState().conversaciones[id];
  if (!c || c.enStream) return;
  if (c.conversationId) {
    try {
      await client.deleteConversation(c.conversationId);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
  quitar(id);
  const s = useConversaciones.getState();
  if (s.activa !== id) return;
  const siguiente = delPerfil(s, perfil).at(-1);
  if (siguiente) useConversaciones.setState({ activa: siguiente });
  else nueva(perfil);
}

export async function enviar(client: Client, id: string, texto: string, opciones: OpcionesEnvio = {}) {
  const actual = useConversaciones.getState().conversaciones[id] ?? vacia(id);
  if (actual.enStream || !texto.trim()) return;
  parchar(id, (c) => ({
    ...c,
    titulo: c.titulo || tituloDe(texto),
    perfil: c.perfil ?? opciones.perfil,
    enStream: true,
    mensajes: [...c.mensajes, { role: "user", text: texto }, { role: "assistant", turno: turnoVacio() }],
  }));
  const abort = new AbortController();
  abortos.set(id, abort);
  try {
    const cuerpo = { message: texto, conversation_id: actual.conversationId, sin_kb: opciones.sinKb || undefined, persistir: id.startsWith("chat:") };
    for await (const ev of client.chat(cuerpo, abort.signal)) {
      if (ev.type === "done") parchar(id, (c) => ({ ...c, conversationId: ev.conversation_id }));
      actualizarTurno(id, (t) => reduceTurno(t, ev));
      if (ev.type === "job_started") seguirJob(client, ev.job);
    }
    // El stream terminó sin done ni error: el sidecar se cerró o se cayó a mitad de respuesta.
    actualizarTurno(id, (t) => (t.estado === "streaming" ? reduceTurno(t, { type: "error", message: "La conexión con el sidecar se cortó antes de terminar la respuesta." }) : t));
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

/** Vacía una conversación (cancelando su turno en curso): "Descartar" en Publicar. */
export function limpiarConversacion(id: string) {
  abortos.get(id)?.abort();
  parchar(id, () => vacia(id));
}

/** Solo para tests. */
export function reiniciarConversaciones() {
  for (const a of abortos.values()) a.abort();
  abortos.clear();
  useConversaciones.setState(inicial(), true);
}
