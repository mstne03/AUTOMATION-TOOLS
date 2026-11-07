import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../api/client";
import { ClientContext } from "../api/context";
import { cargar, desvincularCliente, reiniciarEditor, seleccionar, useEditor, vincularCliente } from "../state/editor";
import type { Proyecto, Recurso } from "../video/modelo";
import { Panel } from "../video/panel/Panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";

const HOSTIL = "<img src=x onerror=alert(1)>";
const BANDEJA = "a".repeat(32);

const proyecto = (extra: Partial<Proyecto> = {}): Proyecto => ({
  version: 1,
  id: "video001",
  revision: 3,
  titulo: "Cocina",
  gancho: "Prueba esto",
  aspecto: "9:16",
  perfilId: "defecto",
  creado: "2026-11-07T10:00:00Z",
  actualizado: "2026-11-07T10:00:00Z",
  frases: [
    { id: "f1", texto: "Hola" },
    { id: "f2", texto: "Adiós" },
  ],
  escenas: [{ id: "e1", fraseIds: ["f1", "f2"], base: { tipo: "cartel", texto: "Hola" }, ajusteCorte: 0 }],
  recursos: [],
  subtitulos: { estilo: "karaoke", correcciones: [], cortes: [] },
  opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [] },
  ...extra,
});
const recurso = (extra: Partial<Recurso> = {}): Recurso => ({
  id: "r-0123456789abcdef",
  clase: "foto",
  ext: "jpg",
  nombreOriginal: "playa.jpg",
  ancho: 1440,
  alto: 2560,
  duracion: 0,
  ...extra,
});
const PERFIL = {
  id: "defecto",
  nombre: "Por defecto",
  voz: "VozUno12345",
  idioma: "es",
  colores: { fondo: "#101010", texto: "#ffffff", acento: "#ff3355", contorno: "#000000", secundario: "#888888" },
  fuente: "Anton",
};

function montar(client: Partial<Client> = {}, p: Proyecto = proyecto()) {
  const c = {
    videoProyectoGuardar: vi.fn(async () => ({ revision: 4, avisos: [] })),
    videoPerfiles: vi.fn(async () => [PERFIL, { ...PERFIL, id: "p-0123456789abcdef", nombre: "Mi canal" }]),
    videoVoces: vi.fn(async () => [
      { id: "VozUno12345", nombre: "Lucía" },
      { id: "VozDos67890", nombre: "Mateo" },
    ]),
    ...client,
  } as unknown as Client;
  vincularCliente(c);
  cargar(p);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ClientContext.Provider value={c}>
        <Panel />
      </ClientContext.Provider>
    </QueryClientProvider>,
  );
  return c;
}
const t = (id: string) => screen.queryByTestId(id);
const g = (id: string) => screen.getByTestId(id);
const pestana = (n: string) => fireEvent.click(screen.getByRole("radio", { name: n }));
const proy = () => useEditor.getState().proyecto!;

afterEach(() => {
  cleanup();
  reiniciarEditor();
  desvincularCliente();
  vi.mocked(invoke).mockReset();
  vi.useRealTimers();
});

describe("pestañas", () => {
  it("muestra una pestaña cada vez", () => {
    montar();
    expect(t("panel-pestanas")).not.toBeNull();
    expect(t("panel-escena")).not.toBeNull();
    expect(t("panel-recursos")).toBeNull();
    pestana("Recursos");
    expect(t("panel-recursos")).not.toBeNull();
    expect(t("panel-escena")).toBeNull();
    pestana("Perfil");
    expect(t("panel-perfil")).not.toBeNull();
  });
});

