// T4: almacén de guiones y proyectos. Validación al guardar y al cargar (I1), rutas solo bajo VIDEO_ROOT (I6),
// escritura atómica y revisión que gana. Los casos de junctions solo se ejecutan en Windows.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { descripcionEsquema } from "../src/esquema.js";
import { archivosVideo, escribirAtomico } from "../src/paths.js";
import type { Config } from "../src/config.js";
import {
  ErrorAlmacen,
  carpetaGuiones,
  guionBorrar,
  guionGuardar,
  guionLeer,
  guionListar,
  proyectoCrear,
  proyectoGuardar,
  proyectoLeer,
  proyectoListar,
} from "../src/proyecto.js";
import { ID_GUION, ID_PROYECTO, guionEsquemaTool, proyectoGuardarTool, proyectoLeerTool, resultadoDeError } from "../src/herramientas-proyecto.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "video proyecto "));
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

let RAIZ = "";
let n = 0;
beforeEach(() => {
  RAIZ = path.join(BASE, `caso${++n}`, "proyectos");
  fs.mkdirSync(RAIZ, { recursive: true });
});
afterEach(() => vi.restoreAllMocks());

const clon = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const GUION: any = {
  version: 1,
  titulo: "La final de 1999",
  gancho: "Dos goles en tres minutos.",
  escenas: [
    { frases: ["Minuto noventa en Barcelona.", "Todo parecía decidido."], base: { tipo: "cartel", texto: "Minuto 90" } },
    { frases: ["Entonces llegó el empate."], base: { tipo: "cifra", valor: 1, prefijo: "", sufijo: " gol", decimales: 0 } },
  ],
  opciones: { fondo: "aurora", look: "normal", subtitulos: "karaoke", destellos: [0] },
};

const RECURSO = { id: "r-0123456789abcdef", clase: "foto", ext: "jpg", nombreOriginal: "estadio.jpg", ancho: 1080, alto: 1920, duracion: 0 };

function codigoDe(f: () => unknown): { codigo: string; problemas: { ruta: string; codigo: string }[] } {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorAlmacen);
    return { codigo: (e as ErrorAlmacen).codigo, problemas: (e as ErrorAlmacen).problemas };
  }
  throw new Error("se esperaba un ErrorAlmacen");
}

/** Proyecto creado desde un guion; devuelve su id y el documento en disco. */
function nuevoProyecto() {
  const { id: guionId } = guionGuardar(RAIZ, { guion: clon(GUION) });
  const { id } = proyectoCrear(RAIZ, { guionId, perfilId: "defecto" });
  return { id, guionId, ruta: path.join(RAIZ, id, "proyecto.json"), disco: () => JSON.parse(fs.readFileSync(path.join(RAIZ, id, "proyecto.json"), "utf8")) };
}

describe("rutas del proyecto", () => {
  it("el MP4 vive dentro de la carpeta del proyecto", () => {
    expect(archivosVideo(RAIZ, "video001").mp4).toBe(path.join(RAIZ, "video001", "video.mp4"));
  });

  it("los guiones cuelgan de dirname(VIDEO_ROOT)/video/guiones", () => {
    expect(carpetaGuiones(RAIZ)).toBe(path.join(path.dirname(RAIZ), "video", "guiones"));
  });
});

