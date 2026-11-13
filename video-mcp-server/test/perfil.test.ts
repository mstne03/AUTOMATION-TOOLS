// T8: perfil visual mínimo. Lista simple (perfiles/<id>.json), el id lo genera siempre el motor, validación al
// cargar y al guardar (I1), y el tema sale de `validarTema`. Nada de rutas ni campos de más (I6).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { validarTema } from "../src/composicion.js";
import { PERFIL_ID_RE } from "../src/esquema.js";
import { ErrorAlmacen, proyectoListar } from "../src/proyecto.js";
import { IDIOMAS, PERFIL_DEFECTO, carpetaPerfiles, perfilDuplicar, perfilGuardar, perfilesListar, temaDePerfil, type Perfil } from "../src/perfil.js";
import { perfilDuplicarTool, perfilGuardarTool, perfilesListarTool } from "../src/herramientas-proyecto.js";
import type { Config } from "../src/config.js";
import { plan } from "./ayudas-plan.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "video perfil "));
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

let RAIZ = "";
let n = 0;
beforeEach(() => {
  RAIZ = path.join(BASE, `caso${++n}`, "proyectos");
  fs.mkdirSync(RAIZ, { recursive: true });
});

const clon = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const cfg = (): Config => ({ videoRoot: RAIZ }) as Config;

function codigoDe(f: () => unknown): { codigo: string; problemas: { ruta: string; codigo: string }[] } {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorAlmacen);
    return { codigo: (e as ErrorAlmacen).codigo, problemas: (e as ErrorAlmacen).problemas };
  }
  throw new Error("se esperaba un ErrorAlmacen");
}

/** Copia de «defecto» con un id nuevo del motor; devuelve el perfil en disco. */
function copia(): Perfil {
  const { id } = perfilDuplicar(RAIZ, { id: "defecto" });
  return clon(perfilesListar(RAIZ).find((p) => "nombre" in p && p.id === id) as Perfil);
}

const ficheros = (): string[] => {
  try {
    return fs.readdirSync(carpetaPerfiles(RAIZ)).sort();
  } catch {
    return [];
  }
};

describe("perfil: lista, duplicar y guardar", () => {
  it("sin nada en disco, la lista trae solo el perfil por defecto, neutro y válido", () => {
    const l = perfilesListar(RAIZ);
    expect(l).toEqual([PERFIL_DEFECTO]);
    expect(PERFIL_DEFECTO.id).toBe("defecto");
    expect(() => validarTema(temaDePerfil(PERFIL_DEFECTO))).not.toThrow();
  });

  it("duplicar crea perfiles/<id>.json con un id del motor y lo devuelve", () => {
    const { id } = perfilDuplicar(RAIZ, { id: "defecto" });
    expect(id).toMatch(PERFIL_ID_RE);
    expect(id).not.toBe("defecto");
    expect(ficheros()).toEqual([`${id}.json`]);
    expect(path.dirname(carpetaPerfiles(RAIZ))).toBe(path.join(path.dirname(RAIZ), "video"));
    const otro = perfilDuplicar(RAIZ, { id });
    expect(otro.id).not.toBe(id);
    expect(perfilesListar(RAIZ).map((p) => p.id)).toEqual(["defecto", ...[id, otro.id].sort()]);
  });

  it("guardar cambia nombre, voz, idioma, colores y fuente, y se relee igual", () => {
    const p = copia();
    const nuevo: Perfil = { ...p, nombre: "Canal sobrio", voz: "AbCdEfGhIj01", idioma: "en", colores: { ...p.colores, acento: "#FF0066" }, fuente: "JetBrains Mono" };
    expect(perfilGuardar(RAIZ, { id: p.id, perfil: nuevo })).toEqual({ id: p.id });
    expect(perfilesListar(RAIZ).find((x) => x.id === p.id)).toEqual(nuevo);
  });

  it("guardar sin id en el cuerpo usa el del argumento", () => {
    const p = copia();
    const { id: _id, ...sinId } = p;
    perfilGuardar(RAIZ, { id: p.id, perfil: { ...sinId, nombre: "Sin id" } });
    expect((perfilesListar(RAIZ).find((x) => x.id === p.id) as Perfil).nombre).toBe("Sin id");
  });

  it("un perfil del disco que no cumple el esquema sale como no válido, sin romper la lista", () => {
    const p = copia();
    fs.writeFileSync(path.join(carpetaPerfiles(RAIZ), `${p.id}.json`), JSON.stringify({ ...p, fuente: "Comic Sans" }));
    expect(perfilesListar(RAIZ).find((x) => x.id === p.id)).toEqual({ id: p.id, valido: false });
  });

  it("un fichero con un id que no es el suyo no es válido al cargar", () => {
    const p = copia();
    fs.writeFileSync(path.join(carpetaPerfiles(RAIZ), `${p.id}.json`), JSON.stringify({ ...p, id: "defecto" }));
    expect(perfilesListar(RAIZ).find((x) => x.id === p.id)).toEqual({ id: p.id, valido: false });
  });

  it("los ficheros que no son perfiles no se listan", () => {
    copia();
    fs.writeFileSync(path.join(carpetaPerfiles(RAIZ), "../x.json"), "{}");
    fs.writeFileSync(path.join(carpetaPerfiles(RAIZ), "otro.json"), "{}");
    fs.writeFileSync(path.join(carpetaPerfiles(RAIZ), "p-0123456789abcdef.json.tmp-1-ab"), "{}");
    expect(perfilesListar(RAIZ)).toHaveLength(2);
  });
});