describe("escena", () => {
  it("sin escena seleccionada avisa", () => {
    montar();
    expect(t("escena-vacia")).not.toBeNull();
    expect(t("escena-tipo")).toBeNull();
  });

  it("edita los campos del tipo y solo escribe por editar()", () => {
    montar();
    act(() => seleccionar("e1"));
    fireEvent.change(within(g("escena-campo-texto")).getByRole("textbox"), { target: { value: "Nuevo" } });
    expect(proy().escenas[0].base).toEqual({ tipo: "cartel", texto: "Nuevo" });
    expect(useEditor.getState().historial).toHaveLength(1);
    expect(useEditor.getState().guardado).toBe("pendiente");
    // el subtexto vacío no deja una clave vacía
    fireEvent.change(within(g("escena-campo-subtexto")).getByRole("textbox"), { target: { value: "x" } });
    fireEvent.change(within(g("escena-campo-subtexto")).getByRole("textbox"), { target: { value: "" } });
    expect(proy().escenas[0].base).toEqual({ tipo: "cartel", texto: "Nuevo" });
  });

  it("cambiar_tipo_conserva_frases", () => {
    montar();
    act(() => seleccionar("e1"));
    fireEvent.change(g("escena-tipo"), { target: { value: "cifra" } });
    const e = proy().escenas[0];
    expect(e.base.tipo).toBe("cifra");
    expect(e.fraseIds).toEqual(["f1", "f2"]);
    expect(proy().frases.map((f) => f.texto)).toEqual(["Hola", "Adiós"]);
    expect(t("escena-campo-valor")).not.toBeNull();
    expect(t("escena-campo-texto")).toBeNull();
    // un tipo con campos de texto obligatorios nace válido
    fireEvent.change(g("escena-tipo"), { target: { value: "titulo3d" } });
    const b = proy().escenas[0].base;
    expect(b.tipo).toBe("titulo3d");
    expect("texto" in b && b.texto.length).toBeGreaterThan(0);
  });

  it("los números inválidos no entran en el proyecto", () => {
    montar();
    act(() => seleccionar("e1"));
    fireEvent.change(g("escena-tipo"), { target: { value: "cifra" } });
    fireEvent.change(within(g("escena-campo-valor")).getByRole("spinbutton"), { target: { value: "42" } });
    expect(proy().escenas[0].base).toMatchObject({ valor: 42 });
    fireEvent.change(within(g("escena-campo-valor")).getByRole("spinbutton"), { target: { value: "" } });
    expect(proy().escenas[0].base).toMatchObject({ valor: 42 });
  });

  it("edita el texto de cada frase", () => {
    montar();
    act(() => seleccionar("e1"));
    fireEvent.change(within(g("escena-frase-f2")).getByRole("textbox"), { target: { value: "Hasta luego" } });
    expect(proy().frases[1].texto).toBe("Hasta luego");
    expect(proy().frases[0].texto).toBe("Hola");
  });

  it("la capa se cambia o se quita", () => {
    const p = proyecto();
    p.recursos = [recurso()];
    p.escenas[0].capa = { recursoId: "r-0123456789abcdef", modo: "encima", encuadre: "marco", entrada: 0, salida: 2 };
    montar({}, p);
    act(() => seleccionar("e1"));
    fireEvent.change(g("escena-capa-encuadre"), { target: { value: "zoom" } });
    expect(proy().escenas[0].capa?.encuadre).toBe("zoom");
    fireEvent.click(g("escena-capa-quitar"));
    expect(proy().escenas[0].capa).toBeUndefined();
  });

  it("la capa «detrás» no se ofrece en un título 3D", () => {
    const p = proyecto();
    p.escenas[0].base = { tipo: "titulo3d", texto: "HOLA" };
    p.escenas[0].capa = { recursoId: "r-0123456789abcdef", modo: "encima", encuadre: "marco", entrada: 0, salida: 2 };
    montar({}, p);
    act(() => seleccionar("e1"));
    const valores = Array.from(g("escena-capa-modo").querySelectorAll("option")).map((o) => o.value);
    expect(valores).toEqual(["encima"]);
  });
});

