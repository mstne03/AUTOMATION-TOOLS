import { describe, expect, it } from "vitest";
import { formatearNumero, haceCuanto, reinicioCuota } from "../formato";

describe("formato", () => {
  it("separador de miles también en cuatro cifras", () => {
    expect([0, 154, 1000, 10000, 1234567].map(formatearNumero)).toEqual(["0", "154", "1.000", "10.000", "1.234.567"]);
  });

  it("la cuota se reinicia a la medianoche del Pacífico (PDT en octubre = UTC-7)", () => {
    // 2026-10-23 20:00 UTC = 13:00 PDT → faltan 11 h → 07:00 UTC del día 24
    expect(reinicioCuota(new Date("2026-10-23T20:00:00Z")).toISOString()).toBe("2026-10-24T07:00:00.000Z");
    // en invierno (PST, UTC-8) la medianoche pacífica son las 08:00 UTC
    expect(reinicioCuota(new Date("2026-12-10T20:00:00Z")).toISOString()).toBe("2026-12-11T08:00:00.000Z");
  });

  it("haceCuanto", () => {
    const ahora = new Date("2026-10-23T12:00:00Z");
    expect(haceCuanto("2026-10-23T11:59:50Z", ahora)).toBe("hace unos segundos");
    expect(haceCuanto("2026-10-23T11:58:00Z", ahora)).toBe("hace 2 min");
    expect(haceCuanto("2026-10-23T09:00:00Z", ahora)).toBe("hace 3 h");
  });
});
