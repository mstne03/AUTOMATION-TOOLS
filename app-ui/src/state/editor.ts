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

/** Época del proyecto abierto: sube en cada `cargar`/`reiniciarEditor`. Las respuestas de PUT/GET
 *  de una época anterior se descartan, para que no se apliquen al proyecto que hay ahora. */
let epoca = 0;
/** Ediciones de otros proyectos que no se pudieron guardar al cambiar: borrador de su propio id. */
const borradores = new Map<string, Proyecto>();
/** Última edición local de un proyecto que se abandonó con un PUT (o el GET de un 409) en vuelo,
 *  por época. Lo que el PUT viejo enviaba ya no es lo último: los manejadores de esa época usan
 *  esto, nunca su copia enviada, para el borrador y para el PUT de seguimiento. */
const salientes = new Map<number, Proyecto>();

export function vincularCliente(c: Client) {
  cliente = c;
}

/** Solo para los tests: `reiniciarEditor` no desvincula el cliente global. */
export function desvincularCliente() {
  cliente = null;
  borradores.clear();
  salientes.clear();
}

/** Deja `p` como borrador de su proyecto. Si ese mismo proyecto está abierto ahora (se reabrió
 *  durante el PUT/GET), el borrador se muestra ya, sobre la versión `remoto` si la hay. */
function dejarBorrador(p: Proyecto, remoto?: Proyecto) {
  const abierto = useEditor.getState().proyecto;
  if (abierto && abierto.id === p.id) {
    const base = remoto ?? abierto;
    useEditor.setState({ proyecto: base, revision: base.revision, borrador: p, conflicto: true, guardado: "error", historial: [], futuro: [] });
  } else {
    borradores.set(p.id, p);
  }
}

/** Guarda en segundo plano la edición pendiente del proyecto que se abandona; si no puede, la
 *  conserva como borrador de ese proyecto (se ofrece al volver a abrirlo). Nunca en silencio. */
function salvarSaliente() {
  const st = useEditor.getState();
  if (st.conflicto && st.borrador) {
    borradores.set(st.borrador.id, st.borrador);
    return;
  }
  if (!st.proyecto) return;
  // PUT (o GET de un 409) en vuelo: no se lanza otro PUT con la misma revisión. Se anota la última
  // edición y el manejador de esa época la guarda con la revisión nueva, o la deja de borrador.
  if (guardando || st.guardado === "guardando") {
    salientes.set(epoca, st.proyecto);
    return;
  }
  if (st.guardado !== "pendiente" && st.guardado !== "error") return;
  const p = st.proyecto;
  const c = cliente;
  if (!c) {
    borradores.set(p.id, p);
    return;
  }
  c.videoProyectoGuardar(p.id, { revision: st.revision, proyecto: { ...p, revision: st.revision } }).catch(() => {
    borradores.set(p.id, p);
  });
}

function abrir(proyecto: Proyecto) {
  cancelarTimer();
  salvarSaliente();
  epoca++;
  guardando = false;
  version = 0;
  const borrador = borradores.get(proyecto.id) ?? null;
  borradores.delete(proyecto.id);
  useEditor.setState({
    ...vacio(),
    proyecto: structuredClone(proyecto),
    revision: proyecto.revision,
    ...(borrador ? { borrador, conflicto: true, guardado: "error" as const } : {}),
  });
}

export function cargar(proyecto: Proyecto) {
  abrir(proyecto);
}

export function reiniciarEditor() {
  cancelarTimer();
  salvarSaliente();
  epoca++;
  guardando = false;
  version = 0;
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

/** Descarta el borrador y se queda con lo del servidor. Si hubo ediciones durante el aviso
 *  (el historial se vació al abrirlo), quedan sin guardar: no se marca «Guardado» y se programa
 *  el guardado. */
export function descartarBorrador() {
  const { historial, futuro } = useEditor.getState();
  const sinGuardar = historial.length > 0 || futuro.length > 0;
  useEditor.setState({ conflicto: false, borrador: null, guardado: sinGuardar ? "pendiente" : "guardado" });
  if (sinGuardar) programar();
}

/** Espera (con tope) a que el autoguardado en curso termine. */
function esperarGuardado(): Promise<void> {
  return new Promise((resolve) => {
    const fin = () => {
      clearTimeout(t);
      desuscribir();
      resolve();
    };
    const desuscribir = useEditor.subscribe((e) => {
      if (e.guardado !== "guardando") fin();
    });
    const t = setTimeout(fin, 5000);
  });
}

/** Deja el servidor con lo que hay en pantalla. `false` si hay conflicto o no se pudo guardar. */
export async function asegurarGuardado(): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const st = useEditor.getState();
    if (st.conflicto) return false;
    if (st.guardado === "guardado") return true;
    if (st.guardado === "guardando") await esperarGuardado();
    else await guardar();
  }
  const st = useEditor.getState();
  return !st.conflicto && st.guardado === "guardado";
}

