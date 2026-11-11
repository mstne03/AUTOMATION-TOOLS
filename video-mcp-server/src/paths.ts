// Resolución y validación de rutas e ids: nada sale de VIDEO_ROOT.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ID_RE = /^video\d{3}$/;
export const EXTENSIONES_IMAGEN = [".jpg", ".jpeg", ".png", ".webp"];

export class ErrorVideo extends Error {}

/** Valor del atacante para un mensaje: recortado, para que un id de varios MB no se repita en el error ni en el log. */
export function valorCorto(v: unknown, max = 40): string {
  if (typeof v !== "string") return typeof v;
  return JSON.stringify(v.length > max ? `${v.slice(0, max)}…` : v);
}

export function validarId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new ErrorVideo(`Id no válido: ${valorCorto(id)}. Tiene que ser "video" más tres cifras, por ejemplo video001.`);
  }
  return id;
}

/** true si `destino` es `raiz` o está dentro de ella. */
export function estaDentro(raiz: string, destino: string): boolean {
  const rel = path.relative(path.resolve(raiz), path.resolve(destino));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resuelve segmentos bajo `raiz` y falla si el resultado se sale (incluido a través de enlaces simbólicos ya existentes). */
export function resolverDentro(raiz: string, ...segmentos: string[]): string {
  const destino = path.resolve(raiz, ...segmentos);
  if (!estaDentro(raiz, destino)) {
    throw new ErrorVideo(`La ruta «${nombreDe(destino)}» está fuera de VIDEO_ROOT.`);
  }
  try {
    const real = fs.realpathSync.native(destino);
    const raizReal = fs.realpathSync.native(raiz);
    if (!estaDentro(raizReal, real)) throw new ErrorVideo(`La ruta «${nombreDe(destino)}» apunta fuera de VIDEO_ROOT.`);
  } catch (e) {
    if (e instanceof ErrorVideo) throw e;
    // No existe todavía: basta con la comprobación léxica.
  }
  return destino;
}

export function carpetaVideo(raiz: string, id: string): string {
  return resolverDentro(raiz, validarId(id));
}

/** El MP4 vive dentro de la carpeta del proyecto: borrar el proyecto no puede dejarlo huérfano. */
export function rutaMp4(raiz: string, id: string): string {
  return resolverDentro(raiz, validarId(id), "video.mp4");
}

export function archivosVideo(raiz: string, id: string) {
  const dir = carpetaVideo(raiz, id);
  return {
    dir,
    guion: path.join(dir, "guion.md"),
    voz: path.join(dir, "voz.mp3"),
    alineacion: path.join(dir, "alineacion.json"),
    palabras: path.join(dir, "palabras.json"),
    composicion: path.join(dir, "_composicion"),
    mp4: rutaMp4(raiz, id),
  };
}

export function listarIds(raiz: string): string[] {
  let entradas: fs.Dirent[];
  try {
    entradas = fs.readdirSync(raiz, { withFileTypes: true });
  } catch {
    return [];
  }
  return entradas
    .filter((e) => e.isDirectory() && ID_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

export function siguienteId(raiz: string): string {
  let max = 0;
  let entradas: string[] = [];
  try {
    entradas = fs.readdirSync(raiz);
  } catch {
    /* raíz vacía */
  }
  for (const nombre of entradas) {
    const m = /^video(\d{3})(\.mp4)?$/i.exec(nombre); // `.mp4` suelto: restos del formato anterior (el MP4 ya vive dentro)
    if (m) max = Math.max(max, Number(m[1]));
  }
  if (max >= 999) throw new ErrorVideo("No quedan ids libres (video999 ya existe).");
  return `video${String(max + 1).padStart(3, "0")}`;
}

export interface ImagenEncontrada {
  n: number;
  nombre: string;
  ruta: string;
  extension: string;
}

/**
 * Busca img1…img6 en la carpeta: vale cualquier nombre que empiece por imgN (sin otra cifra detrás)
 * con extensión jpg, jpeg, png o webp. Si hay varias para un N, se queda con la primera por orden alfabético.
 */
export function buscarImagenes(dir: string): { imagenes: (ImagenEncontrada | undefined)[]; avisos: string[]; ignoradas: string[] } {
  const avisos: string[] = [];
  let nombres: string[] = [];
  try {
    nombres = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    /* carpeta inexistente */
  }
  const imagenes: (ImagenEncontrada | undefined)[] = [];
  for (let n = 1; n <= 6; n++) {
    const re = new RegExp(`^img${n}(?!\\d)`, "i");
    const candidatas = nombres.filter((nm) => re.test(nm) && EXTENSIONES_IMAGEN.includes(path.extname(nm).toLowerCase()));
    if (candidatas.length > 1) avisos.push(`Hay ${candidatas.length} imágenes para img${n} (${candidatas.join(", ")}); uso ${candidatas[0]}.`);
    const nombre = candidatas[0];
    imagenes.push(
      nombre ? { n, nombre, ruta: path.join(dir, nombre), extension: path.extname(nombre).toLowerCase().replace(".jpeg", ".jpg") } : undefined,
    );
  }
  // Fotos que están en la carpeta pero no se reconocen por el nombre: es el error más habitual.
  const ignoradas = nombres.filter(
    (nm) => EXTENSIONES_IMAGEN.includes(path.extname(nm).toLowerCase()) && !/^img[1-6](?!\d)/i.test(nm),
  );
  if (ignoradas.length) {
    avisos.push(
      `Hay ${ignoradas.length} foto(s) que no se reconocen porque no se llaman img1…img6: ${ignoradas.join(", ")}. ` +
        "Renómbralas según el bloque en el que van (img1.jpg es la portada; vale también \"img1 drogba.jpg\").",
    );
  }
  return { imagenes, avisos, ignoradas };
}

/** Tope de tamaño de un recurso del usuario (I15: 50 MB). */
export const MAX_RECURSO_BYTES = 50 * 1024 * 1024;

const nombreDe = (ruta: string) => path.basename(ruta);

/**
 * Un recurso del usuario tiene que ser un fichero normal, sin enlaces simbólicos, junctions ni hardlinks (I6).
 * Se comprueba el propio nombre (`lstat`, que no sigue enlaces); `nlink > 1` delata un hardlink a un fichero ajeno.
 * Solo para recursos del usuario: en `node_modules` pnpm enlaza y `nlink > 1` es normal.
 */
export function comprobarRecurso(ruta: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(ruta);
  } catch {
    throw new ErrorVideo(`No puedo leer ${nombreDe(ruta)}.`);
  }
  if (st.isSymbolicLink()) throw new ErrorVideo(`${nombreDe(ruta)} es un enlace simbólico. Copia el fichero real en la carpeta del vídeo.`);
  if (!st.isFile()) throw new ErrorVideo(`${nombreDe(ruta)} no es un fichero normal.`);
  if (st.nlink > 1) {
    throw new ErrorVideo(`${nombreDe(ruta)} es un enlace duro (hardlink) a otro fichero. Copia el fichero real en la carpeta del vídeo.`);
  }
}

/**
 * Copia un recurso del usuario abriéndolo una sola vez: `lstat` con bigint, abre, `fstat` del descriptor (mismo
 * fichero, normal, un solo enlace, bajo el tope) y lee **del descriptor**, de modo que un cambio posterior del
 * nombre no se cuela. El destino se crea con `wx`: nunca pisa un fichero existente.
 */
export function copiarRecurso(origen: string, destino: string, max: number = MAX_RECURSO_BYTES): void {
  const nombre = nombreDe(origen);
  const antes = fs.lstatSync(origen, { bigint: true });
  if (antes.isSymbolicLink() || !antes.isFile()) throw new ErrorVideo(`${nombre} no es un fichero normal.`);
  const fd = fs.openSync(origen, "r");
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw new ErrorVideo(`${nombre} no es un fichero normal.`);
    if (st.nlink !== 1n) throw new ErrorVideo(`${nombre} es un enlace duro (hardlink) a otro fichero. Copia el fichero real en la carpeta del vídeo.`);
    if (st.dev !== antes.dev || st.ino !== antes.ino) throw new ErrorVideo(`${nombre} ha cambiado mientras se abría; vuelve a intentarlo.`);
    if (st.size > BigInt(max)) throw new ErrorVideo(`${nombre} pesa más de ${max / 1024 / 1024} MB.`);
    // Por trozos (un clip de 500 MB no cabe entero en un Buffer) y con el tope aplicado también a lo leído, por si el fichero crece.
    const trozo = Buffer.alloc(Math.min(1024 * 1024, Math.max(Number(st.size), 1)));
    const salida = fs.openSync(destino, "wx");
    try {
      let total = 0;
      for (;;) {
        const n = fs.readSync(fd, trozo, 0, trozo.length, total);
        if (n === 0) break;
        total += n;
        if (total > max) throw new ErrorVideo(`${nombre} pesa más de ${max / 1024 / 1024} MB.`);
        fs.writeSync(salida, trozo, 0, n);
      }
    } catch (e) {
      fs.closeSync(salida);
      fs.rmSync(destino, { force: true });
      throw e;
    }
    fs.closeSync(salida);
  } finally {
    fs.closeSync(fd);
  }
}

const igualRuta = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

const REINTENTABLES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
/** Reintenta una operación de borrado ante bloqueos breves de Windows (un ffmpeg que acaba de soltar el fichero); ENOENT no es fallo. */
function conReintentos(op: () => void): void {
  for (let intento = 0; ; intento++) {
    try {
      return op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return;
      if (!REINTENTABLES.has(code) || intento >= 10) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}

/** Quita un enlace o junction (de fichero o de carpeta) sin tocar su destino. */
function quitarEnlace(ruta: string): void {
  conReintentos(() => {
    try {
      fs.unlinkSync(ruta);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      fs.rmdirSync(ruta); // junction o symlink de carpeta en Windows
    }
  });
}

/**
 * Borra una carpeta y su contenido sin atravesar enlaces. `fs.rmSync({ recursive })` mira cada entrada con lstat, que
 * no marca las junctions a `\??\Volume{GUID}\…` (las crea `mklink /J` sin privilegios): entraría en ellas y borraría
 * su destino, esté donde esté. Aquí cada entrada se mira por su Dirent, que sí las marca; un enlace se quita sin
 * entrar, y si la propia carpeta es un enlace, solo se quita el enlace. Si no existe, no hace nada.
 */
export function borrarArbol(dir: string): void {
  if (!dir || !path.isAbsolute(dir)) throw new ErrorVideo("borrarArbol exige una ruta absoluta y no vacía.");
  const raiz = path.resolve(dir);
  const padre = path.dirname(raiz);
  if (padre === raiz) throw new ErrorVideo("borrarArbol no borra la raíz de una unidad.");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(raiz);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e; // bloqueada o ilegible: volver sin borrar dejaría ficheros viejos que la preview serviría (I11)
  }
  // El Dirent del padre marca las junctions que lstat no ve. Si no se puede listar o la raíz no aparece (8.3,
  // mayúsculas), no se sabe si es un enlace: se falla en cerrado en vez de suponer que no lo es.
  const enPadre = fs.readdirSync(padre, { withFileTypes: true }).find((e) => igualRuta(e.name, path.basename(raiz)));
  if (!enPadre) throw new ErrorVideo(`borrarArbol: ${nombreDe(raiz)} no aparece en el listado de su carpeta; no se borra.`);
  if (st.isSymbolicLink() || enPadre.isSymbolicLink()) return quitarEnlace(raiz);
  if (!st.isDirectory()) return conReintentos(() => fs.unlinkSync(raiz));
  vaciar(raiz);
  conReintentos(() => fs.rmdirSync(raiz));
}

function leerEntradas(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function vaciar(dir: string): void {
  for (const e of leerEntradas(dir)) {
    const ruta = path.join(dir, e.name);
    if (e.isSymbolicLink()) quitarEnlace(ruta);
    else if (e.isDirectory()) {
      vaciar(ruta);
      conReintentos(() => fs.rmdirSync(ruta));
    } else conReintentos(() => fs.unlinkSync(ruta));
  }
}

/** La carpeta del vídeo no puede ser un enlace, una junction ni colgar de un padre enlazado: nada de lo de dentro sería «suyo». */
export function comprobarCarpeta(dir: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return; // no existe todavía: lo dirá quien la necesite
  }
  const ruta = path.resolve(dir);
  const real = fs.realpathSync.native(ruta);
  const esperada = path.join(fs.realpathSync.native(path.dirname(ruta)), path.basename(ruta));
  if (st.isSymbolicLink() || !igualRuta(real, esperada)) {
    throw new ErrorVideo(`La carpeta ${nombreDe(dir)} es un enlace o una junction a otro sitio. Usa una carpeta real dentro de VIDEO_ROOT.`);
  }
}

/**
 * Como `buscarImagenes`, pero la carpeta y cada imagen se validan (I6): la carpeta no puede ser un enlace o
 * junction, cada foto es un fichero normal sin hardlinks ni enlaces, y además pasa por `resolverDentro` (realpath).
 * Si no, ErrorVideo en vez de copiarla a la composición.
 */
export function imagenesValidadas(dir: string): ReturnType<typeof buscarImagenes> {
  comprobarCarpeta(dir);
  const r = buscarImagenes(dir);
  for (const img of r.imagenes) {
    if (!img) continue;
    try {
      resolverDentro(dir, img.nombre);
    } catch (e) {
      if (e instanceof ErrorVideo) {
        throw new ErrorVideo(`La imagen ${img.nombre} es un enlace que apunta fuera de la carpeta del vídeo. Copia el fichero real en esa carpeta.`);
      }
      throw e;
    }
    comprobarRecurso(img.ruta);
  }
  return r;
}

const RENAME_REINTENTABLE = new Set(["EBUSY", "EPERM", "EACCES"]);
/** `rename` con reintentos breves: en Windows el antivirus o el indexador pueden tener el destino abierto un instante. */
function renombrar(origen: string, destino: string): void {
  for (let intento = 0; ; intento++) {
    try {
      return fs.renameSync(origen, destino);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!RENAME_REINTENTABLE.has(code) || intento >= 5) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** fsync de la carpeta tras el rename (POSIX). En Windows no se puede abrir una carpeta: EPERM/EISDIR/EINVAL se ignoran. */
function sincronizarCarpeta(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (!["EPERM", "EISDIR", "EINVAL", "EACCES", "ENOTSUP", "EBADF"].includes(code)) throw e;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nada que cerrar */
      }
    }
  }
}

/**
 * Escritura atómica y durable: temporal único en la misma carpeta (`wx`), `fsync` del temporal y renombrado. Sin el
 * fsync, un corte de luz puede dejar el rename en disco y el contenido sin escribir (fichero vacío). Si algo falla a
 * mitad, el fichero anterior queda intacto y el temporal se borra.
 */
export function escribirAtomico(ruta: string, datos: string | Buffer): void {
  const tmp = `${ruta}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx");
    try {
      fs.writeFileSync(fd, datos);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renombrar(tmp, ruta);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* no llegó a crearse */
    }
    throw e;
  }
  sincronizarCarpeta(path.dirname(ruta));
}
