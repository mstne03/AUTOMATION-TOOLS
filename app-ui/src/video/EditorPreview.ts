/** Dueño único del ciclo de vida de la preview del editor (invariante I8: la clave de preview
 *  no sobrevive al cierre del editor).
 *
 *  Interfaz para T17 (`Preview.tsx`), sin tocar nada más de este módulo:
 *
 *    const sesion = sesionPreview();          // null fuera de /video/:id
 *    const r = await sesion?.abrir(webgpu);   // POST …/preview; null si el editor ya se cerró
 *    sesion?.programar(() => …, 400);         // temporizador que se cancela al cerrar
 *
 *  T17 no debe llamar a `client.videoPreviewAbrir` ni `videoPreviewCerrar` directamente ni usar
 *  temporizadores propios para reabrir: así la secuencia al salir es siempre
 *  (1) marcar cerrada, (2) cancelar temporizadores, (3) esperar a los POST en vuelo y
 *  (4) lanzar el DELETE. Si un POST responde después de cerrar, su clave la invalida ese DELETE. */
import type { Client } from "../api/client";
import type { PreviewVideo } from "../api/types";

export class SesionPreview {
  private cerrada = false;
  private enVuelo = new Set<Promise<unknown>>();
  private temporizadores = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly client: Pick<Client, "videoPreviewAbrir" | "videoPreviewCerrar">,
    readonly id: string,
  ) {}

  get estaCerrada(): boolean {
    return this.cerrada;
  }

  /** `POST …/preview`. Devuelve `null` (sin llamar) si la sesión ya está cerrada, y también si se
   *  cerró mientras esperaba: la clave recibida no debe usarse, el cierre ya la invalida. */
  async abrir(webgpu: boolean): Promise<PreviewVideo | null> {
    if (this.cerrada) return null;
    const p = Promise.resolve(this.client.videoPreviewAbrir(this.id, webgpu));
    const seguimiento = p.then(
      () => undefined,
      () => undefined,
    );
    this.enVuelo.add(seguimiento);
    try {
      const r = await p;
      return this.cerrada ? null : r;
    } finally {
      this.enVuelo.delete(seguimiento);
    }
  }

  /** Temporizador ligado a la sesión: no salta si se cierra antes. */
  programar(fn: () => void, ms: number): () => void {
    if (this.cerrada) return () => undefined;
    const h = setTimeout(() => {
      this.temporizadores.delete(h);
      if (!this.cerrada) fn();
    }, ms);
    this.temporizadores.add(h);
    return () => {
      clearTimeout(h);
      this.temporizadores.delete(h);
    };
  }

  /** Cierra la sesión: bandera, temporizadores, POST en vuelo y por último el DELETE. */
  cerrar(): Promise<void> {
    if (this.cerrada) return Promise.resolve();
    this.cerrada = true;
    for (const h of this.temporizadores) clearTimeout(h);
    this.temporizadores.clear();
    if (this.enVuelo.size === 0) return this.borrar();
    return Promise.all(this.enVuelo).then(() => this.borrar());
  }

  private async borrar(): Promise<void> {
    for (let intento = 0; intento < 2; intento++) {
      try {
        await this.client.videoPreviewCerrar(this.id);
        return;
      } catch (e) {
        // Sin la clave ni el detalle del error: puede llevar rutas.
        console.warn(
          `No se pudo cerrar la preview del proyecto (intento ${intento + 1} de 2)`,
          e instanceof Error ? e.name : typeof e,
        );
      }
    }
  }
}

let actual: SesionPreview | null = null;

/** Sesión del editor abierto, o `null` si no hay ninguno. */
export function sesionPreview(): SesionPreview | null {
  return actual;
}

/** Solo lo usa `EditorVideoScreen`: abre la sesión de un proyecto (cierra la anterior, si la hay). */
export function iniciarSesionPreview(
  client: Pick<Client, "videoPreviewAbrir" | "videoPreviewCerrar">,
  id: string,
): SesionPreview {
  void actual?.cerrar();
  actual = new SesionPreview(client, id);
  return actual;
}

/** Solo lo usa `EditorVideoScreen` al salir. */
export function cerrarSesionPreview(sesion: SesionPreview): Promise<void> {
  if (actual === sesion) actual = null;
  return sesion.cerrar();
}
