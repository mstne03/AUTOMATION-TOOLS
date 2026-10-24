/** Chats guardados en el sidecar (SEO-100): carga, reproducción, borrado y filtro por perfil. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Client } from "../api/client";
import type { ConversacionDetalle } from "../api/types";
import { abrir, alCambiarDePerfil, borrar, cargarLista, delPerfil, nueva, reiniciarConversaciones, reproducir, useConversaciones } from "../state/conversations";
import * as fx from "./fixtures";

const RESUMEN = (id: string, perfil: string | null, titulo = `chat ${id}`) => ({ id, titulo, perfil, creada: 1, actualizada: 1 });

function cliente(over: Partial<Client> = {}) {
  return {
    listConversations: vi.fn(async () => [RESUMEN("aaaaaa", "default"), RESUMEN("bbbbbb", "otro")]),
    getConversation: vi.fn(async (id: string): Promise<ConversacionDetalle> => ({ ...RESUMEN(id, "default"), turnos: [{ texto: "hola", eventos: [{ type: "text", delta: "¡Hola!" }, { type: "done", conversation_id: id, stop_reason: "end_turn", usage: null }] }] })),
    deleteConversation: vi.fn(async (id: string) => ({ borrada: id })),
    ...over,
  } as unknown as Client;
}

const estado = () => useConversaciones.getState();

describe("conversaciones guardadas", () => {
  beforeEach(() => reiniciarConversaciones());

  it("reproduce los eventos guardados con el mismo reducer; un turno cortado acaba en error y sin propuestas pendientes", () => {
    const mensajes = reproducir([
      { texto: "hola", eventos: [{ type: "text", delta: "¡Ho" }, { type: "text", delta: "la!" }, { type: "done", conversation_id: "c", stop_reason: "end_turn", usage: fx.usage }] },
      { texto: "sube el vídeo", eventos: fx.publicacionRechazada.slice(0, 4) }, // hasta approval_required, y la app se cerró
    ]);
    expect(mensajes.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const [, primero, , segundo] = mensajes;
    if (primero.role !== "assistant" || segundo.role !== "assistant") throw new Error("esperaba turnos");
    expect(primero.turno.estado).toBe("done");
    expect(primero.turno.bloques).toEqual([{ kind: "text", text: "¡Hola!" }]);
    expect(segundo.turno.estado).toBe("error");
    expect(segundo.turno.error).toContain("se interrumpió");
    const tool = segundo.turno.bloques.find((b) => b.kind === "tool");
    expect(tool?.kind === "tool" && tool.approval?.status).toBe("cancelled");
  });

  it("al arrancar carga la lista (delante de las de esta sesión) y el contenido al abrir cada chat", async () => {
    const client = cliente();
    await cargarLista(client);
    await cargarLista(client); // no duplica
    expect(estado().orden).toEqual(["chat:aaaaaa", "chat:bbbbbb", "chat:1"]);
    expect(estado().activa).toBe("chat:1");
    expect(estado().conversaciones["chat:aaaaaa"]).toMatchObject({ titulo: "chat aaaaaa", perfil: "default", conversationId: "aaaaaa", pendiente: true, mensajes: [] });

    await abrir(client, "chat:aaaaaa");
    await abrir(client, "chat:aaaaaa"); // ya descargada: no vuelve a pedirla
    expect(client.getConversation).toHaveBeenCalledTimes(1);
    expect(estado().conversaciones["chat:aaaaaa"].pendiente).toBe(false);
    expect(estado().conversaciones["chat:aaaaaa"].mensajes[0]).toEqual({ role: "user", text: "hola" });
  });

  it("una conversación borrada desde otro sitio desaparece al intentar abrirla", async () => {
    const client = cliente({ getConversation: vi.fn(async () => Promise.reject(new ApiError(404, "Conversación no encontrada."))) });
    await cargarLista(client);
    await expect(abrir(client, "chat:aaaaaa")).rejects.toThrow("no encontrada");
    expect(estado().orden).not.toContain("chat:aaaaaa");
  });

  it("solo se ven los chats del perfil activo; al cambiar de perfil, el abierto pasa a uno de ese perfil", async () => {
    const client = cliente();
    await cargarLista(client);
    expect(delPerfil(estado(), "default")).toEqual(["chat:aaaaaa", "chat:1"]); // chat:1 aún sin perfil
    expect(delPerfil(estado(), "otro")).toEqual(["chat:bbbbbb", "chat:1"]);

    useConversaciones.setState({ activa: "chat:aaaaaa" });
    alCambiarDePerfil("otro");
    expect(estado().activa).toBe("chat:1"); // la última visible con "otro"
    useConversaciones.setState({ activa: "chat:bbbbbb" });
    alCambiarDePerfil("tercero");
    expect(estado().activa).toBe("chat:1");
    useConversaciones.setState({ activa: "chat:bbbbbb" });
    alCambiarDePerfil("otro"); // ya es suyo: no cambia
    expect(estado().activa).toBe("chat:bbbbbb");
  });

  it("borrar quita el chat del sidecar y de la lista; si era el abierto, abre otro del mismo perfil", async () => {
    const client = cliente();
    await cargarLista(client);
    useConversaciones.setState({ activa: "chat:aaaaaa" });
    await borrar(client, "chat:aaaaaa");
    expect(client.deleteConversation).toHaveBeenCalledWith("aaaaaa");
    expect(estado().orden).toEqual(["chat:bbbbbb", "chat:1"]);
    expect(estado().activa).toBe("chat:1");

    // Un chat que nunca se envió solo existe aquí; si era el último del perfil, queda uno vacío.
    await borrar(client, "chat:1");
    expect(client.deleteConversation).toHaveBeenCalledTimes(1);
    expect(estado().activa).toBe("chat:bbbbbb");
    await borrar(client, "chat:bbbbbb");
    expect(estado().orden).toEqual(["chat:2"]);
    expect(estado().conversaciones["chat:2"]).toMatchObject({ perfil: "otro", mensajes: [] });
  });

  it("si el sidecar no puede borrarlo, el chat se queda", async () => {
    const client = cliente({ deleteConversation: vi.fn(async () => Promise.reject(new ApiError(409, "La conversación tiene una respuesta en curso."))) });
    await cargarLista(client);
    await expect(borrar(client, "chat:aaaaaa")).rejects.toThrow("en curso");
    expect(estado().orden).toContain("chat:aaaaaa");
  });

  it("nueva(perfil) crea el chat ya asociado a ese perfil", () => {
    const id = nueva("default");
    expect(estado().conversaciones[id].perfil).toBe("default");
  });
});
