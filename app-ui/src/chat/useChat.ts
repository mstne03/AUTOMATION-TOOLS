/** Enlace de una pantalla con una conversación del store (state/conversations.ts). */
import { useCallback } from "react";
import { useClient } from "../api/context";
import type { Approval } from "../api/types";
import * as store from "../state/conversations";

export type { Mensaje } from "../state/conversations";

export function useChat(id: string) {
  const client = useClient();
  const c = store.useConversaciones(store.seleccionarConversacion(id));
  const enviar = useCallback((texto: string, opciones?: store.OpcionesEnvio) => store.enviar(client, id, texto, opciones), [client, id]);
  const resolver = useCallback(
    (approval: Approval, decision: "approve" | "reject", confirmId?: string) =>
      store.resolver(client, id, approval, decision, confirmId),
    [client, id],
  );
  const cancelar = useCallback(() => store.cancelar(id), [id]);
  return { mensajes: c.mensajes, conversationId: c.conversationId, enStream: c.enStream, titulo: c.titulo, pendiente: !!c.pendiente, enviar, resolver, cancelar };
}
