// Tools MCP del almacén (T4): guiones y proyectos. Envoltorios finos sobre `proyecto.ts`; la lógica y la validación
// viven allí. Los errores tipados salen como `isError` con un bloque JSON `{ codigo, problemas }`.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { descripcionEsquema } from "./esquema.js";
import type { Respuesta } from "./herramientas.js";
import {
  ErrorAlmacen,
  guionBorrar,
  guionGuardar,
  guionLeer,
  guionListar,
  proyectoCrear,
  proyectoGuardar,
  proyectoLeer,
  proyectoListar,
} from "./proyecto.js";

export function guionEsquemaTool(): Respuesta {
  return { texto: "Esquema del guion de vídeo.", datos: { texto: descripcionEsquema() } };
}

export function guionGuardarTool(cfg: Config, a: { guion: unknown; id?: string }): Respuesta {
  const r = guionGuardar(cfg.videoRoot, a);
  return { texto: `Guion guardado como ${r.id}${r.avisos.length ? ` (${r.avisos.length} aviso(s))` : ""}.`, datos: r };
}

export function guionListarTool(cfg: Config): Respuesta {
  const guiones = guionListar(cfg.videoRoot);
  return { texto: `${guiones.length} guion(es).`, datos: { guiones } };
}

export function guionLeerTool(cfg: Config, a: { id: string }): Respuesta {
  const r = guionLeer(cfg.videoRoot, a.id);
  return { texto: `Guion ${a.id}: ${r.guion.titulo}.`, datos: r };
}

export function guionBorrarTool(cfg: Config, a: { id: string }): Respuesta {
  guionBorrar(cfg.videoRoot, a.id);
  return { texto: `Guion ${a.id} borrado.`, datos: {} };
}

export function proyectoCrearTool(cfg: Config, a: { guionId: string; perfilId: string }): Respuesta {
  const r = proyectoCrear(cfg.videoRoot, a);
  return { texto: `Proyecto ${r.id} creado a partir de ${a.guionId}.`, datos: r };
}

export function proyectoListarTool(cfg: Config): Respuesta {
  const proyectos = proyectoListar(cfg.videoRoot);
  return { texto: `${proyectos.length} proyecto(s).`, datos: { proyectos } };
}

export function proyectoLeerTool(cfg: Config, a: { id: string }): Respuesta {
  const r = proyectoLeer(cfg.videoRoot, a.id);
  return { texto: `Proyecto ${a.id}, revisión ${r.proyecto.revision}.`, datos: r };
}

export function proyectoGuardarTool(cfg: Config, a: { id: string; revision: number; proyecto: unknown }): Respuesta {
  const r = proyectoGuardar(cfg.videoRoot, a);
  return { texto: `Proyecto ${a.id} guardado, revisión ${r.revision}.`, datos: r };
}

/** Error tipado → `isError` con el bloque `{ codigo, problemas }` al final; cualquier otro, solo el mensaje. */
export function resultadoDeError(nombre: string, e: unknown): CallToolResult {
  const mensaje = (e as Error)?.message ?? String(e);
  const content: CallToolResult["content"] = [{ type: "text", text: `Error en ${nombre}: ${mensaje}` }];
  if (e instanceof ErrorAlmacen) content.push({ type: "text", text: JSON.stringify({ codigo: e.codigo, problemas: e.problemas }) });
  return { isError: true, content };
}

type Envolver = (nombre: string, fn: () => Respuesta | Promise<Respuesta>) => Promise<CallToolResult>;

const ID_GUION = z.string().describe('Id del guion, "g-" más 16 hexadecimales.');
const ID_PROYECTO = z.string().describe('Id del proyecto, "video" más tres cifras (video001).');

export function registrarHerramientasProyecto(server: McpServer, cfg: Config, envolver: Envolver): void {
  server.registerTool(
    "video_guion_esquema",
    { title: "Esquema del guion", description: "Devuelve en `texto` el esquema JSON del guion de vídeo vertical: campos, límites y listas cerradas. Léelo antes de escribir un guion.", inputSchema: {} },
    () => envolver("video_guion_esquema", () => guionEsquemaTool()),
  );
  server.registerTool(
    "video_guion_guardar",
    {
      title: "Guardar guion",
      description: "Valida el guion contra el esquema y lo guarda. Sin id crea uno nuevo; con id sobrescribe ese guion. Devuelve { id, avisos }. Un guion que no cumple el esquema se rechaza con codigo \"esquema\". Nunca dispara voz ni render.",
      inputSchema: { guion: z.unknown().describe("Guion JSON según video_guion_esquema."), id: ID_GUION.optional() },
    },
    (a) => envolver("video_guion_guardar", () => guionGuardarTool(cfg, a)),
  );
  server.registerTool(
    "video_guion_listar",
    { title: "Listar guiones", description: "Lista los guiones guardados con su título y número de escenas.", inputSchema: {} },
    () => envolver("video_guion_listar", () => guionListarTool(cfg)),
  );
  server.registerTool(
    "video_guion_leer",
    { title: "Leer guion", description: "Devuelve un guion guardado y sus avisos.", inputSchema: { id: ID_GUION } },
    (a) => envolver("video_guion_leer", () => guionLeerTool(cfg, a)),
  );
  server.registerTool(
    "video_guion_borrar",
    { title: "Borrar guion", description: "Borra un guion guardado. Los proyectos creados a partir de él no cambian.", inputSchema: { id: ID_GUION } },
    (a) => envolver("video_guion_borrar", () => guionBorrarTool(cfg, a)),
  );
  server.registerTool(
    "video_proyecto_crear",
    {
      title: "Crear proyecto",
      description: "Crea un proyecto de vídeo a partir de un guion y un perfil. Es una copia de una sola vía: editar el guion después no cambia el proyecto. Devuelve { id }.",
      inputSchema: { guionId: ID_GUION, perfilId: z.string().describe('Id del perfil: "defecto" o "p-" más 16 hexadecimales.') },
    },
    (a) => envolver("video_proyecto_crear", () => proyectoCrearTool(cfg, a)),
  );
  server.registerTool(
    "video_proyecto_listar",
    { title: "Listar proyectos", description: "Lista los proyectos con título, revisión y escenas; los que no cumplen el esquema salen con valido:false.", inputSchema: {} },
    () => envolver("video_proyecto_listar", () => proyectoListarTool(cfg)),
  );
  server.registerTool(
    "video_proyecto_leer",
    { title: "Leer proyecto", description: "Devuelve el proyecto y sus avisos. Se valida al cargar.", inputSchema: { id: ID_PROYECTO } },
    (a) => envolver("video_proyecto_leer", () => proyectoLeerTool(cfg, a)),
  );
  server.registerTool(
    "video_proyecto_guardar",
    {
      title: "Guardar proyecto",
      description: "Guarda el proyecto si `revision` es la del disco (si no, codigo \"conflicto\"). `recursos` no se cambia desde aquí: tiene que coincidir con el disco. Devuelve { revision, avisos }.",
      inputSchema: { id: ID_PROYECTO, revision: z.number().describe("Revisión sobre la que se editó."), proyecto: z.unknown().describe("Proyecto completo.") },
    },
    (a) => envolver("video_proyecto_guardar", () => proyectoGuardarTool(cfg, a)),
  );
}
