#!/usr/bin/env node
// Servidor MCP footy (stdio). Nada de console.log: stdout es del protocolo.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config, faltanParaVoz } from "./config.js";
import { log } from "./log.js";
import { herramientasFfmpeg } from "./proceso.js";
import * as h from "./herramientas.js";
import { resumenCampos } from "./formato.js";

// Red de seguridad: cualquier console.log accidental (también de dependencias) va a stderr.
console.log = (...a: unknown[]) => log.info(...a);
console.info = (...a: unknown[]) => log.info(...a);
console.debug = (...a: unknown[]) => log.info(...a);

const ID = z.string().describe('Id del vídeo, "footy" más tres cifras (footy001).');

function aResultado(r: h.Respuesta): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: r.texto }];
  if (r.imagen) content.push({ type: "image", data: r.imagen.base64, mimeType: r.imagen.mimeType });
  content.push({ type: "text", text: JSON.stringify(r.datos, null, 2) });
  return { content };
}

async function envolver(nombre: string, fn: () => h.Respuesta | Promise<h.Respuesta>): Promise<CallToolResult> {
  try {
    return aResultado(await fn());
  } catch (e) {
    const mensaje = (e as Error).message ?? String(e);
    log.error(`${nombre}: ${mensaje}`);
    return { isError: true, content: [{ type: "text", text: `Error en ${nombre}: ${mensaje}` }] };
  }
}

const server = new McpServer({ name: "footy", version: "0.2.0" });

server.registerTool(
  "footy_listar",
  {
    title: "Listar vídeos footy",
    description: "Lista las carpetas footyNNN de FOOTY_ROOT con su estado (guion, imágenes requeridas, voz, mp4) y el siguiente id libre.",
    inputSchema: {},
  },
  () => envolver("footy_listar", () => h.listar(config)),
);

server.registerTool(
  "footy_guardar_guion",
  {
    title: "Guardar guion",
    description:
      "Valida y guarda guion.md: frontmatter YAML y exactamente 6 bloques [1] a [6] (uno por imagen o escena), máx. 650 caracteres de narración. " +
      `Campos: ${resumenCampos()}. Detalle completo y ejemplos en footy_ayuda. ` +
      "Sin id crea la carpeta con el siguiente id libre. No pisa un guion existente salvo con sobrescribir=true.",
    inputSchema: {
      id: ID.optional(),
      contenido: z.string().describe("Contenido completo de guion.md."),
      sobrescribir: z.boolean().optional().default(false),
    },
  },
  (a) => envolver("footy_guardar_guion", () => h.guardarGuion(config, a)),
);

server.registerTool(
  "footy_estado",
  {
    title: "Estado de un vídeo",
    description: "Detalle de un vídeo: opciones del guion, imágenes requeridas con su resolución, fondo (GPU o reserva), música, voz y mp4.",
    inputSchema: { id: ID },
  },
  (a) => envolver("footy_estado", () => h.estado(config, a.id)),
);

server.registerTool(
  "footy_generar_voz",
  {
    title: "Generar voz con ElevenLabs",
    description:
      "Genera voz.mp3 con la voz clonada de ElevenLabs y los tiempos por palabra (palabras.json). " +
      "Si voz.mp3 ya existe no llama a la API (gasta créditos) salvo con forzar=true.",
    inputSchema: { id: ID, forzar: z.boolean().optional().default(false) },
  },
  (a) => envolver("footy_generar_voz", () => h.generarVoz(config, a)),
);

server.registerTool(
  "footy_renderizar",
  {
    title: "Renderizar short",
    description:
      "Comprueba guion, imágenes requeridas y voz, monta la composición HyperFrames, pasa hyperframes check y lanza el render a FOOTY_ROOT\\footyNNN.mp4 " +
      "(1080×1920, 30 fps). Devuelve un job_id al momento; consulta con footy_estado_render. Un render a la vez; el resto se encola.",
    inputSchema: { id: ID, musica: z.boolean().optional().default(true).describe("Incluir la música del guion si la hay.") },
  },
  (a) => envolver("footy_renderizar", () => h.renderizar(config, a)),
);

