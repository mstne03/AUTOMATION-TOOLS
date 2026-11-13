/** Protocolo `postMessage` entre el editor y la composición de la preview (I8, T17).
 *
 *  La composición vive en un iframe `sandbox="allow-scripts"` sin `allow-same-origin`: su origen es
 *  opaco (`"null"`). Todo lo que llega de ahí es entrada no confiable: solo se acepta con
 *  `e.source === iframe.contentWindow` y `e.origin === "null"`, con un esquema cerrado (tipos de
 *  lista fija, claves exactas, `id` entero correlacionado, números finitos en `[0, duración]`).
 *  Lo demás se descarta en silencio. Nada de esto se pinta como HTML ni se usa como URL. */

export type MensajeIframe =
  | { tipo: "listo"; duracion: number }
  | { tipo: "seek-hecho"; id: number; t: number }
  | { tipo: "tiempo"; t: number; reproduciendo: boolean }
  | { tipo: "error"; id: number };

export type OrdenIframe =
  | { tipo: "seek"; id: number; t: number }
  | { tipo: "play" }
  | { tipo: "pause" };

/** Duración máxima de un proyecto (I1, `LIMITES.duracionS` del backend): 180 s. */
export const DURACION_PROYECTO_S = 180;
/** Tope que acepta `listo`: el límite real más 1 s de margen. Una cifra mayor no es de fiar y
 *  ampliaría el rango de `tiempo` que alcanza al cabezal del editor. */
export const DURACION_MAXIMA = DURACION_PROYECTO_S + 1;
/** Margen de redondeo al comparar `t` con la duración. */
const EPSILON = 1e-3;
export const MAX_MENSAJES_POR_SEGUNDO = 120;

function objetoPlano(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null ? (v as Record<string, unknown>) : null;
}

const clavesExactas = (o: Record<string, unknown>, claves: string[]) => {
  const k = Object.keys(o);
  return k.length === claves.length && claves.every((c) => Object.prototype.hasOwnProperty.call(o, c));
};
const enRango = (t: unknown, max: number): t is number =>
  typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= max + EPSILON;

/** Pura: devuelve el mensaje validado (una copia nueva) o `null`. No modifica `pendientes`:
 *  quien lo llama retira el `id` cuando lo consume. */
export function validarMensajeIframe(
  e: MessageEvent,
  ventana: Window,
  pendientes: Set<number>,
  duracion: number,
): MensajeIframe | null {
  if (e.source !== ventana || e.origin !== "null") return null;
  const d = objetoPlano(e.data);
  if (!d) return null;
  const idValido = (id: unknown): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && pendientes.has(id);
  switch (d.tipo) {
    case "listo":
      if (!clavesExactas(d, ["tipo", "duracion"]) || !enRango(d.duracion, DURACION_MAXIMA)) return null;
      return { tipo: "listo", duracion: d.duracion };
    case "seek-hecho":
      if (!clavesExactas(d, ["tipo", "id", "t"]) || !idValido(d.id) || !enRango(d.t, duracion)) return null;
      return { tipo: "seek-hecho", id: d.id, t: d.t };
    case "tiempo":
      if (!clavesExactas(d, ["tipo", "t", "reproduciendo"]) || !enRango(d.t, duracion) || typeof d.reproduciendo !== "boolean")
        return null;
      return { tipo: "tiempo", t: d.t, reproduciendo: d.reproduciendo };
    case "error":
      if (!clavesExactas(d, ["tipo", "id"]) || !idValido(d.id)) return null;
      return { tipo: "error", id: d.id };
    default:
      return null;
  }
}

/** Ventana deslizante: en cualquier intervalo de `ventanaMs` se admiten como mucho `max`
 *  mensajes; los demás se ignoran (y se cuentan). Sin el efecto borde de una ventana fija. */
export class LimitadorMensajes {
  ignorados = 0;
  private marcas: number[] = [];
  constructor(
    private readonly max = MAX_MENSAJES_POR_SEGUNDO,
    private readonly ventanaMs = 1000,
  ) {}
  admitir(ahoraMs: number): boolean {
    // Fuera las marcas caducadas (y las «del futuro», si el reloj retrocede).
    this.marcas = this.marcas.filter((m) => m <= ahoraMs && ahoraMs - m < this.ventanaMs);
    if (this.marcas.length >= this.max) {
      this.ignorados++;
      return false;
    }
    this.marcas.push(ahoraMs);
    return true;
  }
}

/** Envía una orden a la composición. Es el único `postMessage` hacia dentro.
 *
 *  `targetOrigin` es `"*"` y no puede ser otro: el documento sandbox sin `allow-same-origin` tiene
 *  origen opaco, que ningún `targetOrigin` con forma de URL puede igualar (el navegador descartaría
 *  el mensaje). Se acota de otro modo: se envía solo a `iframe.contentWindow`, nunca a `window`
 *  ni a otra referencia, y las órdenes (`seek`/`play`/`pause`) no llevan datos sensibles. */
export function enviarOrden(destino: Window | null | undefined, orden: OrdenIframe): boolean {
  if (!destino) return false;
  destino.postMessage(orden, "*");
  return true;
}
