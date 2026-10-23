/** Nombre y precio de los modelos que ofrece el sidecar (precios: tabla única de turno.ts). */
import { PRECIOS_MODELO } from "./turno";

export function nombreModelo(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)$/);
  if (!m) return id;
  return `Claude ${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

export function precioModelo(id: string): string {
  const p = id.includes("opus") ? PRECIOS_MODELO.opus : PRECIOS_MODELO.sonnet;
  return `${p.entrada} $ / ${p.salida} $ por Mtok`;
}
