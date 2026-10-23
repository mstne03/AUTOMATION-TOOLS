/** Límites de YouTube para un vídeo nuevo (verificados el 2026-10-23 en
 *  https://developers.google.com/youtube/v3/docs/videos): título ≤ 100 caracteres, descripción
 *  ≤ 5000 BYTES (UTF-8, no caracteres), etiquetas ≤ 500 caracteres en total contando las comas y
 *  las comillas que el servidor añade a las que llevan espacios; ni < ni > en ninguno. */
export const MAX_TITULO = 100;
export const MAX_DESCRIPCION_BYTES = 5000;
export const MAX_ETIQUETAS = 500;

export const bytesUtf8 = (s: string) => new TextEncoder().encode(s).length;

export function longitudEtiquetas(tags: string[]): number {
  const suma = tags.reduce((n, t) => n + t.length + (/\s/.test(t) ? 2 : 0), 0);
  return suma + Math.max(0, tags.length - 1);
}

export const tieneAngulos = (s: string) => /[<>]/.test(s);

/** Marcadores como [ENLACE A CSFINANCE.APP] o [CANAL]: texto de plantilla que no se ha rellenado. */
export const tieneMarcador = (s: string) => /\[[A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9 _.\-/]{2,}\]/.test(s);

export type Nivel = "ok" | "aviso" | "error" | "info";
export interface Comprobacion {
  id: string;
  nivel: Nivel;
  texto: string;
}

export interface EntradaComprobacion {
  title: string;
  description: string;
  tags: string[];
  publishAt: string; // valor de datetime-local ("" si no hay)
  rutaVacia: boolean;
  rutaPermitida: boolean;
  cuota?: { used: number; limit: number };
  ahora: number;
}

/** Comprobaciones en vivo del borrador. Los de nivel "error" bloquean la subida; "aviso" no. */
export function comprobar(e: EntradaComprobacion): Comprobacion[] {
  const r: Comprobacion[] = [];
  if (e.title.trim() === "") r.push({ id: "titulo", nivel: "info", texto: "Falta el título" });
  else if (e.title.length > MAX_TITULO) r.push({ id: "titulo", nivel: "error", texto: `El título pasa de ${MAX_TITULO} caracteres` });
  else if (tieneAngulos(e.title)) r.push({ id: "titulo", nivel: "error", texto: "El título no puede llevar < ni >" });
  else r.push({ id: "titulo", nivel: "ok", texto: "Título dentro del límite y sin < ni >" });

  if (e.rutaVacia) r.push({ id: "ruta", nivel: "info", texto: "Falta elegir un vídeo" });
  else if (!e.rutaPermitida) r.push({ id: "ruta", nivel: "error", texto: "El fichero no está en una carpeta permitida" });
  else r.push({ id: "ruta", nivel: "ok", texto: "Fichero dentro de una carpeta permitida" });

  const bytes = bytesUtf8(e.description);
  if (bytes > MAX_DESCRIPCION_BYTES) r.push({ id: "descripcion", nivel: "error", texto: `La descripción pasa de ${MAX_DESCRIPCION_BYTES} bytes` });
  else if (tieneAngulos(e.description)) r.push({ id: "descripcion", nivel: "error", texto: "La descripción no puede llevar < ni >" });
  else if (tieneMarcador(e.description)) r.push({ id: "descripcion", nivel: "aviso", texto: "La descripción tiene un marcador sin rellenar" });
  else r.push({ id: "descripcion", nivel: "ok", texto: "Descripción dentro del límite" });

  const largo = longitudEtiquetas(e.tags);
  if (largo > MAX_ETIQUETAS) r.push({ id: "etiquetas", nivel: "error", texto: `Las etiquetas pasan de ${MAX_ETIQUETAS} caracteres` });
  else if (e.tags.some(tieneAngulos)) r.push({ id: "etiquetas", nivel: "error", texto: "Las etiquetas no pueden llevar < ni >" });

  if (e.publishAt) {
    const t = new Date(e.publishAt).getTime();
    if (Number.isNaN(t) || t <= e.ahora) r.push({ id: "fecha", nivel: "error", texto: "La fecha programada ya ha pasado" });
    else r.push({ id: "fecha", nivel: "ok", texto: "Fecha programada en el futuro" });
  }

  if (e.cuota) r.push({ id: "cuota", nivel: "info", texto: `Cuota: ${e.cuota.used} de ${e.cuota.limit} subidas usadas hoy` });
  return r;
}

