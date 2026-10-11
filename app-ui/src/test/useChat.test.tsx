import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../api/client";
import { ClientContext } from "../api/context";
import type { ChatEvent } from "../api/types";
import { useChat } from "../chat/useChat";
import type { BloqueTool } from "../chat/turno";
import * as fx from "./fixtures";

/** Cliente simulado: `chat` emite los eventos uno a uno y se detiene en approval_required
 *  hasta que la UI resuelve, como hace el sidecar real. */
function clienteFalso(eventos: ChatEvent[]) {
  let liberar: (() => void) | null = null;
  const resolveApproval = vi.fn(async (id: string, decision: "approve" | "reject", confirmId?: string) => {
    liberar?.();
    return { ...fx.approvalUpload, id, status: decision === "approve" ? "approved" : "rejected", confirmId } as never;
  });
  const client = {
    resolveApproval,
    async *chat() {
      for (const ev of eventos) {
        yield ev;
        if (ev.type === "approval_required") {
          await new Promise<void>((r) => (liberar = r));
        }
      }
    },
  } as unknown as Client;
  return { client, resolveApproval };
}

function montar(client: Client) {
  return renderHook(() => useChat(), {
    wrapper: ({ children }) => <ClientContext.Provider value={client}>{children}</ClientContext.Provider>,
  });
}

describe("useChat", () => {
  it("añade mensaje de usuario y turno; se bloquea en la propuesta hasta resolverla", async () => {
    const { client, resolveApproval } = clienteFalso(fx.publicacionRechazada);
    const { result } = montar(client);

    act(() => void result.current.enviar("sube el vídeo"));
    await waitFor(() => {
      const t = result.current.mensajes[1];
      expect(t.role === "assistant" && (t.turno.bloques[1] as BloqueTool)?.approval?.status).toBe("pending");
    });
    expect(result.current.enStream).toBe(true);
    expect(result.current.mensajes[0]).toEqual({ role: "user", text: "sube el vídeo" });

    const tool = (result.current.mensajes[1] as { turno: { bloques: BloqueTool[] } }).turno.bloques[1];
    await act(() => result.current.resolver(tool.approval!, "reject"));
    expect(resolveApproval).toHaveBeenCalledWith("ap_upload", "reject", undefined);

    await waitFor(() => expect(result.current.enStream).toBe(false));
    const turno = (result.current.mensajes[1] as { turno: { bloques: BloqueTool[]; estado: string } }).turno;
    expect(turno.estado).toBe("done");
    expect(turno.bloques[1].approval?.status).toBe("rejected");
    expect(result.current.conversationId).toBe("conv_1");
  });

  it("un error del stream cierra el turno como error sin tirar el hook", async () => {
    const client = {
      async *chat() {
        yield fx.errorApi[0];
        throw new Error("network down");
      },
    } as unknown as Client;
    const { result } = montar(client);
    await act(() => result.current.enviar("hola"));
    const turno = (result.current.mensajes[1] as { turno: { estado: string; error?: string } }).turno;
    expect(turno.estado).toBe("error");
    expect(turno.error).toBe("network down");
    expect(result.current.enStream).toBe(false);
  });
});