/** Autoguardado en pausa mientras el servidor cambia `proyecto.json` por su cuenta (recursos): un PUT
 *  con la revisión de antes daría un 409 que no es de otra sesión. Lo editado mientras tanto queda
 *  «pendiente» y se guarda al reanudar. */
let pausas = 0;

/** Guarda lo pendiente, pausa el autoguardado, ejecuta `op` (que cambia el proyecto en el servidor y
 *  sube su revisión) y adopta lo que cambió: la revisión nueva y la lista de recursos del servidor,
 *  sin tocar el resto de la edición local. Lanza si no se pudo guardar antes o hay un conflicto. */
export async function cambioEnServidor<T>(c: Client, id: string, op: () => Promise<T>): Promise<T> {
  if (!(await asegurarGuardado())) throw new Error("Hay cambios sin guardar o un conflicto abierto: resuélvelo y vuelve a intentarlo.");
  const mia = epoca;
  pausas++;
  try {
    const r = await op();
    const remoto = await c.videoProyecto(id);
    const st = useEditor.getState();
    // Con un conflicto abierto no se toca nada: «Recuperar mi edición» llevaría la lista de recursos vieja.
    if (st.conflicto) throw new Error("Hay un conflicto abierto: resuélvelo y vuelve a cargar los recursos.");
    if (mia === epoca && st.proyecto?.id === id && remoto?.id === id) {
      // Deshacer no puede revertir el disco del servidor: se vacía el historial (el panel lo avisa).
      useEditor.setState({ revision: remoto.revision, proyecto: { ...st.proyecto, revision: remoto.revision, recursos: remoto.recursos }, historial: [], futuro: [] });
    }
    return r;
  } finally {
    pausas--;
    if (!pausas && mia === epoca && useEditor.getState().guardado === "pendiente") programar();
  }
}

export async function guardar() {
  cancelarTimer();
  const st = useEditor.getState();
  if (!st.proyecto || guardando || st.conflicto || pausas) return;
  if (!cliente) {
    useEditor.setState({ guardado: "error" });
    return;
  }
  guardando = true;
  const enviado = version;
  const mia = epoca;
  const proyecto = st.proyecto;
  useEditor.setState({ guardado: "guardando" });
  try {
    const r = await cliente.videoProyectoGuardar(proyecto.id, { revision: st.revision, proyecto: { ...proyecto, revision: st.revision } });
    if (mia !== epoca) {
      // Se cambió de proyecto durante el PUT: `abrir` ya reinició el estado. Si hubo ediciones
      // después de lo enviado, se guardan ahora con la revisión que acaba de dar el servidor.
      const ultima = salientes.get(mia);
      salientes.delete(mia);
      if (ultima && ultima !== proyecto) {
        cliente.videoProyectoGuardar(ultima.id, { revision: r.revision, proyecto: { ...ultima, revision: r.revision } }).catch(() => dejarBorrador(ultima));
      }
      return;
    }
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
    if (mia !== epoca) {
      // El PUT del proyecto anterior falló: no se pierde, y se conserva lo último, no lo enviado.
      const ultima = salientes.get(mia) ?? proyecto;
      salientes.delete(mia);
      dejarBorrador(ultima);
      return;
    }
    if (e instanceof ApiError && e.status === 409) {
      // `guardando` sigue en true hasta que acabe el GET: ni el autoguardado ni `salvarSaliente`
      // lanzan un PUT con la revisión vieja mientras tanto.
      await alConflicto(proyecto, mia);
    } else {
      guardando = false;
      useEditor.setState({ guardado: "error" });
    }
  }
}

/** 409: la edición local queda como borrador y el proyecto pasa a la versión del servidor. */
async function alConflicto(local: Proyecto, mia: number) {
  try {
    await resolverConflicto(local, mia);
  } finally {
    if (mia === epoca) guardando = false;
  }
}

async function resolverConflicto(local: Proyecto, mia: number) {
  try {
    const remoto = await cliente!.videoProyecto(local.id);
    if (mia !== epoca) {
      const ultima = salientes.get(mia) ?? local;
      salientes.delete(mia);
      dejarBorrador(ultima, useEditor.getState().proyecto?.id === local.id ? remoto : undefined);
      return;
    }
    // La edición local se toma DESPUÉS del GET: lo escrito mientras duraba va al borrador.
    const actualLocal = useEditor.getState().proyecto ?? local;
    useEditor.setState({ proyecto: remoto, revision: remoto.revision, borrador: actualLocal, conflicto: true, guardado: "error", historial: [], futuro: [] });
  } catch {
    if (mia !== epoca) {
      const ultima = salientes.get(mia) ?? local;
      salientes.delete(mia);
      dejarBorrador(ultima);
      return;
    }
    useEditor.setState({ guardado: "error", borrador: useEditor.getState().proyecto ?? local, conflicto: true });
  }
}
