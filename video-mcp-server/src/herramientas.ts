// Lógica de las 12 herramientas MCP, separada del registro para poder probarla.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { faltanParaVoz } from "./config.js";
import { ErrorGuion, parsearGuion, type Guion } from "./guion.js";
import { procesarAlineacion, type ResultadoAlineacion } from "./alineacion.js";
import { archivosVideo, imagenesValidadas, ErrorVideo, listarIds, resolverDentro, siguienteId, validarId } from "./paths.js";
import { esIntegrado, herramientasFfmpeg, mensajeSinFfmpeg, sondear } from "./proceso.js";
import { sintetizarConTimestamps } from "./tts.js";
import { encolarRender, listarJobs, obtenerJob, posicionEnCola, ultimasLineasUtiles } from "./render.js";
import { extraerFotograma } from "./fotograma.js";
import { log } from "./log.js";
import { bloquesConFoto, fondoUsaWebgpu, textoAyuda } from "./formato.js";
import { capacidades, gpuForzadaApagada, leerPruebaGpu } from "./capacidades.js";
import { HYPERFRAMES_BIN, listarMusica } from "./musica.js";
import { montarComposicion, prepararRender } from "./render.js";
import { ejecutar, entornoConFfmpeg } from "./proceso.js";
import { PIEZAS_DIR } from "./composicion.js";

export interface Respuesta {
  texto: string;
  datos: Record<string, unknown>;
  imagen?: { base64: string; mimeType: string };
}

const s2 = (x: number | undefined) => (x === undefined ? "?" : `${x.toFixed(1)} s`);

function leerGuion(ruta: string): { guion?: Guion; problemas?: string[] } {
  if (!fs.existsSync(ruta)) return {};
  try {
    return { guion: parsearGuion(fs.readFileSync(ruta, "utf8")) };
  } catch (e) {
    if (e instanceof ErrorGuion) return { problemas: e.problemas };
    throw e;
  }
}

function leerPalabras(ruta: string): ResultadoAlineacion | undefined {
  try {
    return JSON.parse(fs.readFileSync(ruta, "utf8")) as ResultadoAlineacion;
  } catch {
    return undefined;
  }
}

