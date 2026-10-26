/** Anthropic falso para los E2E: sirve `POST /v1/messages` en streaming con el mismo formato
 *  SSE que usa app-backend/tests/conftest.py. Sin estado: elige el guion por una marca en el
 *  último mensaje del usuario, y tras un tool_result responde con texto y end_turn. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** Marcador: se sustituye por la ruta de "Sube el vídeo <ruta> a YouTube" del último mensaje. */
const RUTA_PEDIDA = "<ruta pedida>";

export const GUIONES: Record<string, Block[]> = {
  "E2E-TEXTO": [{ type: "text", text: "Hola **Marc**, esto es un texto de prueba.\n\n- uno\n- dos" }],
  "E2E-RECHAZO": [
    { type: "text", text: "Voy a cambiar el título." },
    { type: "tool_use", id: "tu_e2e_1", name: "youtube_update_video", input: { video_id: "vid1", title: "Nuevo título" } },
  ],
  "E2E-MARKDOWN": [
    {
      type: "text",
      text: [
        "## Recomendaciones",
        "",
        "Resumen con **negrita**, *cursiva*, `código` y una fuente https://support.google.com/youtube/answer/1. Otra: [guía](https://www.tiktok.com/creators).",
        "",
        "| Acción | Impacto |",
        "| --- | ---: |",
        "| Gancho en los 2 primeros segundos | Alto |",
        "| Texto grande en la miniatura | Medio |",
        "",
        "> Una cita del informe.",
        "",
        "1. Primero",
        "2. Segundo",
        "",
        "```ts",
        "const titulo = 'demo';",
        "```",
        "",
        "<img src=x onerror=alert(1)>",
      ].join("\n"),
    },
  ],
  "E2E-SUBIR": [
    { type: "text", text: "Preparo la subida." },
    {
      type: "tool_use",
      id: "tu_e2e_3",
      name: "youtube_upload_video",
      input: {
        file_path: "demo cs finance",
        title: "CS Finance: controla tu inventario de skins en 60 segundos",
        description: "Te enseño cómo seguir el valor de tus skins de CS2 con CS Finance. ".repeat(4),
        tags: ["cs2", "skins", "cs finance"],
        privacy_status: "private",
        publish_at: null,
      },
    },
  ],
  // Como E2E-SUBIR, pero el agente sube el fichero que le pide el mensaje de Publicar.
  "E2E-FIEL": [
    {
      type: "tool_use",
      id: "tu_e2e_4",
      name: "youtube_upload_video",
      input: {
        file_path: RUTA_PEDIDA,
        title: "CS Finance: controla tu inventario de skins en 60 segundos",
        description: "Te enseño cómo seguir el valor de tus skins de CS2 con CS Finance. ".repeat(4),
        tags: ["cs2", "skins", "cs finance"],
        privacy_status: "private",
        publish_at: null,
      },
    },
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
  const ruta = typeof ultimo?.content === "string" ? ultimo.content.match(/Sube el vídeo (.+?) a YouTube/)?.[1] : undefined;
  for (const [marca, guion] of Object.entries(GUIONES)) {
    if (contenido.includes(marca)) {
      const bloques = guion.map((b) => (b.type === "tool_use" && b.input.file_path === RUTA_PEDIDA ? { ...b, input: { ...b.input, file_path: ruta } } : b));
      return [bloques, bloques.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"];
    }
  }
  return [[{ type: "text", text: "No entiendo la petición." }], "end_turn"];
}

/** Respuesta larga que llega en trozos espaciados, como un streaming real (SEO-105): 50 párrafos,
 *  uno cada 120 ms (~6 s), para probar el scroll mientras se genera. */
export const LENTO = { parrafos: 50, intervaloMs: 120 };
function lento(res: import("node:http").ServerResponse) {
  const evento = (e: { type: string }) => `event: ${e.type}
data: ${JSON.stringify(e)}

`;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write(evento({ type: "message_start", message: { id: "msg_lento", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } } as { type: string }));
  res.write(evento({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as { type: string }));
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    res.write(evento({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Párrafo ${n} de la respuesta larga: texto de relleno para que el hilo crezca mientras se genera.

` } } as { type: string }));
    if (n < LENTO.parrafos) return;
    clearInterval(timer);
    res.write(evento({ type: "content_block_stop", index: 0 } as { type: string }));
    res.write(evento({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } } as { type: string }));
    res.end(evento({ type: "message_stop" }));
  }, LENTO.intervaloMs);
  res.on("close", () => clearInterval(timer));
}

export function startAnthropicMock(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      // validación de la clave del onboarding: una clave que termina en "mala" no es válida
      if (String(req.headers["x-api-key"] ?? "").endsWith("mala")) {
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      const modelo = { id: "claude-opus-5-5", type: "model", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [modelo], has_more: false, first_id: modelo.id, last_id: modelo.id }));
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (JSON.stringify(body.messages.at(-1)?.content ?? "").includes("E2E-LENTO")) return lento(res);
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
