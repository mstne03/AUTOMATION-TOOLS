/** Lectura defensiva del resultado de un job `video_render` (Task 11): `{ id, duracion, modo,
 *  codificador, avisos, reserva }`, sin rutas. Llega del servidor, no es confiable: cada campo se
 *  reduce a texto o número y todo se pinta como texto (I1). */
import { esObjeto } from "../../json";

/** Códigos que emite el motor de render (T11), traducidos con una tabla cerrada. */
const TEXTOS: Record<string, string> = {
  fondo_degradado: "El fondo se ha simplificado a un degradado.",
  foto_pequena: "Alguna foto es pequeña y puede verse borrosa.",
  puertos_preview_ajenos: "Algunos puertos de la vista previa estaban ocupados por otro programa.",
};
const RAPIDO_A_COMPATIBLE = "Rápido no se pudo usar; el vídeo se ha renderizado en Compatible.";

export interface ResultadoRender {
  duracion: number | null;
  modo: string | null;
  codificador: string | null;
  /** Qué falló y a qué se recurrió (p. ej. Rápido → Compatible): nunca en silencio (I11). */
  reserva: string[];
  avisos: string[];
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Un código (o un texto suelto) a su frase; si no está en la tabla, un aviso genérico que lo cita.
 *  También la usa la preview: el backend solo le pasa `{ codigo }`, nunca texto (R2-2). */
export function aFrase(v: unknown): string | null {
  const c = texto(v) ?? (esObjeto(v) ? texto(v.codigo) : null);
  if (!c) return null;
  const t = c.trim();
  if (Object.hasOwn(TEXTOS, t)) return TEXTOS[t];
  return `Aviso no reconocido (${t.slice(0, 60)}).`;
}

const lista = (v: unknown): string[] => {
  const items = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
  return items.flatMap((x) => {
    const f = aFrase(x);
    return f ? [f] : [];
  });
};

/** `solicitado`: el modo con que se lanzó (args.modo). Si fue Rápido y salió Compatible, se dice
 *  aunque el motor no haya anotado la reserva. */
export function aResultadoRender(r: unknown, solicitado?: unknown): ResultadoRender {
  const o = esObjeto(r) ? r : {};
  const modo = texto(o.modo);
  const reserva = lista(o.reserva);
  if (solicitado === "rapido" && modo === "compatible" && reserva.length === 0) reserva.push(RAPIDO_A_COMPATIBLE);
  return {
    duracion: typeof o.duracion === "number" && Number.isFinite(o.duracion) && o.duracion >= 0 ? o.duracion : null,
    modo,
    codificador: texto(o.codificador),
    reserva,
    avisos: lista(o.avisos),
  };
}

/** 12,5 s; con una cifra decimal y coma, como el resto de la UI. */
export const segundos = (s: number) => `${s.toFixed(1).replace(".", ",")} s`;