/** Primer motivo que impide subir (null = se puede). Prioriza lo que el usuario debe resolver antes. */
export function motivoBloqueo(c: Comprobacion[]): string | null {
  const orden = ["ruta", "titulo", "descripcion", "etiquetas", "fecha"];
  for (const id of orden) {
    const x = c.find((k) => k.id === id);
    if (x && (x.nivel === "error" || (x.nivel === "info" && (id === "ruta" || id === "titulo")))) {
      if (id === "ruta" && x.nivel === "info") return "Falta elegir un vídeo dentro de una carpeta permitida.";
      if (id === "titulo" && x.nivel === "info") return "Falta el título del borrador.";
      return `${x.texto}.`;
    }
  }
  return null;
}

/** Zona horaria legible del usuario: "Madrid (UTC+2)". */
export function zonaHoraria(fecha: Date = new Date()): string {
  const min = -fecha.getTimezoneOffset();
  const signo = min >= 0 ? "+" : "-";
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  const utc = `UTC${signo}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
  const ciudad = Intl.DateTimeFormat().resolvedOptions().timeZone?.split("/").pop()?.replace(/_/g, " ");
  return ciudad ? `${ciudad} (${utc})` : utc;
}

export interface Diferencia {
  campo: string;
  borrador: string;
  propuesto: string;
}

const norm = (s: unknown) => (typeof s === "string" ? s.trim() : "");

/** Ruta de Windows comparable: separadores \, sin barra final y sin distinguir mayúsculas. */
export const normRuta = (p: string) => p.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** Compara lo que el agente propone subir con el borrador del usuario (UI-08). El fichero también:
 *  el modelo puede proponer otro (o un nombre suelto que el sidecar resuelve en otra carpeta). */
export function compararConBorrador(
  args: Record<string, unknown>,
  b: { filePath: string; title: string; description: string; tags: string[]; privacy: string; publishAt: string },
): Diferencia[] {
  const d: Diferencia[] = [];
  if (normRuta(norm(args.file_path)) !== normRuta(b.filePath)) d.push({ campo: "Fichero", borrador: b.filePath.trim(), propuesto: norm(args.file_path) });
  if (norm(args.title) !== b.title.trim()) d.push({ campo: "Título", borrador: b.title.trim(), propuesto: norm(args.title) });
  if (norm(args.description) !== b.description.trim()) d.push({ campo: "Descripción", borrador: b.description.trim(), propuesto: norm(args.description) });
  const tagsArg = Array.isArray(args.tags) ? args.tags.map(String) : [];
  const clave = (t: string[]) => [...t].map((x) => x.trim().toLowerCase()).sort().join("|");
  if (clave(tagsArg) !== clave(b.tags)) d.push({ campo: "Etiquetas", borrador: b.tags.join(", "), propuesto: tagsArg.join(", ") });
  if (norm(args.privacy_status) !== b.privacy) d.push({ campo: "Visibilidad", borrador: b.privacy, propuesto: norm(args.privacy_status) });
  const fechaArg = typeof args.publish_at === "string" ? new Date(args.publish_at).getTime() : null;
  const fechaBor = b.publishAt ? new Date(b.publishAt).getTime() : null;
  if ((fechaArg ?? null) !== (fechaBor ?? null)) {
    d.push({ campo: "Programada", borrador: b.publishAt || "sin fecha", propuesto: typeof args.publish_at === "string" ? args.publish_at : "sin fecha" });
  }
  return d;
}
