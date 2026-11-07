import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Client } from "../api/client";
import { ClientContext } from "../api/context";
import type { ProyectoVideoResumen } from "../api/types";
import { EditorVideoScreen } from "../screens/EditorVideoScreen";
import { VideoScreen } from "../screens/VideoScreen";
import {
  desvincularCliente,
  editar,
  guardar,
  reiniciarEditor,
  useEditor,
} from "../state/editor";
import { Toaster, reiniciarToasts } from "../ui";
import type { Proyecto } from "../video/modelo";

const HOSTIL = "<img src=x onerror=alert(1)>";
const resumen = (
  id: string,
  estado: ProyectoVideoResumen["estado"],
  extra: Partial<ProyectoVideoResumen> = {},
): ProyectoVideoResumen => ({
  id,
  titulo: `Vídeo ${id}`,
  perfil: "defecto",
  duracion: 75,
  actualizado: "2026-11-07T10:00:00Z",
  estado,
  ...extra,
});
const proyecto = (extra: Partial<Proyecto> = {}): Proyecto => ({
  version: 1,
  id: "p1",
  revision: 3,
  titulo: "Cocina",
  gancho: "Prueba esto",
  aspecto: "9:16",
  perfilId: "defecto",
  creado: "2026-11-07T10:00:00Z",
  actualizado: "2026-11-07T10:00:00Z",
  frases: [{ id: "f1", texto: "Hola" }],
  escenas: [
    {
      id: "e1",
      fraseIds: ["f1"],
      base: { tipo: "cartel", texto: "Hola" },
      ajusteCorte: 0,
    },
  ],
  recursos: [],
  subtitulos: { estilo: "karaoke", correcciones: [], cortes: [] },
  opciones: {
    fondo: "ninguno",
    look: "normal",
    subtitulos: "karaoke",
    destellos: [],
  },
  ...extra,
});

function montar(client: Partial<Client>, ruta = "/video") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClientContext.Provider value={client as Client}>
        <MemoryRouter initialEntries={[ruta]}>
          <Routes>
            <Route path="/video" element={<VideoScreen />} />
            <Route path="/video/:id" element={<EditorVideoScreen />} />
            <Route path="/guiones" element={<p>guiones</p>} />
          </Routes>
        </MemoryRouter>
      </ClientContext.Provider>
      <Toaster />
    </QueryClientProvider>,
  );
}
const t = (id: string) => screen.queryByTestId(id);

afterEach(() => {
  cleanup();
  reiniciarEditor();
  desvincularCliente();
  reiniciarToasts();
  vi.useRealTimers();
});

