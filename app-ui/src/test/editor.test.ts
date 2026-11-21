import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Client } from "../api/client";
import { cargar, descartarBorrador, deshacer, desvincularCliente, editar, guardar as guardarAhora, rehacer, reiniciarEditor, useEditor, vincularCliente } from "../state/editor";
import { aGuionVideo, aPreviewUrl, type Proyecto } from "../video/modelo";

const proyecto = (titulo = "Cocina"): Proyecto => ({
  version: 1,
  id: "video001",
  revision: 3,
  titulo,
  gancho: "Prueba esto",
  aspecto: "9:16",
  perfilId: "defecto",
  creado: "2026-11-07T10:00:00Z",
  actualizado: "2026-11-07T10:00:00Z",
  frases: [{ id: "f1", texto: "Hola" }],
  escenas: [{ id: "e1", fraseIds: ["f1"], base: { tipo: "cartel", texto: "Hola" }, ajusteCorte: 0 }],
  recursos: [],
  subtitulos: { estilo: "karaoke", correcciones: [], cortes: [] },
  opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [] },
});

const titulo = () => useEditor.getState().proyecto?.titulo;

describe("store del editor", () => {
  let guardar: ReturnType<typeof vi.fn>;
  let leer: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    guardar = vi.fn(async (_id: string, c: { revision: number }) => ({ revision: c.revision + 1, avisos: [] }));
    leer = vi.fn();
    vincularCliente({ videoProyectoGuardar: guardar, videoProyecto: leer } as unknown as Client);
    cargar(proyecto());
  });
  afterEach(() => {
    reiniciarEditor();
    desvincularCliente();
    vi.useRealTimers();
  });

  it("deshacer_y_rehacer", () => {
    editar((p) => { p.titulo = "Uno"; });
    editar((p) => { p.titulo = "Dos"; });
    expect(titulo()).toBe("Dos");
    deshacer();
    expect(titulo()).toBe("Uno");
    deshacer();
    expect(titulo()).toBe("Cocina");
    deshacer(); // sin más historial: no hace nada
    expect(titulo()).toBe("Cocina");
    rehacer();
    expect(titulo()).toBe("Uno");
    editar((p) => { p.titulo = "Tres"; }); // una edición nueva descarta el futuro
    expect(useEditor.getState().futuro).toHaveLength(0);
  });

  it("el historial se limita a 100 instantáneas", () => {
    for (let i = 0; i < 130; i++) editar((p) => { p.titulo = `T${i}`; });
    expect(useEditor.getState().historial).toHaveLength(100);
  });

  it("autoguardado_agrupa: varias ediciones en 800 ms son un solo PUT", async () => {
    editar((p) => { p.titulo = "A"; });
    await vi.advanceTimersByTimeAsync(500);
    editar((p) => { p.titulo = "B"; });
    expect(useEditor.getState().guardado).toBe("pendiente");
    await vi.advanceTimersByTimeAsync(799);
    expect(guardar).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(guardar).toHaveBeenCalledTimes(1);
    expect(guardar.mock.calls[0][0]).toBe("video001");
    expect(guardar.mock.calls[0][1]).toMatchObject({ revision: 3, proyecto: { titulo: "B" } });
    expect(useEditor.getState()).toMatchObject({ revision: 4, guardado: "guardado" });
  });

  it("una edición durante el guardado se guarda después con la revisión nueva", async () => {
    let soltar!: () => void;
    guardar.mockImplementationOnce(() => new Promise((ok) => { soltar = () => ok({ revision: 4, avisos: [] }); }));
    editar((p) => { p.titulo = "A"; });
    await vi.advanceTimersByTimeAsync(800);
    expect(useEditor.getState().guardado).toBe("guardando");
    editar((p) => { p.titulo = "B"; });
    soltar();
    await vi.advanceTimersByTimeAsync(800);
    expect(guardar).toHaveBeenCalledTimes(2);
    expect(guardar.mock.calls[1][1]).toMatchObject({ revision: 4, proyecto: { titulo: "B" } });
  });

  it("conflicto_recarga_sin_perder: el 409 conserva la edición local como borrador y avisa", async () => {
    guardar.mockRejectedValueOnce(new ApiError(409, "Revisión antigua."));
    leer.mockResolvedValueOnce({ ...proyecto("Del servidor"), revision: 7 });
    editar((p) => { p.titulo = "Mía"; });
    await vi.advanceTimersByTimeAsync(800);
    const st = useEditor.getState();
    expect(st.conflicto).toBe(true);
    expect(st.borrador?.titulo).toBe("Mía");
    expect(st.proyecto?.titulo).toBe("Del servidor");
    expect(st.revision).toBe(7);
    // Con conflicto no se reintenta solo.
    await vi.advanceTimersByTimeAsync(5000);
    expect(guardar).toHaveBeenCalledTimes(1);
  });

  it("descartar con ediciones hechas durante el conflicto no marca «guardado» y las guarda", async () => {
    guardar.mockRejectedValueOnce(new ApiError(409, "Revisión antigua."));
    leer.mockResolvedValueOnce({ ...proyecto("Del servidor"), revision: 7 });
    editar((p) => { p.titulo = "Mía"; });
    await vi.advanceTimersByTimeAsync(800);
    editar((p) => { p.titulo = "Durante el aviso"; });
    descartarBorrador();
    expect(useEditor.getState()).toMatchObject({ conflicto: false, borrador: null, guardado: "pendiente" });
    await vi.advanceTimersByTimeAsync(800);
    expect(guardar).toHaveBeenCalledTimes(2);
    expect(guardar.mock.calls[1][1]).toMatchObject({ revision: 7, proyecto: { titulo: "Durante el aviso" } });
  });

  it("un fallo distinto de 409 marca error y no pierde la edición", async () => {
    guardar.mockRejectedValueOnce(new ApiError(503, "Sin motor."));
    editar((p) => { p.titulo = "Mía"; });
    await vi.advanceTimersByTimeAsync(800);
    expect(useEditor.getState()).toMatchObject({ guardado: "error", conflicto: false });
    expect(titulo()).toBe("Mía");
  });

  describe("cambio de proyecto", () => {
    const otro = (): Proyecto => ({ ...proyecto("Otro"), id: "video002", revision: 10 });

    it("cambiar_de_proyecto_con_put_en_vuelo: la respuesta no se aplica al proyecto nuevo", async () => {
      let soltar!: () => void;
      guardar.mockImplementationOnce(() => new Promise((ok) => { soltar = () => ok({ revision: 4, avisos: [] }); }));
      editar((p) => { p.titulo = "A"; });
      await vi.advanceTimersByTimeAsync(800);
      cargar(otro());
      soltar();
      await vi.advanceTimersByTimeAsync(0);
      expect(useEditor.getState()).toMatchObject({ revision: 10, guardado: "guardado" });
      expect(useEditor.getState().proyecto).toMatchObject({ id: "video002", revision: 10 });
    });

    it("cambiar_de_proyecto_con_409: el 409 del anterior no pisa el proyecto abierto", async () => {
      let fallar!: () => void;
      guardar.mockImplementationOnce(() => new Promise((_, ko) => { fallar = () => ko(new ApiError(409, "Revisión antigua.")); }));
      editar((p) => { p.titulo = "A"; });
      await vi.advanceTimersByTimeAsync(800);
      cargar(otro());
      fallar();
      await vi.advanceTimersByTimeAsync(0);
      expect(leer).not.toHaveBeenCalled();
      expect(useEditor.getState()).toMatchObject({ conflicto: false, borrador: null, revision: 10 });
      expect(useEditor.getState().proyecto?.id).toBe("video002");
    });

    it("cambiar con una edición pendiente la guarda antes, con su propia revisión", async () => {
      editar((p) => { p.titulo = "Mía"; });
      cargar(otro());
      await vi.advanceTimersByTimeAsync(0);
      expect(guardar).toHaveBeenCalledTimes(1);
      expect(guardar.mock.calls[0][0]).toBe("video001");
      expect(guardar.mock.calls[0][1]).toMatchObject({ revision: 3, proyecto: { titulo: "Mía" } });
      expect(useEditor.getState().proyecto?.id).toBe("video002");
    });

    it("si no se puede guardar al cambiar, la edición queda como borrador de su proyecto", async () => {
      guardar.mockRejectedValueOnce(new ApiError(503, "Sin motor."));
      editar((p) => { p.titulo = "Mía"; });
      cargar(otro());
      await vi.advanceTimersByTimeAsync(0);
      expect(useEditor.getState().borrador).toBeNull();
      cargar(proyecto());
      expect(useEditor.getState()).toMatchObject({ conflicto: true });
      expect(useEditor.getState().borrador?.titulo).toBe("Mía");
    });

    it("edicion_durante_get_de_conflicto_va_al_borrador", async () => {
      guardar.mockRejectedValueOnce(new ApiError(409, "Revisión antigua."));
      let servir!: (p: Proyecto) => void;
      leer.mockImplementationOnce(() => new Promise((ok) => { servir = ok; }));
      editar((p) => { p.titulo = "Mía"; });
      await vi.advanceTimersByTimeAsync(800);
      editar((p) => { p.titulo = "Mía y más"; }); // durante el GET
      servir({ ...proyecto("Del servidor"), revision: 7 });
      await vi.advanceTimersByTimeAsync(0);
      expect(useEditor.getState().borrador?.titulo).toBe("Mía y más");
      expect(titulo()).toBe("Del servidor");
    });

    it("reabrir_mismo_id_durante_get_de_409_conserva_la_edicion_mia", async () => {
      guardar.mockRejectedValueOnce(new ApiError(409, "Revisión antigua."));
      let servir!: (p: Proyecto) => void;
      leer.mockImplementationOnce(() => new Promise((ok) => { servir = ok; }));
      editar((p) => { p.titulo = "Mía"; });
      await vi.advanceTimersByTimeAsync(800);
      cargar({ ...proyecto("Recargado"), revision: 5 }); // mismo id, durante el GET
      servir({ ...proyecto("Del servidor"), revision: 7 });
      await vi.advanceTimersByTimeAsync(0);
      expect(useEditor.getState()).toMatchObject({ conflicto: true });
      expect(useEditor.getState().borrador?.titulo).toBe("Mía");
    });

    it("salvarSaliente_no_lanza_un_segundo_PUT_con_la_misma_revision", async () => {
      let soltar!: () => void;
      guardar.mockImplementationOnce(() => new Promise((ok) => { soltar = () => ok({ revision: 4, avisos: [] }); }));
      editar((p) => { p.titulo = "A"; });
      await vi.advanceTimersByTimeAsync(800);
      editar((p) => { p.titulo = "B"; }); // durante el PUT
      cargar(otro());
      await vi.advanceTimersByTimeAsync(0);
      expect(guardar).toHaveBeenCalledTimes(1); // espera al PUT en vuelo
      soltar();
      await vi.advanceTimersByTimeAsync(0);
      expect(guardar).toHaveBeenCalledTimes(2);
      expect(guardar.mock.calls[1][1]).toMatchObject({ revision: 4, proyecto: { titulo: "B", revision: 4 } });
    });

    it("409_de_un_PUT_viejo_no_deja_una_version_anterior_como_borrador", async () => {
      let fallar!: () => void;
      guardar.mockImplementationOnce(() => new Promise((_, ko) => { fallar = () => ko(new ApiError(409, "Revisión antigua.")); }));
      editar((p) => { p.titulo = "A"; });
      await vi.advanceTimersByTimeAsync(800);
      editar((p) => { p.titulo = "B"; });
      cargar(otro());
      fallar();
      await vi.advanceTimersByTimeAsync(0);
      expect(guardar).toHaveBeenCalledTimes(1);
      cargar(proyecto());
      expect(useEditor.getState().borrador?.titulo).toBe("B");
    });

    it("edicion_durante_get_de_409_misma_epoca_no_reenvia_con_revision_vieja", async () => {
      guardar.mockRejectedValueOnce(new ApiError(409, "Revisión antigua."));
      let servir!: (p: Proyecto) => void;
      leer.mockImplementationOnce(() => new Promise((ok) => { servir = ok; }));
      editar((p) => { p.titulo = "A"; });
      await vi.advanceTimersByTimeAsync(800);
      editar((p) => { p.titulo = "B"; }); // durante el GET
      await vi.advanceTimersByTimeAsync(2000); // el autoguardado no debe lanzar un PUT con la revisión vieja
      servir({ ...proyecto("Del servidor"), revision: 7 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(guardar).toHaveBeenCalledTimes(1);
      expect(guardar.mock.calls.filter((c) => c[1].revision === 3)).toHaveLength(1);
      expect(useEditor.getState().borrador?.titulo).toBe("B");
      expect(useEditor.getState()).toMatchObject({ conflicto: true, revision: 7 });
    });

    it("edicion_durante_get_de_409_y_cambio_de_proyecto_no_pierde_B", async () => {
      guardar.mockRejectedValueOnce(new ApiError(409, "Revisión antigua."));
      let servir!: (p: Proyecto) => void;
      leer.mockImplementationOnce(() => new Promise((ok) => { servir = ok; }));
      editar((p) => { p.titulo = "A"; });
      await vi.advanceTimersByTimeAsync(800);
      editar((p) => { p.titulo = "B"; }); // durante el GET
      cargar(otro());
      await vi.advanceTimersByTimeAsync(0);
      expect(guardar).toHaveBeenCalledTimes(1); // ningún segundo PUT con la revisión vieja
      servir({ ...proyecto("Del servidor"), revision: 7 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(guardar).toHaveBeenCalledTimes(1);
      cargar(proyecto());
      expect(useEditor.getState().borrador?.titulo).toBe("B");
    });

    it("guardar_sin_cliente_marca_error", async () => {
      desvincularCliente();
      editar((p) => { p.titulo = "A"; });
      await guardarAhora();
      expect(useEditor.getState().guardado).toBe("error");
    });

    it("reiniciarEditor_no_desvincula_el_cliente", async () => {
      reiniciarEditor();
      cargar(proyecto());
      editar((p) => { p.titulo = "A"; });
      await vi.advanceTimersByTimeAsync(800);
      expect(guardar).toHaveBeenCalledTimes(1);
    });
  });
});

describe("aPreviewUrl", () => {
  it("url_preview_solo_loopback", () => {
    for (const p of [47810, 47811, 47812, 47813]) {
      expect(aPreviewUrl(`http://127.0.0.1:${p}/p/abc/index.html`)).toBe(`http://127.0.0.1:${p}/p/abc/index.html`);
    }
    for (const mala of [
      "http://127.0.0.1:47814/p/x",
      "http://127.0.0.1:478100/p/x",
      "https://127.0.0.1:47810/p/x",
      "http://localhost:47810/p/x",
      "http://127.0.0.1:47810@evil.com/p/x",
      "http://127.0.0.1:47810/otro/x",
      "http://127.0.0.1:47810/p/../x",
      "http://127.0.0.1:47810/p/%2e%2e/%2e%2e/x",
      "http://127.0.0.1:47810/p/.%2E/x",
      "http://127.0.0.1:47810/p/a%2Fb",
      "http://127.0.0.1:47810/p//x",
      "http://127.0.0.1:47810/p/",
      "http://127.0.0.1:47810/p/x\\y",
      "javascript:alert(1)",
      "//127.0.0.1:47810/p/x",
      "",
    ]) {
      expect(aPreviewUrl(mala)).toBeNull();
    }
    expect(aPreviewUrl(undefined)).toBeNull();
    expect(aPreviewUrl(42)).toBeNull();
  });
});

describe("aGuionVideo", () => {
  const guion = {
    version: 1,
    titulo: "Receta",
    gancho: "Mira esto",
    escenas: [
      { frases: ["Una frase."], base: { tipo: "cifra", valor: 3, prefijo: "", sufijo: " %", decimales: 0 }, recurso: { tipo: "foto", que_debe_salir: "Un plato", resolucion_minima: { ancho: 1080, alto: 1920 } } },
      { frases: ["Otra."], base: { tipo: "cartel", texto: "<img src=x onerror=alert(1)>" } },
    ],
    opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [] },
  };

  it("reduce a cadenas y números sin interpretar HTML", () => {
    const g = aGuionVideo(guion);
    expect(g?.titulo).toBe("Receta");
    expect(g?.escenas.map((e) => e.tipo)).toEqual(["cifra", "cartel"]);
    expect(g?.escenas[0].recurso).toEqual({ tipo: "foto", queDebeSalir: "Un plato" });
    expect(g?.escenas[1].recurso).toBeNull();
    expect(g?.escenas[1].base.texto).toBe("<img src=x onerror=alert(1)>");
  });

  it("devuelve null con lo que no es un guion", () => {
    for (const j of [null, "x", [], {}, { titulo: "a", escenas: [] }, { titulo: "a", escenas: [{ frases: "x", base: {} }] }, { titulo: "a", escenas: [{ frases: ["a"], base: { tipo: 3 } }] }]) {
      expect(aGuionVideo(j)).toBeNull();
    }
  });

  it("ida y vuelta: el cuerpo conserva lo editado y descarta claves peligrosas", () => {
    const g = aGuionVideo(JSON.parse(JSON.stringify(guion).replace('"version":1', '"version":1,"__proto__":{"x":1}')))!;
    g.escenas[0].frases = ["Editada."];
    const cuerpo = g.aCuerpo() as { escenas: { frases: string[] }[]; titulo: string };
    expect(cuerpo.titulo).toBe("Receta");
    expect(cuerpo.escenas[0].frases).toEqual(["Editada."]);
    expect(Object.keys(cuerpo)).not.toContain("__proto__");
  });

  it("el recurso viaja con su escena al reordenar", () => {
    const g = aGuionVideo(guion)!;
    g.escenas.reverse();
    const cuerpo = g.aCuerpo() as { escenas: { base: { tipo: string }; recurso?: { que_debe_salir: string } }[] };
    expect(cuerpo.escenas[0].base.tipo).toBe("cartel");
    expect(cuerpo.escenas[0].recurso).toBeUndefined();
    expect(cuerpo.escenas[1].recurso?.que_debe_salir).toBe("Un plato");
  });
});
