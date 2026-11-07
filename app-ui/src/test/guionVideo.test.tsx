import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Client } from "../api/client";
import { ClientContext } from "../api/context";
import { Escribir } from "../guiones/Escribir";
import { GuionVideo } from "../guiones/GuionVideo";
import { parcharEscribir, recibirRespuesta, reiniciarGuiones } from "../state/guiones";

const HOSTIL = "<img src=x onerror=alert(1)>";
const GUION = {
  version: 1,
  titulo: HOSTIL,
  gancho: HOSTIL,
  escenas: [
    { frases: [HOSTIL, "Segunda."], base: { tipo: "cartel", texto: HOSTIL } },
    { frases: ["Tres."], base: { tipo: "cifra", valor: 3, prefijo: "", sufijo: "", decimales: 0 }, recurso: { tipo: "foto", que_debe_salir: HOSTIL, resolucion_minima: { ancho: 1080, alto: 1920 } } },
  ],
  opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [] },
};

function montar(extra: Partial<Client> = {}) {
  parcharEscribir({ formato: "video", esperando: true });
  recibirRespuesta("escribir", JSON.stringify(GUION));
  const client = {
    videoGuionCrear: vi.fn(async () => ({ id: "g1", avisos: [] })),
    videoPerfiles: vi.fn(async () => [{ id: "defecto" }]),
    videoProyectoCrear: vi.fn(async () => ({ id: "p1" })),
    ...extra,
  } as unknown as Client;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ClientContext.Provider value={client}>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<GuionVideo />} />
            <Route path="/video/:id" element={<p data-testid="destino">editor</p>} />
          </Routes>
        </MemoryRouter>
      </ClientContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}

describe("GuionVideo", () => {
  afterEach(() => {
    cleanup();
    reiniciarGuiones();
  });

  it("html_del_modelo_es_texto: ningún campo del modelo crea nodos", () => {
    montar();
    expect(document.querySelector("img")).toBeNull();
    expect((screen.getByTestId("guion-video-titulo") as HTMLInputElement).value).toBe(HOSTIL);
    expect(screen.getAllByTestId("guion-video-frase")).toHaveLength(3);
    expect(screen.getByTestId("guion-video-recurso").textContent).toContain(HOSTIL);
    expect(screen.getByTestId("guion-video").querySelectorAll("img, script, [onerror]")).toHaveLength(0);
  });

  it("sin_llamada_sin_clic: pintar el guion no llama al servidor", () => {
    const c = montar();
    expect(c.videoGuionCrear).not.toHaveBeenCalled();
    expect(c.videoProyectoCrear).not.toHaveBeenCalled();
  });

  it("editar una frase y reordenar escenas", () => {
    montar();
    fireEvent.change(screen.getAllByTestId("guion-video-frase")[1], { target: { value: "Cambiada." } });
    expect((screen.getAllByTestId("guion-video-frase")[1] as HTMLTextAreaElement).value).toBe("Cambiada.");
    fireEvent.click(screen.getAllByTestId("guion-video-bajar")[0]);
    expect((screen.getAllByTestId("guion-video-frase")[0] as HTMLTextAreaElement).value).toBe("Tres.");
    expect((screen.getAllByTestId("guion-video-subir")[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("errores_servidor_como_texto: un 422 se pinta como texto con role=alert", async () => {
    montar({ videoGuionCrear: vi.fn(async () => { throw new ApiError(422, JSON.stringify({ problemas: [{ ruta: "escenas.0", mensaje: HOSTIL }] })); }) } as Partial<Client>);
    fireEvent.click(screen.getByTestId("guion-video-guardar"));
    const e = await screen.findByTestId("guion-video-errores");
    expect(e.getAttribute("role")).toBe("alert");
    expect(e.textContent).toContain(HOSTIL);
    expect(document.querySelector("img")).toBeNull();
  });

  it("Crear vídeo guarda, crea el proyecto y abre el editor", async () => {
    const c = montar();
    fireEvent.click(screen.getByTestId("guion-video-crear"));
    await waitFor(() => expect(screen.getByTestId("destino")).toBeTruthy());
    expect(c.videoGuionCrear).toHaveBeenCalledTimes(1);
    expect(c.videoProyectoCrear).toHaveBeenCalledWith("g1", "defecto");
  });

  it("si el guardado falla no hay proyecto ni navegación", async () => {
    const c = montar({ videoGuionCrear: vi.fn(async () => { throw new ApiError(422, "mal"); }) } as Partial<Client>);
    fireEvent.click(screen.getByTestId("guion-video-crear"));
    await screen.findByTestId("guion-video-errores");
    expect(c.videoProyectoCrear).not.toHaveBeenCalled();
    expect(screen.queryByTestId("destino")).toBeNull();
  });
});

describe("Escribir en formato Vídeo", () => {
  afterEach(() => {
    cleanup();
    reiniciarGuiones();
  });

  const montarEscribir = (esquema: Client["videoGuionEsquema"]) => {
    parcharEscribir({ formato: "video", tema: "tortilla" });
    const client = {
      videoGuionEsquema: vi.fn(esquema),
      youtubeTools: vi.fn(async () => [{ name: "youtube_retention_moments", risk: "read", quota: { bucket: "general", cost: 100 }, job_kind: null }]),
      getSettings: vi.fn(async () => ({ profile: "default" })),
      videoGuiones: vi.fn(async () => []),
    } as unknown as Client;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ClientContext.Provider value={client}>
          <MemoryRouter>
            <Escribir />
          </MemoryRouter>
        </ClientContext.Provider>
      </QueryClientProvider>,
    );
    return client;
  };

  it("sin_motor_no_genera: con 503 avisa y no deja generar", async () => {
    montarEscribir(async () => {
      throw new ApiError(503, "Módulo de vídeo no instalado");
    });
    expect((await screen.findByTestId("escribir-video-sin-motor")).textContent).toContain("motor de vídeo");
    expect((screen.getByTestId("escribir-generar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("avisa del coste en cuota: retención de 3 vídeos", async () => {
    montarEscribir(async () => ({ texto: "esquema" }));
    await waitFor(() => expect(screen.getByTestId("escribir-video-nota").textContent).toBe("Consulta tus vídeos y su retención: gasta cuota de YouTube, unas 300 unidades."));
    await waitFor(() => expect((screen.getByTestId("escribir-generar") as HTMLButtonElement).disabled).toBe(false));
  });
});
