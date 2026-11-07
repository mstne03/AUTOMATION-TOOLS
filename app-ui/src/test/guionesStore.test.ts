import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Client } from "../api/client";
import type { Retencion } from "../guiones/modelo";
import { analizarRetencion, cambiarFormatoEscribir, crearVideo, editarEscenaVideo, empezarDeNuevo, guardarGuionVideo, moverEscenaVideo, parcharEscribir, recibirRespuesta, reiniciarGuiones, useGuiones } from "../state/guiones";

const GUION = { ganchos: [{ tipo: "promesa", texto: "Gancho" }], bloques: [{ titulo: "A", segundos: 30, contenido: "B", nota_visual: "" }], cta: "C" };
const RETENCION = { video_id: "abcdefghijk", title: "V", duration_s: 100, format: "long", intro_window_s: 30, intro_retention: 0.5, curve: [], drops: [], spikes: [], transcript_source: null, transcript_error: null } as Retencion;

const cliente = (fn: Client["guionesRetencion"]) => ({ guionesRetencion: vi.fn(fn) }) as unknown as Client;

describe("store de Guiones", () => {
  afterEach(() => reiniciarGuiones());

  it("cambiar de formato ajusta la duración hasta que el usuario la toca", () => {
    cambiarFormatoEscribir("short");
    expect(useGuiones.getState().escribir.minutos).toBe(0.5);
    parcharEscribir({ minutos: 2, minutosTocados: true });
    cambiarFormatoEscribir("long");
    expect(useGuiones.getState().escribir).toMatchObject({ formato: "long", minutos: 2 });
  });

  it("recibe el JSON del guion y vuelve al primer gancho", () => {
    parcharEscribir({ esperando: true, gancho: 2 });
    recibirRespuesta("escribir", "Aquí va:\n" + JSON.stringify(GUION));
    const e = useGuiones.getState().escribir;
    expect(e).toMatchObject({ esperando: false, jsonError: false, gancho: 0 });
    expect(e.guion?.ganchos[0].texto).toBe("Gancho");
  });

  it("un JSON ilegible marca el error y conserva el guion anterior", () => {
    recibirRespuesta("escribir", JSON.stringify(GUION));
    recibirRespuesta("escribir", "sin JSON");
    const e = useGuiones.getState().escribir;
    expect(e.jsonError).toBe(true);
    expect(e.guion).not.toBeNull();
  });

  it("un turno con error no cuenta como JSON roto", () => {
    parcharEscribir({ esperando: true });
    recibirRespuesta("escribir", null);
    expect(useGuiones.getState().escribir).toMatchObject({ esperando: false, jsonError: false });
  });

  it("revisión: valida el esquema", () => {
    recibirRespuesta("revisar", '{"veredicto_gancho": "Flojo", "problemas": []}');
    expect(useGuiones.getState().revisar.revision?.veredicto_gancho).toBe("Flojo");
    recibirRespuesta("revisar", '{"otra": 1}');
    expect(useGuiones.getState().revisar.jsonError).toBe(true);
  });

  it("analizar: resultado, error de la tool y error de red", async () => {
    await analizarRetencion(cliente(async () => RETENCION), "abcdefghijk");
    expect(useGuiones.getState().diagnosticar).toMatchObject({ cargando: false, error: null, resultado: RETENCION });

    await analizarRetencion(cliente(async () => ({ error: "Sin datos" })), "abcdefghijk");
    expect(useGuiones.getState().diagnosticar).toMatchObject({ error: "Sin datos", resultado: null });

    await analizarRetencion(cliente(async () => Promise.reject(new Error("HTTP 503"))), "abcdefghijk");
    expect(useGuiones.getState().diagnosticar).toMatchObject({ error: "HTTP 503", cargando: false });
  });

  it("un análisis anulado no pisa el estado al llegar tarde", async () => {
    let soltar: (r: Retencion) => void = () => undefined;
    const lento = analizarRetencion(cliente(() => new Promise((ok) => (soltar = ok))), "abcdefghijk");
    empezarDeNuevo("diagnosticar");
    soltar(RETENCION);
    await lento;
    expect(useGuiones.getState().diagnosticar).toMatchObject({ resultado: null, cargando: false });
  });

  it("empezar de nuevo solo vacía su modo", () => {
    parcharEscribir({ tema: "x" });
    useGuiones.setState((s) => ({ revisar: { ...s.revisar, texto: "y" } }));
    empezarDeNuevo("escribir");
    expect(useGuiones.getState().escribir.tema).toBe("");
    expect(useGuiones.getState().revisar.texto).toBe("y");
  });
});

const VIDEO = {
  version: 1,
  titulo: "Tortilla",
  gancho: "No batas más",
  escenas: [
    { frases: ["Uno."], base: { tipo: "cartel", texto: "A" } },
    { frases: ["Dos."], base: { tipo: "cifra", valor: 3, prefijo: "", sufijo: "", decimales: 0 }, recurso: { tipo: "foto", que_debe_salir: "huevos", resolucion_minima: { ancho: 1080, alto: 1920 } } },
  ],
  opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [0] },
};
const enVideo = () => parcharEscribir({ formato: "video", esperando: true });
const cv = (o: Partial<Client>) => o as unknown as Client;

