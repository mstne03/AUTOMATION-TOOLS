// borrarArbol: falla en cerrado (M1 y L1 de la revisión de la integración). Nada de esto toca enlaces: sirve en cualquier SO.
// Los casos de ruta relativa se ejecutan con el cwd dentro de una carpeta desechable: antes de la corrección,
// borrarArbol("") borraba el cwd, y el test no debe poder llevarse nada que no sea suyo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { borrarArbol } from "../src/paths.js";

const CWD_ORIGINAL = process.cwd();
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "video borrar "));
afterAll(() => {
  process.chdir(CWD_ORIGINAL);
  fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});
afterEach(() => vi.restoreAllMocks());

/** Anula todo borrado real y devuelve las rutas que se habrían tocado: los casos peligrosos no pueden destruir nada ni sin la corrección. */
function sinBorrar(): string[] {
  const tocadas: string[] = [];
  for (const f of ["unlinkSync", "rmdirSync", "rmSync"] as const) vi.spyOn(fs, f).mockImplementation(((p: fs.PathLike) => void tocadas.push(String(p))) as never);
  return tocadas;
}

function carpeta(nombre: string): string {
  const dir = path.join(BASE, nombre);
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sub", "a.txt"), "x");
  return dir;
}

describe("borrarArbol falla en cerrado", () => {
  it("M1: un lstat que falla por algo distinto de ENOENT lanza y no deja creer que se borró", () => {
    const dir = carpeta("m1");
    const real = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: object) => {
      if (String(p) === path.resolve(dir)) throw Object.assign(new Error("bloqueado"), { code: "EPERM" });
      return real(p, o as never);
    }) as never);
    expect(() => borrarArbol(dir)).toThrow(/bloqueado/);
    vi.restoreAllMocks();
    expect(fs.existsSync(path.join(dir, "sub", "a.txt"))).toBe(true);
  });

  it("M1: una ruta que no existe (ENOENT) sigue sin fallar", () => {
    expect(() => borrarArbol(path.join(BASE, "no existe"))).not.toThrow();
  });

  it("L1: ruta vacía o relativa lanza y no borra el cwd", () => {
    const trampa = carpeta("cwd trampa");
    process.chdir(trampa);
    const tocadas = sinBorrar();
    try {
      for (const mala of ["", "relativa", "./otra", "sub", "."]) expect(() => borrarArbol(mala), JSON.stringify(mala)).toThrow(/ruta absoluta/);
      expect(tocadas).toEqual([]);
    } finally {
      process.chdir(CWD_ORIGINAL);
    }
  });

  it("L1: la raíz de una unidad se rechaza", () => {
    const tocadas = sinBorrar();
    expect(() => borrarArbol(path.parse(BASE).root)).toThrow(/raíz/);
    expect(tocadas).toEqual([]);
  });

  it("L1: si la raíz no aparece en el listado de su padre, no se borra nada", () => {
    const dir = carpeta("l1");
    const padre = path.dirname(path.resolve(dir));
    const real = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, o?: object) => (String(p) === padre ? [] : real(p, o as never))) as never);
    expect(() => borrarArbol(dir)).toThrow(/no aparece/);
    vi.restoreAllMocks();
    expect(fs.existsSync(path.join(dir, "sub", "a.txt"))).toBe(true);
  });

  it("L1: si el padre no se puede listar, tampoco", () => {
    const dir = carpeta("l1b");
    const padre = path.dirname(path.resolve(dir));
    const real = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, o?: object) => {
      if (String(p) === padre) throw Object.assign(new Error("sin permiso"), { code: "EACCES" });
      return real(p, o as never);
    }) as never);
    expect(() => borrarArbol(dir)).toThrow(/sin permiso/);
    vi.restoreAllMocks();
    expect(fs.existsSync(path.join(dir, "sub", "a.txt"))).toBe(true);
  });

  it("una carpeta normal se borra entera", () => {
    const dir = carpeta("normal");
    borrarArbol(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
