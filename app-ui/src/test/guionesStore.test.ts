import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../api/client";
import type { Retencion } from "../guiones/modelo";
import { analizarRetencion, cambiarFormatoEscribir, empezarDeNuevo, parcharEscribir, recibirRespuesta, reiniciarGuiones, useGuiones } from "../state/guiones";

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
