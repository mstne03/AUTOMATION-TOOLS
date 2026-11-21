// D5 (R0 de W3): pruebas negativas mínimas sobre la composición escrita a disco, que es lo que Chrome carga.
//  - La clave de ElevenLabs (BYOK) no puede acabar en ningún fichero de la composición.
//  - Nada de la composición pide `?hf-proxy`: ese parámetro hace que el servidor de HyperFrames lance ffmpeg sobre
//    ficheros del proyecto (R0 oleada 2, M-1 c).
// Sin render ni binarios: se planifica, se escribe y se barre.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escribirPlan, type PlanComposicion } from "../src/composicion.js";
import { GUION_TODAS, GUION_TUNEL } from "../scripts/montar.mjs";
import { planDeGuion } from "./ayudas-plan.js";

const CENTINELA = "sk-centinela-no-debe-salir-9f3a1c7e";
const VARIABLES = ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ANTHROPIC_API_KEY"] as const;
const guardadas = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "video sin secretos "));

beforeAll(() => {
  for (const v of VARIABLES) process.env[v] = `${CENTINELA}-${v}`;
});
afterAll(() => {
  for (const v of VARIABLES) {
    if (guardadas[v] === undefined) delete process.env[v];
    else process.env[v] = guardadas[v];
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

function ficheros(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? ficheros(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** Escribe el plan; las fotos del plan sintético apuntan a rutas que no existen, así que se sustituyen por reales. */
function escribir(nombre: string, p: PlanComposicion): string {
  const foto = path.join(TMP, "foto.jpg");
  fs.writeFileSync(foto, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const destino = path.join(TMP, nombre);
  escribirPlan(destino, { ...p, copias: p.copias.map((c) => (fs.existsSync(c.origen) ? c : { ...c, origen: foto })) });
  return destino;
}

for (const [nombre, guion] of [
  ["GUION_TODAS", GUION_TODAS],
  ["GUION_TUNEL", GUION_TUNEL],
] as const) {
  describe(`composición de ${nombre}`, () => {
    const { p } = planDeGuion(guion);
    const destino = escribir(nombre, p);

    it("ninguna clave del entorno aparece en el plan ni en ningún fichero de _composicion", () => {
      const enPlan = Object.entries(p.archivos).filter(([, contenido]) => contenido.includes(CENTINELA));
      expect(enPlan.map(([rel]) => rel)).toEqual([]);
      const enDisco = ficheros(destino).filter((f) => fs.readFileSync(f).includes(CENTINELA));
      expect(enDisco).toEqual([]);
      expect(ficheros(destino).length).toBeGreaterThan(5); // el barrido vio de verdad la composición
    });

    it("nada de la composición escrita usa ?hf-proxy", () => {
      const conProxy = ficheros(destino).filter((f) => fs.readFileSync(f).includes("hf-proxy"));
      expect(conProxy.map((f) => path.relative(destino, f))).toEqual([]);
    });
  });
}
