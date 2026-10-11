import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient } from "../api/client";
import { parseSse } from "../api/sse";
import * as fx from "./fixtures";

describe("parseSse", () => {
  it("reconstruye eventos aunque los trozos corten líneas y haya CRLF", async () => {
    const out = [];
    for await (const m of parseSse(fx.streamDe(fx.aSse(fx.publicacionRechazada), 5))) out.push(m);
    expect(out).toHaveLength(fx.publicacionRechazada.length);
    expect(out[0].event).toBe("text");
    expect(JSON.parse(out[7].data).type).toBe("done");
  });

  it("ignora comentarios y une data multilínea", async () => {
    const out = [];
    for await (const m of parseSse(fx.streamDe(": ping\n\nevent: x\ndata: a\ndata: b\n\n"))) out.push(m);
    expect(out).toEqual([{ event: "x", data: "a\nb" }]);
  });
});

describe("createClient", () => {
  const fetchMock = vi.fn() as unknown as ReturnType<typeof vi.fn> & typeof fetch;
  const client = createClient(5000, "tok", fetchMock);

  it("manda el token a 127.0.0.1 y tipa la respuesta", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ model: "claude-opus-5-5" })));
    const s = await client.getSettings();
    expect(s.model).toBe("claude-opus-5-5");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:5000/settings");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("convierte errores HTTP en ApiError con el detail del sidecar", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Token invalido o ausente." }), { status: 401 }),
    );
    await expect(client.getSettings()).rejects.toMatchObject({
      status: 401,
      detail: "Token invalido o ausente.",
    });
  });

  it("chat: itera los eventos del stream SSE", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(fx.streamDe(fx.aSse(fx.publicacionAprobada)), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const tipos = [];
    for await (const ev of client.chat({ message: "sube el vídeo" })) tipos.push(ev.type);
    expect(tipos).toEqual(fx.publicacionAprobada.map((e) => e.type));
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(init!.body as string)).toEqual({ message: "sube el vídeo" });
  });

  it("chat: 409 (turno en curso) sale como ApiError antes de leer el stream", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Esta conversacion ya tiene un turno en curso." }), { status: 409 }),
    );
    const it = client.chat({ message: "x" });
    await expect(it.next()).rejects.toBeInstanceOf(ApiError);
  });

  it("resolveApproval envía decision y confirm_id", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...fx.approvalDelete, status: "approved" })));
    const r = await client.resolveApproval("ap_del", "approve", "abc123XYZ");
    expect(r.status).toBe("approved");
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("http://127.0.0.1:5000/approvals/ap_del");
    expect(JSON.parse(init!.body as string)).toEqual({ decision: "approve", confirm_id: "abc123XYZ" });
  });

  it("kbBuscar codifica los parámetros y omite los vacíos", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ texto: "..." })));
    await client.kbBuscar("hashtags tiktok", undefined, 5);
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("http://127.0.0.1:5000/kb/buscar?q=hashtags+tiktok&k=5");
  });
});