describe("guiones", () => {
  it("guarda, lista, lee y borra; el id es g- más 16 hexadecimales", () => {
    const { id, avisos } = guionGuardar(RAIZ, { guion: clon(GUION) });
    expect(id).toMatch(/^g-[0-9a-f]{16}$/);
    expect(Array.isArray(avisos)).toBe(true);
    expect(fs.existsSync(path.join(carpetaGuiones(RAIZ), `${id}.json`))).toBe(true);
    expect(guionListar(RAIZ).map((g) => g.id)).toEqual([id]);
    expect(guionLeer(RAIZ, id).guion.titulo).toBe(GUION.titulo);
    guionBorrar(RAIZ, id);
    expect(guionListar(RAIZ)).toEqual([]);
    expect(codigoDe(() => guionLeer(RAIZ, id)).codigo).toBe("no_encontrado");
    expect(codigoDe(() => guionBorrar(RAIZ, id)).codigo).toBe("no_encontrado");
  });

  it("con id sobrescribe el guion existente; con un id que no existe, no_encontrado", () => {
    const { id } = guionGuardar(RAIZ, { guion: clon(GUION) });
    const otro = clon(GUION);
    otro.titulo = "Otro título";
    expect(guionGuardar(RAIZ, { guion: otro, id }).id).toBe(id);
    expect(guionLeer(RAIZ, id).guion.titulo).toBe("Otro título");
    expect(codigoDe(() => guionGuardar(RAIZ, { guion: clon(GUION), id: "g-ffffffffffffffff" })).codigo).toBe("no_encontrado");
  });

  it("un guion que no cumple el esquema se rechaza con codigo esquema y no escribe nada", () => {
    const malo = clon(GUION);
    malo.escenas[0].base.texto = "ver http://x.example";
    const r = codigoDe(() => guionGuardar(RAIZ, { guion: malo }));
    expect(r.codigo).toBe("esquema");
    expect(r.problemas.length).toBeGreaterThan(0);
    expect(fs.existsSync(carpetaGuiones(RAIZ)) ? fs.readdirSync(carpetaGuiones(RAIZ)) : []).toEqual([]);
    expect(codigoDe(() => guionGuardar(RAIZ, { guion: "no es un objeto" as any })).codigo).toBe("esquema");
  });

  it("ids de guion no válidos", () => {
    for (const id of ["..\\x", "../x", "g-xyz", "g-0123456789ABCDEF", "CON", "video001", "g-0123456789abcdef/../x"]) {
      expect(codigoDe(() => guionLeer(RAIZ, id)), id).toMatchObject({ codigo: "esquema", problemas: [{ ruta: "id", codigo: "id_invalido" }] });
      expect(codigoDe(() => guionBorrar(RAIZ, id)).codigo, id).toBe("esquema");
      expect(codigoDe(() => guionGuardar(RAIZ, { guion: clon(GUION), id })).codigo, id).toBe("esquema");
    }
  });

  it("guion_en_disco_malo: se rechaza al cargar y el listado lo marca", () => {
    const { id } = guionGuardar(RAIZ, { guion: clon(GUION) });
    const ruta = path.join(carpetaGuiones(RAIZ), `${id}.json`);
    const doc = JSON.parse(fs.readFileSync(ruta, "utf8"));
    doc.opciones.fondo = "red;background:url(//x)";
    fs.writeFileSync(ruta, JSON.stringify(doc));
    expect(codigoDe(() => guionLeer(RAIZ, id)).codigo).toBe("esquema");
    expect(guionListar(RAIZ)).toEqual([{ id, valido: false }]);
    fs.writeFileSync(ruta, "{ no es json");
    expect(codigoDe(() => guionLeer(RAIZ, id)).codigo).toBe("esquema");
  });

  it("un guion que es un enlace simbólico o un hardlink se rechaza (I6)", () => {
    const { id } = guionGuardar(RAIZ, { guion: clon(GUION) });
    const ruta = path.join(carpetaGuiones(RAIZ), `${id}.json`);
    const ajeno = path.join(BASE, `ajeno${n}.json`);
    fs.copyFileSync(ruta, ajeno);
    fs.rmSync(ruta);
    try {
      fs.symlinkSync(ajeno, ruta);
    } catch {
      return; // sin privilegio para crear enlaces simbólicos
    }
    expect(codigoDe(() => guionLeer(RAIZ, id)).codigo).toBe("esquema");
    fs.unlinkSync(ruta);
    fs.linkSync(ajeno, ruta);
    expect(codigoDe(() => guionLeer(RAIZ, id)).codigo).toBe("esquema");
  });
});

