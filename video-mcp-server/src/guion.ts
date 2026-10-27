// Parser de guion.md → estructura tipada. Los campos v2 los valida formato.ts.
import crypto from "node:crypto";
import YAML from "yaml";
import { validarOpciones, type OpcionesV2 } from "./formato.js";

export const MAX_CARACTERES = 650;
export const NUM_BLOQUES = 6;

export interface Bloque {
  n: number;
  texto: string;
  /** Offset del primer carácter del bloque en `narracion`. */
  inicio: number;
  /** Offset justo después del último carácter (exclusivo). */
  fin: number;
}

export interface Guion {
  titulo: string;
  gancho: string;
  musica?: string;
  bloques: Bloque[];
  /** Texto que se envía a ElevenLabs: los 6 bloques separados por un espacio. */
  narracion: string;
  caracteres: number;
  hash: string;
  opciones: OpcionesV2;
  /** Avisos de validación que no impiden usar el guion. */
  avisos: string[];
}

export class ErrorGuion extends Error {
  constructor(public problemas: string[]) {
    super(`El guion no es válido:\n- ${problemas.join("\n- ")}`);
  }
}

export function hashNarracion(narracion: string): string {
  return crypto.createHash("sha256").update(narracion, "utf8").digest("hex");
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MARCA_RE = /^[ \t]*\[(\d+)\][ \t]*/gm;

export function parsearGuion(contenido: string): Guion {
  const problemas: string[] = [];
  const fm = FRONTMATTER_RE.exec(contenido);
  if (!fm) {
    throw new ErrorGuion([
      "Falta el frontmatter. El guion tiene que empezar con una línea `---`, luego `titulo:` y `gancho:`, y cerrar con otra línea `---`.",
    ]);
  }

  let datos: Record<string, unknown> = {};
  try {
    const parsed: unknown = YAML.parse(fm[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) datos = parsed as Record<string, unknown>;
    else problemas.push("El frontmatter tiene que ser un mapa YAML con `titulo` y `gancho`.");
  } catch (e) {
    problemas.push(`El frontmatter no es YAML válido: ${(e as Error).message.split("\n")[0]}`);
  }

  const texto = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
  const titulo = texto(datos.titulo);
  const gancho = texto(datos.gancho);
  if (!titulo) problemas.push("Falta `titulo` en el frontmatter.");
  if (!gancho) problemas.push("Falta `gancho` en el frontmatter (el texto en pantalla del primer fotograma).");
  if (gancho.length > 80) problemas.push(`El \`gancho\` tiene ${gancho.length} caracteres; el máximo es 80 para que se lea de un vistazo.`);

  const cuerpo = contenido.slice(fm[0].length);
  const marcas = [...cuerpo.matchAll(MARCA_RE)];
  const antes = marcas.length ? cuerpo.slice(0, marcas[0].index) : cuerpo;
  if (marcas.length && antes.trim()) {
    problemas.push("Hay texto antes de `[1]`. Todo el texto narrado tiene que ir dentro de los bloques [1] a [6].");
  }

  const crudos = marcas.map((m, i) => {
    const desde = (m.index ?? 0) + m[0].length;
    const hasta = i + 1 < marcas.length ? (marcas[i + 1].index ?? cuerpo.length) : cuerpo.length;
    return { n: Number(m[1]), texto: cuerpo.slice(desde, hasta).replace(/\s+/g, " ").trim() };
  });

  const numeros = crudos.map((b) => b.n);
  if (crudos.length !== NUM_BLOQUES) {
    problemas.push(`Hay ${crudos.length} bloques y tienen que ser exactamente ${NUM_BLOQUES}, de [1] a [6] (uno por imagen).`);
  } else if (numeros.some((n, i) => n !== i + 1)) {
    problemas.push(`Los bloques tienen que ir en orden [1] a [6]; están como ${numeros.map((n) => `[${n}]`).join(" ")}.`);
  }
  for (const b of crudos) if (!b.texto) problemas.push(`El bloque [${b.n}] está vacío.`);

  // Narración concatenada y offsets.
  const bloques: Bloque[] = [];
  let narracion = "";
  for (const b of crudos) {
    if (narracion) narracion += " ";
    const inicio = narracion.length;
    narracion += b.texto;
    bloques.push({ n: b.n, texto: b.texto, inicio, fin: narracion.length });
  }
  const caracteres = narracion.length;
  if (caracteres > MAX_CARACTERES) {
    problemas.push(
      `La narración tiene ${caracteres} caracteres y el máximo es ${MAX_CARACTERES} (≈ 45-55 s). Recorta al menos ${caracteres - MAX_CARACTERES}.`,
    );
  }

  // Los campos v2 se validan con la narración ya montada (golpe y énfasis buscan palabras en ella).
  const v2 = validarOpciones(datos, { narracion, bloques });
  problemas.push(...v2.problemas);

  if (problemas.length) throw new ErrorGuion(problemas);
  return {
    titulo,
    gancho,
    musica: v2.musica,
    bloques,
    narracion,
    caracteres,
    hash: hashNarracion(narracion),
    opciones: v2.opciones,
    avisos: v2.avisos,
  };
}
