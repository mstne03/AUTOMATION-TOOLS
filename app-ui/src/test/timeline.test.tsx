import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Client } from "../api/client";
import { ClientContext } from "../api/context";
import { cargar, deshacer, desvincularCliente, reiniciarEditor, useEditor, vincularCliente } from "../state/editor";
import { Toaster, reiniciarToasts } from "../ui";
import type { Proyecto } from "../video/modelo";
import { Timeline } from "../video/timeline/Timeline";

const HOSTIL = "<img src=x onerror=alert(1)>";

function proyecto(n = 3, extra: Partial<Proyecto> = {}): Proyecto {
  return {
    version: 1,
    id: "p1",
    revision: 1,
    titulo: "Cocina",
    gancho: "Prueba esto",
    aspecto: "9:16",
    perfilId: "defecto",
    creado: "2026-11-07T10:00:00Z",
    actualizado: "2026-11-07T10:00:00Z",
    frases: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, texto: `frase número ${i} de prueba` })),
    escenas: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, fraseIds: [`f${i}`], base: { tipo: "cartel" as const, texto: `Escena ${i}` }, ajusteCorte: 0 })),
    recursos: [],
    subtitulos: { estilo: "karaoke", correcciones: [], cortes: [] },
    opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [] },
    ...extra,
  };
}

const coste = (extra: Record<string, unknown> = {}) => ({
  pendientes: ["f0"],
  caracteres: 120,
  caracteresRefacturados: 0,
  fallidasFacturadas: [] as string[],
  plan: "plan-A",
  voz: { id: "v1", nombre: "Lucía" },
  ...extra,
});

function montar(p: Proyecto, extra: Partial<Client> = {}) {
  const client = {
    videoVozForma: vi.fn(async () => ({ picos: [0.1, 0.8, 0.3, 0.6], segundos: 9 })),
    videoVozCoste: vi.fn(async () => coste()),
    videoVozGenerar: vi.fn(async () => ({ generadas: 1 })),
    videoVozQuitarSilencios: vi.fn(async () => ({ recorte: { inicio: 0.2, fin: 1.1 } })),
    videoMusica: vi.fn(async () => [{ id: "m1", nombre: "Ritmo suave" }, { id: "m2", nombre: "Épica" }]),
    ...extra,
  } as unknown as Client;
  cargar(p);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (
    <QueryClientProvider client={qc}>
      <ClientContext.Provider value={client}>
        <MemoryRouter>
          <Timeline />
          <Toaster />
        </MemoryRouter>
      </ClientContext.Provider>
    </QueryClientProvider>
  );
  return { client, ...render(ui) };
}
const t = (id: string) => screen.queryByTestId(id);
const ids = () => useEditor.getState().proyecto!.escenas.map((e) => e.id);

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  cleanup();
  reiniciarToasts();
  reiniciarEditor();
  desvincularCliente();
  vi.restoreAllMocks();
});

describe("estructura", () => {
  it("pinta la regla, el cabezal y las cinco pistas con un clip por elemento", async () => {
    montar(proyecto(3));
    for (const id of ["timeline", "timeline-regla", "timeline-cabezal", "pista-escenas", "pista-recursos", "pista-voz", "pista-musica", "pista-subtitulos"]) {
      expect(t(id), id).not.toBeNull();
    }
    for (const i of [0, 1, 2]) {
      expect(t(`clip-escena-e${i}`)).not.toBeNull();
      expect(t(`clip-voz-f${i}`)).not.toBeNull();
    }
    expect(t("clip-subtitulo-0")).not.toBeNull();
    await waitFor(() => expect(document.querySelector("[data-testid=voz-onda]")).not.toBeNull());
  });

  it("seleccionar un clip de escena lo deja seleccionado en el store", () => {
    montar(proyecto(3));
    fireEvent.click(screen.getByTestId("clip-escena-e1"));
    expect(useEditor.getState().seleccion).toBe("e1");
    expect(screen.getByTestId("clip-escena-e1").getAttribute("aria-pressed")).toBe("true");
  });

  it("el clip de recurso aparece solo en la escena con capa y su nombre es texto", () => {
    const p = proyecto(2, { recursos: [{ id: "r1", clase: "foto", ext: "jpg", nombreOriginal: HOSTIL, ancho: 1080, alto: 1920, duracion: 0 }] });
    p.escenas[1].capa = { recursoId: "r1", modo: "encima", encuadre: "zoom", entrada: 0, salida: 1 };
    montar(p);
    expect(t("clip-recurso-e0")).toBeNull();
    const clip = screen.getByTestId("clip-recurso-e1");
    expect(clip.textContent).toContain(HOSTIL);
    expect(clip.querySelector("img")).toBeNull();
  });
});