describe("proyectos", () => {
  it("crear_copia_una_via: editar o borrar el guion después no toca el proyecto", () => {
    const { id, guionId, disco } = nuevoProyecto();
    const antes = disco();
    expect(antes).toMatchObject({ id, revision: 0, aspecto: "9:16", perfilId: "defecto", recursos: [] });
    expect(antes.frases.map((f: any) => f.texto)).toEqual(["Minuto noventa en Barcelona.", "Todo parecía decidido.", "Entonces llegó el empate."]);
    expect(antes.escenas.map((e: any) => e.fraseIds.length)).toEqual([2, 1]);
    expect(fs.statSync(path.join(RAIZ, id, "voz")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(RAIZ, id, "recursos")).isDirectory()).toBe(true);
    const editado = clon(GUION);
    editado.titulo = "Otro";
    editado.escenas.pop();
    guionGuardar(RAIZ, { guion: editado, id: guionId });
    guionBorrar(RAIZ, guionId);
    expect(disco()).toEqual(antes);
    expect(proyectoLeer(RAIZ, id).proyecto.titulo).toBe(GUION.titulo);
  });

  it("crear con guion inexistente o perfil no válido falla sin dejar carpeta", () => {
    expect(codigoDe(() => proyectoCrear(RAIZ, { guionId: "g-ffffffffffffffff", perfilId: "defecto" })).codigo).toBe("no_encontrado");
    const { id: guionId } = guionGuardar(RAIZ, { guion: clon(GUION) });
    expect(codigoDe(() => proyectoCrear(RAIZ, { guionId, perfilId: "../x" })).codigo).toBe("esquema");
    expect(fs.readdirSync(RAIZ)).toEqual([]);
  });

  it("id_invalido: ..\\x, video1, CON y rutas", () => {
    for (const id of ["..\\x", "../video001", "video1", "video0001", "CON", "", "video001/", "video001.mp4"]) {
      expect(codigoDe(() => proyectoLeer(RAIZ, id)), id).toMatchObject({ codigo: "esquema", problemas: [{ ruta: "id", codigo: "id_invalido" }] });
      expect(codigoDe(() => proyectoGuardar(RAIZ, { id, revision: 0, proyecto: {} })).codigo, id).toBe("esquema");
    }
    expect(codigoDe(() => proyectoLeer(RAIZ, "video099")).codigo).toBe("no_encontrado");
  });

  it("proyecto_en_disco_malo: color con inyección y fuente fuera de lista, rechazado al cargar", () => {
    const { id, ruta, disco } = nuevoProyecto();
    const base = disco();
    for (const tocar of [
      (d: any) => (d.escenas[0].base.color = "red;background:url(//x)"),
      (d: any) => (d.subtitulos.estilo = "Comic Sans MS; src: url(//x)"),
      (d: any) => (d.opciones.fondo = "url(//x)"),
      (d: any) => (d.escenas[0].base.texto = "ver http://x.example"),
      (d: any) => (d.recursos = [{ ...RECURSO, ext: "exe" }]),
    ]) {
      const d = clon(base);
      tocar(d);
      fs.writeFileSync(ruta, JSON.stringify(d));
      expect(codigoDe(() => proyectoLeer(RAIZ, id)).codigo).toBe("esquema");
      expect(codigoDe(() => proyectoGuardar(RAIZ, { id, revision: 0, proyecto: clon(base) })).codigo).toBe("esquema");
      expect(proyectoListar(RAIZ)).toEqual([{ id, valido: false }]);
    }
    fs.writeFileSync(ruta, "no es json");
    expect(codigoDe(() => proyectoLeer(RAIZ, id)).codigo).toBe("esquema");
  });

  it("guardar sube la revisión, conserva creado y devuelve avisos", () => {
    const { id, disco } = nuevoProyecto();
    const doc = disco();
    doc.titulo = "Título nuevo";
    doc.creado = "2001-01-01T00:00:00Z"; // el cliente no manda sobre creado
    const r = proyectoGuardar(RAIZ, { id, revision: 0, proyecto: doc });
    expect(r.revision).toBe(1);
    expect(Array.isArray(r.avisos)).toBe(true);
    const nuevo = disco();
    expect(nuevo.revision).toBe(1);
    expect(nuevo.titulo).toBe("Título nuevo");
    expect(nuevo.creado).not.toBe("2001-01-01T00:00:00Z");
    expect(proyectoGuardar(RAIZ, { id, revision: 1, proyecto: nuevo }).revision).toBe(2);
  });

  it("revision_antigua_409: una revisión anterior da codigo conflicto y no pisa nada", () => {
    const { id, disco } = nuevoProyecto();
    const a = disco();
    const b = disco();
    a.titulo = "Pestaña A";
    b.titulo = "Pestaña B";
    proyectoGuardar(RAIZ, { id, revision: 0, proyecto: a });
    const r = codigoDe(() => proyectoGuardar(RAIZ, { id, revision: 0, proyecto: b }));
    expect(r.codigo).toBe("conflicto");
    expect(r.problemas).toEqual([{ ruta: "revision", codigo: "revision_antigua" }]);
    expect(disco().titulo).toBe("Pestaña A");
    expect(codigoDe(() => proyectoGuardar(RAIZ, { id, revision: 5, proyecto: b })).codigo).toBe("conflicto");
    expect(codigoDe(() => proyectoGuardar(RAIZ, { id, revision: "1" as any, proyecto: b })).codigo).toBe("esquema");
  });

  it("guardar con otro id en el documento se rechaza", () => {
    const { id, disco } = nuevoProyecto();
    const d = disco();
    d.id = "video002";
    expect(codigoDe(() => proyectoGuardar(RAIZ, { id, revision: 0, proyecto: d })).problemas).toContainEqual({ ruta: "id", codigo: "id_distinto" });
  });

  it("recursos_del_cliente_rechazados: el cliente no añade, cambia ni quita recursos", () => {
    const { id, ruta, disco } = nuevoProyecto();
    // Un recurso que sí pasó por la importación está en disco.
    const d0 = disco();
    d0.recursos = [RECURSO];
    fs.writeFileSync(ruta, JSON.stringify(d0));

    const intentos: ((d: any) => void)[] = [
      (d) => d.recursos.push({ ...RECURSO, id: "r-aaaaaaaaaaaaaaaa", nombreOriginal: "otro.jpg" }),
      (d) => (d.recursos[0].nombreOriginal = "cambiado.jpg"),
      (d) => (d.recursos[0].ancho = 5),
      (d) => (d.recursos = []),
    ];
    for (const tocar of intentos) {
      const d = disco();
      tocar(d);
      expect(codigoDe(() => proyectoGuardar(RAIZ, { id, revision: 0, proyecto: d })).problemas).toContainEqual({ ruta: "recursos", codigo: "recursos_del_cliente" });
    }
    // Referenciar un recurso que no existe tampoco vale (lo ataja el esquema).
    const huerfano = disco();
    huerfano.escenas[0].capa = { recursoId: "r-bbbbbbbbbbbbbbbb", modo: "encima", encuadre: "marco", entrada: 0, salida: 1 };
    expect(codigoDe(() => proyectoGuardar(RAIZ, { id, revision: 0, proyecto: huerfano })).codigo).toBe("esquema");
    // Con los recursos tal cual y una capa sobre el recurso importado, guarda.
    const ok = disco();
    ok.escenas[0].capa = { recursoId: RECURSO.id, modo: "encima", encuadre: "marco", entrada: 0, salida: 1 };
    expect(proyectoGuardar(RAIZ, { id, revision: 0, proyecto: ok }).revision).toBe(1);
    expect(disco().recursos).toEqual([RECURSO]);
  });

  it("listar resume los proyectos y marca los que no son válidos", () => {
    const a = nuevoProyecto();
    fs.mkdirSync(path.join(RAIZ, "video050")); // formato anterior: sin proyecto.json
    expect(proyectoListar(RAIZ)).toEqual([
      { id: a.id, titulo: GUION.titulo, revision: 0, actualizado: a.disco().actualizado, escenas: 2 },
      { id: "video050", valido: false },
    ]);
  });
});

