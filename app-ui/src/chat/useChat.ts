/** Estado de una conversación: mensajes del usuario y turnos del agente reconstruidos
 *  desde el stream SSE. Un turno a la vez (el sidecar responde 409 si hay otro). */
import { useCallback, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { useClient } from "../api/context";
import type { Approval } from "../api/types";
import { reduceTurno, turnoVacio, type Turno } from "./turno";

export type Mensaje = { role: "user"; text: string } | { role: "assistant"; turno: Turno };

export function useChat() {
  const client = useClient();
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [enStream, setEnStream] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const actualizarTurno = useCallback((fn: (t: Turno) => Turno) => {
    setMensajes((prev) => {
      const ultimo = prev[prev.length - 1];
      if (ultimo?.role !== "assistant") return prev;
      return [...prev.slice(0, -1), { role: "assistant", turno: fn(ultimo.turno) }];
    });
  }, []);

  /** El SSE solo trae job_started y job_finished; el progreso se consulta por GET /jobs/{id}. */
  const sondearJob = useCallback(
    async (jobId: string) => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        let job;
        try {
          job = await client.getJob(jobId);
        } catch {
          return; // el job_finished del stream cerrará el bloque igualmente
        }
        if (job.status === "done" || job.status === "failed") return;
        actualizarTurno((t) => reduceTurno(t, { type: "job_finished", job }));
      }
    },
    [client, actualizarTurno],
  );

  const enviar = useCallback(
    async (texto: string) => {
      if (enStream || !texto.trim()) return;
      setEnStream(true);
      setMensajes((prev) => [...prev, { role: "user", text: texto }, { role: "assistant", turno: turnoVacio() }]);
      abort.current = new AbortController();
      try {
        for await (const ev of client.chat(
          { message: texto, conversation_id: conversationId },
          abort.current.signal,
        )) {
          if (ev.type === "done") setConversationId(ev.conversation_id);
          actualizarTurno((t) => reduceTurno(t, ev));
          if (ev.type === "job_started") void sondearJob(ev.job.id);
        }
      } catch (e) {
        const msg = e instanceof ApiError ? e.detail : (e as Error).message;
        actualizarTurno((t) => reduceTurno(t, { type: "error", message: msg }));
      } finally {
        setEnStream(false);
        abort.current = null;
      }
    },
    [client, conversationId, enStream, actualizarTurno, sondearJob],
  );

  const resolver = useCallback(
    async (approval: Approval, decision: "approve" | "reject", confirmId?: string) => {
      const res = await client.resolveApproval(approval.id, decision, confirmId);
      actualizarTurno((t) => reduceTurno(t, { type: "approval_resolved", approval: res }));
      return res;
    },
    [client, actualizarTurno],
  );

  const cancelar = useCallback(() => abort.current?.abort(), []);

  return { mensajes, conversationId, enStream, enviar, resolver, cancelar };
}