describe("recursos", () => {
  it("recursos-aviso (D9) siempre visible", () => {
    montar();
    pestana("Recursos");
    expect(g("recursos-aviso").textContent).toMatch(/retransmisiones/i);
    expect(g("recursos-aviso").textContent).toMatch(/licencia/i);
  });

  it("añadir foto: diálogo nativo, solo bandeja_id y recurso en el proyecto", async () => {
    vi.mocked(invoke).mockResolvedValue(BANDEJA);
    const c = montar({
      videoRecursoAnadir: vi.fn(async () => ({ recurso: recurso(), avisos: [{ codigo: "baja", mensaje: "Resolución justa" }] })),
    });
    pestana("Recursos");
    fireEvent.click(g("recursos-anadir-foto"));
    await waitFor(() => expect(t("recurso-r-0123456789abcdef")).not.toBeNull());
    expect(invoke).toHaveBeenCalledWith("importar_recurso", { clase: "foto" });
    expect(c.videoRecursoAnadir).toHaveBeenCalledWith("video001", BANDEJA, "foto");
    expect(proy().recursos.map((r) => r.id)).toEqual(["r-0123456789abcdef"]);
    expect(g("recurso-aviso-r-0123456789abcdef").textContent).toContain("Resolución justa");
    expect(t("recursos-aviso")).not.toBeNull();
  });

  it("cancelar el diálogo no llama al servidor", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const c = montar({ videoRecursoAnadir: vi.fn() });
    pestana("Recursos");
    fireEvent.click(g("recursos-anadir-clip"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("importar_recurso", { clase: "clip" }));
    expect(c.videoRecursoAnadir).not.toHaveBeenCalled();
    expect(t("recursos-error")).toBeNull();
  });

  it("nombre_html_es_texto", () => {
    montar({}, proyecto({ recursos: [recurso({ nombreOriginal: HOSTIL })] }));
    pestana("Recursos");
    const fila = g("recurso-r-0123456789abcdef");
    expect(fila.textContent).toContain(HOSTIL);
    expect(fila.querySelector("img")).toBeNull();
  });

  it("que_debe_salir se pinta como texto", () => {
    const p = proyecto();
    p.escenas[0].recursoPendiente = { tipo: "foto", que_debe_salir: HOSTIL, resolucion_minima: { ancho: 1080, alto: 1920 } };
    montar({}, p);
    pestana("Recursos");
    expect(g("recurso-pendiente-e1").textContent).toContain(HOSTIL);
    expect(g("recursos-pendientes").querySelector("img")).toBeNull();
  });

  it("error_sin_rutas", async () => {
    vi.mocked(invoke).mockResolvedValue(BANDEJA);
    montar({ videoRecursoAnadir: vi.fn(async () => Promise.reject(new Error("no se pudo en C:\\Users\\marc\\secreto\\x.png ya"))) });
    pestana("Recursos");
    fireEvent.click(g("recursos-anadir-foto"));
    const e = await screen.findByTestId("recursos-error");
    expect(e.textContent).not.toContain("marc");
    expect(e.textContent).not.toContain("secreto");
    expect(e.getAttribute("role")).toBe("alert");
  });

  it("error del diálogo nativo sin rutas", async () => {
    vi.mocked(invoke).mockRejectedValue("fallo en /home/marc/privado/x.png");
    montar();
    pestana("Recursos");
    fireEvent.click(g("recursos-anadir-foto"));
    const e = await screen.findByTestId("recursos-error");
    expect(e.textContent).not.toContain("privado");
  });

  it("borrar quita el recurso; un 409 se ve y lo conserva", async () => {
    const borrar = vi.fn().mockRejectedValueOnce(new Error("El recurso está en uso")).mockResolvedValueOnce({});
    montar({ videoRecursoBorrar: borrar }, proyecto({ recursos: [recurso()] }));
    pestana("Recursos");
    fireEvent.click(g("recurso-borrar-r-0123456789abcdef"));
    expect((await screen.findByTestId("recursos-error")).textContent).toContain("en uso");
    expect(proy().recursos).toHaveLength(1);
    fireEvent.click(g("recurso-borrar-r-0123456789abcdef"));
    await waitFor(() => expect(proy().recursos).toHaveLength(0));
    expect(borrar).toHaveBeenLastCalledWith("video001", "r-0123456789abcdef");
  });

  it("avisa de la foto por debajo de la resolución mínima", () => {
    montar({}, proyecto({ recursos: [recurso({ ancho: 800, alto: 1200 })] }));
    pestana("Recursos");
    expect(g("recurso-aviso-r-0123456789abcdef").textContent).toMatch(/1080/);
  });

  it("pendientes_senalados", () => {
    const p = proyecto();
    p.escenas[0].recursoPendiente = { tipo: "clip", que_debe_salir: "Un gol", resolucion_minima: { ancho: 1080, alto: 1920 } };
    montar({}, p);
    pestana("Recursos");
    const fila = g("recurso-pendiente-e1");
    expect(fila.textContent).toContain("Un gol");
    expect(within(g("recursos-pendientes")).getAllByTestId(/^recurso-pendiente-/)).toHaveLength(1);
    fireEvent.click(within(fila).getByRole("button"));
    expect(useEditor.getState().seleccion).toBe("e1");
  });

  it("sin pendientes no hay lista de pendientes", () => {
    montar();
    pestana("Recursos");
    expect(t("recursos-pendientes")).toBeNull();
  });
});

