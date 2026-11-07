/** Estado del editor de vídeo: proyecto en edición, historial por instantáneas del JSON (≤ 100;
 *  ponytail: pasar a parches si pesa) y autoguardado con 800 ms de espera. La revisión manda:
 *  un 409 recarga lo del servidor y conserva la edición local como borrador. Vive fuera de React,
 *  como los demás stores: cambiar de pantalla no pierde ediciones pendientes. */
import { create } from "zustand";
import { ApiError, type Client } from "../api/client";
import type { Proyecto } from "../video/modelo";

export type EstadoGuardado = "guardado" | "pendiente" | "guardando" | "error";
export const MAX_HISTORIAL = 100;
export const ESPERA_GUARDADO_MS = 800;

interface Editor {
  proyecto: Proyecto | null;
  revision: number;
  guardado: EstadoGuardado;
  /** Instantáneas JSON anteriores (la última es la más reciente). */
  historial: string[];
  futuro: string[];
  seleccion: string | null;
  /** Posición del cabezal, en segundos. */
  tiempo: number;
  conflicto: boolean;
  /** Edición local que el servidor rechazó por revisión antigua. */
  borrador: Proyecto | null;
}

const vacio = (): Editor => ({ proyecto: null, revision: 0, guardado: "guardado", historial: [], futuro: [], seleccion: null, tiempo: 0, conflicto: false, borrador: null });
export const useEditor = create<Editor>(() => vacio());

let cliente: Client | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let guardando = false;
/** Se incrementa en cada cambio: si cambia durante un PUT, hay que volver a guardar. */
let version = 0;

export function vincularCliente(c: Client) {
  cliente = c;
}

export function cargar(proyecto: Proyecto) {
  cancelarTimer();
  version = 0;
  useEditor.setState({ ...vacio(), proyecto: structuredClone(proyecto), revision: proyecto.revision });
}

export function reiniciarEditor() {
  cancelarTimer();
  guardando = false;
  version = 0;
  cliente = null;
  useEditor.setState(vacio());
}

function cancelarTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function cambiado() {
  version++;
  if (useEditor.getState().conflicto) return;
  useEditor.setState({ guardado: "pendiente" });
  programar();
}

function programar() {
  cancelarTimer();
  timer = setTimeout(() => void guardar(), ESPERA_GUARDADO_MS);
}

/** Aplica `fn` a una copia y guarda la instantánea anterior. `fn` puede mutar o devolver el proyecto nuevo. */
export function editar(fn: (p: Proyecto) => Proyecto | void) {
  const { proyecto, historial } = useEditor.getState();
  if (!proyecto) return;
  const copia = structuredClone(proyecto);
  const nuevo = fn(copia) ?? copia;
  useEditor.setState({
    proyecto: nuevo,
    historial: [...historial, JSON.stringify(proyecto)].slice(-MAX_HISTORIAL),
    futuro: [],
  });
  cambiado();
}

export function deshacer() {
  const { proyecto, historial, futuro } = useEditor.getState();
  if (!proyecto || !historial.length) return;
  useEditor.setState({
    proyecto: JSON.parse(historial[historial.length - 1]) as Proyecto,
    historial: historial.slice(0, -1),
    futuro: [...futuro, JSON.stringify(proyecto)],
  });
  cambiado();
}

export function rehacer() {
  const { proyecto, historial, futuro } = useEditor.getState();
  if (!proyecto || !futuro.length) return;
  useEditor.setState({
    proyecto: JSON.parse(futuro[futuro.length - 1]) as Proyecto,
    futuro: futuro.slice(0, -1),
    historial: [...historial, JSON.stringify(proyecto)].slice(-MAX_HISTORIAL),
  });
  cambiado();
}

export const seleccionar = (id: string | null) => useEditor.setState({ seleccion: id });
export const fijarTiempo = (tiempo: number) => useEditor.setState({ tiempo });

/** Tras un conflicto: vuelve a aplicar la edición local sobre lo del servidor. */
export function usarBorrador() {
  const { borrador } = useEditor.getState();
  if (!borrador) return;
  useEditor.setState({ conflicto: false, borrador: null });
  editar((p) => ({ ...borrador, revision: p.revision }));
}

/** Descarta el borrador y se queda con lo del servidor. */
export function descartarBorrador() {
  useEditor.setState({ conflicto: false, borrador: null, guardado: "guardado" });
}

export async function guardar() {
  cancelarTimer();
  const st = useEditor.getState();
  if (!cliente || !st.proyecto || guardando || st.conflicto) return;
  guardando = true;
  const enviado = version;
  const proyecto = st.proyecto;
  useEditor.setState({ guardado: "guardando" });
  try {
    const r = await cliente.videoProyectoGuardar(proyecto.id, { revision: st.revision, proyecto: { ...proyecto, revision: st.revision } });
    const actual = useEditor.getState().proyecto;
    useEditor.setState({ revision: r.revision, proyecto: actual ? { ...actual, revision: r.revision } : actual });
    guardando = false;
    if (version !== enviado) {
      useEditor.setState({ guardado: "pendiente" });
      programar();
    } else {
      useEditor.setState({ guardado: "guardado" });
    }
  } catch (e) {
    guardando = false;
    if (e instanceof ApiError && e.status === 409) await alConflicto(proyecto);
    else useEditor.setState({ guardado: "error" });
  }
}

/** 409: la edición local queda como borrador y el proyecto pasa a la versión del servidor. */
async function alConflicto(local: Proyecto) {
  const actualLocal = useEditor.getState().proyecto ?? local;
  try {
    const remoto = await cliente!.videoProyecto(local.id);
    useEditor.setState({ proyecto: remoto, revision: remoto.revision, borrador: actualLocal, conflicto: true, guardado: "error", historial: [], futuro: [] });
  } catch {
    useEditor.setState({ guardado: "error", borrador: actualLocal, conflicto: true });
  }
}
