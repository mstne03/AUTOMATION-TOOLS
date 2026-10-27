import { describe, expect, it } from "vitest";
import {
  aGuion,
  aRevision,
  dominio,
  duracionTotal,
  extraerVideoId,
  guionMarkdown,
  mmss,
  type Guion,
} from "../guiones/modelo";

describe("extraerVideoId", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["  dQw4w9WgXcQ ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["youtube.com/watch?v=a-b_c1234567", null], // 12 caracteres: no es un ID
    ["dQw4w9WgXc", null],
    ["https://vimeo.com/123", null],
    ["", null],
  ])("%s → %s", (entrada, id) => {
    expect(extraerVideoId(entrada)).toBe(id);
  });
});

describe("mmss", () => {
  it.each([
    [0, "0:00"],
    [9.6, "0:10"],
    [65, "1:05"],
    [3725, "62:05"],
  ])("%s s → %s", (s, txt) => {
    expect(mmss(s)).toBe(txt);
  });
});

describe("aGuion", () => {
  const valido = {
    ganchos: [{ tipo: "promesa", texto: "En 5 minutos..." }],
    bloques: [{ titulo: "Intro", segundos: 30, contenido: "...", nota_visual: "plano corto" }],
    cta: "Suscríbete",
    fuentes: [{ titulo: "vidIQ", url: "https://vidiq.com/x" }],
  };

  it("acepta el esquema", () => {
    expect(aGuion(valido)).toEqual(valido);
  });

  it("tolera campos opcionales ausentes", () => {
    const g = aGuion({ ganchos: [{ texto: "Hola" }], bloques: [{ titulo: "A", contenido: "B" }], cta: "" });
    expect(g).toEqual({
      ganchos: [{ tipo: "", texto: "Hola" }],
      bloques: [{ titulo: "A", segundos: 0, contenido: "B", nota_visual: "" }],
      cta: "",
      fuentes: [],
    });
  });

  it("rechaza sin ganchos o sin bloques", () => {
    expect(aGuion({ ...valido, ganchos: [] })).toBeNull();
    expect(aGuion({ ...valido, bloques: "no" })).toBeNull();
    expect(aGuion(null)).toBeNull();
  });
});

describe("aRevision", () => {
  it("acepta el esquema y descarta problemas mal formados", () => {
    const r = aRevision({
      veredicto_gancho: "Flojo",
      problemas: [{ fragmento: "a", problema: "b", propuesta: "c" }, "basura"],
      gancho_reescrito: "Mejor",
    });
    expect(r).toEqual({
      veredicto_gancho: "Flojo",
      problemas: [{ fragmento: "a", problema: "b", propuesta: "c" }],
      gancho_reescrito: "Mejor",
      fuentes: [],
    });
  });

  it("rechaza sin veredicto", () => {
    expect(aRevision({ problemas: [] })).toBeNull();
  });
});

describe("fuentes", () => {
  it("solo se quedan las https", () => {
    const g = aGuion({
      ganchos: [{ texto: "x" }],
      bloques: [{ titulo: "a" }],
      fuentes: [
        { titulo: "ok", url: "https://a.com" },
        { titulo: "http", url: "http://a.com" },
        { titulo: "js", url: "javascript:alert(1)" },
      ],
    });
    expect(g?.fuentes).toEqual([{ titulo: "ok", url: "https://a.com" }]);
  });
});

describe("guionMarkdown y duracionTotal", () => {
  const g: Guion = {
    ganchos: [
      { tipo: "promesa", texto: "Gancho A" },
      { tipo: "curiosidad", texto: "Gancho B" },
    ],
    bloques: [
      { titulo: "Intro", segundos: 30, contenido: "Texto 1", nota_visual: "plano" },
      { titulo: "Cierre", segundos: 15, contenido: "Texto 2", nota_visual: "" },
    ],
    cta: "Suscríbete",
    fuentes: [],
  };

  it("usa el gancho elegido y omite notas visuales vacías", () => {
    expect(guionMarkdown(g, 1)).toBe(
      "## Gancho\n\nGancho B\n\n## Intro (30s)\n\nTexto 1\n\n> Visual: plano\n\n## Cierre (15s)\n\nTexto 2\n\n## Llamada a la acción\n\nSuscríbete\n",
    );
  });

  it("suma los segundos de los bloques", () => {
    expect(duracionTotal(g)).toBe(45);
  });
});

describe("dominio", () => {
  it("devuelve el host de una URL válida", () => {
    expect(dominio("https://www.vidiq.com/blog/x")).toBe("www.vidiq.com");
  });

  it("no lanza con URLs que pasan el filtro https pero no se pueden analizar", () => {
    for (const url of ["https://[", "https://<x>", "https://a:99999"]) {
      expect(() => dominio(url)).not.toThrow();
      expect(dominio(url)).toBe(url);
    }
  });
});
