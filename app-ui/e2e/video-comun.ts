/** Utilidades comunes de los E2E de vídeo (U1–U5): guion y proyecto de ejemplo, y atajos sobre la
 *  API real del sidecar con el motor real. Los ids los pone el servidor; los textos son datos. */
import type { Page } from "@playwright/test";
import { api } from "./api";
import type { AvisoVideo, ProyectoVideoResumen } from "../src/api/types";
import type { GuionVideo, Proyecto } from "../src/video/modelo";

/** Guion de cocina válido para el esquema del motor: 3 escenas, una con recurso pedido. */
export const GUION_COCINA: GuionVideo = {
  version: 1,
  titulo: "Tortilla perfecta",
  gancho: "No batas más los huevos",
  escenas: [
    { frases: ["No batas más los huevos.", "Te lo explico en un minuto."], base: { tipo: "cartel", texto: "Tortilla perfecta", subtexto: "Sin trucos" } },
    {
      frases: ["Con tres huevos basta."],
      base: { tipo: "cifra", valor: 3, prefijo: "", sufijo: " huevos", decimales: 0 },
      recurso: { tipo: "foto", que_debe_salir: "Tres huevos sobre la encimera", resolucion_minima: { ancho: 1080, alto: 1920 } },
    },
    { frases: ["Y ya está."], base: { tipo: "cartel", texto: "Y ya está" } },
  ],
  opciones: { fondo: "ninguno", look: "normal", subtitulos: "karaoke", destellos: [0] },
};

/** Texto que debe quedar inerte en cualquier pantalla (nada de nodos `img` ni scripts). */
export const TEXTO_HOSTIL = "<img src=x onerror=alert(1)>";

export const crearGuion = (guion: unknown = GUION_COCINA) =>
  api<{ id: string; avisos: AvisoVideo[] }>("/video/guiones", { method: "POST", body: JSON.stringify({ guion }) });

export const crearProyecto = (guionId: string, perfilId = "defecto") =>
  api<{ id: string }>("/video/proyectos", { method: "POST", body: JSON.stringify({ guion_id: guionId, perfil_id: perfilId }) });

/** Guion + proyecto en un paso; devuelve el id del proyecto. */
export async function proyectoDeCocina(guion: unknown = GUION_COCINA): Promise<string> {
  const g = await crearGuion(guion);
  return (await crearProyecto(g.id)).id;
}

export const leerProyecto = (id: string) => api<Proyecto>(`/video/proyectos/${id}`);
export const listarProyectos = () => api<ProyectoVideoResumen[]>("/video/proyectos");

/** Borra todos los proyectos y guiones: cada spec parte de cero. */
export async function limpiarVideo(): Promise<void> {
  for (const p of await listarProyectos()) await api(`/video/proyectos/${p.id}`, { method: "DELETE" });
  for (const g of await api<{ id: string }[]>("/video/guiones")) await api(`/video/guiones/${g.id}`, { method: "DELETE" });
}

export const irAlEditor = (page: Page, id: string) => page.goto(`/#/video/${id}`);

/** Llamadas de síntesis y caracteres que ha atendido el ElevenLabs falso. */
export async function llamadasVoz(): Promise<{ sintesis: number; caracteres: number }> {
  return (await fetch(`${process.env.VIDEO_PRUEBAS_TTS_URL}/__llamadas`)).json() as Promise<{ sintesis: number; caracteres: number }>;
}
