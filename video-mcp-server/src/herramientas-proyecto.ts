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
import { perfilDuplicar, perfilGuardar, perfilesListar } from "./perfil.js";
import { vozCoste, vozForma, vozGenerar, vozMuestra, vozQuitarSilencios, voces } from "./voz.js";

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

// ---------- Perfil visual (T8) ----------

export function perfilesListarTool(cfg: Config): Respuesta {
  const perfiles = perfilesListar(cfg.videoRoot);
  return { texto: `${perfiles.length} perfil(es).`, datos: { perfiles } };
}

export function perfilGuardarTool(cfg: Config, a: { id: string; perfil: unknown }): Respuesta {
  const r = perfilGuardar(cfg.videoRoot, a);
  return { texto: `Perfil ${r.id} guardado.`, datos: r };
}

export function perfilDuplicarTool(cfg: Config, a: { id: string; nombre?: string }): Respuesta {
  const r = perfilDuplicar(cfg.videoRoot, a);
  return { texto: `Perfil ${a.id} duplicado como ${r.id}.`, datos: r };
}

// ---------- Voz por frases (T5) ----------

export function vozCosteTool(cfg: Config, a: { id: string; frases?: string[] }): Respuesta {
  const r = vozCoste(cfg, a.id, a.frases);
  const aviso = r.fallidasFacturadas.length ? ` ${r.fallidasFacturadas.length} ya se cobraron y fallaron: reintentarlas cobra ${r.caracteresRefacturados} caracteres más.` : "";
  return { texto: `${r.pendientes.length} frase(s) sin voz: ${r.caracteres} caracteres a facturar.${aviso}`, datos: { ...r } };
}

export async function vozGenerarTool(cfg: Config, a: { id: string; frases?: string[]; caracteresConfirmados: number; planConfirmado: string; reintentarFacturadas?: boolean }, fetchImpl?: typeof fetch): Promise<Respuesta> {
  const r = await vozGenerar(cfg, a, fetchImpl);
  const texto = r.fallo
    ? `Voz generada en parte: ${r.generadas} hecha(s) y se conservan. Falló la frase ${r.fallo.fraseId}: ${r.fallo.mensaje}${r.fallo.facturada ? " ElevenLabs ya cobró esa frase; reintentarla se cobra otra vez." : ""}`
    : `Voz generada: ${r.generadas} llamada(s), ${r.caracteresFacturados} caracteres facturados.`;
  return { texto, datos: { ...r } };
}

export async function vozFormaTool(cfg: Config, a: { id: string }): Promise<Respuesta> {
  const r = await vozForma(cfg, a.id);
  return { texto: `Forma de onda de ${r.segundos} s en ${r.picos.length} picos.`, datos: r };
}

export function vozQuitarSilenciosTool(cfg: Config, a: { id: string; fraseId: string }): Respuesta {
  const r = vozQuitarSilencios(cfg, a.id, a.fraseId);
  return { texto: `Recorte de ${a.fraseId}: de ${r.recorte.inicio} s a ${r.recorte.fin} s.`, datos: r };
}

export async function vocesTool(cfg: Config, fetchImpl?: typeof fetch): Promise<Respuesta> {
  const r = await voces(cfg, fetchImpl);
  return { texto: `${r.voces.length} voz(oces) en la cuenta.`, datos: r };
}

export async function vozMuestraTool(cfg: Config, a: { voiceId?: string; perfilId?: string; caracteresConfirmados: number; planConfirmado: string; reintentarFacturada?: boolean }, fetchImpl?: typeof fetch): Promise<Respuesta> {
  const r = await vozMuestra(cfg, a, fetchImpl);
  return { texto: r.cache ? "Muestra de la voz (de la caché, sin coste)." : `Muestra de la voz generada: ${r.caracteres} caracteres facturados.`, datos: r };
}

/** Error tipado → `isError` con el bloque `{ codigo, problemas }` al final; cualquier otro, solo el mensaje. */
export function resultadoDeError(nombre: string, e: unknown): CallToolResult {
  // Un error crudo de fs lleva rutas absolutas en el mensaje: al cliente solo el código; la ruta queda en el log.
  const code = (e as NodeJS.ErrnoException)?.code;
  const crudoDeFs = !(e instanceof ErrorAlmacen) && typeof code === "string" && /^E[A-Z0-9]+$/.test(code);
  const mensaje = crudoDeFs ? `Error del sistema de ficheros (${code}).` : ((e as Error)?.message ?? String(e));
  const content: CallToolResult["content"] = [{ type: "text", text: `Error en ${nombre}: ${mensaje}` }];
  if (e instanceof ErrorAlmacen) content.push({ type: "text", text: JSON.stringify({ codigo: e.codigo, problemas: e.problemas }) });
  return { isError: true, content };
}

type Envolver = (nombre: string, fn: () => Respuesta | Promise<Respuesta>) => Promise<CallToolResult>;