describe("edición con deshacer", () => {
  it("reordenar_escenas: Alt+flecha mueve la escena y se puede deshacer", () => {
    montar(proyecto(3));
    const clip = screen.getByTestId("clip-escena-e0");
    fireEvent.keyDown(clip, { key: "ArrowRight", altKey: true });
    expect(ids()).toEqual(["e1", "e0", "e2"]);
    expect(useEditor.getState().historial).toHaveLength(1);
    deshacer();
    expect(ids()).toEqual(["e0", "e1", "e2"]);
  });

  it("no reordena más allá de los extremos", () => {
    montar(proyecto(2));
    fireEvent.keyDown(screen.getByTestId("clip-escena-e0"), { key: "ArrowLeft", altKey: true });
    expect(ids()).toEqual(["e0", "e1"]);
    expect(useEditor.getState().historial).toHaveLength(0);
  });

  it("recorte_ajusta_a_palabra: Mayús+flecha deja el final del recorte en un límite de palabra", async () => {
    montar(proyecto(1));
    // El reparto del recorte usa los segundos de la voz: hay que esperar a la forma de onda.
    await waitFor(() => expect(document.querySelector("[data-testid=voz-onda]")).not.toBeNull());
    const clip = screen.getByTestId("clip-voz-f0");
    fireEvent.keyDown(clip, { key: "ArrowLeft", shiftKey: true });
    const fr = useEditor.getState().proyecto!.frases[0];
    expect(fr.recorte).toBeDefined();
    const fin = fr.recorte!.fin;
    // 4 palabras en 9 s repartidas por caracteres: el fin debe ser el inicio o el fin de alguna palabra
    const texto = fr.texto.split(/\s+/);
    const total = texto.reduce((a, w) => a + w.length, 0);
    let acc = 0;
    const limites = [0];
    for (const w of texto) {
      acc += w.length;
      limites.push((acc / total) * 9);
    }
    expect(limites.some((l) => Math.abs(l - fin) < 0.02)).toBe(true);
    expect(fin).toBeLessThan(9);
    expect(useEditor.getState().historial).toHaveLength(1);
  });

  it("teclado_mueve_cabezal: flechas, Mayús, Inicio y Fin sobre la regla", () => {
    montar(proyecto(3));
    const regla = screen.getByTestId("timeline-regla");
    expect(regla.getAttribute("role")).toBe("slider");
    fireEvent.keyDown(regla, { key: "ArrowRight" });
    expect(useEditor.getState().tiempo).toBeCloseTo(0.1);
    fireEvent.keyDown(regla, { key: "ArrowRight", shiftKey: true });
    expect(useEditor.getState().tiempo).toBeCloseTo(1.1);
    fireEvent.keyDown(regla, { key: "ArrowLeft" });
    expect(useEditor.getState().tiempo).toBeCloseTo(1.0);
    fireEvent.keyDown(regla, { key: "Home" });
    expect(useEditor.getState().tiempo).toBe(0);
    fireEvent.keyDown(regla, { key: "ArrowLeft" });
    expect(useEditor.getState().tiempo).toBe(0);
    fireEvent.keyDown(regla, { key: "End" });
    expect(useEditor.getState().tiempo).toBeGreaterThan(0);
    const fin = useEditor.getState().tiempo;
    fireEvent.keyDown(regla, { key: "ArrowRight", shiftKey: true });
    expect(useEditor.getState().tiempo).toBe(fin);
    expect(regla.getAttribute("aria-valuenow")).toBe(String(Math.round(fin * 10) / 10));
  });
});

