// pasaPorEnlace: una ruta 8.3 (como C:\Users\RUNNER~1\… del runner de CI) no es un enlace; una junction
// propia o en un padre, sí. Con la comparación contra realpath, la ruta corta se tomaba por enlace.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { borrarArbol } from "../src/paths.js";
import { pasaPorEnlace } from "../src/proceso.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "video enlaces "));
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

const real = path.join(BASE, "carpeta con nombre largo", "hf-home");
fs.mkdirSync(real, { recursive: true });

/** Nombre 8.3 de la ruta, o la misma si el volumen no los genera. */
function corta(p: string): string {
  return execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${p}") do @echo %~sI`], { windowsVerbatimArguments: true }).toString().trim();
}

describe.runIf(process.platform === "win32")("pasaPorEnlace", () => {
  it("una carpeta real no pasa por enlace", () => {
    expect(pasaPorEnlace(real)).toBe(false);
  });

  it("su ruta 8.3 tampoco (falso positivo del runner de CI)", (ctx) => {
    const c = corta(real);
    if (c.toLowerCase() === real.toLowerCase()) ctx.skip(); // volumen sin nombres 8.3
    expect(fs.realpathSync.native(c).toLowerCase()).not.toBe(c.toLowerCase());
    expect(pasaPorEnlace(c)).toBe(false);
  });

  it("una junction, o colgar de una, sí", () => {
    const junta = path.join(BASE, "junta");
    fs.symlinkSync(path.dirname(real), junta, "junction");
    expect(pasaPorEnlace(junta)).toBe(true);
    expect(pasaPorEnlace(path.join(junta, "hf-home"))).toBe(true);
  });

  // Revisión post-R2, H1: lstat no marca como enlace una junction a \\?\Volume{GUID}\… (la crea mklink /J sin
  // privilegios); la comparación con realpath sí la rechazaba.
  it("una junction a Volume{GUID}, también desde su ruta 8.3", () => {
    const unidad = path.parse(real).root; // C:\
    const guid = /\\\\\?\\Volume\{[0-9a-f-]+\}\\/i.exec(execFileSync("mountvol", [unidad, "/L"]).toString())?.[0];
    expect(guid, "mountvol no dio el volumen").toBeTruthy();
    const destino = guid + path.dirname(real).slice(unidad.length);
    const junta = path.join(BASE, "junta a volumen con nombre largo");
    execFileSync("cmd.exe", ["/d", "/c", `mklink /J "${junta}" "${destino}"`], { windowsVerbatimArguments: true });
    try {
      expect(fs.lstatSync(junta).isSymbolicLink(), "si lstat ya la marca, este test no prueba H1").toBe(false);
      expect(pasaPorEnlace(path.join(junta, "hf-home"))).toBe(true);
      const c = corta(path.join(junta, "hf-home"));
      if (c.toLowerCase() !== path.join(junta, "hf-home").toLowerCase()) expect(pasaPorEnlace(c)).toBe(true);
    } finally {
      // rmdir quita solo el enlace. Sin esto, el rmSync recursivo de afterAll la ve como carpeta (el mismo fallo de
      // lstat) y borra su destino por dos caminos a la vez (ENOTEMPTY en el runner de CI).
      fs.rmdirSync(junta);
    }
  });

  // borrarArbol: el mismo fallo de lstat haría que fs.rmSync recursivo entrase en la junction y borrase su destino.
  describe("borrarArbol no atraviesa una junction a Volume{GUID}", () => {
    const juntaVolumen = (junta: string, destino: string) => {
      const unidad = path.parse(destino).root;
      const guid = /\\\\\?\\Volume\{[0-9a-f-]+\}\\/i.exec(execFileSync("mountvol", [unidad, "/L"]).toString())![0];
      execFileSync("cmd.exe", ["/d", "/c", `mklink /J "${junta}" "${guid}${destino.slice(unidad.length)}"`], { windowsVerbatimArguments: true });
    };
    const preparar = (nombre: string) => {
      const fuera = path.join(BASE, `${nombre} fuera`);
      fs.mkdirSync(fuera, { recursive: true });
      fs.writeFileSync(path.join(fuera, "del usuario.txt"), "no se toca");
      const dir = path.join(BASE, `${nombre} a borrar`);
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sub", "temporal.txt"), "x");
      return { fuera, dir };
    };

    // Node 22 (el del bundle y la CI) borra el destino; el rmSync nativo de Node 24 no lo atraviesa, y ahí el
    // control se salta: los demás casos siguen probando borrarArbol, que no depende de la versión.
    it("control: fs.rmSync recursivo de este Node borra el destino", (ctx) => {
      const { fuera, dir } = preparar("control");
      juntaVolumen(path.join(dir, "sub", "junta"), fuera);
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* puede acabar en ENOTEMPTY: lo que importa es el destino */
      }
      const borrado = !fs.existsSync(path.join(fuera, "del usuario.txt"));
      if (fs.existsSync(path.join(dir, "sub", "junta"))) fs.rmdirSync(path.join(dir, "sub", "junta"));
      if (!borrado) ctx.skip(`Node ${process.version} no atraviesa la junction en rmSync`);
      expect(borrado).toBe(true);
    });

    it("una junction dentro: se quita el enlace y el destino queda intacto", () => {
      const { fuera, dir } = preparar("dentro");
      juntaVolumen(path.join(dir, "sub", "junta"), fuera);
      borrarArbol(dir);
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.readFileSync(path.join(fuera, "del usuario.txt"), "utf8")).toBe("no se toca");
    });

    it("la propia carpeta es la junction: solo se quita el enlace", () => {
      const { fuera } = preparar("raiz");
      const junta = path.join(BASE, "raiz junta");
      juntaVolumen(junta, fuera);
      borrarArbol(junta);
      expect(fs.existsSync(junta)).toBe(false);
      expect(fs.readFileSync(path.join(fuera, "del usuario.txt"), "utf8")).toBe("no se toca");
    });

    it("una carpeta normal se borra entera y una que no existe no falla", () => {
      const { dir } = preparar("normal");
      borrarArbol(dir);
      expect(fs.existsSync(dir)).toBe(false);
      expect(() => borrarArbol(path.join(BASE, "no existe"))).not.toThrow();
    });
  });

  it("rutas UNC o de dispositivo: falla cerrado", () => {
    const malas = ["\\\\?\\UNC\\srv\\share\\x", "\\\\.\\C:\\x", "\\\\srv\\share\\x", "//srv/share/x", "//?/UNC/srv/x", "//./C:/x", "\\/srv/x"];
    // Low-2: con el prefijo de un solo \, path.resolve las haría relativas al cwd y se comprobaría otra ruta.
    malas.push("\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x", "\\\\?\\GLOBALROOT\\Device\\x");
    for (const r of malas) expect(() => pasaPorEnlace(r), r).toThrow(/red o de dispositivo/);
    expect(pasaPorEnlace("\\\\?\\" + real)).toBe(false); // \\?\C:\… es local: se acepta
  });
});
