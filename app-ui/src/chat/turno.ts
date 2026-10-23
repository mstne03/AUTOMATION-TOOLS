/** Reconstrucción de un turno del agente a partir de los eventos SSE de POST /chat.
 *  Reducer puro (sin React) para poder probarlo con secuencias grabadas. */
import type { Approval, ChatEvent, Job, Usage } from "../api/types";

export interface BloqueTexto {
  kind: "text";
  text: string;
}

export interface BloqueTool {
  kind: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  approval?: Approval;
  job?: Job;
  result?: { is_error: boolean; content: string };
}

export type Bloque = BloqueTexto | BloqueTool;

export interface Turno {
  bloques: Bloque[];
  estado: "streaming" | "done" | "error";
  conversation_id?: string;
  stop_reason?: string | null;
  usage?: Usage | null;
  error?: string;
}

export const turnoVacio = (): Turno => ({ bloques: [], estado: "streaming" });

/** Primera tool sin resultado que cumpla `pred`. Las propuestas y jobs no traen tool_use_id;
 *  el sidecar ejecuta las llamadas en el orden de sus bloques, así que la propuesta más antigua
 *  corresponde a la llamada pendiente más antigua del mismo nombre. */
function toolPendiente(bloques: Bloque[], pred: (b: BloqueTool) => boolean): number {
  return bloques.findIndex((b) => b.kind === "tool" && !b.result && pred(b));
}

function conTool(turno: Turno, idx: number, patch: Partial<BloqueTool>): Turno {
  if (idx === -1) return turno;
  const bloques = turno.bloques.slice();
  bloques[idx] = { ...(bloques[idx] as BloqueTool), ...patch };
  return { ...turno, bloques };
}

export function reduceTurno(turno: Turno, ev: ChatEvent): Turno {
  switch (ev.type) {
    case "text": {
      const bloques = turno.bloques.slice();
      const ultimo = bloques[bloques.length - 1];
      if (ultimo?.kind === "text") {
        bloques[bloques.length - 1] = { kind: "text", text: ultimo.text + ev.delta };
      } else {
        bloques.push({ kind: "text", text: ev.delta });
      }
      return { ...turno, bloques };
    }
    case "tool_use":
      return {
        ...turno,
        bloques: [...turno.bloques, { kind: "tool", id: ev.id, name: ev.name, input: ev.input }],
      };
    case "tool_result": {
      const idx = turno.bloques.findIndex((b) => b.kind === "tool" && b.id === ev.tool_use_id);
      return conTool(turno, idx, { result: { is_error: ev.is_error, content: ev.content } });
    }
    case "approval_required":
      return conTool(
        turno,
        toolPendiente(turno.bloques, (b) => b.name === ev.approval.tool && !b.approval),
        { approval: ev.approval },
      );
    case "approval_resolved":
      return conTool(
        turno,
        turno.bloques.findIndex((b) => b.kind === "tool" && b.approval?.id === ev.approval.id),
        { approval: ev.approval },
      );
    case "job_started":
      return conTool(
        turno,
        toolPendiente(turno.bloques, (b) => !b.job && (!b.approval || b.approval.status === "approved")),
        { job: ev.job },
      );
    case "job_finished":
      return conTool(
        turno,
        turno.bloques.findIndex((b) => b.kind === "tool" && b.job?.id === ev.job.id),
        { job: ev.job },
      );
    case "done":
      return {
        ...turno,
        estado: "done",
        conversation_id: ev.conversation_id,
        stop_reason: ev.stop_reason,
        usage: ev.usage,
      };
    case "error":
      return { ...turno, estado: "error", error: ev.message };
  }
}

/** Ruta real resuelta por la lista blanca (viene en el resultado, no en lo que pidió el modelo). */
export function rutaResuelta(b: BloqueTool): string | undefined {
  const f = b.job?.result?.file;
  if (typeof f === "string") return f;
  if (b.result && !b.result.is_error) {
    try {
      const j = JSON.parse(b.result.content) as { file?: unknown };
      if (typeof j.file === "string") return j.file;
    } catch {
      /* el resultado no es JSON */
    }
  }
  return undefined;
}

/** Precios de lista en $/Mtok (entrada, salida, lectura de caché) por familia de modelo.
 *  Única tabla de la UI: se corrige aquí cuando cambien los precios. Escritura de caché = 1,25 × entrada. */
export const PRECIOS_MODELO = {
  opus: { entrada: 4, salida: 20, cache: 0.2 },
  sonnet: { entrada: 2, salida: 10, cache: 0.2 },
} as const;

/** Aproximación para el indicador de coste; cualquier modelo que no sea Opus se tarifa como Sonnet. */
export function costeUsd(model: string, u: Usage | null | undefined): number {
  if (!u) return 0;
  const p = model.includes("opus") ? PRECIOS_MODELO.opus : PRECIOS_MODELO.sonnet;
  return (
    ((u.input_tokens ?? 0) * p.entrada +
      (u.output_tokens ?? 0) * p.salida +
      (u.cache_read_input_tokens ?? 0) * p.cache +
      (u.cache_creation_input_tokens ?? 0) * p.entrada * 1.25) /
    1_000_000
  );
}
