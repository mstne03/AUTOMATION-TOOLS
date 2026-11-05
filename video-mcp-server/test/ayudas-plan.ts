// Ayuda común de los tests de composición: plan de un guion con palabras sintéticas, sin render ni binarios.
import { parsearGuion } from "../src/guion.js";
import { procesarAlineacion, type ResultadoAlineacion } from "../src/alineacion.js";
import { cargarTema, planificarComposicion, type Tema } from "../src/composicion.js";
import type { ImagenEncontrada } from "../src/paths.js";

export const CUERPO = "[1] Five nations rule football.\n[2] Spain, Italy, Germany.\n[3] Brazil and Argentina.\n[4] Seventeen World Cups between them.\n[5] Nobody comes close.\n[6] Can anyone catch up?\n";

/** Plan de un guion completo con palabras a `paso` s por carácter. `tocar` modifica la alineación antes de planificar. */
export function planDeGuion(texto: string, paso = 0.06, tocar?: (p: ResultadoAlineacion) => void, cortes?: number[], tema: Tema = cargarTema()) {
  const g = parsearGuion(texto);
  const chars = [...g.narracion];
  const al = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * paso), character_end_times_seconds: chars.map((_, i) => (i + 1) * paso) };
  const palabras = procesarAlineacion({ narracion: g.narracion, bloques: g.bloques, alineacion: al, hashNarracion: g.hash });
  tocar?.(palabras);
  const img = (n: number): ImagenEncontrada => ({ n, nombre: `img${n}.jpg`, ruta: `C:\\x\\img${n}.jpg`, extension: ".jpg" });
  const imagenes = [1, 2, 3, 4, 5, 6].map((n) => (g.opciones.escenas[n] ? undefined : img(n)));
  return { p: planificarComposicion({ guion: g, palabras, imagenes, tema, gpu: true, cortes }), palabras };
}

/** Plan con el frontmatter `fm` (además de titulo y gancho) y CUERPO. */
export function plan(fm: string, paso = 0.06, tocar?: (p: ResultadoAlineacion) => void, gancho = "Only five nations matter.", cortes?: number[], tema?: Tema) {
  return planDeGuion(`---\ntitulo: T\ngancho: ${gancho}\n${fm}\n---\n${CUERPO}`, paso, tocar, cortes, tema);
}
