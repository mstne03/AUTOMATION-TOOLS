// Spike GSAP → WAAPI (desechable): monta con el pipeline real una composición corta (gancho + dos escenas
// `cifra`, la segunda con golpe) y saca dos variantes con los mismos tiempos:
//   gsap/  la composición tal cual, recortada a esos hosts (referencia)
//   waapi/ la misma, sin GSAP: index.html sin gsap.min.js y las piezas de spikes/waapi/piezas/
// Uso: node spikes/waapi/montar.mjs <carpeta bin del ffmpeg LGPL>   (requiere `npm run build`)
// Salidas en spikes/salidas/waapi/ (ignorada por git). No llama a ElevenLabs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SALIDAS = path.join(AQUI, "..", "salidas", "waapi");
const LGPL = path.resolve(process.argv[2] ?? "");
if (!fs.existsSync(path.join(LGPL, "ffmpeg.exe"))) throw new Error("Pasa la carpeta bin del ffmpeg LGPL como argumento.");
const sep = path.delimiter;
process.env.PATH = [LGPL, ...(process.env.PATH ?? "").split(sep).filter((p) => p && !fs.existsSync(path.join(p, "ffmpeg.exe")))].join(sep);
process.env.HYPERFRAMES_NO_TELEMETRY = "1";
process.env.DO_NOT_TRACK = "1";
process.env.FFMPEG_DIR = LGPL;

const dist = (f) => import(new URL(`../../dist/${f}`, import.meta.url).href);
const { parsearGuion } = await dist("guion.js");
const { procesarAlineacion } = await dist("alineacion.js");
const { prepararRender, montarComposicion } = await dist("render.js");
const { ejecutar } = await dist("proceso.js");

const ID = "video001";
const DUR_VOZ = 12;
const valores = [[1234.5, '"$"', '""', 1], [87, '""', '" %"', 0], [42, '""', '""', 0], [90000, '""', '" pts"', 0], [3.75, '"€"', '""', 2], [12, '""', '"x"', 0]];
const GUION = `---
titulo: Spike WAAPI
gancho: "Nobody saw this coming"
golpe: thousand
escenas:
${valores.map(([v, pre, suf, dec], i) => `  ${i + 1}:
    tipo: cifra
    valor: ${v}
    prefijo: ${pre}
    sufijo: ${suf}
    decimales: ${dec}
    etiqueta: Figure number ${i + 1}`).join("\n")}
---

[1] It started small, and then the money kept coming.
[2] Most of the market followed within a year.
[3] Then the answer to everything showed up.
[4] Nearly ninety thousand points ahead of the rest.
[5] The price per unit barely moved at all.
[6] Twelve times more than anyone expected.
`;