describe("voz y coste (I10)", () => {
  const confirmar = () => fireEvent.click(screen.getByTestId("voz-confirmar-ok"));

  it("voz-generar abre el diálogo con lo del servidor y no gasta hasta confirmar; envía su plan", async () => {
    const { client } = montar(proyecto(2));
    fireEvent.click(screen.getByTestId("voz-generar"));
    const c = await screen.findByTestId("voz-confirmar-coste");
    expect(c.textContent).toContain("120");
    expect(screen.getByTestId("voz-confirmar").textContent).toContain("Lucía");
    expect(client.videoVozGenerar).not.toHaveBeenCalled();
    confirmar();
    await waitFor(() => expect(client.videoVozGenerar).toHaveBeenCalledTimes(1));
    expect(client.videoVozGenerar).toHaveBeenCalledWith("p1", { plan_confirmado: "plan-A", caracteres_confirmados: 120, reintentar_facturadas: false });
    await waitFor(() => expect(t("voz-confirmar")).toBeNull());
  });

  it("regenerar una frase pide el coste de esa frase al servidor (con emoji) y envía su plan", async () => {
    const videoVozCoste = vi.fn(async () => coste({ pendientes: ["f1"], caracteres: 25, plan: "plan-f1" }));
    const { client } = montar(proyecto(3, { frases: [{ id: "f0", texto: "a" }, { id: "f1", texto: "hola 😀 mundo" }, { id: "f2", texto: "c" }] }), { videoVozCoste });
    fireEvent.click(screen.getByTestId("voz-regenerar-f1"));
    expect((await screen.findByTestId("voz-confirmar-coste")).textContent).toContain("25");
    expect(videoVozCoste).toHaveBeenLastCalledWith("p1", ["f1"]);
    expect(screen.getByTestId("voz-confirmar").textContent).toContain("hola 😀 mundo");
    confirmar();
    await waitFor(() =>
      expect(client.videoVozGenerar).toHaveBeenCalledWith("p1", { frases: ["f1"], plan_confirmado: "plan-f1", caracteres_confirmados: 25, reintentar_facturadas: false }),
    );
  });

  it("contenido cambiado con el mismo total no factura: reabre con el plan nuevo y no reintenta solo", async () => {
    let plan = "plan-A";
    const videoVozCoste = vi.fn(async () => coste({ plan }));
    const videoVozGenerar = vi.fn().mockRejectedValueOnce(new ApiError(409, "El contenido a generar ha cambiado", "coste_cambiado")).mockResolvedValue({ generadas: 1 });
    montar(proyecto(2), { videoVozCoste, videoVozGenerar });
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    plan = "plan-B"; // el contenido cambió en el servidor con el mismo total de caracteres
    confirmar();
    await waitFor(() => expect(screen.getByTestId("voz-confirmar").textContent).toMatch(/ha cambiado/i));
    // La misma cifra (120) no cuela: sigue sin reintentarse hasta que la persona confirme otra vez.
    expect(videoVozGenerar).toHaveBeenCalledTimes(1);
    confirmar();
    await waitFor(() => expect(videoVozGenerar).toHaveBeenCalledTimes(2));
    expect(videoVozGenerar.mock.calls[0][1].plan_confirmado).toBe("plan-A");
    expect(videoVozGenerar.mock.calls[1][1].plan_confirmado).toBe("plan-B");
  });

  it("refacturado: el diálogo dice la cifra y no se envía sin marcar la casilla", async () => {
    const videoVozCoste = vi.fn(async () => coste({ fallidasFacturadas: ["f0"], caracteresRefacturados: 40 }));
    const { client } = montar(proyecto(2), { videoVozCoste });
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    expect(screen.getByTestId("voz-confirmar-refacturado").textContent).toContain("40");
    expect(screen.getByTestId("voz-confirmar").textContent).not.toMatch(/solo factura lo que falta/i);
    const ok = screen.getByTestId("voz-confirmar-ok") as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.click(ok);
    expect(client.videoVozGenerar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("voz-confirmar-reintentar"));
    expect((screen.getByTestId("voz-confirmar-ok") as HTMLButtonElement).disabled).toBe(false);
    confirmar();
    await waitFor(() => expect(client.videoVozGenerar).toHaveBeenCalledWith("p1", { plan_confirmado: "plan-A", caracteres_confirmados: 120, reintentar_facturadas: true }));
  });

  it("sin refacturado no hay casilla ni se envía reintentar_facturadas: true", async () => {
    const { client } = montar(proyecto(2));
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    expect(t("voz-confirmar-refacturado")).toBeNull();
    expect(t("voz-confirmar-reintentar")).toBeNull();
    confirmar();
    await waitFor(() => expect(client.videoVozGenerar).toHaveBeenCalled());
    expect(client.videoVozGenerar).toHaveBeenCalledWith("p1", expect.objectContaining({ reintentar_facturadas: false }));
  });

  it("un fallo facturado no promete que reintentar solo factura lo que falta", async () => {
    const videoVozGenerar = vi.fn(async () => ({ generadas: 0, fallo: { fraseId: "f0", mensaje: "x", facturada: true } }));
    montar(proyecto(2), { videoVozGenerar });
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    confirmar();
    const aviso = await screen.findByText(/volverá a cobrar|se cobrará de nuevo|cobró/i);
    expect(aviso.closest("[role=status],[role=alert],li,div")?.textContent ?? "").not.toMatch(/solo factura lo que falta/i);
  });

  it("los errores se distinguen por codigo, no por texto: sin_clave", async () => {
    // El texto habla de «coste» pero el código manda.
    const videoVozGenerar = vi.fn().mockRejectedValue(new ApiError(409, "Añade tu clave; el coste no cambia", "sin_clave"));
    montar(proyecto(2), { videoVozGenerar });
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    confirmar();
    const aviso = await screen.findByTestId("voz-sin-clave");
    expect(within(aviso).getByRole("link").getAttribute("href")).toBe("/ajustes");
    expect(t("voz-confirmar")).toBeNull();
    expect(videoVozGenerar).toHaveBeenCalledTimes(1);
  });

  it("coste_cambiado con un texto que habla de «clave» sigue reabriendo, no enseña voz-sin-clave", async () => {
    const videoVozGenerar = vi.fn().mockRejectedValueOnce(new ApiError(409, "La clave de caché cambió", "coste_cambiado"));
    const { client } = montar(proyecto(2), { videoVozGenerar });
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    confirmar();
    await waitFor(() => expect(client.videoVozCoste).toHaveBeenCalledTimes(2));
    expect(t("voz-sin-clave")).toBeNull();
    expect(t("voz-confirmar")).not.toBeNull();
  });

  it("conflicto entra en el flujo de conflicto del editor, no en el toast de conexión", async () => {
    const videoVozGenerar = vi.fn().mockRejectedValue(new ApiError(409, "Ya se está generando la voz de este proyecto.", "conflicto"));
    const remoto = proyecto(2, { revision: 5 });
    const videoProyectoGuardar = vi.fn().mockRejectedValue(new ApiError(409, "revisión obsoleta", "conflicto"));
    const videoProyecto = vi.fn(async () => remoto);
    vincularCliente({ videoProyectoGuardar, videoProyecto } as unknown as Client);
    montar(proyecto(2), { videoVozGenerar });
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    confirmar();
    await waitFor(() => expect(useEditor.getState().conflicto).toBe(true));
    expect(videoProyectoGuardar).toHaveBeenCalled();
    expect(t("voz-sin-clave")).toBeNull();
    expect(screen.queryByText(/revisa tu conexión/i)).toBeNull();
  });

  it("conflicto sin revisión obsoleta (ya se está generando) lo cuenta, sin culpar a la conexión", async () => {
    const videoVozGenerar = vi.fn().mockRejectedValue(new ApiError(409, "Ya se está generando la voz de este proyecto.", "conflicto"));
    const videoProyectoGuardar = vi.fn(async () => ({ revision: 2, avisos: [] }));
    vincularCliente({ videoProyectoGuardar, videoProyecto: vi.fn() } as unknown as Client);
    montar(proyecto(2), { videoVozGenerar });
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    confirmar();
    await waitFor(() => expect(t("voz-confirmar")).toBeNull());
    await screen.findByText(/ya se está generando/i);
    expect(screen.queryByText(/revisa tu conexión/i)).toBeNull();
  });

  it("no_disponible no se confunde con un fallo de conexión ni con la clave", async () => {
    const videoVozGenerar = vi.fn().mockRejectedValue(new ApiError(503, "x", "no_disponible"));
    montar(proyecto(2), { videoVozGenerar });
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    confirmar();
    await screen.findByText(/no está disponible/i);
    expect(t("voz-sin-clave")).toBeNull();
  });

  it("la cifra y el plan vienen siempre del servidor: nada de coste local", async () => {
    // El texto local de f0 mide 24 caracteres; el servidor dice 7. Gana el servidor.
    const videoVozCoste = vi.fn(async () => coste({ caracteres: 7 }));
    const { client } = montar(proyecto(2), { videoVozCoste });
    fireEvent.click(screen.getByTestId("voz-regenerar-f0"));
    expect((await screen.findByTestId("voz-confirmar-coste")).textContent).toBe("7");
    confirmar();
    await waitFor(() => expect(client.videoVozGenerar).toHaveBeenCalledWith("p1", expect.objectContaining({ caracteres_confirmados: 7, plan_confirmado: "plan-A" })));
  });

  it("con cambios sin guardar, guarda antes de leer el coste", async () => {
    const orden: string[] = [];
    const videoProyectoGuardar = vi.fn(async () => {
      orden.push("guardar");
      return { revision: 2, avisos: [] };
    });
    vincularCliente({ videoProyectoGuardar, videoProyecto: vi.fn() } as unknown as Client);
    const videoVozCoste = vi.fn(async () => {
      orden.push("coste");
      return coste();
    });
    montar(proyecto(2), { videoVozCoste });
    await waitFor(() => expect(orden).toContain("coste"));
    orden.length = 0;
    useEditor.setState({ guardado: "pendiente" });
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    expect(orden[0]).toBe("guardar");
    expect(orden).toContain("coste");
  });

  it("el diálogo de gasto no se puede confirmar durante un conflicto", async () => {
    const { client } = montar(proyecto(2));
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar-coste");
    act(() => useEditor.setState({ conflicto: true }));
    const ok = screen.getByTestId("voz-confirmar-ok") as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.click(ok);
    expect(client.videoVozGenerar).not.toHaveBeenCalled();
  });

  it("cancelar el diálogo no gasta nada", async () => {
    const { client } = montar(proyecto(2));
    fireEvent.click(screen.getByTestId("voz-generar"));
    await screen.findByTestId("voz-confirmar");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(t("voz-confirmar")).toBeNull());
    expect(client.videoVozGenerar).not.toHaveBeenCalled();
  });

  it("editar_no_llama_voz: editar texto o reordenar solo marca pendiente, sin POST de voz", async () => {
    const { client } = montar(proyecto(3));
    await waitFor(() => expect(client.videoVozCoste).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByTestId("clip-escena-e0"), { key: "ArrowRight", altKey: true });
    fireEvent.click(screen.getByTestId("clip-subtitulo-0"));
    const campo = screen.getByTestId("subtitulo-texto");
    fireEvent.change(campo, { target: { value: "otra cosa distinta aquí" } });
    fireEvent.blur(campo);
    expect(client.videoVozGenerar).not.toHaveBeenCalled();
    expect(client.videoVozQuitarSilencios).not.toHaveBeenCalled();
  });

  it("quitar silencios recarga el proyecto del servidor y no edita la revisión vieja", async () => {
    const remoto = proyecto(1, { revision: 2, frases: [{ id: "f0", texto: "frase número 0 de prueba", recorte: { inicio: 0.2, fin: 1.1 } }] });
    const videoProyecto = vi.fn(async () => remoto);
    const videoProyectoGuardar = vi.fn(async () => ({ revision: 3, avisos: [] }));
    vincularCliente({ videoProyecto, videoProyectoGuardar } as unknown as Client);
    const { client } = montar(proyecto(1), { videoProyecto });
    fireEvent.click(screen.getByTestId("voz-quitar-silencios-f0"));
    await waitFor(() => expect(client.videoVozQuitarSilencios).toHaveBeenCalledWith("p1", { frase_id: "f0" }));
    await waitFor(() => expect(videoProyecto).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(useEditor.getState().revision).toBe(2));
    expect(useEditor.getState().proyecto!.frases[0].recorte).toEqual({ inicio: 0.2, fin: 1.1 });
    // Sin edición sobre la revisión vieja: no hay nada pendiente que provoque un PUT con la revisión obsoleta.
    expect(useEditor.getState().guardado).toBe("guardado");
    await new Promise((r) => setTimeout(r, 1000));
    expect(videoProyectoGuardar).not.toHaveBeenCalled();
    expect(useEditor.getState().conflicto).toBe(false);
  });

  it("voz-coste muestra los caracteres pendientes del servidor", async () => {
    montar(proyecto(2));
    await waitFor(() => expect(screen.getByTestId("voz-coste").textContent).toContain("120"));
  });
});