describe("escritura_atomica", () => {
  it("un fallo a mitad deja el fichero anterior intacto y sin temporales", () => {
    const { id, disco } = nuevoProyecto();
    const antes = fs.readFileSync(path.join(RAIZ, id, "proyecto.json"), "utf8");
    const d = disco();
    d.titulo = "Nunca llega";
    const real = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("disco lleno"), { code: "ENOSPC" });
    });
    expect(() => proyectoGuardar(RAIZ, { id, revision: 0, proyecto: d })).toThrow(/disco lleno/);
    vi.mocked(fs.renameSync).mockImplementation(real);
    expect(fs.readFileSync(path.join(RAIZ, id, "proyecto.json"), "utf8")).toBe(antes);
    expect(fs.readdirSync(path.join(RAIZ, id)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("también con los guiones", () => {
    const { id } = guionGuardar(RAIZ, { guion: clon(GUION) });
    const ruta = path.join(carpetaGuiones(RAIZ), `${id}.json`);
    const antes = fs.readFileSync(ruta, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("corte");
    });
    const otro = clon(GUION);
    otro.titulo = "Otro";
    expect(() => guionGuardar(RAIZ, { guion: otro, id })).toThrow(/corte/);
    vi.restoreAllMocks();
    expect(fs.readFileSync(ruta, "utf8")).toBe(antes);
    expect(fs.readdirSync(carpetaGuiones(RAIZ)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("enlaces en el proyecto (I6)", () => {
  it("un proyecto.json que es un enlace simbólico o un hardlink se rechaza", () => {
    const { id, ruta } = nuevoProyecto();
    const ajeno = path.join(BASE, `ajeno-proy${n}.json`);
    fs.copyFileSync(ruta, ajeno);
    fs.rmSync(ruta);
    try {
      fs.symlinkSync(ajeno, ruta);
    } catch {
      return; // sin privilegio para crear enlaces simbólicos
    }
    expect(codigoDe(() => proyectoLeer(RAIZ, id)).codigo).toBe("esquema");
    fs.unlinkSync(ruta);
    fs.linkSync(ajeno, ruta);
    expect(codigoDe(() => proyectoLeer(RAIZ, id)).codigo).toBe("esquema");
    expect(proyectoListar(RAIZ)).toEqual([{ id, valido: false }]);
  });
});

describe.runIf(process.platform === "win32")("junctions (I6)", () => {
  const junction = (enlace: string, destino: string) => execFileSync("cmd.exe", ["/d", "/c", "mklink", "/J", enlace, destino], { windowsVerbatimArguments: true });

  it("la carpeta del proyecto no puede ser una junction a un proyecto de fuera", () => {
    const { id, disco } = nuevoProyecto();
    const fuera = path.join(BASE, `fuera${n}`);
    fs.cpSync(path.join(RAIZ, id), fuera, { recursive: true });
    fs.rmSync(path.join(RAIZ, id), { recursive: true });
    junction(path.join(RAIZ, id), fuera);
    expect(codigoDe(() => proyectoLeer(RAIZ, id)).codigo).toBe("esquema");
    expect(proyectoListar(RAIZ).find((p) => p.id === id)).toBeUndefined();
    const d = JSON.parse(fs.readFileSync(path.join(fuera, "proyecto.json"), "utf8"));
    d.titulo = "Escrito a través de la junction";
    expect(() => proyectoGuardar(RAIZ, { id, revision: 0, proyecto: d })).toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(fuera, "proyecto.json"), "utf8")).titulo).toBe(GUION.titulo);
    void disco;
  });

  it("la carpeta de guiones no puede ser una junction", () => {
    const fuera = path.join(BASE, `fuera-guiones${n}`);
    fs.mkdirSync(fuera, { recursive: true });
    fs.mkdirSync(path.dirname(carpetaGuiones(RAIZ)), { recursive: true });
    junction(carpetaGuiones(RAIZ), fuera);
    expect(() => guionGuardar(RAIZ, { guion: clon(GUION) })).toThrow();
    expect(fs.readdirSync(fuera)).toEqual([]);
  });
});

describe("cierre de la revisión de seguridad de T4", () => {
  const symlinkOk = (destino: string, enlace: string): boolean => {
    try {
      fs.symlinkSync(destino, enlace, "dir");
      return true;
    } catch {
      return false; // sin privilegio para crear enlaces simbólicos
    }
  };

  it("M1: escribirAtomico hace fsync del temporal antes del rename", () => {
    const ruta = path.join(RAIZ, "dato.json");
    const orden: string[] = [];
    const fsync = fs.fsyncSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      orden.push("fsync");
      return fsync(fd);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      orden.push("rename");
      return rename(a, b);
    });
    escribirAtomico(ruta, "{}");
    expect(orden.indexOf("fsync")).toBeGreaterThanOrEqual(0);
    expect(orden.indexOf("fsync")).toBeLessThan(orden.indexOf("rename"));
    expect(fs.readFileSync(ruta, "utf8")).toBe("{}");
  });

  it("M1: si falla el fsync no se publica nada y el temporal se borra", () => {
    const ruta = path.join(RAIZ, "dato.json");
    fs.writeFileSync(ruta, "antes");
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    expect(() => escribirAtomico(ruta, "despues")).toThrow(/EIO/);
    vi.restoreAllMocks();
    expect(fs.readFileSync(ruta, "utf8")).toBe("antes");
    expect(fs.readdirSync(RAIZ).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("L8: el rename se reintenta ante un bloqueo breve (EBUSY)", () => {
    const ruta = path.join(RAIZ, "dato.json");
    const rename = fs.renameSync;
    let fallos = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      if (fallos++ < 2) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return rename(a, b);
    });
    escribirAtomico(ruta, "{}");
    expect(fs.readFileSync(ruta, "utf8")).toBe("{}");
    expect(fallos).toBe(3);
  });

  it("M2: la limpieza de proyecto_crear no usa rmSync recursivo y no toca el destino de un enlace", () => {
    const { id: guionId } = guionGuardar(RAIZ, { guion: clon(GUION) });
    const centinela = path.join(BASE, `centinela${n}`);
    fs.mkdirSync(centinela);
    fs.writeFileSync(path.join(centinela, "intacto.txt"), "x");
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, o?: any) => {
      if (String(p).endsWith(`${path.sep}recursos`)) {
        // Un proceso ajeno se adelanta y deja un enlace donde iba la carpeta.
        if (!symlinkOk(centinela, String(p))) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
      return mkdir(p, o);
    }) as typeof fs.mkdirSync);
    const rmSync = vi.spyOn(fs, "rmSync");
    expect(() => proyectoCrear(RAIZ, { guionId, perfilId: "defecto" })).toThrow();
    expect(rmSync.mock.calls.filter(([, o]) => (o as { recursive?: boolean } | undefined)?.recursive)).toEqual([]);
    expect(fs.readFileSync(path.join(centinela, "intacto.txt"), "utf8")).toBe("x");
    expect(fs.readdirSync(RAIZ)).toEqual([]);
  });

  it("M3: leerJson abre una vez y lee del descriptor, sin readFileSync ni statSync por ruta", () => {
    const { id } = nuevoProyecto();
    const lee = vi.spyOn(fs, "readFileSync");
    const stat = vi.spyOn(fs, "statSync");
    expect(proyectoLeer(RAIZ, id).proyecto.id).toBe(id);
    const sobreProyecto = (c: unknown[]) => String(c[0]).endsWith("proyecto.json");
    expect(lee.mock.calls.filter(sobreProyecto)).toEqual([]);
    expect(stat.mock.calls.filter(sobreProyecto)).toEqual([]);
  });

  it("M3: un fichero que crece mientras se lee no se cuela (tope MAX+1 sobre el descriptor)", () => {
    const { id, ruta } = nuevoProyecto();
    const relleno = Buffer.alloc(3 * 1024 * 1024, " ");
    fs.appendFileSync(ruta, relleno);
    const fstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, o?: any) => {
      const st = fstat(fd, o) as any;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: typeof st.size === "bigint" ? 10n : 10 });
    }) as typeof fs.fstatSync);
    expect(codigoDe(() => proyectoLeer(RAIZ, id)).problemas).toEqual([{ ruta: "", codigo: "demasiado_grande" }]);
  });

  it("L1: los errores del almacén no llevan rutas absolutas", () => {
    const { id } = nuevoProyecto();
    const fuera = path.join(BASE, `fuera-l1-${n}`);
    fs.mkdirSync(fuera);
    fs.renameSync(path.join(RAIZ, id), path.join(fuera, id));
    if (!symlinkOk(path.join(fuera, id), path.join(RAIZ, id))) return;
    try {
      proyectoLeer(RAIZ, id);
      throw new Error("se esperaba un error");
    } catch (e) {
      expect((e as Error).message).not.toContain(BASE);
    }
  });

  it("L1: un error crudo de fs sale sin ruta y con su código", () => {
    const e = Object.assign(new Error(`ENOSPC: no space left, rename '${BASE}/a' -> '${BASE}/b'`), { code: "ENOSPC", path: `${BASE}/a` });
    const r = resultadoDeError("video_proyecto_guardar", e);
    const texto = (r.content[0] as { text: string }).text;
    expect(texto).toContain("ENOSPC");
    expect(texto).not.toContain(BASE);
    expect(r.content).toHaveLength(1);
  });

  it("L1: una colisión de id al crear es un conflicto tipado, sin EEXIST crudo", () => {
    const { id: guionId } = guionGuardar(RAIZ, { guion: clon(GUION) });
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, o?: any) => {
      if (String(p).endsWith(`${path.sep}video001`)) throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${p}'`), { code: "EEXIST" });
      return mkdir(p, o);
    }) as typeof fs.mkdirSync);
    const r = codigoDe(() => proyectoCrear(RAIZ, { guionId, perfilId: "defecto" }));
    expect(r.codigo).toBe("conflicto");
  });

  it("L4: un id enorme no se repite entero en el mensaje y las tools lo limitan a 40", () => {
    const largo = "x".repeat(100000);
    for (const f of [() => proyectoLeer(RAIZ, largo), () => guionLeer(RAIZ, largo)]) {
      try {
        f();
        throw new Error("se esperaba un error");
      } catch (e) {
        expect((e as Error).message.length).toBeLessThan(300);
      }
    }
    for (const z of [ID_GUION, ID_PROYECTO]) {
      expect(z.safeParse("x".repeat(40)).success).toBe(true);
      expect(z.safeParse("x".repeat(41)).success).toBe(false);
    }
  });
});

