// W1.1 (SEO-114): monta una composición mínima con solo el fondo shader, como la del motor.
// Uso: node spikes/shader/montar.mjs [--shader aurora|plasma|nebula|mesh] [--duracion 50.4] [--salida <dir>]
// Escribe spikes/salidas/shader/comp/ (ignorada por git). Sin motor, sin ElevenLabs, sin ffmpeg, sin red.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MOTOR = path.join(AQUI, "..", "..");
const { values: a } = parseArgs({
  options: {
    shader: { type: "string", default: "aurora" },
    duracion: { type: "string", default: "50.4" },
    salida: { type: "string", default: path.join(MOTOR, "spikes", "salidas", "shader", "comp") },
  },
});

// Mismo mapa y mismas props que src/composicion.ts (colores de plantilla/tema.json): lista cerrada, sin URLs.
const SHADERS = { aurora: "Aurora", plasma: "Plasma", nebula: "FractalNoise", mesh: "MeshGradient" };
const c = JSON.parse(fs.readFileSync(path.join(MOTOR, "plantilla", "tema.json"), "utf8")).colores;
const PROPS = {
  aurora: { colorA: c.acento, colorB: c.secundario, colorC: c.texto },
  plasma: { colorA: c.secundario, colorB: c.fondo },
  mesh: { colorA: c.fondo, colorB: c.acento },
  nebula: { colorA: c.fondo, colorB: c.secundario, contrast: 0.7, speed: 0.25 },
};
if (!SHADERS[a.shader]) throw new Error(`--shader debe ser uno de ${Object.keys(SHADERS).join(", ")}`);
const D = Number(a.duracion);
if (!Number.isFinite(D) || D <= 0 || D > 600) throw new Error("--duracion debe ser un número en (0, 600]");

const escaparAtributo = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const marcas = { ID: "fondo", DURACION: String(D), SHADER: SHADERS[a.shader], PROPS: escaparAtributo(JSON.stringify(PROPS[a.shader])) };
const fondo = fs
  .readFileSync(path.join(MOTOR, "plantilla", "piezas", "fondo-shader.html"), "utf8")
  .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in marcas ? marcas[k] : m));
if (/\{\{\w+\}\}/.test(fondo)) throw new Error("quedan marcadores sin sustituir en fondo-shader.html");

// Raíz como la de composicion.ts, sin GSAP: `data-no-timeline` en #root y el host del fondo (z 10, data-no-timeline).
const index = `<!doctype html>
<html lang="en" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>shader ${a.shader}</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: #000; }
      #root { position: relative; width: 1080px; height: 1920px; overflow: hidden; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="${D}" data-width="1080" data-height="1920">
      <div id="h-fondo" data-composition-id="fondo" data-composition-src="compositions/fondo.html" data-start="0" data-duration="${D}" data-track-index="10" data-width="1080" data-height="1920" data-no-timeline style="position: absolute; left: 0; top: 0; width: 1080px; height: 1920px; z-index: 10"></div>
    </div>
  </body>
</html>
`;

// Solo se borra una carpeta de nombre simple directamente bajo spikes/salidas/shader.
const SALIDAS = path.join(MOTOR, "spikes", "salidas", "shader");
a.salida = path.resolve(a.salida);
if (!/^[\w-]+$/.test(path.basename(a.salida)) || path.dirname(a.salida) !== SALIDAS) throw new Error("--salida debe ser spikes/salidas/shader/<nombre> con nombre [A-Za-z0-9_-]");
fs.rmSync(a.salida, { recursive: true, force: true });
fs.mkdirSync(path.join(a.salida, "compositions"), { recursive: true });
fs.mkdirSync(path.join(a.salida, "assets", "vendor"), { recursive: true });
fs.writeFileSync(path.join(a.salida, "index.html"), index);
fs.writeFileSync(path.join(a.salida, "compositions", "fondo.html"), fondo);
fs.copyFileSync(path.join(MOTOR, "plantilla", "vendor", "shaders.iife.js"), path.join(a.salida, "assets", "vendor", "shaders.iife.js"));
if (!fondo.includes(`<canvas data-shader="${SHADERS[a.shader]}"`)) throw new Error("el HTML del fondo no tiene el canvas esperado");
console.log(JSON.stringify({ salida: a.salida, shader: SHADERS[a.shader], duracion: D }));
