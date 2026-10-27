// npm run render:matriz — renderiza footy990-996 (y una copia de C:\Footy\footy001 si existe) sin ElevenLabs:
// fotos, voz y música generadas con ffmpeg y un palabras.json sintético con palabras reales.
// Deja una hoja de contacto por vídeo en test/salidas/footyNNN.jpg.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion, type AlineacionCaracteres, type ResultadoAlineacion } from "../src/alineacion.js";
import { encolarRender, esperarJob, ultimasLineasUtiles } from "../src/render.js";
import { ejecutar, herramientasFfmpeg, sondear } from "../src/proceso.js";
import { urlsDeRed } from "../src/composicion.js";
import { leerPruebaGpu } from "../src/capacidades.js";
import { config } from "../src/config.js";

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "footy matriz "));
const SALIDAS = path.join(import.meta.dirname, "salidas");
const SOLO = (process.env.FOOTY_MATRIZ ?? "").split(",").filter(Boolean);
fs.mkdirSync(SALIDAS, { recursive: true });

afterAll(() => {
  if (process.env.FOOTY_MOCK_CONSERVAR === "1") {
    process.stderr.write(`render:matriz conservado en ${RAIZ}\n`);
    return;
  }
  if (RAIZ.startsWith(os.tmpdir()) && path.basename(RAIZ).startsWith("footy matriz ")) fs.rmSync(RAIZ, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

const BLOQUES = `
[1] Wembley, 1995. England against Colombia.
[2] Jamie Redknapp floats a lazy shot towards goal.
[3] Any keeper just catches it.
[4] René Higuita doesn't.
[5] He dives forward and kicks it away with his heels.
[6] The scorpion kick was born.
`;

const CASOS: { id: string; fm: string; descripcion: string; sinGpu?: boolean; musica?: boolean }[] = [
  { id: "footy990", descripcion: "guion v1 puro", fm: "titulo: V1 puro\ngancho: He saved it with his heels." },
  {
    id: "footy991",
    descripcion: "etiqueta, golpe, énfasis, destellos y píldora",
    fm: "titulo: Efectos\ngancho: He saved it with his heels.\netiqueta: Wembley · 6 Sep 1995\ngolpe: kicks\nenfasis: [scorpion, kick]\ndestellos: [1, 5]\nsubtitulos: pildora",
  },
  {
    id: "footy992",
    descripcion: "videocámara con fecha y neón",
    fm: "titulo: Videocamara\ngancho: He saved it with his heels.\nlook: videocamara\nfecha: 1995-09-06 20:15\nsubtitulos: neon\nenfasis: [scorpion]",
  },
  {
    id: "footy993",
    descripcion: "mapa de España en el 2, barras en el 4 y subtítulos impacto",
    fm: [
      "titulo: Datos",
      "gancho: The numbers behind it.",
      "subtitulos: impacto",
      "enfasis: [goal]",
      "escenas:",
      "  2:",
      "    tipo: mapa",
      "    region: espana",
      "    titulo: Clubes campeones",
      "    destacar: [Madrid, Cataluña, Andalucía, País Vasco]",
      "    etiqueta: 4 comunidades",
      "  4:",
      "    tipo: barras",
      "    titulo: Copas de Europa por club",
      "    periodos: [1960, 1980, 2000, 2025]",
      "    series:",
      "      Real Madrid: [5, 6, 8, 15]",
      "      AC Milan: [0, 2, 5, 7]",
      "      Liverpool: [0, 2, 4, 6]",
      "      Bayern: [0, 3, 4, 6]",
      "    fuente: UEFA",
    ].join("\n"),
  },
  {
    id: "footy994",
    descripcion: "cifra, título 3D y cartel con fondo aurora",
    fm: [
      "titulo: Escenas",
      "gancho: One save. Forever.",
      "fondo: aurora",
      "golpe: kicks",
      "escenas:",
      "  3:",
      "    tipo: cifra",
      "    valor: 15",
      "    sufijo: ' Copas'",
      "    etiqueta: Real Madrid, récord absoluto",
      "  5:",
      "    tipo: titulo3d",
      "    texto: HIGUITA",
      "  6:",
      "    tipo: cartel",
      "    texto: The scorpion was born",
      "    subtexto: Wembley 1995",
    ].join("\n"),
  },
  {
    id: "footy995",
    descripcion: "túnel en el 1, película y música con musica_desde, ducking y cortes al ritmo",
    musica: true,
    fm: [
      "titulo: Tunel",
      "gancho: Inside the legend.",
      "look: pelicula",
      "musica: _musica/clics 120.mp3",
      "musica_desde: 2.25",
      "musica_volumen: 0.2",
      "cortes_al_ritmo: true",
      "escenas:",
      "  1:",
      "    tipo: tunel",
    ].join("\n"),
  },
];
CASOS.push({ ...CASOS[4], id: "footy996", descripcion: "como 994 forzando el fondo sin GPU", sinGpu: true });
CASOS.push({
  id: "footy997",
  descripcion: "mapas de Europa y del mundo, nebula, golpe en la cifra y etiqueta con escena en el bloque 2",
  fm: [
    "titulo: Mapas",
    "gancho: Where the trophies live.",
    "etiqueta: World Cup winners",
    "fondo: nebula",
    "golpe: kicks",
    "subtitulos: neon",
    "escenas:",
    "  2:",
    "    tipo: mapa",
    "    region: europa",
    "    destacar: [Spain, Italy, Germany]",
    "    etiqueta: Europe's champions",
    "  3:",
    "    tipo: mapa",
    "    region: mundo",
    "    destacar: [Brazil, Argentina]",
    "    etiqueta: South America",
    "  5:",
    "    tipo: cifra",
    "    valor: 17",
    "    sufijo: ' Cups'",
  ].join("\n"),
});

async function ff(args: string[]) {
  const h = herramientasFfmpeg(config.ffmpegDir)!;
  const r = await ejecutar(h.ffmpeg, ["-y", "-v", "error", ...args], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(r.stderr);
}

const COLORES = ["0x1f5c3a:0x0b0f0c", "0x8a1c1c:0x220909", "0x1c3f8a:0x08122a", "0x7a5a12:0x241a05", "0x4b1c7a:0x150826", "0x116b6b:0x052222"];

async function imagen(salida: string, n: number) {
  const [a, b] = COLORES[n - 1].split(":");
  const fuente = "C\\:/Windows/Fonts/arialbd.ttf";
  await ff([
    "-f", "lavfi", "-i", `gradients=s=1080x1920:c0=${a}:c1=${b}:x0=0:y0=0:x1=1080:y1=1920:d=1`,
    "-vf", `drawtext=fontfile='${fuente}':text='${n}':fontsize=640:fontcolor=white@0.85:x=(w-text_w)/2:y=(h-text_h)/2-120`,
    "-frames:v", "1", salida,
  ]);
}

/** Alineación sintética: 0,055 s por carácter y 0,7 s de pausa entre bloques. */
function palabrasSinteticas(contenido: string): { palabras: ResultadoAlineacion; duracion: number } {
  const g = parsearGuion(contenido);
  const chars = [...g.narracion];
  const ini: number[] = [];
  const fin: number[] = [];
  let t = 0.2;
  const finBloque = new Set(g.bloques.slice(0, 5).map((b) => b.fin));
  chars.forEach((_, i) => {
    const d = finBloque.has(i) ? 0.7 : 0.055;
    ini.push(+t.toFixed(3));
    t += d;
    fin.push(+t.toFixed(3));
  });
  const duracion = +(t + 0.3).toFixed(3);
  const alineacion: AlineacionCaracteres = { characters: chars, character_start_times_seconds: ini, character_end_times_seconds: fin };
  return { palabras: procesarAlineacion({ narracion: g.narracion, bloques: g.bloques, alineacion, duracionAudio: duracion, hashNarracion: g.hash }), duracion };
}

async function hojaDeContacto(mp4: string, tiempos: number[], salida: string) {
  const entradas = tiempos.flatMap((t) => ["-ss", t.toFixed(3), "-i", mp4]);
  const filtro = tiempos.map((_, i) => `[${i}:v]scale=270:480,trim=end_frame=1[e${i}]`).join(";") + ";" + tiempos.map((_, i) => `[e${i}]`).join("") + `hstack=inputs=${tiempos.length}[o]`;
  await ff([...entradas, "-filter_complex", filtro, "-map", "[o]", "-frames:v", "1", "-q:v", "3", salida]);
}

async function renderizar(id: string, palabras: ResultadoAlineacion, conMusica: boolean) {
  const h = herramientasFfmpeg(config.ffmpegDir)!;
  const job = await encolarRender(id, { raiz: RAIZ, musica: conMusica, musicaVolumen: 0.12, ffmpegDir: config.ffmpegDir });
  const fin = await esperarJob(job.job_id, 1000);
  if (fin.estado !== "terminado") throw new Error(`${id}: render fallido: ${fin.error}\n${ultimasLineasUtiles(fin).join("\n")}`);
  const mp4 = path.join(RAIZ, `${id}.mp4`);
  const info = await sondear(h.ffprobe, mp4);
  expect(info.ancho).toBe(1080);
  expect(info.alto).toBe(1920);
  expect(info.codecVideo).toBe("h264");
  expect(info.tieneAudio).toBe(true);
  expect(Math.abs((info.duracion ?? 0) - palabras.duracionTotal)).toBeLessThanOrEqual(0.5);
  expect(urlsDeRed(path.join(RAIZ, id, "_composicion"))).toEqual([]);
  // Un fotograma en el medio de cada bloque, otro en el 0,5 s y otro en el golpe.
  const tiempos = [0.5, ...palabras.segmentos.map((s) => (s.mostrarDesde + s.mostrarHasta) / 2)];
  const golpe = palabras.palabras.findIndex((p) => p.texto === "kicks");
  if (golpe >= 0) tiempos.push(palabras.palabras[golpe].inicio + 0.05);
  await hojaDeContacto(mp4, tiempos, path.join(SALIDAS, `${id}.jpg`));
  process.stderr.write(`render:matriz ${id} OK → ${info.duracion?.toFixed(2)} s · avisos: ${fin.avisos.join(" | ") || "ninguno"}\n`);
  return fin;
}

describe("render:matriz", () => {
  it(
    "preparar fotos, música y guiones",
    async () => {
      fs.mkdirSync(path.join(RAIZ, "_musica"), { recursive: true });
      await ff([
        "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,0.5),0.04),0.7*sin(2*PI*1000*t),0)+0.25*sin(2*PI*82*t)*if(lt(mod(t,1),0.2),1,0.3)':d=40",
        "-c:a", "libmp3lame", "-q:a", "4", path.join(RAIZ, "_musica", "clics 120.mp3"),
      ]);
      for (const c of CASOS) {
        const dir = path.join(RAIZ, c.id);
        fs.mkdirSync(dir, { recursive: true });
        const contenido = `---\n${c.fm}\n---\n${BLOQUES}`;
        fs.writeFileSync(path.join(dir, "guion.md"), contenido);
        const g = parsearGuion(contenido);
        for (let n = 1; n <= 6; n++) {
          // Fotos solo de los bloques sin escena (el túnel usa las que haya).
          if (!g.opciones.escenas[n] || g.opciones.escenas[1]?.tipo === "tunel") await imagen(path.join(dir, `img${n}.jpg`), n);
        }
        const { palabras, duracion } = palabrasSinteticas(contenido);
        fs.writeFileSync(path.join(dir, "palabras.json"), JSON.stringify(palabras, null, 2));
        await ff(["-f", "lavfi", "-i", `sine=frequency=180:duration=${duracion}`, "-af", "volume=0.6", "-c:a", "libmp3lame", "-b:a", "128k", path.join(dir, "voz.mp3")]);
      }
    },
    5 * 60 * 1000,
  );

  for (const c of CASOS) {
    it.skipIf(SOLO.length > 0 && !SOLO.includes(c.id))(
      `${c.id}: ${c.descripcion}`,
      async () => {
        const palabras = JSON.parse(fs.readFileSync(path.join(RAIZ, c.id, "palabras.json"), "utf8")) as ResultadoAlineacion;
        const antes = process.env.FOOTY_FORZAR_SIN_GPU;
        if (c.sinGpu) process.env.FOOTY_FORZAR_SIN_GPU = "1";
        try {
          const fin = await renderizar(c.id, palabras, !!c.musica);
          const fondo = path.join(RAIZ, c.id, "_composicion", "compositions", "fondo.html");
          if (c.sinGpu) {
            expect(fin.avisos.join(" ")).toMatch(/No hay WebGPU/);
            expect(fs.readFileSync(fondo, "utf8")).not.toMatch(/data-requires-webgpu/);
          } else if (c.id === "footy994" && leerPruebaGpu()?.webgpu) {
            expect(fs.readFileSync(fondo, "utf8")).toMatch(/data-shader="Aurora"/);
          }
          if (c.musica) expect(fin.avisos.join(" ")).toMatch(/Cortes al ritmo/);
        } finally {
          if (antes === undefined) delete process.env.FOOTY_FORZAR_SIN_GPU;
          else process.env.FOOTY_FORZAR_SIN_GPU = antes;
        }
      },
      15 * 60 * 1000,
    );
  }

  const real = "C:\\Footy\\footy001";
  it.skipIf(!fs.existsSync(path.join(real, "palabras.json")) || (SOLO.length > 0 && !SOLO.includes("footy001")))(
    "footy001 real (copia): un guion v1 existente se renderiza sin tocarlo",
    async () => {
      const dir = path.join(RAIZ, "footy001");
      fs.mkdirSync(dir, { recursive: true });
      for (const n of fs.readdirSync(real)) {
        if (/^(guion\.md|voz\.mp3|palabras\.json|img\d.*)$/i.test(n)) fs.copyFileSync(path.join(real, n), path.join(dir, n));
      }
      const palabras = JSON.parse(fs.readFileSync(path.join(dir, "palabras.json"), "utf8")) as ResultadoAlineacion;
      await renderizar("footy001", palabras, true);
    },
    15 * 60 * 1000,
  );
});
