// Almacén de guiones y proyectos (T4). El modelo y el editor hablan con esto; nada más toca los ficheros.
//  - Carpeta del proyecto: <VIDEO_ROOT>/<id>/ con proyecto.json, voz/, recursos/, _composicion/, _render/ y video.mp4.
//  - Guiones: <dirname(VIDEO_ROOT)>/video/guiones/<g-16hex>.json.
// Todo documento se valida con el esquema al escribir Y al leer (I1): un fichero editado a mano no entra. Las rutas
// salen siempre de ids validados (I6); los enlaces, junctions y hardlinks se rechazan; la escritura es atómica.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ErrorEsquema,
  PERFIL_ID_RE,
  recomendaciones,
  validarGuionVideo,
  validarProyecto,
  type Aviso,
  type GuionVideo,
  type Proyecto,
} from "./esquema.js";
import {
  ErrorVideo,
  carpetaVideo,
  comprobarCarpeta,
  escribirAtomico,
  listarIds,
  siguienteId,
  validarId,
  valorCorto,
  borrarArbol,
} from "./paths.js";

export type CodigoAlmacen = "esquema" | "conflicto" | "no_encontrado";
export interface Problema {
  ruta: string;
  codigo: string;
}

/** Error tipado del almacén: sale por MCP como `isError` con un bloque JSON `{ codigo, problemas }`. */
export class ErrorAlmacen extends Error {
  constructor(
    public codigo: CodigoAlmacen,
    mensaje: string,
    public problemas: Problema[] = [],
  ) {
    super(mensaje);
    this.name = "ErrorAlmacen";
  }
}

export const GUION_ID_RE = /^g-[0-9a-f]{16}$/;
/** Tope de lo que se lee de disco: un proyecto de 90 escenas pesa decenas de KB. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const esquema = (mensaje: string, codigo: string, ruta = ""): ErrorAlmacen => new ErrorAlmacen("esquema", mensaje, [{ ruta, codigo }]);

/** Convierte el error de zod (que solo lleva ruta y código, nunca el valor) en un error tipado. */
function validando<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ErrorEsquema) throw new ErrorAlmacen("esquema", e.message, e.problemas);
    throw e;
  }
}

/**
 * Fichero JSON del almacén (I6): se abre una sola vez y todo se comprueba sobre el descriptor. `lstat` con bigint
 * (ni enlace ni otra cosa que un fichero), `fstat` del descriptor (fichero normal, un solo enlace, mismo dev/ino) y
 * lectura del descriptor hasta MAX+1 bytes: un fichero que crece o cambia de nombre no se cuela. Luego se valida.
 */
function leerJson(ruta: string): unknown {
  const nombre = path.basename(ruta);
  const enlace = () => esquema(`${nombre} no es un fichero normal sin enlaces.`, "enlace_no_permitido");
  let antes: fs.BigIntStats;
  try {
    antes = fs.lstatSync(ruta, { bigint: true });
  } catch {
    throw esquema(`No puedo leer ${nombre}.`, "enlace_no_permitido");
  }
  if (antes.isSymbolicLink() || !antes.isFile()) throw enlace();
  const fd = fs.openSync(ruta, "r");
  let texto: string;
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || st.dev !== antes.dev || st.ino !== antes.ino) throw enlace();
    if (st.size > BigInt(MAX_JSON_BYTES)) throw esquema("El documento es demasiado grande.", "demasiado_grande");
    const buf = Buffer.allocUnsafe(MAX_JSON_BYTES + 1);
    let leidos = 0;
    while (leidos < buf.length) {
      const k = fs.readSync(fd, buf, leidos, buf.length - leidos, leidos);
      if (k === 0) break;
      leidos += k;
    }
    if (leidos > MAX_JSON_BYTES) throw esquema("El documento es demasiado grande.", "demasiado_grande");
    texto = buf.toString("utf8", 0, leidos);
  } finally {
    fs.closeSync(fd);
  }
  try {
    return JSON.parse(texto);
  } catch {
    throw esquema("El documento no es JSON válido.", "json_invalido");
  }
}

function escribirJson(ruta: string, doc: unknown): void {
  escribirAtomico(ruta, JSON.stringify(doc, null, 2));
}

const existe = (ruta: string): boolean => {
  try {
    fs.lstatSync(ruta);
    return true;
  } catch {
    return false;
  }
};

const ahora = (): string => new Date().toISOString();

// ---------- Guiones ----------

/** `<dirname(VIDEO_ROOT)>/video/guiones`. */
export function carpetaGuiones(raiz: string): string {
  return path.join(path.dirname(path.resolve(raiz)), "video", "guiones");
}

