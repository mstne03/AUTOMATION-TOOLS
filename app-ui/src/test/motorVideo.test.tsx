import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Client } from "../api/client";
import { ClientContext } from "../api/context";
import { useNavegadorVideo } from "../api/queries";
import type { CapacidadesVideo, NavegadorEstado, Settings } from "../api/types";
import { MotorVideo, sinRutas } from "../screens/MotorVideo";
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
    getSettings: vi.fn(async () => ({ has_elevenlabs_key: false })),
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
    expect((await screen.findByTestId("ajustes-render-rapido-aviso")).textContent).toBe("Descarga el navegador del render para comprobar los codificadores");
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

  it("409 → listo: el error del POST no reaparece como alerta", async () => {
    let fase: NavegadorEstado["estado"] = "ausente";
    const videoNavegador = vi.fn(async () => estado({ estado: fase }));
    const { client } = montar({
      videoNavegador,
      videoNavegadorDescarga: vi.fn(async () => {
        fase = "descargando";
        throw new ApiError(409, "Ya hay una descarga del navegador en curso.");
      }),
    });
    fireEvent.click(await screen.findByTestId("ajustes-video-descargar"));
    await waitFor(() => expect(t("ajustes-video-progreso")).not.toBeNull());
    expect(t("ajustes-video-error")).toBeNull();
    fase = "listo";
    await waitFor(() => expect(t("ajustes-video-estado")?.textContent).toBe("Listo"), { timeout: 3000 });
    expect(client.videoNavegadorDescarga).toHaveBeenCalledTimes(1);
    expect(t("ajustes-video-error")).toBeNull();
  });

  it("aviso de Rápido: listo y pendiente «Comprobando…»; con error de capacidades, texto propio", async () => {
    montar({ videoNavegador: vi.fn(async () => estado({ estado: "listo" })), videoCapacidades: vi.fn(() => new Promise<CapacidadesVideo>(() => {})) });
    await waitFor(() => expect(t("ajustes-render-rapido-aviso")?.textContent).toBe("Comprobando…"));
    cleanup();
    montar({
      videoNavegador: vi.fn(async () => estado({ estado: "listo" })),
      videoCapacidades: vi.fn(async () => {
        throw new ApiError(500, "boom");
      }),
    });
    await waitFor(() => expect(t("ajustes-render-rapido-aviso")?.textContent).toBe("No se han podido comprobar los codificadores"));
  });

  it("«Rápido» guardado sin GPU: no queda marcado; se marca el modo efectivo y lo guardado no se toca", async () => {
    setRenderModo("rapido");
    montar({ videoNavegador: vi.fn(async () => estado({ estado: "listo" })), videoCapacidades: vi.fn(async () => ({ chrome: "1", codificadores: [] })) });
    await waitFor(() => expect(t("ajustes-render-rapido-aviso")).not.toBeNull());
    expect(t("ajustes-render-modo-rapido")?.getAttribute("aria-checked")).toBe("false");
    expect(t("ajustes-render-modo-compatible")?.getAttribute("aria-checked")).toBe("true");
    expect(useRenderModo.getState().modo).toBe("rapido");
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

describe("nota_retirada", () => {
  it("la nota «todavía no se aplica» ya no existe: el modo se aplica al render", async () => {
    const { container } = montar();
    await screen.findByTestId("ajustes-render-modo");
    expect(t("ajustes-render-modo-nota")).toBeNull();
    expect(container.textContent).not.toMatch(/todavía no se aplica/);
  });
});

describe("Clave de ElevenLabs", () => {
  const CLAVE = "xi-secreta-0123456789abcdef";
  const ajustes = (con: boolean) => ({ has_elevenlabs_key: con }) as unknown as Settings;
  const campo = () => screen.getByTestId("ajustes-eleven-clave") as HTMLInputElement;
  const escribir = (v: string) => fireEvent.change(campo(), { target: { value: v } });
  /** Lo que ve la persona y lo que persiste el navegador: la clave no puede estar en ninguno. */
  const fuga = (clave: string) =>
    document.body.innerHTML.includes(clave) ||
    Object.keys(localStorage).concat(Object.values(localStorage)).some((x) => x.includes(clave)) ||
    Object.keys(sessionStorage).concat(Object.values(sessionStorage)).some((x) => x.includes(clave));

  it("sin clave: «No configurada», campo password vacío y sin botón de borrar", async () => {
    montar();
    expect((await screen.findByTestId("ajustes-eleven-estado")).textContent).toBe("No configurada");
    expect(campo().type).toBe("password");
    expect(campo().value).toBe("");
    expect(campo().autocomplete).toBe("new-password");
    expect(t("ajustes-eleven-borrar")).toBeNull();
    expect((screen.getByTestId("ajustes-eleven-guardar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("con clave: «Configurada», campo vacío siempre y botón de borrar", async () => {
    montar({ getSettings: vi.fn(async () => ajustes(true)) as never });
    await waitFor(() => expect(t("ajustes-eleven-estado")?.textContent).toBe("Configurada"));
    expect(campo().value).toBe("");
    expect(t("ajustes-eleven-borrar")).not.toBeNull();
  });

  it("guardar valida primero, envía la clave una vez y el campo queda vacío (clave_nunca_en_dom)", async () => {
    const validateElevenlabsKey = vi.fn(async () => ({ valida: true, detalle: null }));
    const putSettings = vi.fn(async () => ajustes(true));
    montar({ validateElevenlabsKey, putSettings } as never);
    await screen.findByTestId("ajustes-eleven-estado");
    escribir(CLAVE);
    fireEvent.click(screen.getByTestId("ajustes-eleven-guardar"));
    await waitFor(() => expect(t("ajustes-eleven-estado")?.textContent).toBe("Configurada"));
    expect(validateElevenlabsKey).toHaveBeenCalledWith(CLAVE);
    expect(putSettings).toHaveBeenCalledTimes(1);
    expect(putSettings).toHaveBeenCalledWith({ elevenlabs_api_key: CLAVE });
    expect(validateElevenlabsKey.mock.invocationCallOrder[0]).toBeLessThan(putSettings.mock.invocationCallOrder[0]!);
    expect(campo().value).toBe("");
    expect(fuga(CLAVE)).toBe(false);
  });

  it("el campo se vacía al enviar, aunque la validación tarde: la clave no se queda en el DOM", async () => {
    let soltar: (v: { valida: boolean; detalle: string | null }) => void = () => {};
    const validateElevenlabsKey = vi.fn(() => new Promise<{ valida: boolean; detalle: string | null }>((r) => (soltar = r)));
    montar({ validateElevenlabsKey, putSettings: vi.fn(async () => ajustes(true)) } as never);
    await screen.findByTestId("ajustes-eleven-estado");
    escribir(CLAVE);
    fireEvent.click(screen.getByTestId("ajustes-eleven-guardar"));
    await waitFor(() => expect(validateElevenlabsKey).toHaveBeenCalled());
    expect(campo().value).toBe("");
    expect(fuga(CLAVE)).toBe(false);
    expect((screen.getByTestId("ajustes-eleven-guardar") as HTMLButtonElement).disabled).toBe(true); // no se envía dos veces
    await act(async () => soltar({ valida: true, detalle: null }));
    await waitFor(() => expect(t("ajustes-eleven-estado")?.textContent).toBe("Configurada"));
  });

  it("una clave que ElevenLabs no reconoce no se guarda y se explica", async () => {
    const putSettings = vi.fn(async () => ajustes(true));
    montar({ validateElevenlabsKey: vi.fn(async () => ({ valida: false, detalle: "ElevenLabs no reconoce esta clave." })), putSettings } as never);
    await screen.findByTestId("ajustes-eleven-estado");
    escribir(CLAVE);
    fireEvent.click(screen.getByTestId("ajustes-eleven-guardar"));
    const e = await screen.findByTestId("ajustes-eleven-error");
    expect(e.textContent).toBe("ElevenLabs no reconoce esta clave.");
    expect(e.getAttribute("role")).toBe("alert");
    expect(putSettings).not.toHaveBeenCalled();
    expect(t("ajustes-eleven-estado")?.textContent).toBe("No configurada");
    expect(fuga(CLAVE)).toBe(false);
  });

  it("un error de red que repitiera la clave no la deja en pantalla", async () => {
    const putSettings = vi.fn();
    montar({ validateElevenlabsKey: vi.fn(async () => { throw new ApiError(502, `No se pudo conectar con ElevenLabs (xi-api-key: ${CLAVE}) en C:\\Users\\Marc\\x`); }), putSettings } as never);
    await screen.findByTestId("ajustes-eleven-estado");
    escribir(CLAVE);
    fireEvent.click(screen.getByTestId("ajustes-eleven-guardar"));
    const e = await screen.findByTestId("ajustes-eleven-error");
    expect(e.textContent).toContain("No se pudo conectar con ElevenLabs");
    expect(e.textContent).not.toContain(CLAVE);
    expect(e.textContent).not.toContain("Marc");
    expect(putSettings).not.toHaveBeenCalled();
    expect(fuga(CLAVE)).toBe(false);
  });

  it("si falla el guardado, tampoco queda la clave en pantalla", async () => {
    montar({ validateElevenlabsKey: vi.fn(async () => ({ valida: true, detalle: null })), putSettings: vi.fn(async () => { throw new ApiError(500, `fallo con ${CLAVE}`); }) } as never);
    await screen.findByTestId("ajustes-eleven-estado");
    escribir(CLAVE);
    fireEvent.click(screen.getByTestId("ajustes-eleven-guardar"));
    await screen.findByTestId("ajustes-eleven-error");
    expect(fuga(CLAVE)).toBe(false);
    expect(t("ajustes-eleven-estado")?.textContent).toBe("No configurada");
  });

  it("borrar envía la cadena vacía y vuelve a «No configurada»", async () => {
    let con = true;
    const putSettings = vi.fn(async () => ajustes((con = false)));
    montar({ getSettings: vi.fn(async () => ajustes(con)) as never, putSettings } as never);
    await waitFor(() => expect(t("ajustes-eleven-estado")?.textContent).toBe("Configurada"));
    fireEvent.click(screen.getByTestId("ajustes-eleven-borrar"));
    await waitFor(() => expect(t("ajustes-eleven-estado")?.textContent).toBe("No configurada"));
    expect(putSettings).toHaveBeenCalledWith({ elevenlabs_api_key: "" });
    expect(t("ajustes-eleven-borrar")).toBeNull();
  });

  it("una clave solo de espacios no se envía", async () => {
    const validateElevenlabsKey = vi.fn();
    montar({ validateElevenlabsKey } as never);
    await screen.findByTestId("ajustes-eleven-estado");
    escribir("   ");
    expect((screen.getByTestId("ajustes-eleven-guardar") as HTMLButtonElement).disabled).toBe(true);
    expect(validateElevenlabsKey).not.toHaveBeenCalled();
  });
});

describe("sinRutas", () => {
  it.each([
    ["No se pudo escribir en C:\\Users\\Marc Serra\\AppData\\x.tmp <b>", "No se pudo escribir en … <b>"],
    ["fallo en D:/Mis Datos/seo studio/a.json.", "fallo en …"],
    ["no existe \\\\srv\\compartido\\Mis Cosas\\f.bin", "no existe …"],
    ["no existe \\\\?\\C:\\Users\\Marc\\f", "no existe …"],
    ["abre '/home/marc/Mis Cosas/chrome' ya", "abre '…' ya"],
    ["(/Users/marc/x)", "(…)"],
    ["Content-Type application/json y 1/2 o y/o", "Content-Type application/json y 1/2 o y/o"],
    ["ver https://storage.googleapis.com/chrome/x.zip", "ver https://storage.googleapis.com/chrome/x.zip"],
  ])("%s", (entrada, salida) => {
    expect(sinRutas(entrada)).toBe(salida);
  });
  it.each(["Marc Serra", "AppData", "compartido", "Mis Cosas"])("no deja «%s»", (nombre) => {
    for (const r of [`C:\\Users\\${nombre}\\x`, `\\\\srv\\${nombre}\\x`, `/srv/${nombre}/x`]) expect(sinRutas(`error en ${r} fin`)).not.toContain(nombre);
  });
});