async function ff(args) {
  const r = await ejecutar(path.join(LGPL, "ffmpeg.exe"), ["-y", "-v", "error", ...args], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(r.stderr);
}

const raiz = path.join(SALIDAS, "proyecto");
const dir = path.join(raiz, ID);
fs.rmSync(SALIDAS, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "guion.md"), GUION);
await ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${DUR_VOZ}`, "-c:a", "libmp3lame", "-b:a", "128k", path.join(dir, "voz.mp3")]);
const g = parsearGuion(GUION);
const chars = [...g.narracion];
const paso = (DUR_VOZ - 0.4) / chars.length;
const palabras = procesarAlineacion({
  narracion: g.narracion,
  bloques: g.bloques,
  alineacion: {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => 0.2 + i * paso),
    character_end_times_seconds: chars.map((_, i) => 0.2 + (i + 1) * paso),
  },
  duracionAudio: DUR_VOZ,
  hashNarracion: g.hash,
});
fs.writeFileSync(path.join(dir, "palabras.json"), JSON.stringify(palabras, null, 2));
const o = { raiz, musica: false, musicaVolumen: 0.12, ffmpegDir: LGPL };
const comp = path.join(dir, "_composicion");
const m = await montarComposicion(await prepararRender(ID, o), comp, o);
console.error(`montada: ${m.duracion} s, avisos=${JSON.stringify(m.avisos)}`);

// Solo se quedan el suelo y los hosts del gancho y de las escenas: el resto de piezas sigue en GSAP.
const index = fs.readFileSync(path.join(comp, "index.html"), "utf8");
const hosts = [...index.matchAll(/^ *<div id="h-[^"]+".*$/gm)].map((x) => x[0]);
const quedan = hosts.filter((h) => /data-composition-src="compositions\/(gancho|bloque\d+)\.html"/.test(h));
console.error("hosts:", hosts.map((h) => /id="([^"]+)"/.exec(h)[1]).join(", "), "→ quedan:", quedan.map((h) => /id="([^"]+)"/.exec(h)[1]).join(", "));
const recortado = index
  .replace(/^ *<div id="h-[^"]+".*\n/gm, "")
  .replace(/^ *<audio .*\n/gm, "")
  .replace(/(<div id="suelo"[^\n]*\n)/, `$1${quedan.join("\n")}\n`);

function copiar(destino) {
  fs.cpSync(comp, destino, { recursive: true });
  return destino;
}
const gsapDir = copiar(path.join(SALIDAS, "gsap"));
fs.writeFileSync(path.join(gsapDir, "index.html"), recortado);

const waapiDir = copiar(path.join(SALIDAS, "waapi"));
fs.writeFileSync(
  path.join(waapiDir, "index.html"),
  recortado
    .replace(/ *<script src="assets\/gsap\.min\.js"><\/script>\n/, '    <script src="assets/hf-tiempo.js"></script>\n')
    .replace(/ *<script>\s*window\.__timelines[\s\S]*?<\/script>\n/, "")
    // Sin timeline de GSAP: `data-no-timeline` es la exclusión oficial de la regla missing_timeline_registry,
    // que si no `check` da como error y el motor no renderiza.
    .replace('<div id="root" data-composition-id="main"', '<div id="root" data-composition-id="main" data-no-timeline'),
);
fs.rmSync(path.join(waapiDir, "assets", "gsap.min.js"));
fs.copyFileSync(path.join(AQUI, "hf-tiempo.js"), path.join(waapiDir, "assets", "hf-tiempo.js"));
// Las piezas WAAPI reciben el mismo HTML que generó composicion.ts: se cambia solo el <script> de animación.
for (const f of fs.readdirSync(path.join(comp, "compositions"))) {
  const nueva = path.join(AQUI, "piezas", f.startsWith("gancho") ? "gancho.js" : "escena-cifra.js");
  if (!/^(gancho|bloque\d+)\.html$/.test(f) || !fs.existsSync(nueva)) continue;
  const html = fs.readFileSync(path.join(comp, "compositions", f), "utf8");
  const scripts = [...html.matchAll(/<script>\s*\(function \(\) \{[\s\S]*?<\/script>/g)];
  if (scripts.length !== 1) throw new Error(`${f}: esperaba un único <script> de animación`);
  const env = /\}\)\(tl, "[^"]+", (\{.*\})\);/.exec(scripts[0][0])?.[1];
  // El runtime no ejecuta los scripts en su sitio (document.currentScript es null): la raíz va por id, como {{ID}}.
  // En la fase 1 serán marcadores {{ID}}, {{INICIO}} y {{DURACION}} que rellena composicion.ts.
  const host = quedan.find((h) => h.includes(`compositions/${f}"`));
  const [, inicio, duracion] = /data-start="([\d.]+)" data-duration="([\d.]+)"/.exec(host);
  const js =
    `        var RAIZ_ID = ${JSON.stringify(f.replace(".html", ""))}, INICIO = ${inicio}, DURACION = ${duracion};\n` +
    (env ? `        var ENV = ${env};\n` : "") +
    fs.readFileSync(nueva, "utf8");
  fs.writeFileSync(path.join(waapiDir, "compositions", f), html.replace(scripts[0][0], () => `<script>\n${js}\n      </script>`));
}
fs.writeFileSync(path.join(SALIDAS, "montaje.json"), JSON.stringify({ duracion: m.duracion, hosts: quedan }, null, 2));