function validarGuionId(id: unknown): string {
  if (typeof id !== "string" || !GUION_ID_RE.test(id)) throw esquema(`Id de guion no válido: ${valorCorto(id)}.`, "id_invalido", "id");
  return id;
}

/** Carpeta de guiones (creada si hace falta) y que no sea un enlace ni una junction. */
function dirGuiones(raiz: string, crear: boolean): string {
  const dir = carpetaGuiones(raiz);
  if (crear) fs.mkdirSync(dir, { recursive: true });
  try {
    comprobarCarpeta(dir);
  } catch (e) {
    if (e instanceof ErrorVideo) throw esquema(e.message, "enlace_no_permitido");
    throw e;
  }
  return dir;
}

function cargarGuion(raiz: string, id: string): GuionVideo {
  const ruta = path.join(dirGuiones(raiz, false), `${validarGuionId(id)}.json`);
  if (!existe(ruta)) throw new ErrorAlmacen("no_encontrado", `No existe el guion ${id}.`);
  return validando(() => validarGuionVideo(leerJson(ruta)));
}

export function guionGuardar(raiz: string, args: { guion: unknown; id?: string }): { id: string; avisos: Aviso[] } {
  const guion = validando(() => validarGuionVideo(args.guion));
  const dir = dirGuiones(raiz, true);
  let id: string;
  if (args.id !== undefined) {
    id = validarGuionId(args.id);
    if (!existe(path.join(dir, `${id}.json`))) throw new ErrorAlmacen("no_encontrado", `No existe el guion ${id}.`);
  } else {
    do id = `g-${randomBytes(8).toString("hex")}`;
    while (existe(path.join(dir, `${id}.json`)));
  }
  escribirJson(path.join(dir, `${id}.json`), guion);
  return { id, avisos: recomendaciones(guion) };
}

export function guionListar(raiz: string): ({ id: string; titulo: string; escenas: number } | { id: string; valido: false })[] {
  let dir: string;
  try {
    dir = dirGuiones(raiz, false);
  } catch {
    return [];
  }
  let entradas: fs.Dirent[] = [];
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entradas
    .filter((e) => e.isFile() && /^g-[0-9a-f]{16}\.json$/.test(e.name))
    .map((e) => e.name.slice(0, -5))
    .sort()
    .map((id) => {
      try {
        const g = cargarGuion(raiz, id);
        return { id, titulo: g.titulo, escenas: g.escenas.length };
      } catch {
        return { id, valido: false as const };
      }
    });
}

export function guionLeer(raiz: string, id: string): { guion: GuionVideo; avisos: Aviso[] } {
  const guion = cargarGuion(raiz, id);
  return { guion, avisos: recomendaciones(guion) };
}

export function guionBorrar(raiz: string, id: string): void {
  const ruta = path.join(dirGuiones(raiz, false), `${validarGuionId(id)}.json`);
  if (!existe(ruta)) throw new ErrorAlmacen("no_encontrado", `No existe el guion ${id}.`);
  fs.unlinkSync(ruta); // si fuese un enlace, se quita el enlace y no su destino
}

// ---------- Proyectos ----------

function validarProyectoId(id: unknown): string {
  try {
    return validarId(id);
  } catch (e) {
    if (e instanceof ErrorVideo) throw esquema(e.message, "id_invalido", "id");
    throw e;
  }
}

/** Carpeta del proyecto: id válido, existente, real (ni enlace ni junction) y dentro de VIDEO_ROOT. */
function dirProyecto(raiz: string, id: unknown): string {
  const valido = validarProyectoId(id);
  let dir: string;
  try {
    dir = carpetaVideo(raiz, valido);
    comprobarCarpeta(dir);
  } catch (e) {
    if (e instanceof ErrorVideo) throw esquema(e.message, "enlace_no_permitido");
    throw e;
  }
  if (!existe(dir)) throw new ErrorAlmacen("no_encontrado", `No existe el proyecto ${valorCorto(id)}.`);
  return dir;
}

function cargarProyecto(raiz: string, id: unknown): Proyecto {
  const dir = dirProyecto(raiz, id);
  const ruta = path.join(dir, "proyecto.json");
  if (!existe(ruta)) throw new ErrorAlmacen("no_encontrado", `El proyecto ${valorCorto(id)} no tiene proyecto.json.`);
  const doc = validando(() => validarProyecto(leerJson(ruta)));
  if (doc.id !== id) throw esquema("El id del documento no coincide con su carpeta.", "id_distinto", "id");
  return doc;
}