describe("perfil: negativas", () => {
  it("perfil_color_css_rechazado", () => {
    const p = copia();
    for (const c of ["red", "#12345", "red;background:url(//x)", "url(//x)", "rgb(0,0,0)", "#fff\n", ""]) {
      const r = codigoDe(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, colores: { ...p.colores, fondo: c } } }));
      expect(r.codigo).toBe("esquema");
      expect(r.problemas.map((x) => x.ruta)).toContain("colores.fondo");
    }
    expect(perfilesListar(RAIZ).find((x) => x.id === p.id)).toEqual(p);
  });

  it("perfil_fuente_fuera_de_lista", () => {
    const p = copia();
    for (const f of ["Comic Sans", "anton", "Anton; x", "", 3]) {
      expect(codigoDe(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, fuente: f } })).codigo).toBe("esquema");
    }
  });

  it("perfil_con_campo_de_mas: en la raíz, en colores y con __proto__", () => {
    const p = copia();
    const mal: unknown[] = [
      { ...p, ruta: "C:\\x" },
      { ...p, colores: { ...p.colores, extra: "#000000" } },
      JSON.parse(`{"id":"${p.id}","__proto__":{"x":1},"nombre":"a","voz":"AbCdEfGhIj01","idioma":"es","colores":${JSON.stringify(p.colores)},"fuente":"Anton"}`),
    ];
    for (const m of mal) expect(codigoDe(() => perfilGuardar(RAIZ, { id: p.id, perfil: m })).codigo).toBe("esquema");
  });

  it("perfil_id_recorrido: el id del argumento solo puede ser el del motor", () => {
    const p = copia();
    for (const id of ["../defecto", "..\\x", "p-0123456789ABCDEF", "p-0123456789abcde", "p-0123456789abcdef0", "defecto.json", "C:\\x", "", "defecto\n"]) {
      expect(codigoDe(() => perfilGuardar(RAIZ, { id, perfil: p })).codigo).toBe("esquema");
      expect(codigoDe(() => perfilDuplicar(RAIZ, { id })).codigo).toBe("esquema");
    }
    expect(ficheros()).toHaveLength(1);
  });

  it("perfil_id_cuerpo_distinto_422: rechaza con id_distinto y no escribe nada", () => {
    const p = copia();
    const otro = perfilDuplicar(RAIZ, { id: p.id }).id;
    const antes = ficheros().map((f) => fs.readFileSync(path.join(carpetaPerfiles(RAIZ), f), "utf8"));
    for (const idCuerpo of [otro, "defecto", "../x", 3, null]) {
      const r = codigoDe(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, nombre: "Cambiado", id: idCuerpo } }));
      expect(r.codigo).toBe("esquema");
      expect(r.problemas).toEqual([{ ruta: "id", codigo: "id_distinto" }]);
    }
    expect(ficheros().map((f) => fs.readFileSync(path.join(carpetaPerfiles(RAIZ), f), "utf8"))).toEqual(antes);
    expect(ficheros().filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("perfil_guardar_inexistente_404: no crea el fichero", () => {
    const p = copia();
    const r = codigoDe(() => perfilGuardar(RAIZ, { id: "p-0123456789abcdef", perfil: { ...p, id: "p-0123456789abcdef" } }));
    expect(r.codigo).toBe("no_encontrado");
    expect(ficheros()).toEqual([`${p.id}.json`]);
  });

  it("duplicar_no_acepta_id: el id nuevo es siempre del motor", () => {
    const pedido = "p-aaaaaaaaaaaaaaaa";
    for (const extra of [{ idNuevo: pedido }, { nuevoId: pedido }, { nombreId: pedido }, { perfil: { id: pedido } }]) {
      expect(codigoDe(() => perfilDuplicar(RAIZ, { id: "defecto", ...extra } as never)).codigo).toBe("esquema");
    }
    expect(ficheros()).toEqual([]);
    const { id } = perfilDuplicar(RAIZ, { id: "defecto", nombre: "Mi copia" });
    expect(id).not.toBe(pedido);
    expect((perfilesListar(RAIZ).find((x) => x.id === id) as Perfil).nombre).toBe("Mi copia");
  });

  it("duplicar un perfil inexistente es no_encontrado", () => {
    expect(codigoDe(() => perfilDuplicar(RAIZ, { id: "p-0123456789abcdef" })).codigo).toBe("no_encontrado");
  });

  it("perfil_voz_regex", () => {
    const p = copia();
    for (const v of ["", "corta", "x".repeat(41), "con espacios!", "../etc/passwd", "voz\n0123456789", "voz_0123456789", 5, null]) {
      expect(codigoDe(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, voz: v } })).codigo).toBe("esquema");
    }
    expect(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, voz: "A".repeat(40) } })).not.toThrow();
  });

  it("idioma de una lista cerrada", () => {
    const p = copia();
    for (const i of ["xx", "ES", "es-ES", "", "es\n", 1]) expect(codigoDe(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, idioma: i } })).codigo).toBe("esquema");
    for (const i of IDIOMAS) expect(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, idioma: i } })).not.toThrow();
  });

  it("nombre: textoSeguro, no vacío y ≤ 60", () => {
    const p = copia();
    const malos = ["", "x".repeat(61), "https://evil.example", "a\u202Eb", "a\u0000b", "javascript:alert(1)", "a\u200Bb", 7];
    for (const nombre of malos) {
      const r = codigoDe(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, nombre } }));
      expect(r.codigo).toBe("esquema");
      expect(r.problemas.map((x) => x.ruta)).toContain("nombre");
    }
    expect(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, nombre: "x".repeat(60) } })).not.toThrow();
  });

  it("el error no repite el valor del atacante", () => {
    const p = copia();
    const r = codigoDe(() => perfilGuardar(RAIZ, { id: p.id, perfil: { ...p, colores: { ...p.colores, fondo: "SECRETO-CENTINELA" } } }));
    expect(JSON.stringify(r)).not.toContain("SECRETO-CENTINELA");
  });

  it("un enlace en la carpeta de perfiles no se sigue al cargar", () => {
    const p = copia();
    const ruta = path.join(carpetaPerfiles(RAIZ), `${p.id}.json`);
    const fuera = path.join(BASE, `fuera${n}.json`);
    fs.writeFileSync(fuera, JSON.stringify(p));
    fs.rmSync(ruta);
    try {
      fs.symlinkSync(fuera, ruta);
    } catch {
      return; // sin permiso para enlaces simbólicos en este entorno
    }
    expect(perfilesListar(RAIZ).find((x) => x.id === p.id)).toEqual({ id: p.id, valido: false });
    expect(codigoDe(() => perfilGuardar(RAIZ, { id: p.id, perfil: p })).codigo).toBe("esquema");
  });

  it("la carpeta de perfiles queda fuera de VIDEO_ROOT: no cuenta como proyecto", () => {
    copia();
    expect(proyectoListar(RAIZ)).toEqual([]);
    expect(fs.readdirSync(RAIZ)).toEqual([]);
  });
});