describe("perfil", () => {
  it("perfil_cambia_y_preview_recarga: elegir otro perfil edita perfilId y marca pendiente", async () => {
    montar();
    pestana("Perfil");
    const sel = (await screen.findByTestId("perfil-selector")) as HTMLSelectElement;
    await waitFor(() => expect(sel.options.length).toBe(2));
    fireEvent.change(sel, { target: { value: "p-0123456789abcdef" } });
    expect(proy().perfilId).toBe("p-0123456789abcdef");
    expect(useEditor.getState().guardado).toBe("pendiente");
  });

  it("duplicar crea el perfil en el servidor y lo selecciona", async () => {
    const duplicar = vi.fn(async () => ({ ...PERFIL, id: "p-fedcba9876543210", nombre: "Copia" }));
    montar({ videoPerfilDuplicar: duplicar });
    pestana("Perfil");
    await screen.findByTestId("perfil-selector");
    await waitFor(() => expect((g("perfil-duplicar") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(g("perfil-duplicar"));
    await waitFor(() => expect(proy().perfilId).toBe("p-fedcba9876543210"));
    expect(duplicar).toHaveBeenCalledWith("defecto");
  });

  it("editar un color guarda el perfil y vuelve a cargar la preview", async () => {
    const guardarPerfil = vi.fn(async (_id: string, p: unknown) => p);
    montar({ videoPerfilGuardar: guardarPerfil as unknown as Client["videoPerfilGuardar"] });
    pestana("Perfil");
    const campo = await screen.findByTestId("perfil-color-acento");
    const input = within(campo).getByRole("textbox");
    fireEvent.change(input, { target: { value: "#00ff00" } });
    fireEvent.blur(input);
    await waitFor(() => expect(guardarPerfil).toHaveBeenCalled());
    const [pid, cuerpo] = guardarPerfil.mock.calls[0] as [string, typeof PERFIL];
    expect(pid).toBe("defecto");
    expect(cuerpo.colores).toEqual({ ...PERFIL.colores, acento: "#00ff00" });
    expect(cuerpo.id).toBe("defecto");
    // el proyecto cambia (revisión nueva) y la preview se recarga
    await waitFor(() => expect(useEditor.getState().guardado).toBe("pendiente"));
  });

  it("cambiar la fuente guarda el perfil", async () => {
    const guardarPerfil = vi.fn(async (_id: string, p: unknown) => p);
    montar({ videoPerfilGuardar: guardarPerfil as unknown as Client["videoPerfilGuardar"] });
    pestana("Perfil");
    fireEvent.change(await screen.findByTestId("perfil-fuente"), { target: { value: "JetBrains Mono" } });
    await waitFor(() => expect(guardarPerfil).toHaveBeenCalled());
    expect((guardarPerfil.mock.calls[0][1] as typeof PERFIL).fuente).toBe("JetBrains Mono");
  });

  it("error_sin_rutas del perfil", async () => {
    montar({ videoPerfilGuardar: vi.fn(async () => Promise.reject(new Error("422 en C:\\Users\\marc\\perfiles\\x.json"))) });
    pestana("Perfil");
    fireEvent.change(await screen.findByTestId("perfil-fuente"), { target: { value: "Inter Tight" } });
    const e = await screen.findByTestId("perfil-error");
    expect(e.textContent).not.toContain("marc");
  });

  it("muestra_voz_pide_coste: escuchar no gasta hasta confirmar los 60 caracteres", async () => {
    const muestra = vi.fn(async () => ({}));
    montar({ videoVozMuestra: muestra });
    pestana("Perfil");
    await screen.findByTestId("perfil-voz");
    await waitFor(() => expect((g("perfil-voz") as HTMLSelectElement).options.length).toBe(2));
    fireEvent.click(g("perfil-voz-escuchar"));
    const dialogo = await screen.findByRole("dialog");
    expect(dialogo.textContent).toMatch(/60 caracteres/);
    expect(muestra).not.toHaveBeenCalled();
    // cancelar tampoco gasta
    fireEvent.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    expect(muestra).not.toHaveBeenCalled();
    fireEvent.click(g("perfil-voz-escuchar"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Generar muestra/ }));
    await waitFor(() => expect(muestra).toHaveBeenCalledWith("VozUno12345", 60));
  });

  it("el error de la muestra se ve sin rutas", async () => {
    montar({ videoVozMuestra: vi.fn(async () => Promise.reject(new Error("Falta la clave en /home/marc/x/y"))) });
    pestana("Perfil");
    await waitFor(() => expect((g("perfil-voz") as HTMLSelectElement).options.length).toBe(2));
    fireEvent.click(g("perfil-voz-escuchar"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Generar muestra/ }));
    const e = await screen.findByTestId("perfil-error");
    expect(e.textContent).not.toContain("marc");
  });

  it("el nombre del perfil es texto", async () => {
    montar({ videoPerfiles: vi.fn(async () => [{ ...PERFIL, nombre: HOSTIL }]) });
    pestana("Perfil");
    const sel = await screen.findByTestId("perfil-selector");
    await waitFor(() => expect(sel.textContent).toContain(HOSTIL));
    expect(g("panel-perfil").querySelector("img")).toBeNull();
  });
});
