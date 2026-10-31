import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Client } from "../api/client";
import { ClientContext } from "../api/context";
import { useNavegadorVideo } from "../api/queries";
import type { CapacidadesVideo, NavegadorEstado } from "../api/types";
import { MotorVideo } from "../screens/MotorVideo";
import { setRenderModo, useRenderModo } from "../state/renderModo";
import { Toaster, reiniciarToasts } from "../ui";

const MiB = 1024 * 1024;
const estado = (e: Partial<NavegadorEstado> = {}): NavegadorEstado => ({ version: "148.0.1", tamano: 120 * MiB, estado: "ausente", descargado: 0, error: null, ...e });
const GPU: CapacidadesVideo = { chrome: "148", codificadores: [{ codificador: "h264_nvenc", adaptador: "NVIDIA" }] };

function montar(extra: Partial<Client> = {}) {
  const client = {
    videoNavegador: vi.fn(async () => estado()),
    videoNavegadorDescarga: vi.fn(async () => estado({ estado: "descargando" })),
    videoCapacidades: vi.fn(async () => GPU),
    ...extra,
  } as unknown as Client;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const envoltorio = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
    </QueryClientProvider>
  );
  return { client, envoltorio, ...render(<MotorVideo />, { wrapper: envoltorio }) };
}
const t = (id: string) => screen.queryByTestId(id);

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  reiniciarToasts();
  setRenderModo("auto");
  vi.useRealTimers();
});

describe("renderModo", () => {
  it("un valor basura en localStorage vale «auto»", async () => {
    localStorage.setItem("seo-studio.render-modo", "<script>");
    vi.resetModules();
    const { useRenderModo: fresco } = await import("../state/renderModo");
    expect(fresco.getState().modo).toBe("auto");
  });
});

describe("useNavegadorVideo", () => {
  it("sondea cada segundo mientras descarga y para en «listo»", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const respuestas = [estado({ estado: "descargando" }), estado({ estado: "descargando", descargado: 5 }), estado({ estado: "listo" })];
    const videoNavegador = vi.fn(async () => respuestas[Math.min(videoNavegador.mock.calls.length - 1, 2)]);
    const { envoltorio } = montar({ videoNavegador });
    cleanup();
    const { result } = renderHook(() => useNavegadorVideo(), { wrapper: envoltorio });
    await waitFor(() => expect(result.current.data?.estado).toBe("descargando"));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(videoNavegador.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(result.current.data?.estado).toBe("listo"));
    const n = videoNavegador.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(videoNavegador.mock.calls.length).toBe(n);
  });
});

