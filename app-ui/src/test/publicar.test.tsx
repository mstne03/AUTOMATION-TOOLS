import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../api/client";
import { ClientContext } from "../api/context";
import type { Settings } from "../api/types";

vi.mock("../dialogo", () => ({ elegirVideo: vi.fn() }));
import { elegirVideo } from "../dialogo";
import { PublicarScreen } from "../screens/PublicarScreen";

const DIR = "C:\\Users\\Marc\\Videos";

function montar(extra: Partial<Client> = {}) {
  const settings = {
    model: "claude-opus-5-5",
    models: ["claude-opus-5-5"],
    allowed_dirs: [{ path: DIR, language: "es" }],
    profile: "default",
    has_anthropic_key: true,
    has_client_secret: true,
    state_dir: "C:\\estado",
    secret_store: "FileSecretStore",
  } as Settings;
  const client = { getSettings: vi.fn(async () => settings), ...extra } as unknown as Client;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClientContext.Provider value={client}>
        <PublicarScreen />
      </ClientContext.Provider>
    </QueryClientProvider>,
  );
}

describe("PublicarScreen", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("Elegir vídeo… abre el diálogo en la primera carpeta permitida y rellena la ruta", async () => {
    vi.mocked(elegirVideo).mockResolvedValueOnce(`${DIR}\\demo cs finance.mp4`);
    montar();
    const boton = await screen.findByTestId("publicar-elegir");
    await waitFor(() => expect((boton as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("publicar-subir-motivo").textContent).toContain("Falta elegir un vídeo");

    fireEvent.click(boton);
    await waitFor(() => expect((screen.getByTestId("publicar-path") as HTMLInputElement).value).toBe(`${DIR}\\demo cs finance.mp4`));
    expect(elegirVideo).toHaveBeenCalledWith(DIR);
    expect((screen.getByTestId("publicar-transcribir") as HTMLButtonElement).disabled).toBe(false);
    // E3: el botón de subir explica por qué sigue deshabilitado
    expect((screen.getByTestId("publicar-subir") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("publicar-subir-motivo").textContent).toBe("Falta el título del borrador.");

    fireEvent.change(screen.getByTestId("borrador-title"), { target: { value: "Demo" } });
    expect((screen.getByTestId("publicar-subir") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("publicar-subir-motivo")).toBeNull();
  });

  it("cancelar el diálogo (o no estar en Tauri) deja la ruta como estaba", async () => {
    vi.mocked(elegirVideo).mockResolvedValueOnce(null);
    montar();
    const boton = await screen.findByTestId("publicar-elegir");
    await waitFor(() => expect((boton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByTestId("publicar-path"), { target: { value: `${DIR}\\a.mp4` } });
    fireEvent.click(boton);
    await waitFor(() => expect(elegirVideo).toHaveBeenCalled());
    expect((screen.getByTestId("publicar-path") as HTMLInputElement).value).toBe(`${DIR}\\a.mp4`);
  });

  // E6: el job devuelve full_text (no text); antes la UI volcaba el JSON entero en el textarea.
  const jobHecho = (full_text: string) => ({
    id: "j1",
    kind: "transcribe",
    status: "done",
    progress: 1,
    result: { full_text, segments: [], language: "es", notes: full_text ? [] : ["No speech detected in the file."] },
    error: null,
  });

  async function transcribir(full_text: string) {
    montar({ createJob: vi.fn(async () => jobHecho(full_text)) } as unknown as Partial<Client>);
    const boton = await screen.findByTestId("publicar-transcribir");
    fireEvent.change(screen.getByTestId("publicar-path"), { target: { value: `${DIR}\\a.mp4` } });
    await waitFor(() => expect((boton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(boton);
  }

  it("la transcripción muestra full_text", async () => {
    await transcribir("hola a todos");
    await waitFor(() => expect((screen.getByTestId("publicar-transcripcion") as HTMLTextAreaElement).value).toBe("hola a todos"));
  });

  it("sin voz avisa en vez de mostrar el JSON del job", async () => {
    await transcribir("");
    await screen.findByTestId("publicar-sin-voz");
    expect(screen.queryByTestId("publicar-transcripcion")).toBeNull();
  });
});