export const ID_GUION = z.string().max(40).describe('Id del guion, "g-" más 16 hexadecimales.');
export const ID_PERFIL = z.string().max(40).describe('Id del perfil: "defecto" o "p-" más 16 hexadecimales.');
export const ID_PROYECTO = z.string().max(40).describe('Id del proyecto, "video" más tres cifras (video001).');

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
  // Perfil visual (T8). El id nuevo lo genera siempre el motor: duplicar solo recibe el de origen.
  server.registerTool(
    "video_perfiles_listar",
    { title: "Listar perfiles", description: "Lista los perfiles visuales (nombre, voz, idioma, colores y fuente). \"defecto\" siempre existe. Los que no cumplen el esquema salen con valido:false.", inputSchema: {} },
    () => envolver("video_perfiles_listar", () => perfilesListarTool(cfg)),
  );
  server.registerTool(
    "video_perfil_guardar",
    {
      title: "Guardar perfil",
      description: "Guarda un perfil que ya existe. Si el `id` del perfil no es el del argumento, codigo \"esquema\" con id_distinto y no se escribe nada; un perfil que no existe es \"no_encontrado\". Colores #RGB/#RRGGBB, fuente de la lista cerrada. Devuelve { id }.",
      inputSchema: { id: ID_PERFIL, perfil: z.unknown().describe("Perfil { id?, nombre, voz, idioma, colores { fondo, texto, acento, contorno, secundario }, fuente }.") },
    },
    (a) => envolver("video_perfil_guardar", () => perfilGuardarTool(cfg, a)),
  );
  server.registerTool(
    "video_perfil_duplicar",
    {
      title: "Duplicar perfil",
      description: "Copia un perfil con un id nuevo que genera el motor (no se puede pedir uno). `nombre` es opcional. Devuelve { id } del nuevo.",
      inputSchema: { id: ID_PERFIL.describe("Id del perfil que se copia."), nombre: z.string().max(240).optional() },
    },
    (a) => envolver("video_perfil_duplicar", () => perfilDuplicarTool(cfg, a)),
  );
  // Voz por frases (T5). Gastan créditos de ElevenLabs: el modelo no las usa (D2, I10) y el gasto exige los caracteres confirmados.
  server.registerTool(
    "video_voz_coste",
    { title: "Coste de la voz", description: "Frases del proyecto sin voz y caracteres que se facturarían al generarlas. No llama a ElevenLabs. `frases` limita el cálculo a esas frases. Devuelve { pendientes, caracteres, voz, plan, fallidasFacturadas, caracteresRefacturados }.", inputSchema: { id: ID_PROYECTO, frases: z.array(z.string().max(40)).max(540).optional() } },
    (a) => envolver("video_voz_coste", () => vozCosteTool(cfg, a)),
  );
  server.registerTool(
    "video_voz_generar",
    {
      title: "Generar voz por frases",
      description:
        "Genera la voz de las frases que no la tienen (o de `frases`), de una en una, y las conserva en disco. `caracteresConfirmados` y `planConfirmado` tienen que ser los de video_voz_coste; si no, codigo \"coste_cambiado\" y no se llama. Si hay frases ya cobradas que fallaron, hace falta `reintentarFacturadas: true` (codigo \"reintento_facturado\"). Un fallo a medias devuelve `fallo` (con `facturada`) y conserva lo hecho. Devuelve { generadas, caracteresFacturados, fallo? }.",
      inputSchema: { id: ID_PROYECTO, frases: z.array(z.string().max(40)).max(540).optional(), caracteresConfirmados: z.number().describe("Caracteres que la persona vio y confirmó."), planConfirmado: z.string().max(100).describe("El `plan` de video_voz_coste que la persona vio."), reintentarFacturadas: z.boolean().optional() },
    },
    (a) => envolver("video_voz_generar", () => vozGenerarTool(cfg, a)),
  );
  server.registerTool(
    "video_voz_forma",
    { title: "Forma de onda de la voz", description: "Une la voz de las frases y devuelve su forma de onda: { picos (≤ 2000, de 0 a 1), segundos }. Faltan voces: codigo \"voz_pendiente\".", inputSchema: { id: ID_PROYECTO } },
    (a) => envolver("video_voz_forma", () => vozFormaTool(cfg, a)),
  );
  server.registerTool(
    "video_voz_quitar_silencios",
    {
      title: "Quitar silencios de una frase",
      description: "Recorta el silencio (huecos de más de 0,25 s) al principio y al final de la voz de una frase y guarda el `recorte` en el proyecto. Devuelve { recorte }.",
      inputSchema: { id: ID_PROYECTO, fraseId: z.string().max(40) },
    },
    (a) => envolver("video_voz_quitar_silencios", () => vozQuitarSilenciosTool(cfg, a)),
  );
  server.registerTool(
    "video_voces",
    { title: "Voces de la cuenta", description: "Catálogo de voces de la cuenta de ElevenLabs: { voces: [{ id, nombre, idioma }] }.", inputSchema: {} },
    () => envolver("video_voces", () => vocesTool(cfg)),
  );
  server.registerTool(
    "video_voz_muestra",
    {
      title: "Muestra de una voz",
      description: "Genera una muestra de 60 caracteres con esa voz (`voiceId`) o con la del perfil (`perfilId`); una de las dos (guardada por voz). `caracteresConfirmados` tiene que ser 60 y `planConfirmado` el `planMuestra` de esa voz en video_voces. Si ya se cobró y falló, `reintentarFacturada: true`. Devuelve { audioBase64, caracteres, cache }.",
      inputSchema: { voiceId: z.string().max(60).optional(), perfilId: z.string().max(20).optional(), caracteresConfirmados: z.number(), planConfirmado: z.string().max(100), reintentarFacturada: z.boolean().optional() },
    },
    (a) => envolver("video_voz_muestra", () => vozMuestraTool(cfg, a)),
  );
}
