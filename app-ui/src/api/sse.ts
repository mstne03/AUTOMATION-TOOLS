/** Parser SSE sobre fetch: EventSource no admite cabecera Authorization, así que leemos
 *  el cuerpo como stream y troceamos por líneas en blanco (spec de text/event-stream). */

export interface SseMessage {
  event: string;
  data: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const bloque = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const msg = parseBloque(bloque);
        if (msg) yield msg;
      }
    }
    const resto = parseBloque(buffer);
    if (resto) yield resto;
  } finally {
    reader.releaseLock();
  }
}

function parseBloque(bloque: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const linea of bloque.split("\n")) {
    if (!linea || linea.startsWith(":")) continue;
    const sep = linea.indexOf(":");
    const campo = sep === -1 ? linea : linea.slice(0, sep);
    const valor = sep === -1 ? "" : linea.slice(sep + 1).replace(/^ /, "");
    if (campo === "event") event = valor;
    else if (campo === "data") data.push(valor);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}