describe.runIf(process.platform === "win32")("cierre T4 en Windows (junctions)", () => {
  const junction = (enlace: string, destino: string) => execFileSync("cmd.exe", ["/d", "/c", "mklink", "/J", enlace, destino], { windowsVerbatimArguments: true });

  it("M2: si falla la creación, la limpieza no entra en una junction y deja intacta la centinela", () => {
    const { id: guionId } = guionGuardar(RAIZ, { guion: clon(GUION) });
    const centinela = path.join(BASE, `centinela-j${n}`);
    fs.mkdirSync(centinela);
    fs.writeFileSync(path.join(centinela, "intacto.txt"), "x");
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, o?: any) => {
      if (String(p).endsWith(`${path.sep}recursos`)) {
        junction(String(p), centinela);
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
      return mkdir(p, o);
    }) as typeof fs.mkdirSync);
    expect(() => proyectoCrear(RAIZ, { guionId, perfilId: "defecto" })).toThrow();
    expect(fs.readFileSync(path.join(centinela, "intacto.txt"), "utf8")).toBe("x");
    expect(fs.readdirSync(RAIZ)).toEqual([]);
  });
});

describe("herramientas", () => {
  const cfg = () => ({ videoRoot: RAIZ }) as Config;

  it("video_guion_esquema devuelve el texto del esquema", () => {
    expect(guionEsquemaTool().datos).toEqual({ texto: descripcionEsquema() });
  });

  it("los errores tipados salen como isError con un bloque JSON { codigo, problemas }", () => {
    let error: unknown;
    try {
      proyectoLeerTool(cfg(), { id: "video1" });
    } catch (e) {
      error = e;
    }
    const r = resultadoDeError("video_proyecto_leer", error);
    expect(r.isError).toBe(true);
    const bloque = JSON.parse((r.content.at(-1) as { text: string }).text);
    expect(bloque).toEqual({ codigo: "esquema", problemas: [{ ruta: "id", codigo: "id_invalido" }] });
  });

  it("proyecto_guardar y proyecto_leer devuelven revisión y avisos", () => {
    const { id, disco } = nuevoProyecto();
    const r = proyectoGuardarTool(cfg(), { id, revision: 0, proyecto: disco() });
    expect(r.datos).toMatchObject({ revision: 1, avisos: expect.any(Array) });
    expect(proyectoLeerTool(cfg(), { id }).datos).toMatchObject({ proyecto: { id, revision: 1 }, avisos: expect.any(Array) });
  });

  it("un error que no es del almacén no se disfraza de tipado", () => {
    const r = resultadoDeError("x", new Error("boom"));
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
  });
});
