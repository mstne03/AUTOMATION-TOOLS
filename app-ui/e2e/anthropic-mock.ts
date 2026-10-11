/** Anthropic falso para los E2E: sirve `POST /v1/messages` en streaming con el mismo formato
 *  SSE que usa app-backend/tests/conftest.py. Sin estado: elige el guion por una marca en el
 *  último mensaje del usuario, y tras un tool_result responde con texto y end_turn. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export const GUIONES: Record<string, Block[]> = {
  "E2E-TEXTO": [{ type: "text", text: "Hola **Marc**, esto es un texto de prueba.\n\n- uno\n- dos" }],
  "E2E-RECHAZO": [
    { type: "text", text: "Voy a cambiar el título." },
    { type: "tool_use", id: "tu_e2e_1", name: "youtube_update_video", input: { video_id: "vid1", title: "Nuevo título" } },
  ],
  "E2E-BORRAR": [
    { type: "tool_use", id: "tu_e2e_2", name: "youtube_delete_video", input: { video_id: "vid9" } },
  ],
};

function sse(blocks: Block[], stopReason: string): string {
  const events: unknown[] = [
    {
      type: "message_start",
      message: {
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 13861 },
      },
    },
  ];
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      events.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      events.push({
        type: "content_block_start",
        index: i,
        content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
      });
    }
    events.push({ type: "content_block_stop", index: i });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  events.push({ type: "message_stop" });
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function elegir(body: { messages: { role: string; content: unknown }[] }): [Block[], string] {
  const ultimo = body.messages[body.messages.length - 1];
  const contenido = JSON.stringify(ultimo?.content ?? "");
  if (contenido.includes('"tool_result"')) {
    const rechazado = contenido.includes("ha rechazado");
    return [[{ type: "text", text: rechazado ? "Vale, no lo hago." : "Hecho." }], "end_turn"];
  }
  for (const [marca, bloques] of Object.entries(GUIONES)) {
    if (contenido.includes(marca)) {
      return [bloques, bloques.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"];
    }
  }
  return [[{ type: "text", text: "No entiendo la petición." }], "end_turn"];
}

export function startAnthropicMock(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const [blocks, stop] = elegir(body);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.end(sse(blocks, stop));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}
