// Solo para pruebas (R1 de T1+T3+T9): monta `_composicion/` de un proyecto GUARDADO con voz sintética (1 s por frase) y
// escribe en stdout `{ red, archivos }`. Pasa por el mismo camino que el montaje: proyectoLeer (valida) → construirLinea →
// planificarComposicion → escribirPlan → urlsDeRed. Uso: node scripts/componer-proyecto.mjs <raiz> <id> <destino>
import path from "node:path";
import { procesarAlineacion } from "../dist/alineacion.js";
import { cargarTema, escribirPlan, planificarComposicion, urlsDeRed } from "../dist/composicion.js";
import { construirLinea, desdeProyecto } from "../dist/linea.js";
import { proyectoLeer } from "../dist/proyecto.js";

const [raiz, id, destino] = process.argv.slice(2);
const { proyecto } = proyectoLeer(raiz, id);
const voz = new Map(
  proyecto.frases.map((f) => {
    const chars = [...f.texto];
    const al = { characters: chars, character_start_times_seconds: chars.map((_, i) => i / chars.length), character_end_times_seconds: chars.map((_, i) => (i + 1) / chars.length) };
    return [f.id, { duracion: 1, palabras: procesarAlineacion({ narracion: f.texto, bloques: [{ n: 1, inicio: 0, fin: f.texto.length }], alineacion: al, duracionAudio: 1, hashNarracion: "h" }) }];
  }),
);
const palabras = construirLinea(proyecto, voz);
const plan = planificarComposicion({ ...desdeProyecto(proyecto, palabras), palabras, tema: cargarTema(), gpu: false });
escribirPlan(path.resolve(destino), plan);
process.stdout.write(JSON.stringify({ red: urlsDeRed(path.resolve(destino)), archivos: Object.keys(plan.archivos).length, avisos: plan.avisos }));