describe("store de Guiones: modo Vídeo", () => {
  afterEach(() => reiniciarGuiones());

  it("recibe el guion de escenas", () => {
    enVideo();
    recibirRespuesta("escribir", "```json\n" + JSON.stringify(VIDEO) + "\n```");
    const e = useGuiones.getState().escribir;
    expect(e).toMatchObject({ esperando: false, jsonError: false });
    expect(e.guionVideo?.escenas).toHaveLength(2);
  });

  it("json_invalido_no_pisa: una respuesta ilegible conserva el guion anterior", () => {
    enVideo();
    recibirRespuesta("escribir", JSON.stringify(VIDEO));
    recibirRespuesta("escribir", '{"titulo": "x", "escenas": []}');
    recibirRespuesta("escribir", "no hay JSON");
    const e = useGuiones.getState().escribir;
    expect(e.jsonError).toBe(true);
    expect(e.guionVideo?.titulo).toBe("Tortilla");
  });

  it("sin_llamada_sin_clic: terminar el turno no llama al servidor", () => {
    const c = { videoGuionCrear: vi.fn(), videoProyectoCrear: vi.fn() };
    enVideo();
    recibirRespuesta("escribir", JSON.stringify(VIDEO));
    expect(c.videoGuionCrear).not.toHaveBeenCalled();
    expect(c.videoProyectoCrear).not.toHaveBeenCalled();
  });

  it("editar frases, tipo y orden mantiene lo que la UI no toca y borra el id guardado", async () => {
    enVideo();
    recibirRespuesta("escribir", JSON.stringify(VIDEO));
    const c = cv({ videoGuionCrear: vi.fn(async () => ({ id: "g1", avisos: [] })) });
    await guardarGuionVideo(c);
    expect(useGuiones.getState().escribir.videoGuardadoId).toBe("g1");
    editarEscenaVideo(0, { frases: ["Cero."] });
    expect(useGuiones.getState().escribir.videoGuardadoId).toBeNull();
    moverEscenaVideo(1, -1);
    const cuerpo = useGuiones.getState().escribir.guionVideo?.aCuerpo() as typeof VIDEO;
    expect(cuerpo.escenas.map((x) => x.frases[0])).toEqual(["Dos.", "Cero."]);
    expect(cuerpo.escenas[0].recurso?.que_debe_salir).toBe("huevos");
    expect(cuerpo.opciones.destellos).toEqual([0]);
  });

  it("mover fuera de rango no hace nada", () => {
    enVideo();
    recibirRespuesta("escribir", JSON.stringify(VIDEO));
    moverEscenaVideo(0, -1);
    moverEscenaVideo(1, 1);
    expect(useGuiones.getState().escribir.guionVideo?.escenas.map((x) => x.frases[0])).toEqual(["Uno.", "Dos."]);
  });

  it("errores_servidor_como_texto: un 422 se guarda como líneas de texto", async () => {
    enVideo();
    recibirRespuesta("escribir", JSON.stringify(VIDEO));
    const c = cv({ videoGuionCrear: vi.fn(async () => { throw new ApiError(422, JSON.stringify({ problemas: [{ ruta: "escenas.0", mensaje: "<img src=x onerror=alert(1)>" }] })); }) });
    expect(await guardarGuionVideo(c)).toBeNull();
    const e = useGuiones.getState().escribir;
    expect(e.videoErrores).toEqual(["escenas.0: <img src=x onerror=alert(1)>"]);
    expect(e.videoOcupado).toBe(false);
  });

  it("guardar envía el cuerpo del guion y guarda los avisos", async () => {
    enVideo();
    recibirRespuesta("escribir", JSON.stringify(VIDEO));
    const crear = vi.fn(async () => ({ id: "g9", avisos: [{ codigo: "a", mensaje: "Sin gancho en 3 s" }] }));
    expect(await guardarGuionVideo(cv({ videoGuionCrear: crear }))).toBe("g9");
    expect((crear.mock.calls[0] as unknown[])[0]).toMatchObject({ titulo: "Tortilla" });
    expect(useGuiones.getState().escribir.videoAvisos).toEqual([{ codigo: "a", mensaje: "Sin gancho en 3 s" }]);
  });

  it("crear guarda, crea el proyecto con un perfil del servidor y devuelve su id", async () => {
    enVideo();
    recibirRespuesta("escribir", JSON.stringify(VIDEO));
    const c = cv({
      videoGuionCrear: vi.fn(async () => ({ id: "g1", avisos: [] })),
      videoPerfiles: vi.fn(async () => [{ id: "otro" }, { id: "defecto" }]),
      videoProyectoCrear: vi.fn(async () => ({ id: "p1" })),
    });
    expect(await crearVideo(c)).toBe("p1");
    expect(c.videoProyectoCrear).toHaveBeenCalledWith("g1", "defecto");
  });

  it("crear no crea proyecto si el guion no se guarda", async () => {
    enVideo();
    recibirRespuesta("escribir", JSON.stringify(VIDEO));
    const c = cv({ videoGuionCrear: vi.fn(async () => { throw new ApiError(422, "mal"); }), videoPerfiles: vi.fn(), videoProyectoCrear: vi.fn() });
    expect(await crearVideo(c)).toBeNull();
    expect(c.videoProyectoCrear).not.toHaveBeenCalled();
  });

  it("empezar de nuevo vacía el guion de vídeo", () => {
    enVideo();
    recibirRespuesta("escribir", JSON.stringify(VIDEO));
    empezarDeNuevo("escribir");
    expect(useGuiones.getState().escribir.guionVideo).toBeNull();
  });
});
