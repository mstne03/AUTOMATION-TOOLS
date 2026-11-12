import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../api/client";
import type { PreviewVideo } from "../api/types";
import { cargar, desvincularCliente, editar, reiniciarEditor, useEditor, vincularCliente } from "../state/editor";
import { cerrarSesionPreview, iniciarSesionPreview, type SesionPreview } from "../video/EditorPreview";
import type { Proyecto } from "../video/modelo";
import { Preview } from "../video/Preview";
import { recargarPreview } from "../video/previewRecarga";

const URL1 = "http://127.0.0.1:47810/p/abc_DEF-123/index.html";
const URL2 = "http://127.0.0.1:47810/p/abc_DEF-123/r2/index.html";
const proyecto = (): Proyecto => ({
  version: 1, id: "video001", revision: 1, titulo: "Cocina", gancho: "x", aspecto: "9:16", perfilId: "defecto",
  creado: "2026-11-07T10:00:00Z", actualizado: "2026-11-07T10:00:00Z",
  frases: [{ id: "f1", texto: "Hola" }],
  escenas: [{ id: "e1", fraseIds: ["f1"], base: { tipo: "cartel", texto: "Hola" }, ajusteCorte: 0 }],
  recursos: [], subtitulos: { estilo: "karaoke", correcciones: [], cortes: [] },
  opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [] },
});
const resp = (url = URL1, extra: Partial<PreviewVideo> = {}): PreviewVideo => ({ url, duracion: 30, avisos: [], fondo: "css", ...extra });

let abrir: ReturnType<typeof vi.fn>;
let cerrar: ReturnType<typeof vi.fn>;
let sesion: SesionPreview;

const iframe = () => screen.getByTestId("preview-marco") as HTMLIFrameElement;
/** Simula un mensaje del iframe: `source` es su contentWindow y el origen es opaco. */
function desdeIframe(data: unknown, o: { origin?: string; source?: Window | null } = {}) {
  const w = iframe().contentWindow!;
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin: o.origin ?? "null", source: o.source === undefined ? w : o.source }));
  });
}
async function montar(r: PreviewVideo = resp()) {
  abrir.mockResolvedValue(r);
  render(<Preview />);
  await waitFor(() => expect(iframe().getAttribute("src")).toBe(r.url));
}

beforeEach(() => {
  abrir = vi.fn();
  cerrar = vi.fn(async () => ({}));
  const client = { videoPreviewAbrir: abrir, videoPreviewCerrar: cerrar } as unknown as Client;
  vincularCliente({ videoProyectoGuardar: vi.fn(async (_i: string, c: { revision: number }) => ({ revision: c.revision + 1, avisos: [] })) } as unknown as Client);
  sesion = iniciarSesionPreview(client, "video001");
  cargar(proyecto());
});
afterEach(async () => {
  cleanup();
  await cerrarSesionPreview(sesion);
  reiniciarEditor();
  desvincularCliente();
  vi.useRealTimers();
});

