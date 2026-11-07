/** Estado de la pantalla Guiones: lo de cada modo vive en un store para sobrevivir a cambiar de
 *  pantalla, como Publicar. Cada modo tiene su conversación con el agente ("guiones:<modo>" en
 *  state/conversations.ts; no se guardan en el sidecar, como "publicar"). */
import { create } from "zustand";
import { ApiError, type Client } from "../api/client";
import type { AvisoVideo } from "../api/types";
import { aGuionVideo, type EscenaGuionUi, type GuionVideoUi } from "../video/modelo";
import { aGuion, aRevision, erroresServidor, type Formato, type Guion, type Retencion, type Revision } from "../guiones/modelo";
import { esObjeto, extraerJson } from "../json";
import { limpiarConversacion } from "./conversations";

export type Modo = "escribir" | "revisar" | "diagnosticar";
export const CONVERSACION: Record<Modo, string> = {
  escribir: "guiones:escribir",
  revisar: "guiones:revisar",
  diagnosticar: "guiones:diagnosticar",
};
export const MINUTOS_POR_DEFECTO: Record<Formato, number> = { long: 8, short: 0.5, video: 0.75 };

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
  /** Formato Vídeo: guion de escenas editable y estado de su guardado en el servidor. */
  guionVideo: GuionVideoUi | null;
  videoGuardadoId: string | null;
  videoAvisos: AvisoVideo[];
  videoErrores: string[];
  videoOcupado: boolean;
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
  escribir: { tema: "", formato: "long", minutos: MINUTOS_POR_DEFECTO.long, minutosTocados: false, publico: "", guion: null, gancho: 0, esperando: false, jsonError: false, guionVideo: null, videoGuardadoId: null, videoAvisos: [], videoErrores: [], videoOcupado: false },
  revisar: { texto: "", formato: "long", revision: null, esperando: false, jsonError: false },
  diagnosticar: { entrada: "", formato: "long", resultado: null, error: null, cargando: false, propuesto: false },
});

export const useGuiones = create<EstadoGuiones>(() => inicial());

export const setModo = (modo: Modo) => useGuiones.setState({ modo });
export const parcharEscribir = (p: Partial<Escribir>) => useGuiones.setState((s) => ({ escribir: { ...s.escribir, ...p } }));
export const parcharRevisar = (p: Partial<Revisar>) => useGuiones.setState((s) => ({ revisar: { ...s.revisar, ...p } }));
export const parcharDiagnosticar = (p: Partial<Diagnosticar>) => useGuiones.setState((s) => ({ diagnosticar: { ...s.diagnosticar, ...p } }));

export function cambiarFormatoEscribir(formato: Formato) {
  if (useGuiones.getState().escribir.esperando) return;
  const { minutosTocados } = useGuiones.getState().escribir;
  parcharEscribir(minutosTocados ? { formato } : { formato, minutos: MINUTOS_POR_DEFECTO[formato] });
}

/** Lee el JSON del turno terminado (null = el turno acabó en error: ese error ya lo pinta el turno).
 *  Si no se puede leer, marca jsonError y conserva el resultado anterior. */
export function recibirRespuesta(modo: "escribir" | "revisar", texto: string | null) {
  if (modo === "escribir" && useGuiones.getState().escribir.formato === "video") return recibirVideo(texto);
  const normal = texto === null ? null : (() => {
    const j = extraerJson(texto, esObjeto);
    return j ? (modo === "escribir" ? aGuion(j) : aRevision(j)) : null;
  })();
  const jsonError = texto !== null && !normal;
  if (modo === "escribir") parcharEscribir({ esperando: false, jsonError, ...(normal ? { guion: normal as Guion, gancho: 0 } : {}) });
  else parcharRevisar({ esperando: false, jsonError, ...(normal ? { revision: normal as Revision } : {}) });
}

function recibirVideo(texto: string | null) {
  const g = texto === null ? null : (() => {
    const j = extraerJson(texto, esObjeto);
    return j ? aGuionVideo(j) : null;
  })();
  parcharEscribir({
    esperando: false,
    jsonError: texto !== null && !g,
    ...(g ? { guionVideo: g, videoGuardadoId: null, videoAvisos: [], videoErrores: [] } : {}),
  });
}

/** Copia del guion editable: `aCuerpo()` lee el objeto que lo creó, así que cada edición parte de
 *  un clon (misma ruta que el cuerpo que se envía) y deja el anterior intacto. */
