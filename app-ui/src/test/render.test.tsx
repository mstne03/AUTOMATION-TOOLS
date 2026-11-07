/** Task 20: render, exportar y errores del render (docs/pantallas.md › Render). El cliente HTTP y los
 *  comandos nativos se simulan; el motor de render es de la Task 11. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient, type Client } from "../api/client";
import { ClientContext } from "../api/context";
import type { CapacidadesVideo, Job, NavegadorEstado } from "../api/types";
import { reiniciarEditor, useEditor } from "../state/editor";
import { reiniciarJobs, seguirJob } from "../state/jobs";
import { setRenderModo } from "../state/renderModo";
import { RenderBoton } from "../video/render/RenderBoton";
import type { Proyecto } from "../video/modelo";
import { Toaster, reiniciarToasts } from "../ui";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const ID = "video001";
const MiB = 1024 * 1024;
const NAV: NavegadorEstado = { version: "148.0.1", tamano: 120 * MiB, estado: "listo", descargado: 120 * MiB, error: null };
const GPU: CapacidadesVideo = { chrome: "148", codificadores: [{ codificador: "h264_nvenc", adaptador: "NVIDIA" }] };
const SIN_GPU: CapacidadesVideo = { chrome: "148", codificadores: [{ codificador: "h264_mf", adaptador: "Microsoft" }] };

const proyecto = (): Proyecto => ({ id: ID, titulo: "Tortilla perfecta", revision: 3 }) as unknown as Proyecto;
const job = (status: Job["status"], extra: Partial<Job> = {}): Job => ({
  id: "j1",
  kind: "video_render",
  args: { id: ID, titulo: "Tortilla perfecta", modo: "compatible" },
  status,
  progress: 0,
  result: null,
  error: null,
  created_at: "2026-11-07T10:00:00Z",
  updated_at: "2026-11-07T10:00:00Z",
  ...extra,
});
const RESULTADO = { id: ID, duracion: 12.5, modo: "compatible", codificador: "h264_mf", avisos: [], reserva: null };

let jobsServidor: Job[] = [];
function montar(extra: Partial<Client> = {}) {
  const client = {
    videoVozCoste: vi.fn(async () => ({ pendientes: [], caracteres: 0, voz: "Lucía" })),
    videoRender: vi.fn(async () => job("queued")),
    listJobs: vi.fn(async () => jobsServidor),
    videoNavegador: vi.fn(async () => NAV),
    videoCapacidades: vi.fn(async () => GPU),
    ...extra,
  } as unknown as Client;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const envoltorio = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
    </QueryClientProvider>
  );
  return { client, qc, ...render(<><RenderBoton /><Toaster /></>, { wrapper: envoltorio }) };
}
const t = (id: string) => screen.queryByTestId(id);
const abrir = async () => {
  fireEvent.click(screen.getByTestId("editor-render"));
  return screen.findByTestId("render-dialogo");
};
const lanzar = async () => {
  await waitFor(() => expect((screen.getByTestId("render-lanzar") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("render-lanzar"));
};

beforeEach(() => {
  localStorage.clear();
  jobsServidor = [];
  invoke.mockClear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  useEditor.setState({ proyecto: proyecto(), guardado: "guardado", conflicto: false });
});
afterEach(() => {
  cleanup();
  reiniciarToasts();
  reiniciarJobs();
  reiniciarEditor();
  setRenderModo("auto");
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("RenderBoton", () => {
  it("sin proyecto cargado está deshabilitado", () => {
    reiniciarEditor();
    montar();
    expect((screen.getByTestId("editor-render") as HTMLButtonElement).disabled).toBe(true);
  });

  it("abre el diálogo y, sin motor de render del lado de la UI, no lanza nada por abrirlo", async () => {
    const { client } = montar();
    const d = await abrir();
    expect(d).toBeTruthy();
    expect(client.videoRender).not.toHaveBeenCalled();
  });
});

describe("render_bloqueado_sin_voz", () => {
  it("con frases sin voz muestra render-bloqueo y no deja lanzar", async () => {
    const { client } = montar({ videoVozCoste: vi.fn(async () => ({ pendientes: ["f0", "f1"], caracteres: 40, voz: "Lucía" })) as never });
    await abrir();
    const b = await screen.findByTestId("render-bloqueo");
    expect(b.textContent).toMatch(/voz/i);
    expect(b.getAttribute("data-motivo")).toBe("voz");
    expect((screen.getByTestId("render-lanzar") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("render-lanzar"));
    expect(client.videoRender).not.toHaveBeenCalled();
  });

  it("mientras comprueba la voz no deja lanzar, y sin pendientes sí", async () => {
    montar();
    await abrir();
    await waitFor(() => expect((screen.getByTestId("render-lanzar") as HTMLButtonElement).disabled).toBe(false));
    expect(t("render-bloqueo")).toBeNull();
  });

  it("si el servidor rechaza con el código sin_voz, también es un bloqueo y no un error genérico", async () => {
    montar({ videoRender: vi.fn(async () => { throw new ApiError(409, "Faltan frases por generar.", "sin_voz"); }) as never });
    await abrir();
    await lanzar();
    expect((await screen.findByTestId("render-bloqueo")).textContent).toContain("Faltan frases por generar.");
    expect(t("render-error")).toBeNull();
  });

  it("con el proyecto sin guardar o en conflicto tampoco se lanza", async () => {
    useEditor.setState({ guardado: "pendiente" });
    const { client } = montar();
    await abrir();
    const b = await screen.findByTestId("render-bloqueo");
    expect(b.getAttribute("data-motivo")).toBe("guardado");
    expect((screen.getByTestId("render-lanzar") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    useEditor.setState({ guardado: "guardado", conflicto: true });
    montar({ videoRender: client.videoRender });
    await abrir();
    expect((await screen.findByTestId("render-bloqueo")).getAttribute("data-motivo")).toBe("guardado");
  });
});

describe("modo de render", () => {
  it("envía el modo guardado; Automático va como «auto» (equivale a Compatible, M-D6)", async () => {
    const { client } = montar();
    await abrir();
    await lanzar();
    await waitFor(() => expect(client.videoRender).toHaveBeenCalledWith(ID, "auto"));
  });

  it("«Compatible» va como compatible", async () => {
    setRenderModo("compatible");
    const { client } = montar();
    await abrir();
    await lanzar();
    await waitFor(() => expect(client.videoRender).toHaveBeenCalledWith(ID, "compatible"));
  });

  it("«Rápido» con GPU va como rapido", async () => {
    setRenderModo("rapido");
    const { client } = montar();
    await abrir();
    await waitFor(() => expect(client.videoCapacidades).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toMatch(/GPU/));
    await lanzar();
    await waitFor(() => expect(client.videoRender).toHaveBeenCalledWith(ID, "rapido"));
  });

  it("«Rápido» guardado sin GPU se envía como compatible y se dice", async () => {
    setRenderModo("rapido");
    const { client } = montar({ videoCapacidades: vi.fn(async () => SIN_GPU) as never });
    await abrir();
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toMatch(/Compatible/));
    await lanzar();
    await waitFor(() => expect(client.videoRender).toHaveBeenCalledWith(ID, "compatible"));
  });

  it("«Rápido» guardado: mientras no llega el estado del navegador el botón espera", async () => {
    setRenderModo("rapido");
    montar({ videoNavegador: vi.fn(() => new Promise(() => {})) as never });
    await abrir();
    await waitFor(() => expect(screen.getByTestId("render-lanzar")).toBeTruthy());
    expect((screen.getByTestId("render-lanzar") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("dialog").textContent).not.toMatch(/no está disponible en este equipo/);
  });

  it("la UI no manda nada más que el id del proyecto y el modo (ninguna ruta)", async () => {
    const { client } = montar();
    await abrir();
    await lanzar();
    await waitFor(() => expect(client.videoRender).toHaveBeenCalled());
    expect(vi.mocked(client.videoRender).mock.calls[0]).toEqual([ID, "auto"]);
  });
});

describe("progreso y resultado", () => {
  it("muestra el progreso del job y el resultado al acabar, sin repetir el lanzamiento", async () => {
    const { client } = montar();
    await abrir();
    await lanzar();
    await screen.findByTestId("render-progreso");
    act(() => seguirJob(client, job("running", { progress: 0.4 })));
    const barra = within(screen.getByTestId("render-progreso")).getByRole("progressbar");
    expect(barra.getAttribute("aria-valuenow")).toBe("40");
    expect(t("render-lanzar")).toBeNull(); // no se lanza otro mientras corre
    act(() => seguirJob(client, job("done", { progress: 1, result: RESULTADO })));
    const r = await screen.findByTestId("render-resultado");
    expect(r.textContent).toContain("12,5 s");
    expect(t("render-progreso")).toBeNull();
    expect(t("render-error")).toBeNull();
    expect(client.videoRender).toHaveBeenCalledTimes(1);
  });

  it("al volver a abrir con un render en curso del mismo proyecto retoma el progreso", async () => {
    jobsServidor = [job("running", { progress: 0.25 })];
    const { client } = montar();
    await abrir();
    const barra = within(await screen.findByTestId("render-progreso")).getByRole("progressbar");
    expect(barra.getAttribute("aria-valuenow")).toBe("25");
    expect(t("render-lanzar")).toBeNull();
    expect(client.videoRender).not.toHaveBeenCalled();
  });

  it("un job de otro proyecto no se enseña", async () => {
    jobsServidor = [job("running", { args: { id: "video002", titulo: "Otro", modo: "auto" } })];
    montar();
    await abrir();
    await waitFor(() => expect((screen.getByTestId("render-lanzar") as HTMLButtonElement).disabled).toBe(false));
    expect(t("render-progreso")).toBeNull();
  });
});

describe("reserva_visible", () => {
  it("reserva_lista_de_codigos: forma real del backend (reserva = códigos, aviso = {codigo})", async () => {
    jobsServidor = [job("done", { progress: 1, result: { ...RESULTADO, modo: "rapido", avisos: [{ codigo: "fondo_degradado" }, { codigo: "foto_pequena" }], reserva: ["fondo_degradado"] } })];
    montar();
    await abrir();
    const a = await screen.findByTestId("render-avisos");
    expect(a.textContent).toContain("h264_mf");
    expect(a.textContent).toMatch(/Reserva: .*degradado/i);
    expect(a.textContent).toMatch(/foto.*pequeña/i);
    expect(a.textContent).not.toContain("fondo_degradado");
  });

  it("un código desconocido se enseña como aviso genérico, nunca se descarta", async () => {
    jobsServidor = [job("done", { progress: 1, result: { ...RESULTADO, avisos: [{ codigo: "algo_nuevo" }], reserva: ["otro_nuevo", "C:\\Users\\Marc\\x"] } })];
    montar();
    await abrir();
    const a = await screen.findByTestId("render-avisos");
    expect(a.textContent).toMatch(/Reserva: .*no reconocid/i);
    expect(a.textContent).toContain("algo_nuevo");
    expect(a.textContent).toContain("otro_nuevo");
    expect(a.textContent).not.toContain("Marc");
  });

  it("si Rápido cae a Compatible sin reserva, igualmente se ve", async () => {
    jobsServidor = [job("done", { progress: 1, args: { id: ID, titulo: "T", modo: "rapido" }, result: { ...RESULTADO, modo: "compatible", reserva: [] } })];
    montar();
    await abrir();
    const a = await screen.findByTestId("render-avisos");
    expect(a.textContent).toMatch(/Rápido.*Compatible/);
  });

  it("sin reserva ni avisos enseña solo el codificador", async () => {
    jobsServidor = [job("done", { progress: 1, result: RESULTADO })];
    montar();
    await abrir();
    const a = await screen.findByTestId("render-avisos");
    expect(a.textContent).toContain("h264_mf");
    expect(a.textContent).not.toMatch(/reserva/i);
  });

  it("un resultado malformado no rompe el diálogo", async () => {
    jobsServidor = [job("done", { progress: 1, result: { duracion: "mucho", codificador: 7, avisos: "x", reserva: { a: 1 } } })];
    montar();
    await abrir();
    expect(await screen.findByTestId("render-resultado")).toBeTruthy();
  });
});

describe("error_sin_rutas", () => {
  it("un render fallido se ve, como texto y sin rutas del sistema", async () => {
    jobsServidor = [job("failed", { error: "ffmpeg salió con 1 en C:\\Users\\Marc\\AppData\\seo-studio\\video\\video001\\_render\\r1 <img src=x onerror=alert(1)>" })];
    montar();
    await abrir();
    const e = await screen.findByTestId("render-error");
    expect(e.getAttribute("role")).toBe("alert");
    expect(e.textContent).toContain("ffmpeg salió con 1");
    expect(e.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(e.textContent).not.toMatch(/Users|AppData|_render/);
    expect(e.querySelector("img, script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(t("render-resultado")).toBeNull();
  });

  it("un fallo del POST (409 con código) se ve sin rutas y deja reintentar", async () => {
    const videoRender = vi.fn(async () => { throw new ApiError(409, "Ya hay un render de /home/marc/.local/share/seo/video001/x", "conflicto"); });
    montar({ videoRender: videoRender as never });
    await abrir();
    await lanzar();
    const e = await screen.findByTestId("render-error");
    expect(e.textContent).toContain("Ya hay un render");
    expect(e.textContent).not.toContain("/home/marc");
    expect((screen.getByTestId("render-lanzar") as HTMLButtonElement).disabled).toBe(false);
  });

  it("tras un fallo se puede volver a lanzar y el error anterior se va", async () => {
    jobsServidor = [job("failed", { error: "Se agotó el tiempo del render." })];
    const { client } = montar();
    await abrir();
    await screen.findByTestId("render-error");
    await lanzar();
    await waitFor(() => expect(client.videoRender).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(t("render-error")).toBeNull());
  });

  it("un job fallido no se queda en cola de estado de otro proyecto", async () => {
    jobsServidor = [job("failed", { error: "x", args: { id: "video009", titulo: "Otro", modo: "auto" } })];
    montar();
    await abrir();
    await waitFor(() => expect((screen.getByTestId("render-lanzar") as HTMLButtonElement).disabled).toBe(false));
    expect(t("render-error")).toBeNull();
  });
});

describe("exportar", () => {
  const listo = () => {
    jobsServidor = [job("done", { progress: 1, result: RESULTADO })];
  };

  it("render-exportar llama a exportar_mp4 con el id y nada más", async () => {
    listo();
    montar();
    await abrir();
    fireEvent.click(await screen.findByTestId("render-exportar"));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("exportar_mp4", { id: ID });
  });

  it("cancelar el diálogo nativo (null) no enseña ningún error", async () => {
    listo();
    invoke.mockResolvedValueOnce(null);
    montar();
    await abrir();
    fireEvent.click(await screen.findByTestId("render-exportar"));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await act(async () => {});
    expect(t("render-error")).toBeNull();
  });

  it("un fallo de la exportación se ve sin rutas", async () => {
    listo();
    invoke.mockRejectedValueOnce("No se pudo copiar a D:\\Vídeos\\salida.mp4: el destino ya existe");
    montar();
    await abrir();
    fireEvent.click(await screen.findByTestId("render-exportar"));
    const e = await screen.findByTestId("render-error");
    expect(e.textContent).toContain("el destino ya existe");
    expect(e.textContent).not.toContain("Vídeos");
  });

  it("fuera de Tauri explica que solo existe en la aplicación y no invoca nada", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    listo();
    montar();
    await abrir();
    fireEvent.click(await screen.findByTestId("render-exportar"));
    expect((await screen.findByTestId("render-error")).textContent).toMatch(/aplicación de escritorio/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("render-exportar no existe sin un render terminado", async () => {
    montar();
    await abrir();
    await waitFor(() => expect((screen.getByTestId("render-lanzar") as HTMLButtonElement).disabled).toBe(false));
    expect(t("render-exportar")).toBeNull();
  });
});

describe("el cliente separa los errores por código", () => {
  it("detail { mensaje, codigo } llega a ApiError.codigo y el texto plano sigue siendo texto", async () => {
    const respuestas = [
      new Response(JSON.stringify({ detail: { mensaje: "Faltan frases.", codigo: "sin_voz" } }), { status: 409 }),
      new Response(JSON.stringify({ detail: "Texto plano" }), { status: 409 }),
    ];
    const c = createClient(1, "tok", (async () => respuestas.shift()!) as unknown as typeof fetch);
    const e1 = await c.videoRender(ID, "auto").catch((e) => e as ApiError);
    expect(e1).toMatchObject({ status: 409, detail: "Faltan frases.", codigo: "sin_voz" });
    const e2 = await c.videoRender(ID, "auto").catch((e) => e as ApiError);
    expect(e2).toMatchObject({ status: 409, detail: "Texto plano" });
    expect((e2 as ApiError).codigo).toBeUndefined();
  });

  it("validateElevenlabsKey hace POST a /settings/validate-elevenlabs-key", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ valida: true, detalle: null }), { status: 200 }));
    const c = createClient(1, "tok", f as unknown as typeof fetch);
    await c.validateElevenlabsKey("clave");
    expect(f.mock.calls[0]![0]).toContain("/settings/validate-elevenlabs-key");
    expect(f.mock.calls[0]![1]!.method).toBe("POST");
  });
});
