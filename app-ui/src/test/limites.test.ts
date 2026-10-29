import { describe, expect, it } from "vitest";
import { bytesUtf8, compararConBorrador, comprobar, longitudEtiquetas, motivoBloqueo, tieneMarcador } from "../publicar/limites";

const base = { title: "Título", description: "Desc", tags: ["cs2"], publishAt: "", rutaVacia: false, rutaPermitida: true, ahora: Date.parse("2026-10-23T10:00:00") };

describe("límites de YouTube", () => {
  it("la descripción se mide en bytes UTF-8, no en caracteres", () => {
    expect(bytesUtf8("áé")).toBe(4);
    expect(bytesUtf8("😀")).toBe(4);
    const r = comprobar({ ...base, description: "á".repeat(2501) }); // 2501 caracteres = 5002 bytes
    expect(r.find((c) => c.id === "descripcion")).toMatchObject({ nivel: "error" });
    expect(comprobar({ ...base, description: "á".repeat(2500) }).find((c) => c.id === "descripcion")?.nivel).toBe("ok");
  });

  it("las etiquetas cuentan comas y las comillas de las que llevan espacios", () => {
    expect(longitudEtiquetas(["cs2"])).toBe(3);
    expect(longitudEtiquetas(["cs2", "skins"])).toBe(3 + 5 + 1);
    expect(longitudEtiquetas(["cs finance"])).toBe(10 + 2);
    expect(comprobar({ ...base, tags: ["a".repeat(501)] }).find((c) => c.id === "etiquetas")?.nivel).toBe("error");
  });

  it("< y > bloquean título, descripción y etiquetas; el marcador sin rellenar solo avisa", () => {
    expect(motivoBloqueo(comprobar({ ...base, title: "a<b" }))).toBe("El título no puede llevar < ni >.");
    expect(motivoBloqueo(comprobar({ ...base, description: "x>y" }))).toContain("descripción");
    expect(motivoBloqueo(comprobar({ ...base, tags: ["<x>"] }))).toContain("etiquetas");
    const aviso = comprobar({ ...base, description: "Mira [ENLACE A CSFINANCE.APP]" });
    expect(aviso.find((c) => c.id === "descripcion")?.nivel).toBe("aviso");
    expect(motivoBloqueo(aviso)).toBeNull();
    expect(tieneMarcador("lista [uno] y [dos]")).toBe(false);
  });

  it("una fecha programada pasada bloquea; una futura no", () => {
    expect(motivoBloqueo(comprobar({ ...base, publishAt: "2026-10-22T10:00" }))).toBe("La fecha programada ya ha pasado.");
    expect(motivoBloqueo(comprobar({ ...base, publishAt: "2026-10-25T18:00" }))).toBeNull();
  });

  it("motivos de bloqueo con el texto que ya usaban la UI y los tests", () => {
    expect(motivoBloqueo(comprobar({ ...base, rutaVacia: true, rutaPermitida: false }))).toContain("Falta elegir un vídeo");
    expect(motivoBloqueo(comprobar({ ...base, title: "" }))).toBe("Falta el título del borrador.");
  });

  it("compara lo que propone el agente con el borrador", () => {
    const b = { filePath: "C:\\Videos\\demo.mp4", title: "T", description: "D", tags: ["a", "b"], privacy: "private", publishAt: "" };
    const igual = { file_path: "c:/videos/DEMO.mp4", title: " T ", description: "D", tags: ["B", "a"], privacy_status: "private", publish_at: null };
    expect(compararConBorrador(igual, b)).toEqual([]);
    const dif = compararConBorrador({ ...igual, title: "Otro", privacy_status: "public" }, b);
    expect(dif.map((d) => d.campo)).toEqual(["Título", "Visibilidad"]);
  });

  it("si el agente propone otro fichero (o un nombre suelto), es una diferencia", () => {
    const b = { filePath: "C:\\Videos\\demo.mp4", title: "T", description: "", tags: [], privacy: "private", publishAt: "" };
    const resto = { title: "T", description: "", tags: [], privacy_status: "private" };
    for (const otro of ["C:\\Videos\\privado.mp4", "demo.mp4", "", undefined]) {
      const d = compararConBorrador({ ...resto, file_path: otro }, b);
      expect(d.map((x) => x.campo)).toEqual(["Fichero"]);
      expect(d[0]).toMatchObject({ borrador: "C:\\Videos\\demo.mp4", propuesto: otro ?? "" });
    }
  });
});
