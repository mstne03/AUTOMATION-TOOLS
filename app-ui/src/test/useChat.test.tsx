import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../api/client";
import { ClientContext } from "../api/context";
import type { ChatEvent } from "../api/types";
import { useChat } from "../chat/useChat";
import type { BloqueTool } from "../chat/turno";
import { nueva, reiniciarConversaciones, tituloDe, useConversaciones } from "../state/conversations";
import { reiniciarJobs } from "../state/jobs";
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
  return renderHook(() => useChat("chat:1"), {
    wrapper: ({ children }) => <ClientContext.Provider value={client}>{children}</ClientContext.Provider>,
  });
}

describe("useChat", () => {
  beforeEach(() => {
    reiniciarConversaciones();
    reiniciarJobs();
  });


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

  it("la conversación y su aprobación pendiente sobreviven a desmontar la pantalla (UI-01)", async () => {
    const { client, resolveApproval } = clienteFalso(fx.publicacionRechazada);
    const primera = montar(client);
    act(() => void primera.result.current.enviar("sube el vídeo de prueba por favor"));
    await waitFor(() => {
      const t = primera.result.current.mensajes[1];
      expect(t.role === "assistant" && (t.turno.bloques[1] as BloqueTool)?.approval?.status).toBe("pending");
    });
    primera.unmount(); // el usuario se va a Ajustes

    const segunda = montar(client); // y vuelve
    expect(segunda.result.current.enStream).toBe(true);
    expect(segunda.result.current.titulo).toBe("sube el vídeo de prueba por");
    const tool = (segunda.result.current.mensajes[1] as { turno: { bloques: BloqueTool[] } }).turno.bloques[1];
    expect(tool.approval?.status).toBe("pending");
    await act(() => segunda.result.current.resolver(tool.approval!, "reject"));
    expect(resolveApproval).toHaveBeenCalled();
    await waitFor(() => expect(segunda.result.current.enStream).toBe(false));
  });

  it("Chat y Publicar usan conversaciones distintas", async () => {
    const { client } = clienteFalso([fx.publicacionRechazada[fx.publicacionRechazada.length - 1]]);
    const chat = montar(client);
    const publicar = renderHook(() => useChat("publicar"), {
      wrapper: ({ children }) => <ClientContext.Provider value={client}>{children}</ClientContext.Provider>,
    });
    await act(() => chat.result.current.enviar("hola"));
    expect(chat.result.current.mensajes).toHaveLength(2);
    expect(publicar.result.current.mensajes).toHaveLength(0);
  });

  it("con 'Usar KB' apagado el agente recibe la indicación, pero el mensaje visible no cambia", async () => {
    const mensajes: string[] = [];
    const client = {
      async *chat(req: { message: string }) {
        mensajes.push(req.message);
        yield fx.errorApi[0];
      },
    } as unknown as Client;
    const { result } = montar(client);
    await act(() => result.current.enviar("hola", { sinKb: true }));
    expect(mensajes[0]).toContain("hola");
    expect(mensajes[0]).toContain("no uses las herramientas de la base de conocimiento");
    expect(result.current.mensajes[0]).toEqual({ role: "user", text: "hola" });
    await act(() => result.current.enviar("otra"));
    expect(mensajes[1]).toBe("otra");
  });

  it("si el stream se corta sin done ni error, el turno acaba en error y la aprobación pendiente se cancela", async () => {
    const client = {
      async *chat() {
        yield* fx.publicacionRechazada.slice(0, 4); // hasta approval_required, y el sidecar desaparece
      },
    } as unknown as Client;
    const { result } = montar(client);
    await act(() => result.current.enviar("sube el vídeo"));
    const t = result.current.mensajes[1];
    expect(t.role === "assistant" && t.turno.estado).toBe("error");
    expect(t.role === "assistant" && t.turno.error).toContain("se cortó");
    expect(t.role === "assistant" && (t.turno.bloques[1] as BloqueTool).approval?.status).toBe("cancelled");
    expect(result.current.enStream).toBe(false);
  });

  it("nueva() crea otra conversación y la deja activa", () => {
    expect(useConversaciones.getState().activa).toBe("chat:1");
    const id = nueva();
    expect(id).toBe("chat:2");
    expect(useConversaciones.getState().orden).toEqual(["chat:1", "chat:2"]);
    expect(useConversaciones.getState().activa).toBe("chat:2");
    expect(tituloDe("una frase muy larga con muchas palabras para recortar el título del todo")).toBe("una frase muy larga con muchas");
  });
});