describe("música", () => {
  it("elige pista, inicio, volumen y ducking mediante editar()", async () => {
    montar(proyecto(2));
    const sel = screen.getByTestId("musica-elegir");
    await waitFor(() => expect(within(sel).getAllByRole("option").length).toBeGreaterThan(2));
    fireEvent.change(sel, { target: { value: "m2" } });
    expect(useEditor.getState().proyecto!.musica).toMatchObject({ pistaId: "m2", ducking: true });
    fireEvent.change(screen.getByTestId("musica-inicio"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByTestId("musica-volumen"), { target: { value: "0.4" } });
    fireEvent.click(screen.getByTestId("musica-ducking"));
    expect(useEditor.getState().proyecto!.musica).toEqual({ pistaId: "m2", inicio: 1.5, volumen: 0.4, ducking: false });
    expect(useEditor.getState().historial).toHaveLength(4);
    fireEvent.change(sel, { target: { value: "" } });
    expect(useEditor.getState().proyecto!.musica).toBeUndefined();
  });

  it("los nombres de pista se pintan como texto", async () => {
    montar(proyecto(1), { videoMusica: vi.fn(async () => [{ id: "m1", nombre: HOSTIL }]) });
    const sel = screen.getByTestId("musica-elegir");
    await waitFor(() => expect(within(sel).getAllByRole("option")).toHaveLength(2));
    expect(sel.textContent).toContain(HOSTIL);
    expect(sel.querySelector("img")).toBeNull();
  });

  it("los valores fuera de rango se acotan", async () => {
    montar(proyecto(1, { musica: { pistaId: "m1", inicio: 0, volumen: 0.5, ducking: true } }));
    fireEvent.change(screen.getByTestId("musica-volumen"), { target: { value: "7" } });
    expect(useEditor.getState().proyecto!.musica!.volumen).toBe(1);
    fireEvent.change(screen.getByTestId("musica-inicio"), { target: { value: "-4" } });
    expect(useEditor.getState().proyecto!.musica!.inicio).toBe(0);
  });
});

describe("subtítulos", () => {
  it("subtitulo_html_es_texto: una corrección con HTML se pinta como texto", () => {
    const p = proyecto(1, { frases: [{ id: "f0", texto: "uno dos" }], subtitulos: { estilo: "karaoke", correcciones: [{ indice: 0, texto: HOSTIL }], cortes: [] } });
    montar(p);
    expect(screen.getByTestId("clip-subtitulo-0").textContent).toContain(HOSTIL);
    expect(document.querySelector("[data-testid=pista-subtitulos] img")).toBeNull();
    fireEvent.click(screen.getByTestId("clip-subtitulo-0"));
    expect((screen.getByTestId("subtitulo-texto") as HTMLInputElement).value).toContain(HOSTIL);
    expect(document.querySelector("img")).toBeNull();
  });

  it("corregir una palabra guarda la corrección; volver al original la quita", () => {
    montar(proyecto(1, { frases: [{ id: "f0", texto: "uno dos tres" }] }));
    fireEvent.click(screen.getByTestId("clip-subtitulo-0"));
    const campo = screen.getByTestId("subtitulo-texto");
    fireEvent.change(campo, { target: { value: "uno DOS tres" } });
    fireEvent.blur(campo);
    expect(useEditor.getState().proyecto!.subtitulos.correcciones).toEqual([{ indice: 1, texto: "DOS" }]);
    fireEvent.change(campo, { target: { value: "uno dos tres" } });
    fireEvent.blur(campo);
    expect(useEditor.getState().proyecto!.subtitulos.correcciones).toEqual([]);
  });

  it("cambiar el número de palabras se rechaza con un aviso y no edita", () => {
    montar(proyecto(1, { frases: [{ id: "f0", texto: "uno dos tres" }] }));
    fireEvent.click(screen.getByTestId("clip-subtitulo-0"));
    const campo = screen.getByTestId("subtitulo-texto");
    fireEvent.change(campo, { target: { value: "uno dos" } });
    fireEvent.blur(campo);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(useEditor.getState().historial).toHaveLength(0);
  });

  it("dividir y unir líneas modifica los cortes", () => {
    montar(proyecto(1, { frases: [{ id: "f0", texto: "uno dos tres cuatro" }] }));
    fireEvent.click(screen.getByTestId("clip-subtitulo-0"));
    const campo = screen.getByTestId("subtitulo-texto") as HTMLInputElement;
    campo.setSelectionRange(8, 8); // tras «uno dos »
    fireEvent.click(screen.getByTestId("subtitulo-dividir"));
    expect(useEditor.getState().proyecto!.subtitulos.cortes).toEqual([2]);
    expect(screen.getByTestId("clip-subtitulo-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("subtitulo-unir"));
    expect(useEditor.getState().proyecto!.subtitulos.cortes).toEqual([]);
  });
});

describe("rendimiento (Review Focus 5)", () => {
  it("90 escenas se pintan y se reordenan con margen amplio", async () => {
    const p = proyecto(90);
    const t0 = performance.now();
    montar(p);
    const pintar = performance.now() - t0;
    expect(screen.getAllByTestId(/^clip-escena-/)).toHaveLength(90);
    expect(screen.getAllByTestId(/^clip-voz-/)).toHaveLength(90);
    const t1 = performance.now();
    act(() => {
      for (let i = 0; i < 20; i++) fireEvent.keyDown(screen.getByTestId("clip-escena-e0"), { key: "ArrowRight", altKey: true });
    });
    const mover = performance.now() - t1;
    const t2 = performance.now();
    for (let i = 0; i < 30; i++) act(() => useEditor.setState({ tiempo: i / 3 }));
    const cabezal = performance.now() - t2;
    // Umbrales holgados: detectan un coste cuadrático, no microoptimizaciones.
    expect(pintar).toBeLessThan(6000);
    expect(mover).toBeLessThan(6000);
    expect(cabezal).toBeLessThan(3000);
  });
});
