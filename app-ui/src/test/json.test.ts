import { describe, expect, it } from "vitest";
import { extraerJson } from "../json";

const esObjeto = (j: unknown): j is { a: number } =>
  typeof j === "object" && j !== null && typeof (j as { a?: unknown }).a === "number";

describe("extraerJson", () => {
  it("extrae el JSON aunque venga rodeado de texto o en un bloque de código", () => {
    expect(extraerJson('Aquí va:\n```json\n{"a": 1}\n```\nListo.', esObjeto)).toEqual({ a: 1 });
  });

  it("null si no hay JSON", () => {
    expect(extraerJson("sin llaves", esObjeto)).toBeNull();
  });

  it("null si el JSON está roto", () => {
    expect(extraerJson('{"a": 1', esObjeto)).toBeNull();
  });

  it("null si no pasa la validación", () => {
    expect(extraerJson('{"a": "uno"}', esObjeto)).toBeNull();
  });
});
