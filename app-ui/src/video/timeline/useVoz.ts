/** Voz del proyecto: forma de onda, coste pendiente y el flujo de gasto (I10).
 *  Contrato: `docs/video-fase1/contrato-voz.md`. Nada de aquí gasta sin que la persona confirme en
 *  `voz-confirmar` lo que dio el servidor (cifra y `plan`); la UI no calcula el coste en ningún caso.
 *  Editar texto, reordenar o recortar nunca llama a la voz. */
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { useClient } from "../../api/context";
import type { CosteVoz } from "../../api/types";
import { cargar, fijarTiempo, guardar, seleccionar, useEditor } from "../../state/editor";
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
  voz: { id: string; nombre: string };
  /** Huella del contenido que vio la persona: se devuelve tal cual al confirmar. */
  plan: string;
  fallidasFacturadas: string[];
  caracteresRefacturados: number;
  /** La persona marcó de forma explícita volver a pagar frases ya cobradas. */
  reintentar: boolean;
  /** El servidor cambió lo que se iba a generar entre mostrarlo y confirmarlo. */
  cambio: boolean;
}

/** Código del contrato (`detail: { mensaje, codigo }`). Nunca se mira el texto del mensaje. */
const codigoDe = (e: unknown) => (e instanceof ApiError ? e.codigo : undefined);

