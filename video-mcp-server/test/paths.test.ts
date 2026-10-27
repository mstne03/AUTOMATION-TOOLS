import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buscarImagenes, carpetaVideo, estaDentro, resolverDentro, siguienteId, validarId } from "../src/paths.js";

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), "footy paths "));
afterAll(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

describe("paths", () => {
  it("valida ids", () => {
    expect(validarId("footy001")).toBe("footy001");
    for (const malo of ["footy1", "footy0001", "../footy001", "footy001/..", "Footy001", "", 5]) {
      expect(() => validarId(malo)).toThrow(/no válido/);
    }
  });

  it("impide salir de FOOTY_ROOT", () => {
    expect(() => resolverDentro(RAIZ, "..", "x")).toThrow(/fuera/);
    expect(() => resolverDentro(RAIZ, "C:\\Windows\\win.ini")).toThrow(/fuera/);
    expect(() => resolverDentro(RAIZ, "_musica/../../x.mp3")).toThrow(/fuera/);
    expect(resolverDentro(RAIZ, "_musica/tema uno.mp3")).toBe(path.join(RAIZ, "_musica", "tema uno.mp3"));
    expect(estaDentro(RAIZ, RAIZ + "otra")).toBe(false);
    expect(carpetaVideo(RAIZ, "footy007")).toBe(path.join(RAIZ, "footy007"));
  });

  it("calcula el siguiente id libre contando carpetas y mp4", () => {
    expect(siguienteId(RAIZ)).toBe("footy001");
    fs.mkdirSync(path.join(RAIZ, "footy002"));
    fs.writeFileSync(path.join(RAIZ, "footy005.mp4"), "");
    expect(siguienteId(RAIZ)).toBe("footy006");
  });

  it("encuentra img1…img6 con cualquier sufijo y extensión válida", () => {
    const dir = path.join(RAIZ, "footy002");
    for (const n of ["img1.jpg", "IMG2 estadio.PNG", "img3.webp", "img4.jpeg", "img5.gif", "img10.jpg", "img6-a.jpg", "img6-b.jpg"]) {
      fs.writeFileSync(path.join(dir, n), "");
    }
    const { imagenes, avisos } = buscarImagenes(dir);
    expect(imagenes.map((i) => i?.nombre)).toEqual(["img1.jpg", "IMG2 estadio.PNG", "img3.webp", "img4.jpeg", undefined, "img6-a.jpg"]);
    expect(imagenes[3]?.extension).toBe(".jpg");
    expect(avisos.join(" ")).toMatch(/img6/);
  });
});
