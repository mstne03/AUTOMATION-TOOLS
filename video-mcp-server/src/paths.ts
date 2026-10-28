// Resolución y validación de rutas e ids: nada sale de VIDEO_ROOT.
import fs from "node:fs";
import path from "node:path";

export const ID_RE = /^video\d{3}$/;
export const EXTENSIONES_IMAGEN = [".jpg", ".jpeg", ".png", ".webp"];

export class ErrorVideo extends Error {}

export function validarId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new ErrorVideo(`Id no válido: ${JSON.stringify(id)}. Tiene que ser "video" más tres cifras, por ejemplo video001.`);
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
    throw new ErrorVideo(`La ruta ${destino} está fuera de VIDEO_ROOT (${raiz}).`);
  }
  try {
    const real = fs.realpathSync.native(destino);
    const raizReal = fs.realpathSync.native(raiz);
    if (!estaDentro(raizReal, real)) throw new ErrorVideo(`La ruta ${destino} apunta fuera de VIDEO_ROOT (${raiz}).`);
  } catch (e) {
    if (e instanceof ErrorVideo) throw e;
    // No existe todavía: basta con la comprobación léxica.
  }
  return destino;
}

export function carpetaVideo(raiz: string, id: string): string {
  return resolverDentro(raiz, validarId(id));
}

export function rutaMp4(raiz: string, id: string): string {
  return resolverDentro(raiz, `${validarId(id)}.mp4`);
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
    const m = /^video(\d{3})(\.mp4)?$/i.exec(nombre);
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