describe("lista de proyectos", () => {
  it("lista_estados: los cuatro estados llevan su data-estado", async () => {
    montar({
      videoProyectos: vi.fn(async () => [
        resumen("a", "borrador"),
        resumen("b", "renderizando"),
        resumen("c", "listo"),
        resumen("d", "error"),
      ]),
    });
    await screen.findByTestId("video-lista");
    for (const [id, estado] of [
      ["a", "borrador"],
      ["b", "renderizando"],
      ["c", "listo"],
      ["d", "error"],
    ]) {
      expect(
        t(`video-proyecto-estado-${id}`)!.getAttribute("data-estado"),
      ).toBe(estado);
    }
    expect(t("video-proyecto-a")!.textContent).toContain("Vídeo a");
    expect(t("video-proyecto-a")!.textContent).toContain("1:15");
    expect(t("video-proyecto-a")!.textContent).toContain("defecto");
  });

  it("titulo_html_es_texto: el título con HTML se pinta como texto", async () => {
    montar({
      videoProyectos: vi.fn(async () => [
        resumen("a", "borrador", { titulo: HOSTIL, perfil: HOSTIL }),
      ]),
    });
    const fila = await screen.findByTestId("video-proyecto-a");
    expect(fila.textContent).toContain(HOSTIL);
    expect(fila.querySelector("img")).toBeNull();
  });

  it("borrar_pide_confirmacion: no borra hasta confirmar, y cancelar no borra", async () => {
    const borrar = vi.fn(async () => ({}));
    montar({
      videoProyectos: vi.fn(async () => [
        resumen("a", "borrador", { titulo: HOSTIL }),
      ]),
      videoProyectoBorrar: borrar,
    });
    await screen.findByTestId("video-lista");
    fireEvent.click(t("video-proyecto-borrar-a")!);
    const dialogo = await screen.findByRole("dialog");
    expect(dialogo.textContent).toContain(HOSTIL);
    expect(dialogo.querySelector("img")).toBeNull();
    expect(borrar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(borrar).not.toHaveBeenCalled();
    fireEvent.click(t("video-proyecto-borrar-a")!);
    fireEvent.click(await screen.findByRole("button", { name: "Borrar" }));
    await waitFor(() => expect(borrar).toHaveBeenCalledWith("a"));
  });

  it("si el borrado falla (409) se avisa con el texto del servidor", async () => {
    montar({
      videoProyectos: vi.fn(async () => [resumen("a", "renderizando")]),
      videoProyectoBorrar: vi.fn(async () =>
        Promise.reject(new ApiError(409, "Hay un render en curso")),
      ),
    });
    await screen.findByTestId("video-lista");
    fireEvent.click(t("video-proyecto-borrar-a")!);
    fireEvent.click(await screen.findByRole("button", { name: "Borrar" }));
    expect(await screen.findByText("Hay un render en curso")).toBeTruthy();
  });

  it("estado vacío, sin motor (503) y error", async () => {
    montar({ videoProyectos: vi.fn(async () => []) });
    expect(await screen.findByTestId("video-vacio")).toBeTruthy();
    expect(t("video-lista")).toBeNull();
    cleanup();
    montar({
      videoProyectos: vi.fn(async () =>
        Promise.reject(
          new ApiError(
            503,
            "El módulo de vídeo no está instalado en esta versión.",
          ),
        ),
      ),
    });
    expect(await screen.findByTestId("video-sin-motor")).toBeTruthy();
    cleanup();
    montar({
      videoProyectos: vi.fn(async () =>
        Promise.reject(
          new ApiError(500, "Fallo en C:\\Users\\marc\\estado\\video\\p.json"),
        ),
      ),
    });
    const err = await screen.findByTestId("video-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).not.toContain("marc");
  });
});

describe("marco del editor", () => {
  const cliente = (extra: Partial<Client> = {}): Partial<Client> => ({
    videoProyecto: vi.fn(async () => proyecto()),
    videoProyectoGuardar: vi.fn(
      async (_id: string, c: { revision: number }) => ({
        revision: c.revision + 1,
        avisos: [],
      }),
    ),
    videoPreviewCerrar: vi.fn(async () => ({})),
    ...extra,
  });

  it("carga el proyecto, pinta título como texto y deja las zonas del layout B", async () => {
    montar(
      cliente({
        videoProyecto: vi.fn(async () => proyecto({ titulo: HOSTIL })),
      }),
      "/video/p1",
    );
    const titulo = await screen.findByTestId("editor-titulo");
    expect(titulo.textContent).toBe(HOSTIL);
    expect(titulo.querySelector("img")).toBeNull();
    expect(t("editor")).toBeTruthy();
    for (const z of [
      "editor-zona-preview",
      "editor-zona-panel",
      "editor-zona-timeline",
    ])
      expect(t(z)).toBeTruthy();
    expect(t("editor-guardado")!.textContent).toBe("Guardado");
    expect(t("editor-volver")!.getAttribute("href")).toBe("/video");
  });

  it("error de carga: editor-error sin rutas", async () => {
    montar(
      cliente({
        videoProyecto: vi.fn(async () =>
          Promise.reject(
            new ApiError(404, "No existe C:\\Users\\marc\\x\\p.json"),
          ),
        ),
      }),
      "/video/p1",
    );
    const err = await screen.findByTestId("editor-error");
    expect(err.textContent).not.toContain("marc");
    expect(t("editor")).toBeNull();
  });

  it("Ctrl+Z y Ctrl+Y deshacen y rehacen fuera de campos; dentro de un campo no", async () => {
    montar(cliente(), "/video/p1");
    await screen.findByTestId("editor");
    act(() => editar((p) => void (p.titulo = "Nuevo")));
    expect(t("editor-titulo")!.textContent).toBe("Nuevo");
    const campo = document.createElement("input");
    document.body.appendChild(campo);
    fireEvent.keyDown(campo, { key: "z", ctrlKey: true });
    expect(useEditor.getState().proyecto!.titulo).toBe("Nuevo");
    campo.remove();
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(useEditor.getState().proyecto!.titulo).toBe("Cocina");
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    expect(useEditor.getState().proyecto!.titulo).toBe("Nuevo");
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    fireEvent.keyDown(document.body, {
      key: "Z",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(useEditor.getState().proyecto!.titulo).toBe("Nuevo");
  });

  it("los botones deshacer y rehacer reflejan el historial", async () => {
    montar(cliente(), "/video/p1");
    await screen.findByTestId("editor");
    const des = t("editor-deshacer") as HTMLButtonElement;
    const reh = t("editor-rehacer") as HTMLButtonElement;
    expect(des.disabled).toBe(true);
    expect(reh.disabled).toBe(true);
    act(() => editar((p) => void (p.titulo = "Nuevo")));
    expect(des.disabled).toBe(false);
    fireEvent.click(des);
    expect(reh.disabled).toBe(false);
  });

  it("al salir cierra la preview (DELETE) y reinicia el editor", async () => {
    const cliente1 = cliente();
    const { unmount } = montar(cliente1, "/video/p1");
    await screen.findByTestId("editor");
    unmount();
    expect(cliente1.videoPreviewCerrar).toHaveBeenCalledWith("p1");
    expect(useEditor.getState().proyecto).toBeNull();
  });

  it("editor-conflicto: un 409 muestra el aviso, conserva la edición local y se puede recuperar", async () => {
    const remoto = proyecto({ revision: 5, titulo: "Remoto" });
    const guardarMock = vi.fn(async (_id: string, c: { revision: number }) => {
      if (c.revision === 3) throw new ApiError(409, "Revisión antigua");
      return { revision: c.revision + 1, avisos: [] };
    });
    montar(
      cliente({
        videoProyecto: vi
          .fn()
          .mockResolvedValueOnce(proyecto())
          .mockResolvedValue(remoto),
        videoProyectoGuardar: guardarMock,
      }),
      "/video/p1",
    );
    await screen.findByTestId("editor");
    expect(t("editor-conflicto")).toBeNull();
    act(() => editar((p) => void (p.titulo = "Mi edición")));
    await act(async () => {
      await guardar();
    });
    await screen.findByTestId("editor-conflicto");
    expect(t("editor-titulo")!.textContent).toBe("Remoto");
    expect(useEditor.getState().borrador!.titulo).toBe("Mi edición");
    expect(t("editor-guardado")!.textContent).toBe("Error al guardar");
    // Descartar y recuperar
    fireEvent.click(
      screen.getByRole("button", { name: "Recuperar mi edición" }),
    );
    expect(t("editor-conflicto")).toBeNull();
    expect(t("editor-titulo")!.textContent).toBe("Mi edición");
    expect(useEditor.getState().revision).toBe(5);
  });

  it("editor-conflicto: descartar se queda con la versión del servidor", async () => {
    const remoto = proyecto({ revision: 5, titulo: "Remoto" });
    montar(
      cliente({
        videoProyecto: vi
          .fn()
          .mockResolvedValueOnce(proyecto())
          .mockResolvedValue(remoto),
        videoProyectoGuardar: vi.fn(async () =>
          Promise.reject(new ApiError(409, "Revisión antigua")),
        ),
      }),
      "/video/p1",
    );
    await screen.findByTestId("editor");
    act(() => editar((p) => void (p.titulo = "Mi edición")));
    await act(async () => {
      await guardar();
    });
    await screen.findByTestId("editor-conflicto");
    fireEvent.click(screen.getByRole("button", { name: "Descartar la mía" }));
    expect(t("editor-conflicto")).toBeNull();
    expect(t("editor-titulo")!.textContent).toBe("Remoto");
    expect(t("editor-guardado")!.textContent).toBe("Guardado");
  });
});