server.registerTool(
  "footy_estado_render",
  {
    title: "Estado de un render",
    description: "Estado de un job de render (en_cola, renderizando, terminado, error), progreso, ruta y duración del mp4.",
    inputSchema: { job_id: z.string() },
  },
  (a) => envolver("footy_estado_render", () => h.estadoRender(a)),
);

server.registerTool(
  "footy_fotograma",
  {
    title: "Ver un fotograma",
    description: "Extrae un fotograma del mp4 renderizado y lo devuelve como imagen PNG de 540×960 para revisarlo.",
    inputSchema: { id: ID, segundo: z.number().min(0).describe("Segundo del vídeo.") },
  },
  (a) => envolver("footy_fotograma", () => h.fotograma(config, a)),
);

server.registerTool(
  "footy_ayuda",
  {
    title: "Formato del guion",
    description:
      "Formato completo del guion v2: campos, escenas especiales con ejemplo, listas válidas y un guion de ejemplo. Léelo antes de escribir un guion con efectos o escenas.",
    inputSchema: {},
  },
  () => envolver("footy_ayuda", () => h.ayuda()),
);

server.registerTool(
  "footy_capacidades",
  {
    title: "Capacidades de la máquina",
    description:
      "GPU/WebGPU (y fecha de la prueba), versiones de HyperFrames, FFmpeg y Chrome, fondos disponibles y telemetría. reprobar=true repite la prueba de GPU.",
    inputSchema: { reprobar: z.boolean().optional().default(false) },
  },
  (a) => envolver("footy_capacidades", () => h.capacidadesHerramienta(config, a)),
);

server.registerTool(
  "footy_vista_previa",
  {
    title: "Vista previa sin render",
    description:
      "Monta la composición y devuelve una hoja de contacto (máx. 8 fotogramas de 270×480) en los segundos pedidos, sin renderizar el vídeo. Necesita guion válido y voz.",
    inputSchema: { id: ID, segundos: z.array(z.number().min(0)).min(1).max(8).describe("Segundos del vídeo, por ejemplo [0.5, 4, 9].") },
  },
  (a) => envolver("footy_vista_previa", () => h.vistaPrevia(config, a)),
);

server.registerTool(
  "footy_musica",
  {
    title: "Biblioteca de música",
    description: "Lista FOOTY_ROOT\\_musica con duración, BPM y sonoridad de cada pista (cacheado). Usa la ruta que devuelve en `musica:` del guion.",
    inputSchema: {},
  },
  () => envolver("footy_musica", () => h.musica(config)),
);

server.registerTool(
  "footy_catalogo",
  {
    title: "Buscar en el catálogo HyperFrames",
    description: "Busca bloques y componentes del catálogo de HyperFrames (solo lectura) e indica cuáles ya están adaptados en plantilla/piezas/.",
    inputSchema: { consulta: z.string().min(1).describe('Palabras de búsqueda, por ejemplo "map" o "caption".') },
  },
  (a) => envolver("footy_catalogo", () => h.catalogo(config, a)),
);

async function main() {
  log.info(`footy-mcp-server arrancando. FOOTY_ROOT=${config.footyRoot}`);
  herramientasFfmpeg(config.ffmpegDir);
  const faltan = faltanParaVoz(config);
  if (faltan.length) log.warn(`Faltan ${faltan.join(", ")} en .env: footy_generar_voz no funcionará hasta rellenarlas.`);
  await server.connect(new StdioServerTransport());
  log.info("footy-mcp-server listo (stdio).");
}

process.on("unhandledRejection", (e) => log.error("unhandledRejection:", e));
main().catch((e) => {
  log.error("Fallo al arrancar:", e);
  process.exit(1);
});