describe("Preview", () => {
  it("atributos_exactos del iframe", async () => {
    await montar();
    const f = iframe();
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("allow")).toBe("autoplay");
    expect(f.hasAttribute("srcdoc")).toBe(false);
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
  it("abre solo con la sesión y pasa por aPreviewUrl", async () => {
    await montar();
    expect(abrir).toHaveBeenCalledTimes(1);
    expect(abrir).toHaveBeenCalledWith("video001", false);
  });
  it("url_fuera_de_lista: nunca llega al src", async () => {
    abrir.mockResolvedValue(resp("http://127.0.0.1:47814/p/abc/index.html"));
    render(<Preview />);
    await screen.findByTestId("preview-error");
    expect(screen.queryByTestId("preview-marco")).toBeNull();
  });
  it("url_ajena y javascript: se rechazan", async () => {
    for (const u of ["https://evil.example/p/a/x.html", "javascript:alert(1)", "http://127.0.0.1:47810/p/a/../b"]) {
      cleanup();
      abrir.mockResolvedValue(resp(u));
      render(<Preview />);
      await screen.findByTestId("preview-error");
      expect(screen.queryByTestId("preview-marco")).toBeNull();
    }
  });
  it("sesion_de_otro_proyecto: no abre nada", async () => {
    await cerrarSesionPreview(sesion);
    sesion = iniciarSesionPreview({ videoPreviewAbrir: abrir, videoPreviewCerrar: cerrar } as unknown as Client, "otro");
    render(<Preview />);
    await screen.findByTestId("preview-error");
    expect(abrir).not.toHaveBeenCalled();
  });
  it("sin_sesion: error visible y sin llamadas", async () => {
    await cerrarSesionPreview(sesion);
    render(<Preview />);
    await screen.findByTestId("preview-error");
    expect(abrir).not.toHaveBeenCalled();
  });
  it("preview_error_visible: el 503 se pinta como texto y sin rutas", async () => {
    abrir.mockRejectedValue(new Error("Sin puerto <img src=x onerror=alert(1)> en C:\\Users\\marc\\x"));
    render(<Preview />);
    const e = await screen.findByTestId("preview-error");
    expect(e.getAttribute("role")).toBe("alert");
    expect(e.querySelector("img")).toBeNull();
    expect(e.textContent).not.toContain("marc");
  });
  it("avisos del backend: solo llega el código y se traduce con la tabla cerrada (R2-2)", async () => {
    // Forma real de `POST …/preview` (`video_rest.py`): `{ codigo, puertos }`, sin `mensaje`.
    await montar(resp(URL1, { avisos: [{ codigo: "puertos_preview_ajenos", puertos: [47811] }, { codigo: "otro_codigo" }] }));
    const a = await screen.findByTestId("preview-aviso-fondo");
    expect(a.textContent).toContain("Algunos puertos de la vista previa estaban ocupados por otro programa.");
    expect(a.textContent).toContain("Aviso no reconocido (otro_codigo).");
    expect(a.textContent).not.toContain("undefined");
  });
  it("un aviso con texto hostil se pinta como texto", async () => {
    await montar(resp(URL1, { avisos: [{ codigo: "<b>x</b>" }] }));
    const a = await screen.findByTestId("preview-aviso-fondo");
    expect(a.querySelector("b")).toBeNull();
  });
  it("cargando hasta recibir listo", async () => {
    await montar();
    expect(screen.getByTestId("preview-cargando")).toBeTruthy();
    desdeIframe({ tipo: "listo", duracion: 30 });
    expect(screen.queryByTestId("preview-cargando")).toBeNull();
  });
  it("mensajes hostiles se ignoran y se cuentan", async () => {
    await montar();
    desdeIframe({ tipo: "listo", duracion: 30 });
    desdeIframe({ tipo: "tiempo", t: 5, reproduciendo: false }, { origin: "https://evil.example" });
    desdeIframe({ tipo: "tiempo", t: 5, reproduciendo: false }, { source: window });
    desdeIframe({ tipo: "tiempo", t: 5, reproduciendo: false, html: "<img>" });
    expect(screen.getByTestId("preview-tiempo").textContent).toContain("0:00");
    expect(screen.getByTestId("preview-marco").getAttribute("data-descartados")).toBe("3");
  });
  it("tiempo válido se muestra como texto", async () => {
    await montar();
    desdeIframe({ tipo: "listo", duracion: 30 });
    desdeIframe({ tipo: "tiempo", t: 5, reproduciendo: false });
    expect(screen.getByTestId("preview-tiempo").textContent).toContain("0:05");
  });
  it("postMessage solo a la ventana del iframe", async () => {
    await montar();
    desdeIframe({ tipo: "listo", duracion: 30 });
    const espia = vi.spyOn(iframe().contentWindow!, "postMessage");
    fireEvent.click(screen.getByTestId("preview-play"));
    expect(espia).toHaveBeenCalledTimes(1);
    const [msg, destino] = espia.mock.calls[0] as unknown as [{ tipo: string }, string];
    expect(msg.tipo).toBe("play");
    expect(typeof destino).toBe("string");
  });
  it("seek_al_cambiar_el_cabezal, con id entero", async () => {
    await montar();
    desdeIframe({ tipo: "listo", duracion: 30 });
    const espia = vi.spyOn(iframe().contentWindow!, "postMessage");
    act(() => useEditor.setState({ tiempo: 7 }));
    const [msg] = espia.mock.calls.at(-1) as unknown as [{ tipo: string; id: number; t: number }];
    expect(msg).toMatchObject({ tipo: "seek", t: 7 });
    expect(Number.isInteger(msg.id)).toBe(true);
  });
  it("el seek se acota a [0, duración]", async () => {
    await montar();
    desdeIframe({ tipo: "listo", duracion: 30 });
    const espia = vi.spyOn(iframe().contentWindow!, "postMessage");
    act(() => useEditor.setState({ tiempo: 999 }));
    expect((espia.mock.calls.at(-1)![0] as { t: number }).t).toBe(30);
  });
  it("cambio tras guardar: espera 400 ms, reabre y al recibir listo hace seek al tiempo anterior", async () => {
    await montar();
    desdeIframe({ tipo: "listo", duracion: 30 });
    desdeIframe({ tipo: "tiempo", t: 8, reproduciendo: false });
    abrir.mockResolvedValue(resp(URL2));
    vi.useFakeTimers();
    act(() => editar((p) => { p.titulo = "Otro"; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(800); }); // autoguardado
    expect(abrir).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(399); });
    expect(abrir).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(abrir).toHaveBeenCalledTimes(2);
    expect(iframe().getAttribute("src")).toBe(URL2);
    const espia = vi.spyOn(iframe().contentWindow!, "postMessage");
    desdeIframe({ tipo: "listo", duracion: 30 });
    expect(espia.mock.calls[0]![0]).toMatchObject({ tipo: "seek", t: 8 });
  });
  it("recargarPreview() fuerza la reapertura (T18, perfil guardado)", async () => {
    await montar();
    abrir.mockResolvedValue(resp(URL2));
    vi.useFakeTimers();
    act(() => recargarPreview());
    await act(async () => { await vi.advanceTimersByTimeAsync(401); });
    expect(abrir).toHaveBeenCalledTimes(2);
    expect(iframe().getAttribute("src")).toBe(URL2);
  });
  it("tras cerrar la sesión no reabre", async () => {
    await montar();
    vi.useFakeTimers();
    act(() => recargarPreview());
    await cerrarSesionPreview(sesion);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(abrir).toHaveBeenCalledTimes(1);
  });
  it("StrictMode no abre dos veces con la misma sesión viva", async () => {
    const { StrictMode } = await import("react");
    abrir.mockResolvedValue(resp());
    render(<StrictMode><Preview /></StrictMode>);
    await waitFor(() => expect(iframe().getAttribute("src")).toBe(URL1));
    expect(cerrar).not.toHaveBeenCalled();
  });
});
