import { describe, expect, it } from "vitest";
import { ErrorGuion, parsearGuion } from "../src/guion.js";
import { bloquesConFoto, EJEMPLO, fondoUsaWebgpu, parsearFecha, resumenCampos, textoAyuda } from "../src/formato.js";

const CUERPO = `
[1] Wembley, 1995. England against Colombia.
[2] Jamie Redknapp floats a lazy shot towards goal.
[3] Any keeper just catches it. Any keeper.
[4] René Higuita doesn't.
[5] He dives forward and kicks it away with his heels.
[6] The scorpion kick was born.
`;

function guion(fm: string): string {
  return `---\ntitulo: T\ngancho: He saved it.\n${fm}\n---\n${CUERPO}`;
}

function problemas(fm: string): string {
  try {
    parsearGuion(guion(fm));
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorGuion);
    return (e as ErrorGuion).problemas.join("\n");
  }
  throw new Error("se esperaba un error");
}

describe("formato v2", () => {
  it("un guion v1 sigue siendo válido y sale con los valores por defecto", () => {
    const g = parsearGuion(guion("musica: _musica/a.mp3"));
    expect(g.musica).toBe("_musica/a.mp3");
    expect(g.opciones).toMatchObject({ look: "normal", subtitulos: "karaoke", fondo: "ninguno", destellos: [1], escenas: {}, cortesAlRitmo: false });
    expect(g.avisos).toEqual([]);
  });

  it("el ejemplo de la ayuda es válido", () => {
    const g = parsearGuion(EJEMPLO);
    expect(g.opciones.golpe?.palabra).toBe("kicks");
    expect(g.opciones.escenas[3]).toMatchObject({ tipo: "mapa", destacar: ["United Kingdom", "Colombia"] });
    expect(textoAyuda()).toContain("### barras");
    expect(resumenCampos()).toContain("cortes_al_ritmo");
  });

  it("golpe: palabra inexistente lista las palabras del bloque más parecido", () => {
    const p = problemas("golpe: kickz");
    expect(p).toMatch(/`golpe: kickz` no aparece/);
    expect(p).toMatch(/Palabras del bloque \[5\]: he, dives, forward, and, kicks/);
  });

  it("golpe: admite #N y exige esas apariciones", () => {
    const g = parsearGuion(guion("golpe: keeper#2"));
    expect(g.opciones.golpe?.indice).toBeGreaterThan(0);
    expect(problemas("golpe: keeper#3")).toMatch(/aparición 3.*sale 2/);
  });

  it("golpe sin mayúsculas ni puntuación y destellos por defecto con su bloque", () => {
    const g = parsearGuion(guion("golpe: HEELS"));
    expect(g.opciones.golpe?.palabra).toBe("heels");
    expect(g.opciones.destellos).toEqual([1, 5]);
  });

  it("enfasis: cada palabra tiene que existir; marca todas sus apariciones", () => {
    expect(problemas("enfasis: [scorpion, escorpion]")).toMatch(/"escorpion" no aparece[\s\S]*Palabras del bloque \[6\]/);
    const g = parsearGuion(guion("enfasis: [keeper]"));
    expect(g.opciones.enfasis).toHaveLength(2);
  });

  it("destellos, look, subtitulos y fondo inválidos", () => {
    expect(problemas("destellos: [0, 7]")).toMatch(/"0" no es un bloque válido[\s\S]*"7"/);
    expect(problemas("look: vhs")).toMatch(/`look: vhs` no es válido. Valores posibles: normal, videocamara, pelicula/);
    expect(problemas("subtitulos: comic")).toMatch(/karaoke, pildora, neon, impacto/);
    expect(problemas("fondo: estrellas")).toMatch(/ninguno, aurora, plasma, nebula, gradiente, mesh/);
  });

  it("look videocamara exige fecha con formato AAAA-MM-DD HH:MM", () => {
    expect(problemas("look: videocamara")).toMatch(/necesita `fecha`/);
    expect(problemas("look: videocamara\nfecha: 6/9/1995")).toMatch(/AAAA-MM-DD HH:MM/);
    const g = parsearGuion(guion("look: videocamara\nfecha: 1995-09-06 20:15"));
    expect(g.opciones.fecha).toEqual({ iso: "1995-09-06 20:15", dia: "SEP 06 1995", hora: "08:15 PM" });
    expect(parsearFecha("2001-01-01 00:05")?.hora).toBe("12:05 AM");
  });

  it("videocamara con escena 3D en el bloque 1 avisa en vez de fallar", () => {
    const g = parsearGuion(guion("look: videocamara\nfecha: 1995-09-06 20:15\nescenas:\n  1:\n    tipo: titulo3d\n    texto: WEMBLEY"));
    expect(g.avisos.join(" ")).toMatch(/bloque 1 es una escena 3D/);
  });

  it("música: musica_desde y musica_volumen", () => {
    expect(problemas("musica: _musica/a.mp3\nmusica_desde: -2")).toMatch(/musica_desde.*≥ 0/);
    expect(problemas("musica: _musica/a.mp3\nmusica_volumen: 1.5")).toMatch(/entre 0 y 1/);
    const g = parsearGuion(guion("musica: _musica/a.mp3\nmusica_desde: 12.5\nmusica_volumen: 0.2\ncortes_al_ritmo: true"));
    expect(g.opciones).toMatchObject({ musicaDesde: 12.5, musicaVolumen: 0.2, cortesAlRitmo: true });
  });

  it("un campo desconocido da aviso con la lista de campos válidos", () => {
    const g = parsearGuion(guion("color: rojo"));
    expect(g.avisos[0]).toMatch(/desconocidos.*color.*Campos válidos: titulo, gancho/);
  });

  it("escenas: clave y tipo inválidos", () => {
    expect(problemas("escenas:\n  7:\n    tipo: cifra\n    valor: 1")).toMatch(/clave "7" no es un bloque válido/);
    expect(problemas("escenas:\n  2:\n    tipo: video")).toMatch(/`tipo: video` no es válido. Tipos: mapa, barras, cifra, titulo3d, tunel, cartel/);
  });

  it("barras: periodos, series y una cifra por periodo", () => {
    const base = "escenas:\n  4:\n    tipo: barras\n    titulo: Copas\n    periodos: [1960, 1980, 2000]\n    series:\n";
    expect(problemas(base + "      Madrid: [5, 6, 8]\n      Milan: [0, 2]")).toMatch(/"Milan" tiene 2 cifras y hay 3 periodos/);
    expect(problemas(base + "      Madrid: [5, 6, 8]")).toMatch(/hay 1 series; tienen que ser de 2 a 6/);
    expect(problemas("escenas:\n  4:\n    tipo: barras\n    titulo: X\n    periodos: [1]\n    series:\n      A: [1]\n      B: [2]")).toMatch(/periodos` tiene 1; tienen que ser de 2 a 8/);
    const g = parsearGuion(guion(base + "      Madrid: [5, 6, 8]\n      Milan: [0, 2, 5]"));
    expect(g.opciones.escenas[4]).toMatchObject({ tipo: "barras", series: [{ nombre: "Madrid", valores: [5, 6, 8] }, { nombre: "Milan" }] });
  });

  it("mapa: nombres del atlas con alias y 10 parecidos si no existe", () => {
    const p = problemas("escenas:\n  3:\n    tipo: mapa\n    region: espana\n    destacar: [Andalusia]");
    expect(p).toMatch(/"Andalusia" no está en el atlas de espana. Los más parecidos: Andalucía/);
    expect(p.split("parecidos:")[1].split(",").length).toBe(10);
    const g = parsearGuion(guion("escenas:\n  3:\n    tipo: mapa\n    region: españa\n    destacar: [Madrid, Cataluña, pais vasco]"));
    expect(g.opciones.escenas[3]).toMatchObject({ region: "espana", destacar: ["Comunidad de Madrid", "Cataluña/Catalunya", "País Vasco/Euskadi"] });
    const e = parsearGuion(guion("escenas:\n  3:\n    tipo: mapa\n    region: europa\n    destacar: [Inglaterra, Alemania]"));
    expect(e.avisos.join(" ")).toMatch(/Reino Unido entero/);
    expect(problemas("escenas:\n  3:\n    tipo: mapa\n    region: europa\n    destacar: [Colombia]")).toMatch(/no está en el atlas de europa/);
    expect(problemas("escenas:\n  3:\n    tipo: mapa\n    region: luna")).toMatch(/region` tiene que ser espana, europa, mundo/);
  });

  it("cifra, titulo3d y cartel", () => {
    expect(problemas("escenas:\n  6:\n    tipo: cifra\n    sufijo: Copas")).toMatch(/necesita `valor` numérico/);
    expect(problemas("escenas:\n  5:\n    tipo: titulo3d\n    texto: SCORPIONKICKS")).toMatch(/`texto` tiene 13 caracteres; el máximo es 12/);
    expect(problemas("escenas:\n  5:\n    tipo: titulo3d\n    texto: RENÉ")).toMatch(/sin acentos.*É/);
    expect(problemas("escenas:\n  6:\n    tipo: cartel")).toMatch(/necesita `texto`/);
    expect(problemas("escenas:\n  6:\n    tipo: cartel\n    texto: " + "x".repeat(41))).toMatch(/41 caracteres; el máximo es 40/);
    const g = parsearGuion(guion("escenas:\n  6:\n    tipo: cifra\n    valor: 15\n    sufijo: ' Copas'"));
    expect(g.opciones.escenas[6]).toMatchObject({ valor: 15, sufijo: " Copas", decimales: 0 });
  });

  it("imágenes requeridas = bloques sin escena; fondo WebGPU solo si se usa", () => {
    const g = parsearGuion(guion("fondo: aurora\nescenas:\n  3:\n    tipo: cifra\n    valor: 3\n  5:\n    tipo: tunel"));
    expect(bloquesConFoto(g.opciones.escenas)).toEqual([1, 2, 4, 6]);
    expect(fondoUsaWebgpu(g.opciones)).toBe(true);
    const sinEscena = parsearGuion(guion("fondo: plasma"));
    expect(fondoUsaWebgpu(sinEscena.opciones)).toBe(false);
    expect(sinEscena.avisos.join(" ")).toMatch(/solo se ve en escenas/);
  });
});