/** Escritura atómica: primero a un temporal y luego renombrado. */
function escribirAtomico(ruta: string, datos: string | Buffer): void {
  const tmp = `${ruta}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, datos);
  fs.renameSync(tmp, ruta);
}

/** Opciones v2 activas en una línea. */
export function resumenOpciones(g: Guion): string {
  const o = g.opciones;
  const partes: string[] = [];
  if (o.etiqueta) partes.push(`etiqueta "${o.etiqueta}"`);
  if (o.golpe) partes.push(`golpe en "${o.golpe.palabra}"`);
  if (o.enfasisPalabras.length) partes.push(`énfasis ${o.enfasisPalabras.join(", ")}`);
  partes.push(`destellos en ${o.destellos.join(", ") || "ninguno"}`, `look ${o.look}`, `subtítulos ${o.subtitulos}`);
  if (o.fondo !== "ninguno") partes.push(`fondo ${o.fondo}`);
  const esc = Object.entries(o.escenas).map(([n, e]) => `${n}: ${e!.tipo}`);
  if (esc.length) partes.push(`escenas ${esc.join(", ")}`);
  if (g.musica) {
    partes.push(`música ${g.musica}${o.musicaDesde ? ` desde ${o.musicaDesde} s` : ""}${o.cortesAlRitmo ? " con cortes al ritmo" : ""}`);
  }
  return partes.join(" · ");
}

// ---------- video_listar ----------

export function listar(cfg: Config): Respuesta {
  const ids = listarIds(cfg.videoRoot);
  const videos = ids.map((id) => {
    const r = archivosVideo(cfg.videoRoot, id);
    // Un enlace simbólico sospechoso en un vídeo no debe impedir listar los demás: ese vídeo cuenta como sin imágenes.
    let imagenes: ReturnType<typeof imagenesValidadas>["imagenes"] = [];
    let ignoradas: string[] = [];
    let aviso: string | undefined;
    try {
      ({ imagenes, ignoradas } = imagenesValidadas(r.dir));
    } catch (e) {
      if (!(e instanceof ErrorVideo)) throw e;
      aviso = e.message;
    }
    const { guion } = leerGuion(r.guion);
    // Imágenes requeridas = bloques sin escena (sin guion válido, las 6).
    const requeridas = guion ? bloquesConFoto(guion.opciones.escenas) : [1, 2, 3, 4, 5, 6];
    return {
      id,
      guion: fs.existsSync(r.guion),
      imagenes: requeridas.filter((n) => imagenes[n - 1]).length,
      imagenesRequeridas: requeridas.length,
      fotosConOtroNombre: ignoradas,
      aviso,
      voz: fs.existsSync(r.voz),
      mp4: fs.existsSync(r.mp4),
    };
  });
  const siguiente = siguienteId(cfg.videoRoot);
  const marca = (b: boolean) => (b ? "sí" : "no");
  const lineas = videos.map(
    (v) => `- ${v.id}: guion ${marca(v.guion)} · imágenes requeridas ${v.imagenes}/${v.imagenesRequeridas}${v.fotosConOtroNombre.length ? ` (+${v.fotosConOtroNombre.length} foto(s) con otro nombre que no se usan; mira video_estado)` : ""} · voz ${marca(v.voz)} · mp4 ${marca(v.mp4)}${v.aviso ? `
  AVISO: no he podido leer las imágenes de ${v.id}: ${v.aviso}` : ""}`,
  );
  const texto = [
    videos.length ? `${videos.length} vídeo(s) en ${cfg.videoRoot}:` : `No hay vídeos todavía en ${cfg.videoRoot}.`,
    ...lineas,
    `Siguiente id libre: ${siguiente}.`,
  ].join("\n");
  return { texto, datos: { raiz: cfg.videoRoot, videos, siguienteId: siguiente } };
}

// ---------- video_guardar_guion ----------

export function guardarGuion(cfg: Config, args: { id?: string; contenido: string; sobrescribir?: boolean }): Respuesta {
  const guion = parsearGuion(args.contenido); // valida antes de escribir nada
  fs.mkdirSync(cfg.videoRoot, { recursive: true });
  const id = args.id ? validarId(args.id) : siguienteId(cfg.videoRoot);
  const r = archivosVideo(cfg.videoRoot, id);
  const existia = fs.existsSync(r.guion);
  if (existia && !args.sobrescribir) {
    throw new ErrorVideo(`${id} ya tiene guion.md. Para reemplazarlo, llama otra vez con sobrescribir=true.`);
  }
  const avisos: string[] = [];
  if (fs.existsSync(r.voz)) {
    const p = leerPalabras(r.palabras);
    if (!p || p.hashNarracion !== guion.hash) {
      avisos.push("Ya existe voz.mp3 y el texto narrado ha cambiado: hay que regenerar la voz con video_generar_voz(forzar=true).");
    }
  }
  avisos.push(...guion.avisos);
  fs.mkdirSync(r.dir, { recursive: true });
  const contenido = args.contenido.endsWith("\n") ? args.contenido : `${args.contenido}\n`;
  escribirAtomico(r.guion, contenido);
  const requeridas = bloquesConFoto(guion.opciones.escenas);
  const texto = [
    `Guion ${existia ? "reemplazado" : "guardado"} en ${r.guion}.`,
    `"${guion.titulo}" · ${guion.caracteres}/650 caracteres de narración.`,
    `Opciones: ${resumenOpciones(guion)}.`,
    ...avisos.map((a) => `Aviso: ${a}`),
    `Siguiente paso: deja ${requeridas.map((n) => `img${n}`).join(", ")} en ${r.dir} y genera la voz con video_generar_voz("${id}").`,
  ].join("\n");
  return {
    texto,
    datos: { id, ruta: r.guion, titulo: guion.titulo, caracteres: guion.caracteres, sobrescrito: existia, imagenesRequeridas: requeridas, opciones: guion.opciones, avisos },
  };
}

// ---------- video_estado ----------

export async function estado(cfg: Config, idArg: string): Promise<Respuesta> {
  const id = validarId(idArg);
  const r = archivosVideo(cfg.videoRoot, id);
  if (!fs.existsSync(r.dir)) throw new ErrorVideo(`No existe ${r.dir}. Usa video_listar para ver los ids.`);
  const h = herramientasFfmpeg(cfg.ffmpegDir);
  const avisos: string[] = [];
  const { guion, problemas } = leerGuion(r.guion);

  const { imagenes, avisos: avisosImg } = imagenesValidadas(r.dir);
  avisos.push(...avisosImg);
  const infoImagenes: { n: number; encontrada: boolean; nombre?: string; ancho?: number; alto?: number; avisoResolucion?: boolean }[] = [];
  for (const [i, img] of imagenes.entries()) {
    if (!img) {
      infoImagenes.push({ n: i + 1, encontrada: false });
      continue;
    }
    let ancho: number | undefined;
    let alto: number | undefined;
    if (h) {
      try {
        ({ ancho, alto } = await sondear(h.ffprobe, img.ruta));
      } catch (e) {
        avisos.push(`No puedo leer ${img.nombre}: ${(e as Error).message}`);
      }
    }
    const pequena = ancho !== undefined && alto !== undefined && Math.min(ancho, alto) < 1080;
    if (pequena) avisos.push(`${img.nombre} mide ${ancho}×${alto}: el lado corto es menor de 1080 px y se verá blanda.`);
    infoImagenes.push({ n: i + 1, encontrada: true, nombre: img.nombre, ancho, alto, avisoResolucion: pequena });
  }

  let duracionVoz: number | undefined;
  let vozCoherente: boolean | undefined;
  if (fs.existsSync(r.voz)) {
    if (h) duracionVoz = (await sondear(h.ffprobe, r.voz).catch(() => undefined))?.duracion;
    const p = leerPalabras(r.palabras);
    vozCoherente = !!p && !!guion && p.hashNarracion === guion.hash;
    if (!vozCoherente) avisos.push("La voz no corresponde al guion actual (o falta palabras.json): regenérala con forzar=true.");
  }
  let mp4: { ruta: string; duracion?: number } | undefined;
  if (fs.existsSync(r.mp4)) {
    mp4 = { ruta: r.mp4, duracion: h ? (await sondear(h.ffprobe, r.mp4).catch(() => undefined))?.duracion : undefined };
  }
  if (!h) avisos.push(mensajeSinFfmpeg());
  const jobs = listarJobs()
    .filter((j) => j.id === id)
    .map((j) => ({ job_id: j.job_id, estado: j.estado, creado: j.creado }));

  const requeridas = guion ? bloquesConFoto(guion.opciones.escenas) : [1, 2, 3, 4, 5, 6];
  const encontradas = requeridas.filter((n) => infoImagenes[n - 1]?.encontrada).length;
  const textoImagen = (i: (typeof infoImagenes)[number]) => {
    const esc = guion?.opciones.escenas[i.n];
    if (esc) return `bloque ${i.n}: escena ${esc.tipo}${i.encontrada ? ` (sobra ${i.nombre})` : ""}`;
    return i.encontrada ? `${i.nombre}${i.ancho ? ` ${i.ancho}×${i.alto}` : ""}` : `img${i.n} FALTA`;
  };
  if (guion) avisos.push(...guion.avisos);

  // Fondo: con GPU o con el degradado de reserva.
  let fondo: { tipo: string; modo: string } | null = null;
  if (guion && guion.opciones.fondo !== "ninguno") {
    const prueba = leerPruebaGpu();
    const modo = !fondoUsaWebgpu(guion.opciones)
      ? guion.opciones.fondo === "gradiente"
        ? "degradado CSS"
        : "sin escenas que lo usen"
      : gpuForzadaApagada()
        ? "degradado de reserva (VIDEO_FORZAR_SIN_GPU=1)"
        : !prueba
          ? "WebGPU sin comprobar todavía (la prueba se hace en el primer render o con video_capacidades)"
          : prueba.webgpu
            ? "WebGPU con la GPU"
            : "degradado de reserva (no hay WebGPU)";
    fondo = { tipo: guion.opciones.fondo, modo };
  }
  // Música: pista, desde, volumen y BPM si ya se analizó con video_musica.
  let musica: Record<string, unknown> | null = null;
  if (guion?.musica) {
    let ruta: string | undefined;
    try {
      ruta = resolverDentro(cfg.videoRoot, guion.musica);
    } catch {
      avisos.push(`La música "${guion.musica}" está fuera de VIDEO_ROOT.`);
    }
    const existe = !!ruta && fs.existsSync(ruta);
    if (ruta && !existe) avisos.push(`No encuentro la música ${ruta}.`);
    let bpm: number | undefined;
    let duracionPista: number | undefined;
    if (existe && h) {
      const p = (await listarMusica(h, path.dirname(ruta!)).catch(() => [])).find((x) => x.ruta === ruta);
      bpm = p?.bpm;
      duracionPista = p?.duracion;
      if (duracionPista !== undefined && guion.opciones.musicaDesde >= duracionPista) {
        avisos.push(`musica_desde (${guion.opciones.musicaDesde} s) es mayor que la pista (${duracionPista.toFixed(1)} s).`);
      }
    }
    musica = {
      pista: guion.musica,
      existe,
      desde: guion.opciones.musicaDesde,
      volumen: guion.opciones.musicaVolumen ?? cfg.musicaVolumen,
      bpm,
      duracionPista,
      cortesAlRitmo: guion.opciones.cortesAlRitmo,
    };
  }

  const texto = [
    `${id}:`,
    guion
      ? `- Guion: "${guion.titulo}" · gancho "${guion.gancho}" · ${guion.caracteres}/650 caracteres`
      : problemas
        ? `- Guion NO válido:\n  - ${problemas.join("\n  - ")}`
        : "- Sin guion.md",
    guion ? `- Opciones: ${resumenOpciones(guion)}` : "",
    `- Imágenes requeridas: ${encontradas}/${requeridas.length} (${infoImagenes.map(textoImagen).join(", ")})`,
    fondo ? `- Fondo ${fondo.tipo}: ${fondo.modo}` : "",
    musica
      ? `- Música: ${musica.pista} desde ${musica.desde} s a volumen ${musica.volumen}${musica.bpm ? ` · ${Math.round(musica.bpm as number)} BPM` : ""}${musica.existe ? "" : " (NO ENCONTRADA)"}`
      : "",
    `- Voz: ${fs.existsSync(r.voz) ? `${s2(duracionVoz)}${vozCoherente ? "" : " (desactualizada)"}` : "no generada"}`,
    `- MP4: ${mp4 ? `${mp4.ruta} (${s2(mp4.duracion)})` : "no renderizado"}`,
    ...avisos.map((a) => `Aviso: ${a}`),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    texto,
    datos: {
      id,
      carpeta: r.dir,
      guion: guion ? { titulo: guion.titulo, gancho: guion.gancho, musica: guion.musica, caracteres: guion.caracteres, opciones: guion.opciones } : null,
      problemasGuion: problemas ?? null,
      imagenesRequeridas: requeridas,
      fondo,
      musica,
      imagenes: infoImagenes,
      voz: fs.existsSync(r.voz) ? { ruta: r.voz, duracion: duracionVoz, coherenteConGuion: vozCoherente } : null,
      mp4: mp4 ?? null,
      jobs,
      avisos,
    },
  };
}

// ---------- video_generar_voz ----------

/** Qué falta para generar la voz, dicho según quién configura el motor (SEO Studio o el .env). */
export function mensajeFaltanParaVoz(faltan: string[]): string {
  if (!esIntegrado()) return `Faltan ${faltan.join(" y ")} en el .env del servidor. Rellénalas y reinicia Claude Desktop.`;
  return [
    faltan.includes("ELEVENLABS_API_KEY") ? "Añade tu clave de ElevenLabs en Ajustes de SEO Studio." : "",
    faltan.includes("ELEVENLABS_VOICE_ID") ? "Elige la voz de ElevenLabs en Ajustes de SEO Studio." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function generarVoz(
  cfg: Config,
  args: { id: string; forzar?: boolean },
  fetchImpl?: typeof fetch,
): Promise<Respuesta> {
  const id = validarId(args.id);
  const r = archivosVideo(cfg.videoRoot, id);
  if (!fs.existsSync(r.guion)) throw new ErrorVideo(`${id} no tiene guion.md. Guárdalo primero con video_guardar_guion.`);
  const guion = parsearGuion(fs.readFileSync(r.guion, "utf8"));
  const h = herramientasFfmpeg(cfg.ffmpegDir);

  if (fs.existsSync(r.voz) && !args.forzar) {
    const p = leerPalabras(r.palabras);
    const coherente = !!p && p.hashNarracion === guion.hash;
    const duracion = (h ? (await sondear(h.ffprobe, r.voz).catch(() => undefined))?.duracion : undefined) ?? p?.duracionAudio;
    const avisos = coherente ? [] : ["La voz existente no corresponde al guion actual. Usa forzar=true para regenerarla (gasta créditos)."];
    return {
      texto: [
        `${id} ya tiene voz.mp3 (${s2(duracion)}). No he llamado a ElevenLabs para no gastar créditos.`,
        ...avisos.map((a) => `Aviso: ${a}`),
        coherente ? `Siguiente paso: video_renderizar("${id}").` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      datos: { id, voz: r.voz, duracion, llamadaApi: false, coherenteConGuion: coherente, avisos },
    };
  }

  const faltan = faltanParaVoz(cfg);
  if (faltan.length) throw new ErrorVideo(mensajeFaltanParaVoz(faltan));

  log.info(`Generando voz de ${id} (${guion.caracteres} caracteres, modelo ${cfg.elevenModelId}).`);
  const tts = await sintetizarConTimestamps({
    texto: guion.narracion,
    apiKey: cfg.elevenApiKey!,
    voiceId: cfg.elevenVoiceId!,
    modelId: cfg.elevenModelId,
    fetchImpl,
  });

  escribirAtomico(r.voz, tts.audio);
  escribirAtomico(
    r.alineacion,
    JSON.stringify(
      { generado: new Date().toISOString(), modelo: cfg.elevenModelId, requestId: tts.requestId, texto: guion.narracion, ...tts.crudo },
      null,
      2,
    ),
  );
  let duracionAudio: number | undefined;
  if (h) duracionAudio = (await sondear(h.ffprobe, r.voz).catch(() => undefined))?.duracion;
  const palabras = procesarAlineacion({
    narracion: guion.narracion,
    bloques: guion.bloques,
    alineacion: tts.alineacion,
    duracionAudio,
    hashNarracion: guion.hash,
  });
  escribirAtomico(r.palabras, JSON.stringify(palabras, null, 2));

  const avisos = [...palabras.avisos];
  if (palabras.duracionAudio > 58) {
    avisos.push(`La voz dura ${palabras.duracionAudio.toFixed(1)} s: con la cola pasa de 58 s y se acerca al límite de un Short. Recorta el guion.`);
  }
  const facturados = tts.caracteresFacturados ?? guion.caracteres;
  return {
    texto: [
      `Voz generada para ${id}: ${palabras.duracionAudio.toFixed(1)} s, ${palabras.palabras.length} palabras, ${palabras.frases.length} frases de subtítulo.`,
      `Caracteres facturados: ${facturados}${tts.caracteresFacturados === undefined ? " (estimado: la API no devolvió la cabecera)" : ""}.`,
      ...avisos.map((a) => `Aviso: ${a}`),
      `Siguiente paso: video_renderizar("${id}").`,
    ].join("\n"),
    datos: {
      id,
      voz: r.voz,
      duracion: palabras.duracionAudio,
      caracteresFacturados: facturados,
      caracteresFacturadosEstimados: tts.caracteresFacturados === undefined,
      llamadaApi: true,
      segmentos: palabras.segmentos,
      avisos,
    },
  };
}

// ---------- video_renderizar / video_estado_render ----------

export async function renderizar(cfg: Config, args: { id: string; musica?: boolean }): Promise<Respuesta> {
  const id = validarId(args.id);
  const job = await encolarRender(id, {
    raiz: cfg.videoRoot,
    musica: args.musica ?? true,
    musicaVolumen: cfg.musicaVolumen,
    ffmpegDir: cfg.ffmpegDir,
    browserPath: cfg.browserPath,
  });
  const pos = posicionEnCola(job.job_id);
  return {
    texto: [
      `Render de ${id} ${pos > 0 ? `en cola (posición ${pos})` : "en marcha"}. job_id: ${job.job_id}`,
      `Consulta el avance con video_estado_render("${job.job_id}"). Suele tardar menos de un minuto por cada 20 s de vídeo.`,
      ...job.avisos.map((a) => `Aviso: ${a}`),
    ].join("\n"),
    datos: { job_id: job.job_id, id, estado: job.estado, mp4: job.mp4, avisos: job.avisos },
  };
}

export function estadoRender(args: { job_id: string }): Respuesta {
  const job = obtenerJob(args.job_id);
  if (!job) {
    throw new ErrorVideo(
      `No existe el job ${args.job_id}. Los jobs viven en memoria: si el motor se reinició, vuelve a lanzar video_renderizar.`,
    );
  }
  const datos: Record<string, unknown> = {
    job_id: job.job_id,
    id: job.id,
    estado: job.estado,
    fase: job.fase ?? null,
    progreso: job.progreso ?? null,
    mp4: job.estado === "terminado" ? job.mp4 : null,
    duracion: job.duracion ?? null,
    avisos: job.avisos,
  };
  let texto: string;
  switch (job.estado) {
    case "en_cola":
      texto = `${job.job_id}: en cola (posición ${posicionEnCola(job.job_id)}).`;
      break;
    case "renderizando":
      texto = `${job.job_id}: renderizando (${job.fase ?? ""}${job.progreso !== undefined ? `, ${job.progreso.toFixed(0)} %` : ""}).`;
      break;
    case "terminado":
      texto = [
        `${job.job_id}: terminado. ${job.mp4} (${s2(job.duracion)}).`,
        `Revísalo con video_fotograma("${job.id}", segundo) y, con el OK del usuario, súbelo con youtube_upload_video desde ${job.mp4}.`,
        ...job.avisos.map((a) => `Aviso: ${a}`),
      ].join("\n");
      break;
    default: {
      const lineas = ultimasLineasUtiles(job, 30);
      datos.error = job.error;
      datos.salida = lineas;
      texto = [`${job.job_id}: error. ${job.error ?? ""}`, "Últimas líneas de la CLI:", ...lineas.map((l) => `  ${l}`)].join("\n");
    }
  }
  return { texto, datos };
}

// ---------- video_fotograma ----------

export async function fotograma(cfg: Config, args: { id: string; segundo: number }): Promise<Respuesta> {
  const id = validarId(args.id);
  const r = archivosVideo(cfg.videoRoot, id);
  if (!fs.existsSync(r.mp4)) throw new ErrorVideo(`No existe ${r.mp4}. Renderiza primero con video_renderizar("${id}").`);
  const h = herramientasFfmpeg(cfg.ffmpegDir);
  if (!h) throw new ErrorVideo(mensajeSinFfmpeg());
  const info = await sondear(h.ffprobe, r.mp4);
  const dur = info.duracion ?? 0;
  if (!Number.isFinite(args.segundo) || args.segundo < 0 || args.segundo > dur) {
    throw new ErrorVideo(`El segundo tiene que estar entre 0 y ${dur.toFixed(2)} (duración del mp4).`);
  }
  const segundo = Math.min(args.segundo, Math.max(0, dur - 0.05));
  const png = await extraerFotograma(h, r.mp4, segundo);
  return {
    texto: `Fotograma de ${path.basename(r.mp4)} en ${segundo.toFixed(2)} s (540×960).`,
    datos: { id, segundo, mp4: r.mp4 },
    imagen: { base64: png.toString("base64"), mimeType: "image/png" },
  };
}

// ---------- video_ayuda ----------

export function ayuda(): Respuesta {
  return { texto: textoAyuda(), datos: {} };
}

// ---------- video_capacidades ----------

export async function capacidadesHerramienta(cfg: Config, args: { reprobar?: boolean }): Promise<Respuesta> {
  const h = herramientasFfmpeg(cfg.ffmpegDir);
  const c = await capacidades(h, !!args.reprobar, cfg.browserPath);
  const gpu = c.gpu
    ? `${c.gpu.webgpu ? "sí" : "no"} (prueba del ${c.gpu.fecha.slice(0, 16).replace("T", " ")}: ${c.gpu.detalle})`
    : "sin comprobar (falta ffmpeg)";
  const texto = [
    `WebGPU: ${c.gpuForzadaApagada ? "desactivado a la fuerza (VIDEO_FORZAR_SIN_GPU=1)" : gpu}`,
    `HyperFrames ${c.hyperframes} · ${c.ffmpeg ?? "ffmpeg NO encontrado"}`,
    `Chrome: ${c.chrome ?? "no encontrado (npx hyperframes browser ensure)"}`,
    `Telemetría: ${c.telemetria ?? "desconocida"}`,
    `Fondos: ${c.fondos.disponibles.join(", ")}. Con WebGPU: ${c.fondos.conWebgpu.join(", ")}${c.fondos.usaranFallback.length ? ` (aquí saldrán con el degradado de reserva)` : ""}.`,
  ].join("\n");
  return { texto, datos: c as unknown as Record<string, unknown> };
}

// ---------- video_vista_previa ----------

const MAX_FOTOGRAMAS = 8;

export async function vistaPrevia(cfg: Config, args: { id: string; segundos: number[] }): Promise<Respuesta> {
  const id = validarId(args.id);
  if (!args.segundos.length) throw new ErrorVideo("Pasa al menos un segundo en `segundos`, por ejemplo [0.5, 3, 8].");
  if (args.segundos.length > MAX_FOTOGRAMAS) throw new ErrorVideo(`Como mucho ${MAX_FOTOGRAMAS} fotogramas por vista previa.`);
  const o = { raiz: cfg.videoRoot, musica: false, musicaVolumen: cfg.musicaVolumen, ffmpegDir: cfg.ffmpegDir, browserPath: cfg.browserPath };
  const prep = await prepararRender(id, o);
  const h = prep.herramientas;
  const dir = path.join(prep.rutas.dir, "_vista_previa");
  const fotos = path.join(prep.rutas.dir, "_vista_previa_fotos");
  try {
    const m = await montarComposicion(prep, dir, o);
    const segundos = args.segundos.map((s) => Math.min(Math.max(0, s), m.duracion - 0.05));
    fs.rmSync(fotos, { recursive: true, force: true });
    const env = { ...entornoConFfmpeg(h, cfg.browserPath ? { HYPERFRAMES_BROWSER_PATH: cfg.browserPath } : {}), CI: "1" };
    const snap = [HYPERFRAMES_BIN, "snapshot", dir, "--at", segundos.map((s) => s.toFixed(2)).join(","), "--no-end", "-o", fotos];
    if (m.usaWebgpu) snap.push("--browser-gpu");
    const r = await ejecutar(process.execPath, snap, { cwd: prep.rutas.dir, env, timeoutMs: 300000 });
    const pngs = fs.existsSync(fotos) ? fs.readdirSync(fotos).filter((n) => /^frame-.*\.png$/.test(n)).sort() : [];
    if (!pngs.length) throw new Error(`hyperframes snapshot no sacó fotogramas: ${(r.stderr || r.stdout).replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-400)}`);
    // Hoja de contacto: los fotogramas en fila a 270×480.
    const entradas = pngs.flatMap((n) => ["-i", path.join(fotos, n)]);
    const escalas = pngs.map((_, i) => `[${i}:v]scale=270:480[e${i}]`).join(";");
    const pila = pngs.length > 1 ? `${escalas};${pngs.map((_, i) => `[e${i}]`).join("")}hstack=inputs=${pngs.length}[out]` : `${escalas.replace("[e0]", "[out]")}`;
    const hoja = path.join(fotos, "hoja.png");
    const f = await ejecutar(h.ffmpeg, ["-y", "-v", "error", ...entradas, "-filter_complex", pila, "-map", "[out]", "-frames:v", "1", hoja], { timeoutMs: 60000 });
    if (f.code !== 0) throw new Error(`ffmpeg no pudo montar la hoja de contacto: ${f.stderr.trim().slice(0, 300)}`);
    const png = fs.readFileSync(hoja);
    return {
      texto: [`Vista previa de ${id} (sin renderizar): ${segundos.map((s) => `${s.toFixed(2)} s`).join(", ")}.`, ...m.avisos.map((a) => `Aviso: ${a}`)].join("\n"),
      datos: { id, segundos, duracion: m.duracion, avisos: m.avisos },
      imagen: { base64: png.toString("base64"), mimeType: "image/png" },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    fs.rmSync(fotos, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

// ---------- video_musica ----------

export async function musica(cfg: Config): Promise<Respuesta> {
  const h = herramientasFfmpeg(cfg.ffmpegDir);
  if (!h) throw new ErrorVideo(mensajeSinFfmpeg());
  const carpeta = path.join(cfg.videoRoot, "_musica");
  const pistas = await listarMusica(h, carpeta);
  const texto = pistas.length
    ? [
        `${pistas.length} pista(s) en ${carpeta}:`,
        ...pistas.map(
          (p) =>
            `- _musica/${p.archivo}: ${p.duracion ? `${p.duracion.toFixed(1)} s` : "?"}${p.bpm ? ` · ${Math.round(p.bpm)} BPM` : ""}${p.lufs !== undefined ? ` · ${p.lufs.toFixed(1)} LUFS` : ""}${p.error ? ` · ERROR: ${p.error}` : ""}`,
        ),
        "Usa la ruta tal cual en `musica:` del guion. La sonoridad se iguala a la voz al renderizar.",
      ].join("\n")
    : `No hay pistas en ${carpeta}. Descarga música de la Biblioteca de audio de YouTube y déjala ahí (mp3, wav, m4a…).`;
  return { texto, datos: { carpeta, pistas: pistas.map((p) => ({ ...p, rutaGuion: `_musica/${p.archivo}` })) } };
}

// ---------- video_catalogo ----------

/** Piezas del catálogo que ya están adaptadas en plantilla/piezas/. */
export const ADAPTADAS: Record<string, string> = {
  "headline-slam": "gancho.html",
  "organic-light-leak-overlay": "capas.html",
  vignette: "capas.html",
  "camcorder-hud": "capas.html",
  "grain-overlay": "capas.html",
  "caption-pill-karaoke": "subtitulos.html",
  "caption-neon-glow": "subtitulos.html",
  "caption-kinetic-slam": "subtitulos.html",
  "spain-map": "escena-mapa.html",
  "world-map": "escena-mapa.html",
  "bar-chart-race": "escena-barras.html",
  "mk-progress-stat": "escena-cifra.html",
  "extruded-logo": "escena-titulo3d.html",
  "gallery-tunnel": "escena-tunel.html",
  "weight-wave": "escena-cartel.html",
  aurora: "fondo-shader.html",
  plasma: "fondo-shader.html",
  nebula: "fondo-shader.html",
  "mesh-gradient": "fondo-shader.html",
};

const TIMEOUT_CATALOGO_MS = 120_000;

export async function catalogo(cfg: Config, args: { consulta: string }): Promise<Respuesta> {
  const h = herramientasFfmpeg(cfg.ffmpegDir);
  const r = await ejecutar(process.execPath, [HYPERFRAMES_BIN, "catalog", `--query=${args.consulta}`, "--json"], {
    env: { ...entornoConFfmpeg(h), CI: "1" },
    cwd: PIEZAS_DIR,
    timeoutMs: TIMEOUT_CATALOGO_MS,
  });
  if (r.timeout) throw new ErrorVideo(`La CLI de HyperFrames no respondió al buscar en el catálogo (${TIMEOUT_CATALOGO_MS / 1000} s).`);
  let j: { total?: number; results?: { name: string; type?: string; title?: string; description?: string; tags?: string[] }[] };
  try {
    j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  } catch {
    throw new Error(`hyperframes catalog no devolvió JSON: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  }
  const resultados = (j.results ?? []).map((x) => ({
    nombre: x.name,
    tipo: x.type,
    titulo: x.title,
    descripcion: x.description,
    adaptada: ADAPTADAS[x.name] ? `plantilla/piezas/${ADAPTADAS[x.name]}` : null,
  }));
  const texto = resultados.length
    ? [
        `${resultados.length} resultado(s) para "${args.consulta}" (de ${j.total ?? "?"} en el catálogo):`,
        ...resultados.map((x) => `- ${x.nombre} (${x.tipo}): ${x.descripcion ?? x.titulo ?? ""}${x.adaptada ? ` · YA ADAPTADA en ${x.adaptada}` : ""}`),
      ].join("\n")
    : `Nada en el catálogo para "${args.consulta}".`;
  return { texto, datos: { consulta: args.consulta, total: j.total, resultados } };
}
