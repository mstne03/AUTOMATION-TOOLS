import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient } from "../api/client";
import { parseSse } from "../api/sse";
import modeloSrc from "../video/modelo.ts?raw";
import clienteSrc from "../api/client.ts?raw";
import tiposSrc from "../api/types.ts?raw";
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

  it("navegador del render: GET con token, POST de descarga y 409 con el detail del sidecar", async () => {
    const estado = { version: "1", tamano: 10, estado: "ausente", descargado: 0, error: null };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(estado)));
    expect(await client.videoNavegador()).toEqual(estado);
    let [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("http://127.0.0.1:5000/video/navegador");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(estado), { status: 202 }));
    await client.videoNavegadorDescarga();
    [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("http://127.0.0.1:5000/video/navegador/descarga");
    expect(init?.method).toBe("POST");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Ya hay una descarga del navegador en curso." }), { status: 409 }));
    await expect(client.videoNavegadorDescarga()).rejects.toMatchObject({ status: 409, detail: "Ya hay una descarga del navegador en curso." });
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

describe("cliente de vídeo", () => {
  const fetchMock = vi.fn() as unknown as ReturnType<typeof vi.fn> & typeof fetch;
  const client = createClient(5000, "tok", fetchMock);
  const ok = (cuerpo: unknown, status = 200) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(cuerpo), { status }));
  const ultima = () => {
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    return { url: url as string, init: init as RequestInit };
  };

  it("proyectos: PUT lleva revisión y proyecto, ids codificados", async () => {
    ok({ revision: 5, avisos: [] });
    await client.videoProyectoGuardar("video001", { revision: 4, proyecto: { id: "video001" } as never });
    const { url, init } = ultima();
    expect(url).toBe("http://127.0.0.1:5000/video/proyectos/video001");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toMatchObject({ revision: 4 });
  });

  it("crear proyecto manda solo ids de guion y de perfil", async () => {
    ok({ id: "video002" }, 201);
    await client.videoProyectoCrear("g-0123456789abcdef", "defecto");
    expect(JSON.parse(ultima().init.body as string)).toEqual({ guion_id: "g-0123456789abcdef", perfil_id: "defecto" });
  });

  it("guiones, preview y render usan las rutas de la tabla REST", async () => {
    ok({ id: "g-0123456789abcdef", avisos: [] }, 201);
    await client.videoGuionCrear({ titulo: "x" });
    expect(ultima().url).toBe("http://127.0.0.1:5000/video/guiones");
    ok({ url: "http://127.0.0.1:47810/p/a/", duracion: 10, avisos: [], fondo: "ninguno" });
    await client.videoPreviewAbrir("video001", true);
    expect(JSON.parse(ultima().init.body as string)).toEqual({ webgpu: true });
    ok({ id: "j" }, 202);
    await client.videoRender("video001", "auto");
    expect(JSON.parse(ultima().init.body as string)).toEqual({ modo: "auto" });
    expect(ultima().url).toBe("http://127.0.0.1:5000/video/proyectos/video001/render");
  });

  it("contrato_backend: perfiles, voces y música llegan en sobre y salen como lista", async () => {
    ok({ perfiles: [{ id: "defecto" }] });
    expect(await client.videoPerfiles()).toEqual([{ id: "defecto" }]);
    ok({ voces: [{ id: "v", nombre: "V" }] });
    expect(await client.videoVoces()).toEqual([{ id: "v", nombre: "V" }]);
    ok({ pistas: [] });
    expect(await client.videoMusica()).toEqual([]);
  });

  it("contrato_backend: un sobre sin lista es un error, no datos", async () => {
    ok({ perfiles: { id: "defecto" } });
    await expect(client.videoPerfiles()).rejects.toBeInstanceOf(ApiError);
    ok([{ id: "v" }]);
    await expect(client.videoVoces()).rejects.toBeInstanceOf(ApiError);
  });

  it("guardar perfil manda {perfil} y devuelve el perfil enviado (el servidor solo responde {id})", async () => {
    ok({ id: "defecto" });
    const perfil = { id: "defecto", nombre: "Canal" } as never;
    expect(await client.videoPerfilGuardar("defecto", perfil)).toEqual(perfil);
    expect(JSON.parse(ultima().init.body as string)).toEqual({ perfil });
  });

  it("sin_rutas_en_cliente: ni los tipos ni los métodos de vídeo reciben rutas (I6)", () => {
    const prohibido = /\b(ruta|rutas|path|paths|file_path|filePath|filename|uri)\??\s*:/i;
    // Excepción única: `ruta` de un aviso es la ruta dentro del documento, no del sistema de ficheros.
    const sinAvisos = (t: string) => t.split("\n").filter((l) => !l.includes("ruta dentro del documento")).join("\n");
    const tipos = tiposSrc;
    const marca = tipos.indexOf("// --- Contrato REST de vídeo");
    expect(marca).toBeGreaterThan(-1);
    expect(sinAvisos(tipos.slice(marca))).not.toMatch(prohibido);
    const metodos = clienteSrc.split("\n").filter((l: string) => /^\s+video[A-Z]\w*\(/.test(l));
    expect(metodos.length).toBeGreaterThan(10);
    for (const m of metodos) expect(m).not.toMatch(prohibido);
    expect(sinAvisos(modeloSrc)).not.toMatch(prohibido);
  });
});
