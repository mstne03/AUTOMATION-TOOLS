// Perfil visual mínimo (T8, M-D2): una lista simple en <dirname(VIDEO_ROOT)>/video/perfiles/<id>.json. El proyecto
// referencia uno por `perfilId`. El id lo genera siempre el motor (I6); el perfil se valida al guardar y al cargar (I1)
// y el tema que llega a la composición sale de `validarTema`. «defecto» es neutro y existe aunque no haya fichero.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CARAS_FUENTE, COLOR_RE, validarTema, type Tema } from "./composicion.js";
import { PERFIL_ID_RE, VOICE_ID_RE, textoSeguro, validar } from "./esquema.js";
import { ErrorVideo, comprobarCarpeta, escribirAtomico, valorCorto } from "./paths.js";
import { ErrorAlmacen, esquema, existe, leerJson, validando } from "./proyecto.js";

/** Lista cerrada de idiomas del perfil (código ISO 639-1, como los de ElevenLabs). */
export const IDIOMAS = ["es", "en", "ca", "fr", "de", "it", "pt"] as const;
export const FUENTES = ["Anton", "Inter Tight", "JetBrains Mono"] as const;
const MAX_NOMBRE = 60;

const Color = z.string().regex(COLOR_RE);
const EsquemaPerfil = z.strictObject({
  id: z.string().regex(PERFIL_ID_RE),
  nombre: textoSeguro(MAX_NOMBRE, 1),
  voz: z.string().regex(VOICE_ID_RE),
  idioma: z.enum(IDIOMAS),
  colores: z.strictObject({ fondo: Color, texto: Color, acento: Color, contorno: Color, secundario: Color }),
  fuente: z.enum(FUENTES),
});
export type Perfil = z.infer<typeof EsquemaPerfil>;

/** Neutro: sin marca ni temática. La voz es una de las predefinidas de ElevenLabs. */
export const PERFIL_DEFECTO: Perfil = {
  id: "defecto",
  nombre: "Perfil por defecto",
  voz: "21m00Tcm4TlvDq8ikWAM",
  idioma: "es",
  colores: { fondo: "#101114", texto: "#F5F5F5", acento: "#4DA3FF", contorno: "#000000", secundario: "#2B2F36" },
  fuente: "Inter Tight",
};

/** Tamaños del tema base; el perfil mínimo no los toca. */
const TAMANOS = { gancho: 150, ganchoMinimo: 84, subtitulo: 92, subtituloMinimo: 56 };

/** El tema de la composición para este perfil. Pasa por `validarTema`: un color o una fuente malos no llegan al CSS. */
export function temaDePerfil(p: Perfil): Tema {
  const cara = (f: Perfil["fuente"]) => ({ familia: f, ...CARAS_FUENTE[f] });
  return validarTema({
    nombre: p.nombre,
    colores: p.colores,
    fuentes: { titulos: cara(p.fuente), subtitulos: cara(p.fuente) },
    tamanos: TAMANOS,
  });
}

/** `<dirname(VIDEO_ROOT)>/video/perfiles`. */
export function carpetaPerfiles(raiz: string): string {
  return path.join(path.dirname(path.resolve(raiz)), "video", "perfiles");
}

function dirPerfiles(raiz: string, crear: boolean): string {
  const dir = carpetaPerfiles(raiz);
  if (crear) fs.mkdirSync(dir, { recursive: true });
  try {
    comprobarCarpeta(dir);
  } catch (e) {
    if (e instanceof ErrorVideo) throw esquema(e.message, "enlace_no_permitido");
    throw e;
  }
  return dir;
}

function validarPerfilId(id: unknown): string {
  if (typeof id !== "string" || !PERFIL_ID_RE.test(id)) throw esquema(`Id de perfil no válido: ${valorCorto(id)}.`, "id_invalido", "id");
  return id;
}