describe("perfil → tema", () => {
  it("temaDePerfil pasa por validarTema y usa la fuente del perfil", () => {
    const p = copia();
    const t = temaDePerfil({ ...p, fuente: "JetBrains Mono" });
    expect(t.fuentes.titulos).toMatchObject({ familia: "JetBrains Mono", peso: 700 });
    expect(t.colores).toEqual(p.colores);
    expect(() => temaDePerfil({ ...p, colores: { ...p.colores, fondo: "red" } })).toThrow(/Tema no válido/);
  });

  it("dos_perfiles_dos_temas: mismo guion, CSS distinto y nada más cambia", () => {
    const a = copia();
    const b: Perfil = { ...a, colores: { fondo: "#112233", texto: "#EEEEEE", acento: "#FF00AA", contorno: "#000000", secundario: "#445566" }, fuente: "Anton" };
    const pa = plan("", 0.06, undefined, undefined, undefined, temaDePerfil({ ...a, fuente: "Inter Tight" })).p;
    const pb = plan("", 0.06, undefined, undefined, undefined, temaDePerfil(b)).p;
    // Lo único que puede diferir son los colores y la fuente: con ellos neutralizados, el resto es idéntico.
    const neutro = (p: typeof pa) =>
      Object.fromEntries(
        Object.entries(p.archivos).map(([k, v]) => [k, v.replace(/#[0-9a-fA-F]{3,8}\b/g, "#C").replace(/(Anton|Inter Tight|JetBrains Mono)/g, "F").replace(/(font-weight: |--peso-\w+: )\d+/g, "$1N").replace(/(anton|inter-tight|jetbrains-mono)-latin-\d+-normal/g, "f")]),
      );
    expect(pa.archivos["index.html"]).not.toBe(pb.archivos["index.html"]);
    expect(pb.archivos["index.html"]).toMatch(/#FF00AA/i);
    expect(pa.archivos["index.html"]).not.toMatch(/#FF00AA/i);
    expect(neutro(pa)).toEqual(neutro(pb));
    expect(pa.duracion).toBe(pb.duracion);
  });
});

describe("tools del perfil", () => {
  it("listar, duplicar y guardar devuelven datos y texto", () => {
    expect(perfilesListarTool(cfg()).datos).toMatchObject({ perfiles: [{ id: "defecto" }] });
    const d = perfilDuplicarTool(cfg(), { id: "defecto" });
    const id = (d.datos as { id: string }).id;
    expect(id).toMatch(PERFIL_ID_RE);
    const p = perfilesListar(RAIZ).find((x) => x.id === id) as Perfil;
    const g = perfilGuardarTool(cfg(), { id, perfil: { ...p, nombre: "Desde la tool" } });
    expect(g.datos).toEqual({ id });
    expect(g.texto).toContain(id);
  });
});
