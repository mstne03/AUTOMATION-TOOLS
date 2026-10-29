// Alineación por carácter de ElevenLabs → palabras → segmentos → frases de subtítulo (§6). Lógica pura.

export interface AlineacionCaracteres {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface Palabra {
  texto: string;
  inicio: number;
  fin: number;
  /** 1-6 */
  segmento: number;
}

export interface Segmento {
  n: number;
  /** Inicio de su primera palabra. */
  inicio: number;
  /** Fin de su última palabra. */
  fin: number;
  /** La imagen N se ve desde aquí… */
  mostrarDesde: number;
  /** …hasta aquí (inicio del siguiente; la última, hasta el final del audio + 0,4 s). */
  mostrarHasta: number;
}

export interface Frase {
  texto: string;
  inicio: number;
  fin: number;
  segmento: number;
  /** Índices en `palabras`. */
  palabras: number[];
}

export interface ResultadoAlineacion {
  version: 1;
  hashNarracion: string;
  duracionAudio: number;
  /** Duración total del vídeo: audio + cola final. */
  duracionTotal: number;
  palabras: Palabra[];
  segmentos: Segmento[];
  frases: Frase[];
  avisos: string[];
}

export const COLA_FINAL = 0.4;
export const MAX_PALABRAS_FRASE = 3;
export const MAX_CARACTERES_FRASE = 18;

const redondear = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Tiempos (inicio, fin) por carácter del texto enviado. Si la alineación no trae exactamente
 * el mismo texto (ElevenLabs a veces normaliza), alinea con distancia de edición e interpola.
 */
export function tiemposPorCaracter(
  texto: string,
  al: AlineacionCaracteres,
): { inicios: number[]; fines: number[]; descuadre: number } {
  const chars = al.characters;
  const ini = al.character_start_times_seconds;
  const fin = al.character_end_times_seconds;
  const n = texto.length;
  const m = Math.min(chars.length, ini.length, fin.length);

  if (m === n && chars.slice(0, m).join("") === texto) {
    return { inicios: ini.slice(0, n), fines: fin.slice(0, n), descuadre: 0 };
  }

  // Alineamiento global (Levenshtein) entre texto[i] y chars[j], comparando sin mayúsculas.
  const norm = (c: string) => c.toLowerCase();
  const ancho = m + 1;
  const dp = new Uint32Array((n + 1) * ancho);
  for (let i = 0; i <= n; i++) dp[i * ancho] = i;
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    const a = norm(texto[i - 1]);
    for (let j = 1; j <= m; j++) {
      const coste = a === norm(chars[j - 1]) ? 0 : 1;
      dp[i * ancho + j] = Math.min(dp[(i - 1) * ancho + j - 1] + coste, dp[(i - 1) * ancho + j] + 1, dp[i * ancho + j - 1] + 1);
    }
  }
  const mapa: number[] = new Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const actual = dp[i * ancho + j];
    const coste = norm(texto[i - 1]) === norm(chars[j - 1]) ? 0 : 1;
    if (actual === dp[(i - 1) * ancho + j - 1] + coste) {
      mapa[i - 1] = j - 1; // coincidencia o sustitución: hereda el tiempo
      i--;
      j--;
    } else if (actual === dp[(i - 1) * ancho + j] + 1) {
      i--; // carácter del texto que no está en la alineación
    } else {
      j--; // carácter extra en la alineación
    }
  }

  const inicios: number[] = new Array(n);
  const fines: number[] = new Array(n);
  const total = m > 0 ? fin[m - 1] : 0;
  for (let k = 0; k < n; k++) {
    if (mapa[k] >= 0) {
      inicios[k] = ini[mapa[k]];
      fines[k] = fin[mapa[k]];
    }
  }
  // Interpola los caracteres sin pareja entre sus vecinos con tiempo.
  for (let k = 0; k < n; k++) {
    if (mapa[k] >= 0) continue;
    let a = k - 1;
    while (a >= 0 && mapa[a] < 0) a--;
    let b = k + 1;
    while (b < n && mapa[b] < 0) b++;
    const t0 = a >= 0 ? fines[a] : 0;
    const t1 = b < n ? inicios[b] : total;
    const huecos = b - a;
    const paso = (t1 - t0) / huecos;
    inicios[k] = t0 + paso * (k - a - 1);
    fines[k] = t0 + paso * (k - a);
  }
  return { inicios, fines, descuadre: dp[n * ancho + m] };
}

const ES_PALABRA = /[\p{L}\p{N}]/u;

export interface Token {
  texto: string;
  desde: number;
  hasta: number;
  segmento: number;
}

/**
 * Palabras de la narración tal como acaban en palabras.json (mismo orden e índices):
 * se corta por espacios y la puntuación suelta va pegada a la palabra vecina.
 */
