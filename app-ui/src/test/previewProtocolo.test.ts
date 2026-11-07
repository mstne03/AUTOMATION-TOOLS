import { describe, expect, it } from "vitest";
import { LimitadorMensajes, validarMensajeIframe } from "../video/previewProtocolo";

const ventana = {} as Window;
const otra = {} as Window;

function evento(data: unknown, o: { origin?: string; source?: Window | null } = {}): MessageEvent {
  return {
    data,
    origin: o.origin ?? "null",
    source: o.source === undefined ? ventana : o.source,
  } as unknown as MessageEvent;
}
const val = (e: MessageEvent, pend: number[] = [], dur = 30) =>
  validarMensajeIframe(e, ventana, new Set(pend), dur);

describe("validarMensajeIframe", () => {
  it("acepta los cuatro tipos bien formados", () => {
    expect(val(evento({ tipo: "listo", duracion: 12.5 }))).toEqual({ tipo: "listo", duracion: 12.5 });
    expect(val(evento({ tipo: "seek-hecho", id: 3, t: 4 }), [3])).toEqual({ tipo: "seek-hecho", id: 3, t: 4 });
    expect(val(evento({ tipo: "tiempo", t: 0, reproduciendo: true }))).toEqual({ tipo: "tiempo", t: 0, reproduciendo: true });
    expect(val(evento({ tipo: "error", id: 3 }), [3])).toEqual({ tipo: "error", id: 3 });
  });
  it("source_ajeno", () => {
    expect(val(evento({ tipo: "tiempo", t: 1, reproduciendo: false }, { source: otra }))).toBeNull();
    expect(val(evento({ tipo: "tiempo", t: 1, reproduciendo: false }, { source: null }))).toBeNull();
  });
  it("origen_no_null", () => {
    for (const origin of ["http://127.0.0.1:47810", "https://evil.example", "", "tauri://localhost"])
      expect(val(evento({ tipo: "tiempo", t: 1, reproduciendo: false }, { origin }))).toBeNull();
  });
  it("tipo_desconocido", () => {
    for (const tipo of ["navegar", "eval", "", 7, null, "TIEMPO", "__proto__"])
      expect(val(evento({ tipo, t: 1, reproduciendo: false }))).toBeNull();
    expect(val(evento("tiempo"))).toBeNull();
    expect(val(evento(null))).toBeNull();
    expect(val(evento([1, 2]))).toBeNull();
  });
  it("id_sin_pendiente", () => {
    expect(val(evento({ tipo: "seek-hecho", id: 9, t: 1 }), [3])).toBeNull();
    expect(val(evento({ tipo: "error", id: 9 }), [3])).toBeNull();
    expect(val(evento({ tipo: "seek-hecho", id: 1.5, t: 1 }), [1.5])).toBeNull();
    expect(val(evento({ tipo: "seek-hecho", id: "3", t: 1 }), [3])).toBeNull();
  });
  it("t_nan, infinito y no numérico", () => {
    for (const t of [NaN, Infinity, -Infinity, "1", null, undefined])
      expect(val(evento({ tipo: "tiempo", t, reproduciendo: false }))).toBeNull();
    expect(val(evento({ tipo: "listo", duracion: NaN }))).toBeNull();
  });
  it("t_fuera_de_rango", () => {
    expect(val(evento({ tipo: "tiempo", t: -0.5, reproduciendo: false }))).toBeNull();
    expect(val(evento({ tipo: "tiempo", t: 31, reproduciendo: false }), [], 30)).toBeNull();
    expect(val(evento({ tipo: "seek-hecho", id: 1, t: 99 }), [1], 30)).toBeNull();
    expect(val(evento({ tipo: "tiempo", t: 30, reproduciendo: false }), [], 30)).not.toBeNull();
    expect(val(evento({ tipo: "listo", duracion: -1 }))).toBeNull();
    expect(val(evento({ tipo: "listo", duracion: 1e9 }))).toBeNull();
  });
  it("objeto_con_html: claves de más o valores no esperados se descartan", () => {
    expect(val(evento({ tipo: "tiempo", t: 1, reproduciendo: false, html: "<img src=x onerror=alert(1)>" }))).toBeNull();
    expect(val(evento({ tipo: "tiempo", t: 1, reproduciendo: "<b>si</b>" }))).toBeNull();
    expect(val(evento({ tipo: "error", id: 1, mensaje: "<script>" }), [1])).toBeNull();
    expect(val(evento({ tipo: { toString: () => "tiempo" }, t: 1, reproduciendo: false }))).toBeNull();
  });
  it("no devuelve el objeto original", () => {
    const d = { tipo: "tiempo", t: 1, reproduciendo: false };
    expect(val(evento(d))).not.toBe(d);
  });
  it("no muta los pendientes", () => {
    const p = new Set([3]);
    validarMensajeIframe(evento({ tipo: "seek-hecho", id: 3, t: 1 }), ventana, p, 30);
    expect([...p]).toEqual([3]);
  });
});

describe("LimitadorMensajes", () => {
  it("inundacion: más de 120 mensajes por segundo se ignoran", () => {
    const l = new LimitadorMensajes(120, 1000);
    let ok = 0;
    for (let i = 0; i < 500; i++) if (l.admitir(1000 + i / 10)) ok++;
    expect(ok).toBe(120);
    expect(l.ignorados).toBe(380);
  });
  it("la ventana se renueva", () => {
    const l = new LimitadorMensajes(120, 1000);
    for (let i = 0; i < 200; i++) l.admitir(0);
    expect(l.admitir(1001)).toBe(true);
  });
});