function clonarVideo(g: GuionVideoUi): GuionVideoUi {
  return aGuionVideo(g.aCuerpo()) ?? g;
}

function editarVideo(f: (g: GuionVideoUi) => void) {
  const actual = useGuiones.getState().escribir.guionVideo;
  if (!actual) return;
  const g = clonarVideo(actual);
  f(g);
  parcharEscribir({ guionVideo: g, videoGuardadoId: null, videoAvisos: [], videoErrores: [] });
}

export const editarCabeceraVideo = (patch: Partial<Pick<GuionVideoUi, "titulo" | "gancho">>) => editarVideo((g) => Object.assign(g, patch));

/** Base mínima de cada tipo al cambiarlo: el motor decide después si el guion vale. */
function baseNueva(tipo: string, texto: string): EscenaGuionUi["base"] {
  const t = texto.slice(0, 40);
  switch (tipo) {
    case "cifra":
      return { tipo, valor: 0, prefijo: "", sufijo: "", decimales: 0 };
    case "barras":
      return { tipo, titulo: t.slice(0, 48), periodos: ["A", "B"], series: [{ nombre: "S1", valores: [0, 0] }, { nombre: "S2", valores: [0, 0] }], prefijo: "", sufijo: "" };
    case "mapa":
      return { tipo, region: "mundo", destacar: [] };
    case "titulo3d":
      return { tipo, texto: texto.replace(/[^\x20-\x7e]/g, "").slice(0, 12) };
    default:
      return { tipo, texto: t };
  }
}

export function editarEscenaVideo(i: number, patch: { frases?: string[]; tipo?: string }) {
  editarVideo((g) => {
    const e = g.escenas[i];
    if (!e) return;
    if (patch.frases) e.frases = patch.frases;
    if (patch.tipo && patch.tipo !== e.tipo) {
      e.tipo = patch.tipo;
      e.base = baseNueva(patch.tipo, e.frases[0] ?? "");
    }
  });
}

export function moverEscenaVideo(i: number, delta: -1 | 1) {
  editarVideo((g) => {
    const j = i + delta;
    if (!g.escenas[i] || !g.escenas[j]) return;
    [g.escenas[i], g.escenas[j]] = [g.escenas[j], g.escenas[i]];
  });
}

const textoError = (e: unknown) => (e instanceof ApiError ? erroresServidor(e.detail) : [e instanceof Error ? e.message : "Error desconocido."]);

/** `POST /video/guiones` con el guion tal como está. Siempre por un clic del usuario. El servidor es
 *  quien valida: sus errores se guardan como líneas de texto. Devuelve el id o null. */
export async function guardarGuionVideo(client: Client): Promise<string | null> {
  const { guionVideo, videoOcupado } = useGuiones.getState().escribir;
  if (!guionVideo || videoOcupado) return null;
  parcharEscribir({ videoOcupado: true, videoErrores: [] });
  try {
    const r = await client.videoGuionCrear(guionVideo.aCuerpo());
    parcharEscribir({ videoGuardadoId: r.id, videoAvisos: r.avisos });
    return r.id;
  } catch (e) {
    parcharEscribir({ videoErrores: textoError(e) });
    return null;
  } finally {
    parcharEscribir({ videoOcupado: false });
  }
}

/** Guardar + `POST /video/proyectos` con el perfil «defecto» (o el primero que haya). Devuelve el id
 *  del proyecto para ir a `/video/:id`, o null si algo falló (el motivo queda en `videoErrores`). */
export async function crearVideo(client: Client): Promise<string | null> {
  const { videoGuardadoId, videoOcupado } = useGuiones.getState().escribir;
  if (videoOcupado) return null;
  const gid = videoGuardadoId ?? (await guardarGuionVideo(client));
  if (!gid) return null;
  parcharEscribir({ videoOcupado: true });
  try {
    const perfiles = await client.videoPerfiles();
    const perfil = perfiles.find((p) => p.id === "defecto") ?? perfiles[0];
    if (!perfil) {
      parcharEscribir({ videoErrores: ["No hay ningún perfil visual para crear el vídeo."] });
      return null;
    }
    return (await client.videoProyectoCrear(gid, perfil.id)).id;
  } catch (e) {
    parcharEscribir({ videoErrores: textoError(e) });
    return null;
  } finally {
    parcharEscribir({ videoOcupado: false });
  }
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