export function tokenizarPalabras(texto: string, bloques: { n: number; inicio: number; fin: number }[]): Token[] {
  const tokens: { desde: number; hasta: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) tokens.push({ desde: m.index, hasta: m.index + m[0].length });

  // La puntuación suelta ("—", "...") va pegada a la palabra anterior (o a la siguiente si es la primera del bloque).
  const segmentoDe = (offset: number) => bloques.find((b) => offset >= b.inicio && offset < b.fin)?.n ?? bloques.at(-1)?.n ?? 1;
  const fusionados: { desde: number; hasta: number }[] = [];
  let pendiente: { desde: number; hasta: number } | null = null;
  for (const t of tokens) {
    const contenido = texto.slice(t.desde, t.hasta);
    if (!ES_PALABRA.test(contenido)) {
      const previo = fusionados.at(-1);
      if (previo && segmentoDe(previo.desde) === segmentoDe(t.desde)) previo.hasta = t.hasta;
      else pendiente = pendiente ? { desde: pendiente.desde, hasta: t.hasta } : { ...t };
      continue;
    }
    if (pendiente && segmentoDe(pendiente.desde) === segmentoDe(t.desde)) {
      fusionados.push({ desde: pendiente.desde, hasta: t.hasta });
    } else {
      if (pendiente) fusionados.push(pendiente);
      fusionados.push({ ...t });
    }
    pendiente = null;
  }
  if (pendiente) fusionados.push(pendiente);
  return fusionados.map((t) => ({ texto: texto.slice(t.desde, t.hasta), desde: t.desde, hasta: t.hasta, segmento: segmentoDe(t.desde) }));
}

export function agruparPalabras(
  texto: string,
  bloques: { n: number; inicio: number; fin: number }[],
  inicios: number[],
  fines: number[],
): Palabra[] {
  return tokenizarPalabras(texto, bloques).map((t) => ({
    texto: t.texto,
    inicio: redondear(Math.min(...inicios.slice(t.desde, t.hasta))),
    fin: redondear(Math.max(...fines.slice(t.desde, t.hasta))),
    segmento: t.segmento,
  }));
}

export function calcularSegmentos(palabras: Palabra[], numSegmentos: number, duracionAudio: number): Segmento[] {
  const segs: Segmento[] = [];
  for (let n = 1; n <= numSegmentos; n++) {
    const ps = palabras.filter((p) => p.segmento === n);
    const previo = segs.at(-1);
    const inicio = ps.length ? ps[0].inicio : (previo?.fin ?? 0);
    const fin = ps.length ? ps[ps.length - 1].fin : inicio;
    segs.push({ n, inicio, fin, mostrarDesde: 0, mostrarHasta: 0 });
  }
  for (let k = 0; k < segs.length; k++) {
    // La imagen 1 se ve desde el fotograma 0 (gancho).
    segs[k].mostrarDesde = k === 0 ? 0 : segs[k].inicio;
    segs[k].mostrarHasta = k + 1 < segs.length ? segs[k + 1].inicio : redondear(duracionAudio + COLA_FINAL);
  }
  return segs;
}

export function agruparFrases(palabras: Palabra[]): Frase[] {
  const frases: Frase[] = [];
  let actual: number[] = [];
  const cerrar = () => {
    if (!actual.length) return;
    const ps = actual.map((i) => palabras[i]);
    frases.push({
      texto: ps.map((p) => p.texto).join(" "),
      inicio: ps[0].inicio,
      fin: ps[ps.length - 1].fin,
      segmento: ps[0].segmento,
      palabras: actual,
    });
    actual = [];
  };
  palabras.forEach((p, i) => {
    if (actual.length) {
      const previa = palabras[actual[actual.length - 1]];
      const largo = actual.map((k) => palabras[k].texto).join(" ").length + 1 + p.texto.length;
      if (previa.segmento !== p.segmento || actual.length >= MAX_PALABRAS_FRASE || largo > MAX_CARACTERES_FRASE) cerrar();
    }
    actual.push(i);
    // Final de frase: cierra para no mezclar dos oraciones en un subtítulo.
    if (/[.!?…]["'”’)]*$/.test(p.texto)) cerrar();
  });
  cerrar();
  return frases;
}

export function procesarAlineacion(opts: {
  narracion: string;
  bloques: { n: number; inicio: number; fin: number }[];
  alineacion: AlineacionCaracteres;
  duracionAudio?: number;
  hashNarracion: string;
}): ResultadoAlineacion {
  const avisos: string[] = [];
  const { inicios, fines, descuadre } = tiemposPorCaracter(opts.narracion, opts.alineacion);
  if (descuadre > 0) {
    avisos.push(
      `La alineación de ElevenLabs no coincide carácter a carácter con el texto enviado (${descuadre} diferencias, ` +
        `${opts.alineacion.characters.length} caracteres recibidos frente a ${opts.narracion.length} enviados). ` +
        "Se ha hecho un alineamiento tolerante; revisa la sincronía de los subtítulos.",
    );
  }
  const palabras = agruparPalabras(opts.narracion, opts.bloques, inicios, fines);
  const finAlineacion = opts.alineacion.character_end_times_seconds.at(-1) ?? palabras.at(-1)?.fin ?? 0;
  const duracionAudio = redondear(opts.duracionAudio ?? finAlineacion);
  const segmentos = calcularSegmentos(palabras, opts.bloques.length, duracionAudio);
  const frases = agruparFrases(palabras);
  return {
    version: 1,
    hashNarracion: opts.hashNarracion,
    duracionAudio,
    duracionTotal: redondear(duracionAudio + COLA_FINAL),
    palabras,
    segmentos,
    frases,
    avisos,
  };
}
