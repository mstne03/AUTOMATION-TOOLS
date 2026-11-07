/** Voz del proyecto: forma de onda, coste pendiente y el flujo de gasto (I10).
 *  Nada de aquí gasta sin que el usuario confirme en `voz-confirmar` los caracteres que ha dado
 *  el servidor; editar texto, reordenar o recortar nunca llama a la voz. */
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { useClient } from "../../api/context";
import type { CosteVoz } from "../../api/types";
import { editar, useEditor } from "../../state/editor";
import { toast } from "../../ui";

export function useFormaVoz(id: string | undefined) {
  const client = useClient();
  const revision = useEditor((e) => e.revision);
  return useQuery({
    queryKey: ["video", "voz", id, "forma", revision],
    queryFn: () => client.videoVozForma(id!),
    enabled: !!id,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useCosteVoz(id: string | undefined) {
  const client = useClient();
  const revision = useEditor((e) => e.revision);
  return useQuery({
    queryKey: ["video", "voz", id, "coste", revision],
    queryFn: () => client.videoVozCoste(id!),
    enabled: !!id,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export interface Gasto {
  /** Frases a regenerar; `undefined` = todas las pendientes. */
  frases?: string[];
  caracteres: number;
  voz: string;
  /** El servidor cambió la cifra entre mostrarla y confirmarla. */
  cambio: boolean;
}

const esCosteCambiado = (e: unknown) => e instanceof ApiError && e.status === 409 && /coste/i.test(e.detail);
const esSinClave = (e: unknown) => e instanceof ApiError && e.status === 409 && /clave/i.test(e.detail);

/** Caracteres que se confirman: los del servidor. Para una sola frase, si no es la única
 *  pendiente, la cifra es la de su propio texto (el servidor la rechaza si difiere). */
function caracteresDe(coste: CosteVoz, frases?: string[]): number {
  if (!frases) return coste.caracteres;
  if (coste.pendientes.length === 1 && coste.pendientes[0] === frases[0]) return coste.caracteres;
  const f = useEditor.getState().proyecto?.frases.find((x) => x.id === frases[0]);
  return f ? [...f.texto].length : coste.caracteres;
}

export function useGastoVoz() {
  const client = useClient();
  const qc = useQueryClient();
  const [gasto, setGasto] = useState<Gasto | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [sinClave, setSinClave] = useState(false);
  const ocupado = useRef(false);

  const leerCoste = useCallback(
    async (frases: string[] | undefined, cambio: boolean) => {
      const id = useEditor.getState().proyecto?.id;
      if (!id) return false;
      try {
        const c = await client.videoVozCoste(id);
        setGasto({ frases, caracteres: caracteresDe(c, frases), voz: c.voz, cambio });
        return true;
      } catch {
        toast({ title: "No se pudo calcular el coste de la voz", description: "Inténtalo de nuevo.", tone: "error" });
        return false;
      }
    },
    [client],
  );

  /** Abre el diálogo con el coste que da el servidor ahora; no genera nada. */
  const pedir = useCallback(
    async (frases?: string[]) => {
      setSinClave(false);
      await leerCoste(frases, false);
    },
    [leerCoste],
  );

  const cerrar = useCallback(() => setGasto(null), []);

  const confirmar = useCallback(async () => {
    const id = useEditor.getState().proyecto?.id;
    if (!gasto || !id || ocupado.current) return;
    ocupado.current = true;
    setEnviando(true);
    try {
      const cuerpo = gasto.frases ? { frases: gasto.frases, caracteres_confirmados: gasto.caracteres } : { caracteres_confirmados: gasto.caracteres };
      const r = await client.videoVozGenerar(id, cuerpo);
      setGasto(null);
      await qc.invalidateQueries({ queryKey: ["video", "voz", id] });
      if (r && typeof r === "object" && "fallo" in r && r.fallo) {
        toast({ title: "La voz quedó incompleta", description: "Lo generado se conserva; reintentar solo factura lo que falta.", tone: "warning" });
      } else {
        toast({ title: "Voz generada" });
      }
    } catch (e) {
      if (esCosteCambiado(e)) {
        // No se reintenta solo: se vuelve a pedir confirmación con la cifra nueva.
        await leerCoste(gasto.frases, true);
      } else if (esSinClave(e)) {
        setGasto(null);
        setSinClave(true);
      } else {
        setGasto(null);
        toast({ title: "No se pudo generar la voz", description: "Revisa tu conexión y tu cuenta de ElevenLabs e inténtalo de nuevo.", tone: "error" });
      }
    } finally {
      ocupado.current = false;
      setEnviando(false);
    }
  }, [client, gasto, leerCoste, qc]);

  return { gasto, enviando, sinClave, pedir, confirmar, cerrar };
}

const esRecorte = (r: unknown): r is { inicio: number; fin: number } =>
  typeof r === "object" && r !== null && Number.isFinite((r as { inicio: unknown }).inicio) && Number.isFinite((r as { fin: unknown }).fin) && (r as { inicio: number }).inicio >= 0 && (r as { fin: number }).fin > (r as { inicio: number }).inicio;

/** Quita los silencios de una frase: análisis local, sin coste. El recorte entra por `editar`. */
export function useQuitarSilencios() {
  const client = useClient();
  const [ocupadas, setOcupadas] = useState<ReadonlySet<string>>(new Set());
  const quitar = useCallback(
    async (fraseId: string) => {
      const id = useEditor.getState().proyecto?.id;
      if (!id) return;
      setOcupadas((s) => new Set(s).add(fraseId));
      try {
        const r = await client.videoVozQuitarSilencios(id, { frases: [fraseId], caracteres_confirmados: 0 });
        if (!esRecorte(r.recorte)) throw new Error("recorte inválido");
        const recorte = { inicio: r.recorte.inicio, fin: r.recorte.fin };
        editar((p) => {
          const f = p.frases.find((x) => x.id === fraseId);
          if (f) f.recorte = recorte;
        });
      } catch {
        toast({ title: "No se pudieron quitar los silencios", tone: "error" });
      } finally {
        setOcupadas((s) => {
          const n = new Set(s);
          n.delete(fraseId);
          return n;
        });
      }
    },
    [client],
  );
  return { ocupadas, quitar };
}
