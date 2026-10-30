// Arnés de SEO-111: monta con el pipeline real (dist/: parsearGuion, procesarAlineacion, prepararRender,
// montarComposicion) una composición completa, sin recortar hosts ni cambiar piezas. Voz sintética (sine de ffmpeg),
// alineación sintética y fotos sintéticas (testsrc2, para que el Ken Burns se note en el SSIM). No llama a ElevenLabs.
// Uso: node scripts/montar.mjs <video-engine> <salida> [GUION_TODAS | GUION_TUNEL | guion.md]   (requiere `npm run build`)
// Solo desarrollo: no se empaqueta. Las salidas van a <salida>, nunca al repo.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { entornoCerrado } from "./comparar-fotogramas.mjs";

const CUERPO = `
[1] It started small, and then the money kept coming in.
[2] Nearly ninety thousand points ahead of everyone else.
[3] Nobody comes close to that number today.
[4] Sales went up every single year since then.
[5] Spain and Italy led the way in Europe.
[6] And the water kept rising all along.
`;

/** Todas las piezas: foto (con bucle), cifra con golpe, cartel, barras, mapa, titulo3d; aurora y videocámara. */
export const GUION_TODAS = `---
titulo: Arnés SEO-111
gancho: "Nobody saw this coming"
etiqueta: World Cup winners
golpe: ninety
fondo: aurora
look: videocamara
fecha: 1995-09-06 20:15
escenas:
  2:
    tipo: cifra
    valor: 90000
    sufijo: " pts"
    etiqueta: Points ahead
  3:
    tipo: cartel
    texto: Nobody comes close
    subtexto: Not even near
  4:
    tipo: barras
    titulo: Sales per year
    periodos: [2020, 2022, 2024]
    series:
      Alpha: [5, 8, 15]
      Beta: [2, 6, 7]
  5:
    tipo: mapa
    region: europa
    destacar: [Spain, Italy]
    etiqueta: Spain and Italy
  6:
    tipo: titulo3d
    texto: AGUA
---
${CUERPO}`;

/** Túnel en el bloque 6 (usa las fotos 1-5) y look película. */
export const GUION_TUNEL = `---
titulo: Arnés SEO-111 túnel
gancho: "Nobody saw this coming"
look: pelicula
escenas:
  6:
    tipo: tunel
---
${CUERPO}`;

/** Seis bloques de foto, sin escenas: el más barato de renderizar (pruebas de la CSP). */
export const GUION_FOTOS = `---
titulo: Arnés SEO-111 fotos
gancho: "Nobody saw this coming"
---
${CUERPO}`;

const GUIONES = { GUION_TODAS, GUION_TUNEL, GUION_FOTOS };

/** Marcador que deja el arnés en su salida: solo se borra una carpeta que lo tenga (o vacía). */
export const MARCADOR_SALIDA = ".salida-arnes-seo111";

/** Vacía `salida` para un montaje nuevo. Se niega a borrar una carpeta con contenido que no creó el arnés (LOW-10). */
export function prepararSalida(salida) {
  if (fs.existsSync(salida)) {
    const hay = fs.readdirSync(salida);
    if (hay.length && !hay.includes(MARCADOR_SALIDA)) {
      throw new Error(`${salida} existe, no está vacía y no la creó el arnés (falta ${MARCADOR_SALIDA}): no la borro.`);
    }
    fs.rmSync(salida, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  fs.mkdirSync(salida, { recursive: true });
  fs.writeFileSync(path.join(salida, MARCADOR_SALIDA), "Salida de scripts/montar.mjs (SEO-111): se puede borrar.\n");
}

/**
 * Monta `<salida>/proyecto/video001/_composicion`. El proceso solo ve el entorno cerrado mientras monta (la prueba de
 * GPU de montarComposicion lanza la CLI con process.env) y lo recupera al terminar.
 * `gpu: false` fuerza el fondo sin WebGPU (VIDEO_FORZAR_SIN_GPU), para pruebas que no lo necesitan.
 */
export async function montar(motor, salida, guion = GUION_TODAS, { duracionVoz = 20, gpu = true } = {}) {
  const texto = GUIONES[guion] ?? (guion.trimStart().startsWith("---") ? guion : fs.readFileSync(guion, "utf8"));
  const ffdir = path.join(motor, "ffmpeg");
  const navegador = path.join(motor, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  const raiz = path.join(salida, "proyecto");
  const dir = path.join(raiz, "video001");
  prepararSalida(salida);
  fs.mkdirSync(dir, { recursive: true });

  const previo = { ...process.env };
  const cerrado = entornoCerrado(motor, path.join(salida, "hf-home"));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, cerrado, { VIDEO_STATE_DIR: path.join(salida, "estado") });
  if (!gpu) process.env.VIDEO_FORZAR_SIN_GPU = "1";
  try {
    const dist = (f) => import(new URL(`../dist/${f}`, import.meta.url).href);
    const { parsearGuion } = await dist("guion.js");
    const { procesarAlineacion } = await dist("alineacion.js");
    const { prepararRender, montarComposicion } = await dist("render.js");
    const { ejecutar } = await dist("proceso.js");
    const ff = async (args) => {
      const r = await ejecutar(path.join(ffdir, "ffmpeg.exe"), ["-y", "-v", "error", ...args], { timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(r.stderr);
    };

    fs.writeFileSync(path.join(dir, "guion.md"), texto);
    const g = parsearGuion(texto);
    await ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${duracionVoz}`, "-c:a", "libmp3lame", "-b:a", "128k", path.join(dir, "voz.mp3")]);
    for (let n = 1; n <= 6; n++) {
      if (g.opciones.escenas[n]) continue;
      await ff(["-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=1", "-vf", `hue=h=${n * 55}`, "-frames:v", "1", "-q:v", "3", path.join(dir, `img${n}.jpg`)]);
    }
    const chars = [...g.narracion];
    const paso = (duracionVoz - 0.4) / chars.length;
    const palabras = procesarAlineacion({
      narracion: g.narracion,
      bloques: g.bloques,
      alineacion: {
        characters: chars,
        character_start_times_seconds: chars.map((_, i) => 0.2 + i * paso),
        character_end_times_seconds: chars.map((_, i) => 0.2 + (i + 1) * paso),
      },
      duracionAudio: duracionVoz,
      hashNarracion: g.hash,
    });
    fs.writeFileSync(path.join(dir, "palabras.json"), JSON.stringify(palabras, null, 2));
    const o = { raiz, musica: false, musicaVolumen: 0.12, ffmpegDir: ffdir, browserPath: navegador };
    const comp = path.join(dir, "_composicion");
    const m = await montarComposicion(await prepararRender("video001", o), comp, o);
    return { dir: comp, duracion: m.duracion, avisos: m.avisos, usaWebgpu: m.usaWebgpu };
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, previo);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [motor, salida, guion] = process.argv.slice(2);
  if (!motor || !salida) {
    console.error("Uso: node scripts/montar.mjs <video-engine> <salida> [GUION_TODAS | GUION_TUNEL | GUION_FOTOS | guion.md]");
    process.exit(2);
  }
  const r = await montar(path.resolve(motor), path.resolve(salida), guion ?? "GUION_TODAS");
  console.log(JSON.stringify(r, null, 2));
}