describe("MotorVideo", () => {
  it("ausente: botón de descarga, sin progreso, sin pedir capacidades ni descargar solo", async () => {
    const { client } = montar();
    expect(await screen.findByTestId("ajustes-video-descargar")).toHaveProperty("textContent", "Descargar el navegador del render");
    expect(t("ajustes-video-progreso")).toBeNull();
    expect(t("ajustes-video-aviso")?.textContent).toContain("Chrome for Testing 148.0.1 (~120 MB)");
    expect(client.videoNavegadorDescarga).not.toHaveBeenCalled();
    expect(client.videoCapacidades).not.toHaveBeenCalled();
  });

  it("descargando al 40 %: barra con aria-valuenow=40 y sin botón", async () => {
    montar({ videoNavegador: vi.fn(async () => estado({ estado: "descargando", descargado: 48 * MiB })) });
    const barra = await screen.findByRole("progressbar", { name: /descarga|navegador/i });
    expect(barra.getAttribute("aria-valuenow")).toBe("40");
    expect(t("ajustes-video-progreso")?.textContent).toContain("48 de 120 MB");
    expect(t("ajustes-video-descargar")).toBeNull();
  });

  it.each(["verificando", "extrayendo"] as const)("%s: barra indeterminada", async (fase) => {
    montar({ videoNavegador: vi.fn(async () => estado({ estado: fase, descargado: 120 * MiB })) });
    const barra = await screen.findByRole("progressbar", { name: /descarga|navegador/i });
    expect(barra.getAttribute("aria-valuenow")).toBeNull();
    expect(t("ajustes-video-descargar")).toBeNull();
  });

  it("listo: sin botón y pide capacidades", async () => {
    const { client } = montar({ videoNavegador: vi.fn(async () => estado({ estado: "listo" })) });
    await waitFor(() => expect(client.videoCapacidades).toHaveBeenCalledTimes(1));
    expect(t("ajustes-video-descargar")).toBeNull();
    expect(t("ajustes-video-estado")?.textContent).toBe("Listo");
  });

  it("error: el texto del backend se ve como texto, sin rutas, y se ofrece reintentar", async () => {
    const { container } = montar({
      videoNavegador: vi.fn(async () => estado({ estado: "error", error: "No se pudo escribir en C:\\Users\\Marc\\AppData\\x <img src=x onerror=alert(1)>" })),
    });
    const alerta = await screen.findByTestId("ajustes-video-error");
    expect(alerta.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(alerta.textContent).not.toContain("AppData");
    expect(container.querySelector("img")).toBeNull();
    expect(t("ajustes-video-descargar")?.textContent).toBe("Reintentar la descarga");
  });

  it("clic en descargar hace un POST; un 409 muestra el detail sin romper", async () => {
    const videoNavegadorDescarga = vi.fn(async () => {
      throw new ApiError(409, "Ya hay una descarga del navegador en curso.");
    });
    montar({ videoNavegadorDescarga });
    fireEvent.click(await screen.findByTestId("ajustes-video-descargar"));
    expect((await screen.findByTestId("ajustes-video-error")).textContent).toContain("Ya hay una descarga");
    expect(videoNavegadorDescarga).toHaveBeenCalledTimes(1);
  });

  it("503 «no está instalado» en el POST: aviso y sin botón", async () => {
    montar({
      videoNavegadorDescarga: vi.fn(async () => {
        throw new ApiError(503, "El módulo de vídeo no está instalado en esta versión de SEO Studio.");
      }),
    });
    fireEvent.click(await screen.findByTestId("ajustes-video-descargar"));
    expect(await screen.findByTestId("ajustes-video-sin-motor")).toBeTruthy();
    expect(t("ajustes-video-descargar")).toBeNull();
    expect(t("ajustes-video-error")).toBeNull();
  });

  it("503 «no está instalado» en capacidades: aviso", async () => {
    montar({
      videoNavegador: vi.fn(async () => estado({ estado: "listo" })),
      videoCapacidades: vi.fn(async () => {
        throw new ApiError(503, "El módulo de vídeo no está instalado en esta versión de SEO Studio.");
      }),
    });
    expect(await screen.findByTestId("ajustes-video-sin-motor")).toBeTruthy();
  });

  it("M9: listo pero capacidades falla por otra causa: error y «Volver a descargar»", async () => {
    montar({
      videoNavegador: vi.fn(async () => estado({ estado: "listo" })),
      videoCapacidades: vi.fn(async () => {
        throw new ApiError(503, "El navegador del render no verifica.");
      }),
    });
    expect((await screen.findByTestId("ajustes-video-error")).textContent).toContain("no verifica");
    expect(t("ajustes-video-descargar")?.textContent).toBe("Volver a descargar");
    expect(t("ajustes-video-sin-motor")).toBeNull();
  });

  it("M9: 200 sin chrome y con gpu.detalle también ofrece «Volver a descargar»", async () => {
    montar({
      videoNavegador: vi.fn(async () => estado({ estado: "listo" })),
      videoCapacidades: vi.fn(async () => ({ gpu: { webgpu: false, detalle: "Falta el navegador del render." } })),
    });
    expect((await screen.findByTestId("ajustes-video-error")).textContent).toContain("Falta el navegador");
    expect(t("ajustes-video-descargar")?.textContent).toBe("Volver a descargar");
  });

  it("Rápido: deshabilitado sin codificadores (aviso), solo h264_mf no cuenta, y habilitado con GPU", async () => {
    montar();
    expect((await screen.findByTestId("ajustes-render-rapido-aviso")).textContent).toBe("Comprobando codificadores…");
    expect((t("ajustes-render-modo-rapido") as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    montar({ videoNavegador: vi.fn(async () => estado({ estado: "listo" })), videoCapacidades: vi.fn(async () => ({ chrome: "1", codificadores: [{ codificador: "h264_mf", adaptador: "Microsoft" }] })) });
    await waitFor(() => expect(t("ajustes-render-rapido-aviso")?.textContent).toBe("No hay codificador de GPU: se usará Compatible"));
    expect((t("ajustes-render-modo-rapido") as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    montar({ videoNavegador: vi.fn(async () => estado({ estado: "listo" })) });
    await waitFor(() => expect((t("ajustes-render-modo-rapido") as HTMLButtonElement).disabled).toBe(false));
    expect(t("ajustes-render-rapido-aviso")).toBeNull();
  });

  it("elegir un modo lo guarda y avisa", async () => {
    render(<Toaster />);
    montar();
    fireEvent.click(await screen.findByTestId("ajustes-render-modo-compatible"));
    expect(useRenderModo.getState().modo).toBe("compatible");
    expect(localStorage.getItem("seo-studio.render-modo")).toBe("compatible");
    expect(await screen.findByText("Modo de render guardado")).toBeTruthy();
    expect(t("ajustes-render-modo-compatible")?.getAttribute("aria-checked")).toBe("true");
  });

  it("I11: ni input file ni botón para usar otro navegador", async () => {
    const { container } = montar({ videoNavegador: vi.fn(async () => estado({ estado: "error", error: "x" })) });
    await screen.findByTestId("ajustes-video-error");
    expect(container.querySelector("input[type=file]")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /otro navegador|examinar|chrome|edge/i })).toHaveLength(0);
  });
});
