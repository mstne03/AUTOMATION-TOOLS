/** Lectura defensiva del resultado de un job `video_render` (Task 11): `{ id, duracion, modo,
 *  codificador, avisos, reserva }`, sin rutas. Llega del servidor, no es confiable: cada campo se
 *  reduce a texto o número y todo se pinta como texto (I1). */
import { esObjeto } from "../../json";

export interface ResultadoRender {
  duracion: number | null;
  modo: string | null;
  codificador: string | null;
  /** Qué falló y a qué se recurrió (p. ej. Rápido → Compatible): nunca en silencio (I11). */
  reserva: string | null;
  avisos: string[];
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function aResultadoRender(r: unknown): ResultadoRender {
  const o = esObjeto(r) ? r : {};
  const avisos = Array.isArray(o.avisos)
    ? o.avisos.flatMap((a): string[] => {
        const t = texto(a) ?? (esObjeto(a) ? texto(a.mensaje) : null);
        return t ? [t] : [];
      })
    : [];
  return {
    duracion: typeof o.duracion === "number" && Number.isFinite(o.duracion) && o.duracion >= 0 ? o.duracion : null,
    modo: texto(o.modo),
    codificador: texto(o.codificador),
    reserva: texto(o.reserva),
    avisos,
  };
}

/** 12,5 s; con una cifra decimal y coma, como el resto de la UI. */
export const segundos = (s: number) => `${s.toFixed(1).replace(".", ",")} s`;