/** Valida un perfil y su tema. */
function validarPerfil(v: unknown): Perfil {
  const p = validando(() => validar<Perfil>(EsquemaPerfil as unknown as z.ZodType<Perfil>, v));
  try {
    temaDePerfil(p);
  } catch {
    throw esquema("El perfil no da un tema válido.", "tema_invalido");
  }
  return p;
}

/** Perfil validado del disco (o el neutro). `no_encontrado` si no existe; `esquema` si el fichero no es válido. */
export function cargarPerfil(raiz: string, id: string): Perfil {
  validarPerfilId(id);
  const ruta = path.join(dirPerfiles(raiz, false), `${id}.json`);
  if (!existe(ruta)) {
    if (id === "defecto") return structuredClone(PERFIL_DEFECTO);
    throw new ErrorAlmacen("no_encontrado", `No existe el perfil ${id}.`);
  }
  const doc = validarPerfil(leerJson(ruta));
  if (doc.id !== id) throw esquema("El id del perfil no coincide con su fichero.", "id_distinto", "id");
  return doc;
}

const FICHERO_RE = /^((?:defecto)|(?:p-[0-9a-f]{16}))\.json$/;

export type ResumenPerfil = Perfil | { id: string; valido: false };

/** «defecto» primero (el del disco si existe, si no el neutro) y luego los demás por id. */
export function perfilesListar(raiz: string): ResumenPerfil[] {
  let ids: string[] = [];
  try {
    const dir = dirPerfiles(raiz, false);
    ids = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .flatMap((e) => FICHERO_RE.exec(e.name)?.[1] ?? [])
      .filter((id) => id !== "defecto");
  } catch (e) {
    if (e instanceof ErrorAlmacen) ids = [];
    else if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return ["defecto", ...ids.sort()].map((id): ResumenPerfil => {
    try {
      return cargarPerfil(raiz, id);
    } catch {
      return { id, valido: false };
    }
  });
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Guarda un perfil que ya existe (`no_encontrado` si no). El `id` del cuerpo, si viene, tiene que ser el del argumento:
 * si no, `id_distinto` sin escribir nada (falla visible antes que ignorar en silencio). Un `id` ausente se toma del argumento.
 */
export function perfilGuardar(raiz: string, args: { id: string; perfil: unknown }): { id: string } {
  const id = validarPerfilId(args.id);
  if (esObjeto(args.perfil) && "id" in args.perfil && args.perfil.id !== id) {
    throw new ErrorAlmacen("esquema", "El id del perfil no es el del argumento.", [{ ruta: "id", codigo: "id_distinto" }]);
  }
  const perfil = validarPerfil(esObjeto(args.perfil) ? { ...args.perfil, id } : args.perfil);
  cargarPerfil(raiz, id); // existe (o es el neutro) y el fichero actual es válido
  escribirAtomico(path.join(dirPerfiles(raiz, true), `${id}.json`), JSON.stringify(perfil, null, 2));
  return { id };
}

/** Copia un perfil con un id nuevo del motor. Solo acepta `id` (el de origen) y `nombre`: no hay forma de pedir el id. */
export function perfilDuplicar(raiz: string, args: { id: string; nombre?: string }): { id: string } {
  const permitidas = new Set(["id", "nombre"]);
  const extra = Object.keys(args as object).filter((k) => !permitidas.has(k));
  if (extra.length) throw esquema("Campo no admitido al duplicar.", "campo_de_mas", "?");
  const origen = cargarPerfil(raiz, validarPerfilId(args.id));
  const nombre = args.nombre ?? `${origen.nombre} (copia)`.slice(0, MAX_NOMBRE);
  const dir = dirPerfiles(raiz, true);
  let id: string;
  do id = `p-${randomBytes(8).toString("hex")}`;
  while (existe(path.join(dir, `${id}.json`)));
  const copia = validarPerfil({ ...origen, id, nombre });
  escribirAtomico(path.join(dir, `${id}.json`), JSON.stringify(copia, null, 2));
  return { id };
}
