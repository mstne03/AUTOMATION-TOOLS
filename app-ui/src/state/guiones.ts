/** Estado de la pantalla Guiones: lo de cada modo vive en un store para sobrevivir a cambiar de
 *  pantalla, como Publicar. Cada modo tiene su conversación con el agente ("guiones:<modo>" en
 *  state/conversations.ts; no se guardan en el sidecar, como "publicar"). */
import { create } from "zustand";
import type { Client } from "../api/client";
import { aGuion, aRevision, type Formato, type Guion, type Retencion, type Revision } from "../guiones/modelo";
import { esObjeto, extraerJson } from "../json";
import { limpiarConversacion } from "./conversations";

export type Modo = "escribir" | "revisar" | "diagnosticar";
export const CONVERSACION: Record<Modo, string> = {
  escribir: "guiones:escribir",
  revisar: "guiones:revisar",
  diagnosticar: "guiones:diagnosticar",
};
export const MINUTOS_POR_DEFECTO: Record<Formato, number> = { long: 8, short: 0.5 };

interface Escribir {
  tema: string;
  formato: Formato;
  minutos: number;
  /** El usuario ha cambiado la duración: cambiar de formato ya no la pisa. */
  minutosTocados: boolean;
  publico: string;
  guion: Guion | null;
  gancho: number;
  esperando: boolean;
  jsonError: boolean;
}
interface Revisar {
  texto: string;
  formato: Formato;
  revision: Revision | null;
  esperando: boolean;
  jsonError: boolean;
}
interface Diagnosticar {
  entrada: string;
  formato: Formato;
  resultado: Retencion | null;
  error: string | null;
  cargando: boolean;
  /** «Proponer mejoras» se ha pedido: habilita «Guardar aprendizaje» al terminar ese turno. */
  propuesto: boolean;
}

interface EstadoGuiones {
  modo: Modo;
  escribir: Escribir;
  revisar: Revisar;
  diagnosticar: Diagnosticar;
}

const inicial = (): EstadoGuiones => ({
  modo: "escribir",
  escribir: { tema: "", formato: "long", minutos: MINUTOS_POR_DEFECTO.long, minutosTocados: false, publico: "", guion: null, gancho: 0, esperando: false, jsonError: false },
  revisar: { texto: "", formato: "long", revision: null, esperando: false, jsonError: false },
  diagnosticar: { entrada: "", formato: "long", resultado: null, error: null, cargando: false, propuesto: false },
});

export const useGuiones = create<EstadoGuiones>(() => inicial());

export const setModo = (modo: Modo) => useGuiones.setState({ modo });
export const parcharEscribir = (p: Partial<Escribir>) => useGuiones.setState((s) => ({ escribir: { ...s.escribir, ...p } }));
export const parcharRevisar = (p: Partial<Revisar>) => useGuiones.setState((s) => ({ revisar: { ...s.revisar, ...p } }));
export const parcharDiagnosticar = (p: Partial<Diagnosticar>) => useGuiones.setState((s) => ({ diagnosticar: { ...s.diagnosticar, ...p } }));

export function cambiarFormatoEscribir(formato: Formato) {
  const { minutosTocados } = useGuiones.getState().escribir;
  parcharEscribir(minutosTocados ? { formato } : { formato, minutos: MINUTOS_POR_DEFECTO[formato] });
}

/** Lee el JSON del turno terminado (null = el turno acabó en error: ese error ya lo pinta el turno).
 *  Si no se puede leer, marca jsonError y conserva el resultado anterior. */
export function recibirRespuesta(modo: "escribir" | "revisar", texto: string | null) {
  const normal = texto === null ? null : (() => {
    const j = extraerJson(texto, esObjeto);
    return j ? (modo === "escribir" ? aGuion(j) : aRevision(j)) : null;
  })();
  const jsonError = texto !== null && !normal;
  if (modo === "escribir") parcharEscribir({ esperando: false, jsonError, ...(normal ? { guion: normal as Guion, gancho: 0 } : {}) });
  else parcharRevisar({ esperando: false, jsonError, ...(normal ? { revision: normal as Revision } : {}) });
}

/** El análisis en curso; uno nuevo o «Empezar de nuevo» anulan el anterior. */
let intento: object | null = null;

/** GET /guiones/retencion sin pasar por el agente (SPEC-guiones.md, D2). */
export async function analizarRetencion(client: Client, videoId: string) {
  const testigo = {};
  intento = testigo;
  const { formato } = useGuiones.getState().diagnosticar;
  parcharDiagnosticar({ cargando: true, error: null, resultado: null, propuesto: false });
  limpiarConversacion(CONVERSACION.diagnosticar);
  try {
    const r = await client.guionesRetencion(videoId, formato);
    if (intento !== testigo) return;
    if ("error" in r) parcharDiagnosticar({ error: r.error });
    else parcharDiagnosticar({ resultado: r });
  } catch (e) {
    if (intento === testigo) parcharDiagnosticar({ error: (e as Error).message });
  } finally {
    if (intento === testigo) parcharDiagnosticar({ cargando: false });
  }
}

/** «Empezar de nuevo»: vacía el modo y su conversación con el agente. */
export function empezarDeNuevo(modo: Modo) {
  if (modo === "diagnosticar") intento = null;
  useGuiones.setState({ [modo]: inicial()[modo] } as Partial<EstadoGuiones>);
  limpiarConversacion(CONVERSACION[modo]);
}

/** Solo para tests. */
export function reiniciarGuiones() {
  intento = null;
  useGuiones.setState(inicial(), true);
}
