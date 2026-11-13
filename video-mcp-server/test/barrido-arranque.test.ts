// T6 · R0-6 (I7): el motor barre también al arrancar y a petición del backend (tras una cancelación o un reinicio),
// no solo tras un timeout o un error de la CLI. Lo que dejó un motor muerto se recoge por ruta de imagen.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { barrerProcesosTool } from "../src/herramientas.js";
import { barridoAlArrancar, ejecutar, fijarDepsBarridoParaPruebas, type ProcesoVivo } from "../src/proceso.js";

const NAV = String.raw`C:\Users\Marc\AppData\Local\seo-studio\navegador\152`;
const EXE_NAV = String.raw`${NAV}\chrome-headless-shell-win64\chrome-headless-shell.exe`;
const entorno = { VIDEO_NAVEGADOR_MANIFIESTO: String.raw`${NAV}\manifiesto.json`, HYPERFRAMES_BROWSER_PATH: EXE_NAV };
const huerfano: ProcesoVivo = { pid: 9991, ruta: EXE_NAV, nombre: "chrome-headless-shell.exe" };
const ajeno: ProcesoVivo = { pid: 9992, ruta: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`, nombre: "chrome.exe" };

/** Dependencias falsas con estado: lo que se mata deja de listarse. */
function deps(vivos: ProcesoVivo[]) {
  let lista = [...vivos];
  const matados: number[] = [];
  return {
    matados,
    listar: vi.fn(async () => lista),
    matar: vi.fn(async (m: ProcesoVivo[]) => {
      matados.push(...m.map((p) => p.pid));
      lista = lista.filter((p) => !m.some((x) => x.pid === p.pid));
    }),
    reiniciar: vi.fn(),
  };
}

describe.runIf(process.platform === "win32")("barrido_al_arrancar", () => {
  it("mata el Chrome huérfano de un motor muerto y no toca un Chrome ajeno", async () => {
    const d = deps([huerfano, ajeno]);
    await barridoAlArrancar(d, entorno);
    expect(d.matados).toEqual([9991]);
    expect(d.reiniciar).not.toHaveBeenCalled();
  });

  it("sin nada que barrer no hace nada", async () => {
    const d = deps([ajeno]);
    await barridoAlArrancar(d, entorno);
    expect(d.matar.mock.calls).toEqual([]);
  });

  it("sin navegador ni ffmpeg del motor ni lista: no lista procesos", async () => {
    const d = deps([huerfano]);
    await barridoAlArrancar(d, {});
    expect(d.listar).not.toHaveBeenCalled();
  });

  it("si no se puede matar, lo registra y NO reinicia el motor (M-1 de la auditoría)", async () => {
    const d = deps([huerfano]);
    d.matar.mockImplementation(async () => undefined);
    await barridoAlArrancar(d, entorno);
    expect(d.reiniciar).not.toHaveBeenCalled();
    const e = deps([huerfano]);
    e.matar.mockImplementation(async () => undefined);
    await barridoAlArrancar(e, entorno, true); // tras un timeout sí reinicia
    expect(e.reiniciar).toHaveBeenCalled();
  });
});

describe("video_barrer_procesos", () => {
  it("la tool barre y responde sin rutas ni pids", async () => {
    const d = deps([]);
    const r = await barrerProcesosTool(d, entorno);
    expect(r.texto).toMatch(/barrido/i);
    expect(JSON.stringify(r)).not.toMatch(/C:\\|\bpid\b/i);
  });

  it("se registra también en el integrado (el backend la pide tras cancelar) y no entra en el registro del modelo", () => {
    const index = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
    // Fuera de cualquier `if (!esIntegrado())`: va en el bloque común, después de registrarHerramientasProyecto.
    expect(index).toMatch(/"video_barrer_procesos"/);
    const antes = index.slice(0, index.indexOf('"video_barrer_procesos"'));
    const abiertos = (antes.match(/if \(!esIntegrado\(\)\) \{/g) ?? []).length;
    const cerrados = (antes.match(/^\}$/gm) ?? []).length;
    expect(abiertos).toBeLessThanOrEqual(cerrados);
  });
});

describe.runIf(process.platform === "win32")("LOW-N1 y LOW-N2 (re-revisión)", () => {
  it("LOW-N1: con restos sin matar la tool dice barrido:false con un aviso sin rutas ni pids, y no reinicia", async () => {
    const d = deps([huerfano]);
    d.matar.mockImplementation(async () => undefined);
    const r = await barrerProcesosTool(d, entorno);
    expect(r.datos).toEqual({ barrido: false });
    expect(r.texto).toMatch(/no he podido|quedan/i);
    expect(JSON.stringify(r)).not.toMatch(/9991|chrome-headless|C:\\/);
    expect(d.reiniciar).not.toHaveBeenCalled();
  });

  it("LOW-N1: si falla la consulta de procesos también es barrido:false", async () => {
    const d = deps([]);
    d.listar.mockRejectedValue(new Error("WMI caído"));
    const r = await barrerProcesosTool(d, entorno);
    expect(r.datos).toEqual({ barrido: false });
  });

  it("LOW-N2: un timeout de `ejecutar` barre con reinicio (si se quita el `true` de `lanzar`, falla)", async () => {
    const d = deps([huerfano]);
    d.matar.mockImplementation(async () => undefined);
    fijarDepsBarridoParaPruebas(d);
    const previo = { ...process.env };
    Object.assign(process.env, entorno);
    try {
      const ping = String.raw`C:\Windows\System32\PING.EXE`;
      const r = await ejecutar(ping, ["-n", "8", "127.0.0.1"], { timeoutMs: 400 });
      expect(r.timeout).toBe(true);
      expect(d.reiniciar).toHaveBeenCalled();
    } finally {
      fijarDepsBarridoParaPruebas(undefined);
      for (const k of Object.keys(entorno)) {
        if (previo[k] === undefined) delete process.env[k];
        else process.env[k] = previo[k];
      }
    }
  });
});