/** La respuesta del servidor es entrada: se valida la forma antes de pintarla o devolverla. */
function costeValido(c: CosteVoz): boolean {
  return (
    !!c &&
    typeof c.plan === "string" &&
    c.plan.length > 0 &&
    Number.isFinite(c.caracteres) &&
    c.caracteres >= 0 &&
    Number.isFinite(c.caracteresRefacturados) &&
    c.caracteresRefacturados >= 0 &&
    Array.isArray(c.fallidasFacturadas) &&
    c.fallidasFacturadas.every((f) => typeof f === "string") &&
    !!c.voz &&
    typeof c.voz.id === "string" &&
    typeof c.voz.nombre === "string"
  );
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
async function asegurarGuardado(): Promise<boolean> {
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

export function useGastoVoz() {
  const client = useClient();
  const qc = useQueryClient();
  const [gasto, setGasto] = useState<Gasto | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [sinClave, setSinClave] = useState(false);
  const ocupado = useRef(false);
  /** Solo vale la última petición de coste: una respuesta vieja no pisa el diálogo. */
  const peticion = useRef(0);

  const leerCoste = useCallback(
    async (frases: string[] | undefined, cambio: boolean) => {
      const id = useEditor.getState().proyecto?.id;
      if (!id) return false;
      const mia = ++peticion.current;
      try {
        const c = await client.videoVozCoste(id, frases);
        if (mia !== peticion.current) return false;
        if (!costeValido(c)) throw new Error("coste inválido");
        setGasto({
          frases,
          caracteres: c.caracteres,
          voz: { id: c.voz.id, nombre: c.voz.nombre },
          plan: c.plan,
          fallidasFacturadas: c.fallidasFacturadas,
          caracteresRefacturados: c.caracteresRefacturados,
          reintentar: false,
          cambio,
        });
        return true;
      } catch {
        if (mia !== peticion.current) return false;
        setGasto(null);
        toast({ title: "No se pudo calcular el coste de la voz", description: "Inténtalo de nuevo.", tone: "error" });
        return false;
      }
    },
    [client],
  );

  /** Abre el diálogo con el coste y el plan que da el servidor ahora; no genera nada. */
  const pedir = useCallback(
    async (frases?: string[]) => {
      setSinClave(false);
      if (!(await asegurarGuardado())) {
        toast({ title: "Guarda los cambios antes de generar la voz", description: "El coste se calcula sobre lo que hay guardado.", tone: "warning" });
        return;
      }
      await leerCoste(frases, false);
    },
    [leerCoste],
  );

  const cerrar = useCallback(() => {
    peticion.current++;
    setGasto(null);
  }, []);

  const marcarReintento = useCallback((reintentar: boolean) => setGasto((g) => (g ? { ...g, reintentar } : g)), []);

  const confirmar = useCallback(async () => {
    const id = useEditor.getState().proyecto?.id;
    if (!gasto || !id || ocupado.current || useEditor.getState().conflicto) return;
    if (gasto.fallidasFacturadas.length > 0 && !gasto.reintentar) return;
    ocupado.current = true;
    setEnviando(true);
    try {
      const cuerpo = {
        plan_confirmado: gasto.plan,
        caracteres_confirmados: gasto.caracteres,
        reintentar_facturadas: gasto.reintentar,
        ...(gasto.frases ? { frases: gasto.frases } : {}),
      };
      const r = await client.videoVozGenerar(id, cuerpo);
      setGasto(null);
      await qc.invalidateQueries({ queryKey: ["video", "voz", id] });
      const fallo = r && typeof r === "object" && "fallo" in r ? (r.fallo as { facturada?: unknown } | undefined) : undefined;
      if (fallo) {
        toast({
          title: "La voz quedó incompleta",
          description:
            fallo.facturada === true
              ? "ElevenLabs cobró una frase que no se pudo usar: volver a generarla se cobrará de nuevo. Lo demás se conserva."
              : "Lo generado se conserva; reintentar solo factura lo que falta.",
          tone: "warning",
        });
      } else {
        toast({ title: "Voz generada" });
      }
    } catch (e) {
      const codigo = codigoDe(e);
      if (codigo === "coste_cambiado" || codigo === "reintento_facturado") {
        // No se reintenta solo: se vuelve a pedir confirmación con lo que ve ahora el servidor.
        await leerCoste(gasto.frases, true);
      } else if (codigo === "sin_clave") {
        setGasto(null);
        setSinClave(true);
      } else if (codigo === "conflicto") {
        setGasto(null);
        // La versión del servidor no es la que se vio: se reenvía el guardado y el editor abre su aviso de conflicto.
        await guardar();
        if (!useEditor.getState().conflicto) {
          toast({
            title: "Ya se está generando la voz de este proyecto (o ha cambiado en otro sitio)",
            description: "No se ha cobrado nada de esta petición. Espera a que termine y vuelve a intentarlo.",
            tone: "warning",
          });
        }
      } else if (codigo === "no_disponible") {
        setGasto(null);
        toast({ title: "La voz no está disponible ahora", description: "Falta un componente del motor de vídeo. Inténtalo más tarde.", tone: "error" });
      } else {
        setGasto(null);
        toast({ title: "No se pudo generar la voz", description: "Revisa tu conexión y tu cuenta de ElevenLabs e inténtalo de nuevo.", tone: "error" });
      }
    } finally {
      ocupado.current = false;
      setEnviando(false);
    }
  }, [client, gasto, leerCoste, qc]);

  return { gasto, enviando, sinClave, pedir, confirmar, cerrar, marcarReintento };
}

const esRecorte = (r: unknown): r is { inicio: number; fin: number } =>
  typeof r === "object" && r !== null && Number.isFinite((r as { inicio: unknown }).inicio) && Number.isFinite((r as { fin: unknown }).fin) && (r as { inicio: number }).inicio >= 0 && (r as { fin: number }).fin > (r as { inicio: number }).inicio;

/** Quita los silencios de una frase: sin coste. El motor guarda el proyecto y sube la revisión, así que
 *  después se recarga del servidor; nunca se aplica el recorte con `editar()` sobre la revisión vieja. */
export function useQuitarSilencios() {
  const client = useClient();
  const [ocupadas, setOcupadas] = useState<ReadonlySet<string>>(new Set());
  const quitar = useCallback(
    async (fraseId: string) => {
      const id = useEditor.getState().proyecto?.id;
      if (!id) return;
      setOcupadas((s) => new Set(s).add(fraseId));
      try {
        // El motor guarda con la revisión que ve en disco: antes, lo pendiente del editor.
        if (!(await asegurarGuardado())) {
          toast({ title: "Guarda los cambios antes de quitar silencios", tone: "warning" });
          return;
        }
        const r = await client.videoVozQuitarSilencios(id, { frase_id: fraseId });
        if (!esRecorte(r.recorte)) throw new Error("recorte inválido");
        const st = useEditor.getState();
        if (st.proyecto?.id !== id) return;
        if (st.conflicto) return;
        if (st.guardado !== "guardado") {
          // Se editó mientras tanto: el guardado con la revisión vieja abrirá el aviso de conflicto del editor.
          await guardar();
          return;
        }
        const remoto = await client.videoProyecto(id);
        if (!remoto || remoto.id !== id) throw new Error("proyecto inválido");
        const { tiempo, seleccion } = useEditor.getState();
        cargar(remoto);
        fijarTiempo(tiempo);
        seleccionar(seleccion);
      } catch (e) {
        const codigo = codigoDe(e);
        if (codigo === "conflicto") {
          await guardar();
          if (!useEditor.getState().conflicto) toast({ title: "El proyecto ha cambiado", description: "Vuelve a intentarlo.", tone: "warning" });
        } else if (codigo === "no_disponible") {
          toast({ title: "La voz no está disponible ahora", tone: "error" });
        } else {
          toast({ title: "No se pudieron quitar los silencios", tone: "error" });
        }
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
