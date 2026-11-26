/** Las rutas del sistema no se enseñan (los mensajes del motor y del backend pueden traerlas):
 *  `C:\…`, UNC y POSIX de dos segmentos o más (I6, I11). Los segmentos intermedios admiten espacios;
 *  el último acaba en el primer espacio. Se prefiere enmascarar de más: lo que sobra es texto, lo
 *  que falta es una ruta filtrada. */
const SEG = String.raw`[^\\/:*?"<>|\r\n]+[\\/]`;
const INICIO = String.raw`(?:\\\\\?\\)?(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|/(?=[^\s\\/]+/))`;
const RUTA = new RegExp(String.raw`(^|[\s"'(\[«])${INICIO}(?:${SEG})*[^\s\\/:*?"<>|»)'’]*`, "g");
export const sinRutas = (t: string) => t.replace(RUTA, "$1…");