/** Proyecto nuevo a partir de un guion: una copia de una sola vía (D6b), sin referencia al guion. */
export function proyectoCrear(raiz: string, args: { guionId: string; perfilId: string }): { id: string } {
  const guion = cargarGuion(raiz, args.guionId);
  if (typeof args.perfilId !== "string" || !PERFIL_ID_RE.test(args.perfilId)) throw esquema("Perfil no válido.", "perfil_invalido", "perfilId");
  fs.mkdirSync(raiz, { recursive: true });
  const id = siguienteId(raiz);
  const marca = ahora();
  let n = 0;
  const proyecto = validando(() =>
    validarProyecto({
      version: 1,
      id,
      revision: 0,
      titulo: guion.titulo,
      gancho: guion.gancho,
      aspecto: "9:16",
      perfilId: args.perfilId,
      creado: marca,
      actualizado: marca,
      frases: guion.escenas.flatMap((e) => e.frases.map((texto) => ({ id: `f${++n}`, texto }))),
      escenas: (() => {
        let k = 0;
        return guion.escenas.map((e, i) => ({
          id: `e${i + 1}`,
          fraseIds: e.frases.map(() => `f${++k}`),
          base: structuredClone(e.base),
          ajusteCorte: 0,
          ...(e.recurso ? { recursoPendiente: structuredClone(e.recurso) } : {}),
        }));
      })(),
      recursos: [],
      subtitulos: { estilo: guion.opciones.subtitulos, correcciones: [], cortes: [] },
      opciones: structuredClone(guion.opciones),
    }),
  );
  const dir = path.join(raiz, id);
  try {
    fs.mkdirSync(dir); // sin recursive: si otro proceso se adelantó con el id, falla en vez de mezclarse
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ErrorAlmacen("conflicto", "Otro proceso creó el proyecto a la vez. Vuelve a intentarlo.");
    throw e;
  }
  try {
    fs.mkdirSync(path.join(dir, "voz"));
    fs.mkdirSync(path.join(dir, "recursos"));
    escribirJson(path.join(dir, "proyecto.json"), proyecto);
  } catch (e) {
    borrarArbol(dir); // sin atravesar junctions: rmSync recursivo borraría su destino
    throw e;
  }
  return { id };
}

export type ResumenProyecto = { id: string; titulo: string; revision: number; actualizado: string; escenas: number } | { id: string; valido: false };

export function proyectoListar(raiz: string): ResumenProyecto[] {
  return listarIds(raiz).flatMap((id): ResumenProyecto[] => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(raiz, id));
    } catch {
      return [];
    }
    if (st.isSymbolicLink()) return []; // un enlace no es un proyecto
    try {
      comprobarCarpeta(path.join(raiz, id));
    } catch {
      return []; // junction o carpeta colgada de un enlace: no se lista
    }
    try {
      const p = cargarProyecto(raiz, id);
      return [{ id, titulo: p.titulo, revision: p.revision, actualizado: p.actualizado, escenas: p.escenas.length }];
    } catch {
      return [{ id, valido: false }];
    }
  });
}

export function proyectoLeer(raiz: string, id: string): { proyecto: Proyecto; avisos: Aviso[] } {
  const proyecto = cargarProyecto(raiz, id);
  return { proyecto, avisos: recomendaciones(proyecto) };
}

/**
 * Guarda el proyecto que manda el editor. La revisión gana (`conflicto` si no es la del disco). `recursos` no lo
 * cambia el cliente: tiene que coincidir con el disco, para que un PUT no pueda referenciar un fichero que no pasó por
 * la importación. `creado`, `id` y `revision` los fija el almacén.
 */
export function proyectoGuardar(raiz: string, args: { id: string; revision: number; proyecto: unknown }): { revision: number; avisos: Aviso[] } {
  const disco = cargarProyecto(raiz, args.id);
  if (!Number.isInteger(args.revision)) throw esquema("La revisión tiene que ser un entero.", "revision_invalida", "revision");
  if (args.revision !== disco.revision) {
    throw new ErrorAlmacen("conflicto", `El proyecto está en la revisión ${disco.revision} y se intentó guardar sobre la ${args.revision}. Recárgalo.`, [
      { ruta: "revision", codigo: "revision_antigua" },
    ]);
  }
  const cliente = validando(() => validarProyecto(args.proyecto));
  if (cliente.id !== disco.id) throw new ErrorAlmacen("esquema", "El id del documento no es el del proyecto.", [{ ruta: "id", codigo: "id_distinto" }]);
  if (!isDeepStrictEqual(cliente.recursos, disco.recursos)) {
    throw new ErrorAlmacen("esquema", "Los recursos solo cambian al importarlos.", [{ ruta: "recursos", codigo: "recursos_del_cliente" }]);
  }
  const siguiente = validando(() => validarProyecto({ ...cliente, revision: disco.revision + 1, creado: disco.creado, actualizado: ahora() }));
  escribirJson(path.join(dirProyecto(raiz, args.id), "proyecto.json"), siguiente);
  return { revision: siguiente.revision, avisos: recomendaciones(siguiente) };
}
