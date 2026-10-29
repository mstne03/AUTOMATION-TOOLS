// I2 (a) en ejecución: una pieza hostil (fetch, WebSocket, imágenes, WebRTC, navegación del iframe, dns-prefetch,
// preconnect y speculationrules hacia sumideros locales) no llega a la red ni en la preview (iframe sandbox con la
// cabecera CSP) ni en el render real de HyperFrames, solo por la CSP. Cada sonda lleva su control positivo (la misma
// pieza sin CSP SÍ conecta): si el control no conecta, la sonda no mide nada y el test lo dice.
// Lo que la CSP no para se marca con it.fails y nombra al paquete dueño; nunca se borra la sonda.
// Necesita los binarios del motor: VIDEO_ENGINE_DIR=<…/binaries/video-engine> (variable solo de tests).
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { montar } from "../scripts/montar.mjs";
import { sondearPreview } from "../scripts/sondear-preview.mjs";
import { renderizar } from "../scripts/comparar-fotogramas.mjs";

const motor = process.env.VIDEO_ENGINE_DIR;
if (!motor) console.warn("I2 (a) NO verificada en ejecución: csp-integracion.test.ts se salta porque falta VIDEO_ENGINE_DIR (carpeta video-engine con Chrome y ffmpeg).");

type Canal = "red" | "especulacion" | "preconexion" | "navegacion" | "rtc";
type Cuenta = Record<Canal, number>;
type Violacion = { directiva: string; bloqueada: string; origen: string };

describe.skipIf(!motor)("CSP en ejecución: pieza hostil en preview y render (I2 a)", () => {
  const cuentas: Cuenta = { red: 0, especulacion: 0, preconexion: 0, navegacion: 0, rtc: 0 };
  const servidores: (net.Server | dgram.Socket)[] = [];
  const puertos = {} as Record<Canal, number>;
  const r = {} as Record<string, { cuenta: Cuenta; hostil?: boolean; violaciones?: Violacion[]; marcaRoja?: boolean }>;
  let tmp: string;

  async function sumideroTcp(canal: Canal) {
    const s = net.createServer((c) => {
      cuentas[canal]++;
      c.destroy();
    });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    servidores.push(s);
    puertos[canal] = (s.address() as net.AddressInfo).port;
  }

  /** Ejecuta `fn` con los contadores a cero y devuelve lo que llegó a cada sumidero. */
  async function medir<T>(fn: () => Promise<T>): Promise<{ cuenta: Cuenta; valor: T }> {
    for (const k of Object.keys(cuentas) as Canal[]) cuentas[k] = 0;
    const valor = await fn();
    await new Promise((ok) => setTimeout(ok, 1000));
    return { cuenta: { ...cuentas }, valor };
  }

  /** ¿Pintó hostil.js su marca roja (200×200 arriba a la izquierda) en el render? Prueba que se ejecutó. */
  async function marcaRoja(mp4: string): Promise<boolean> {
    const { ejecutar } = await import("../src/proceso.js");
    const rgb = `${mp4}.rgb`;
    await ejecutar(path.join(motor!, "ffmpeg", "ffmpeg.exe"), ["-y", "-v", "error", "-ss", "0.5", "-i", mp4, "-frames:v", "1", "-vf", "crop=100:100:50:50,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", rgb], {
      timeoutMs: 60_000,
    });
    const [rr, g, b] = fs.existsSync(rgb) ? [...fs.readFileSync(rgb)] : [0, 0, 0];
    return rr > 200 && g < 60 && b < 60;
  }

  beforeAll(async () => {
    for (const c of ["red", "especulacion", "preconexion", "navegacion"] as const) await sumideroTcp(c);
    const udp = dgram.createSocket("udp4");
    udp.on("message", () => cuentas.rtc++);
    await new Promise<void>((ok) => udp.bind(0, "127.0.0.1", ok));
    servidores.push(udp);
    puertos.rtc = udp.address().port;

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csp-integracion-"));
    const { dir } = await montar(motor!, path.join(tmp, "montaje"), "GUION_FOTOS", { duracionVoz: 6, gpu: false });
    // La marca va antes de nada; la URL de cada canal lleva esquema explícito (H1).
    const hostil = `document.documentElement.dataset.hostil = "1"; window.__hostil = true;
var m = document.createElement("div"); m.style.cssText = "position:fixed;left:0;top:0;width:200px;height:200px;background:#ff0000;z-index:2147483647"; document.documentElement.appendChild(m);
fetch("http://127.0.0.1:${puertos.red}/f").catch(function () {});
fetch("http://203.0.113.1/").catch(function () {});
try { new WebSocket("ws://127.0.0.1:${puertos.red}/w"); } catch (e) {}
var i = new Image(); i.src = "http://127.0.0.1:${puertos.red}/i.png"; document.documentElement.appendChild(i);
try { var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${puertos.rtc}" }] }); pc.createDataChannel("x"); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }); window.__pc = pc; } catch (e) {}
`;
    fs.writeFileSync(path.join(dir, "assets", "hostil.js"), hostil);
    const cabeza = `<link rel="dns-prefetch" href="http://localhost:${puertos.especulacion}/" />
    <link rel="preconnect" href="http://localhost:${puertos.preconexion}/" />
    <script type="speculationrules">{"prefetch":[{"source":"list","urls":["http://localhost:${puertos.especulacion}/s"]}],"prerender":[{"source":"list","urls":["http://localhost:${puertos.especulacion}/p"]}]}</script>
  </head>`;
    const cuerpo = `<img src="http://ejemplo.test/x.png" /><script src="assets/hostil.js"></script>\n  </body>`;
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8").replace("</head>", cabeza).replace("</body>", cuerpo);
    fs.writeFileSync(path.join(dir, "index.html"), html);
    // Control positivo del render: la misma composición sin el <meta> de la CSP.
    const sin = path.join(tmp, "sin-csp");
    fs.cpSync(dir, sin, { recursive: true });
    fs.writeFileSync(path.join(sin, "index.html"), html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""));

    const navegador = path.join(motor!, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    const sonda = "new Promise((ok) => setTimeout(() => ok({ hostil: window.__hostil === true }), 3000))";
    for (const [nombre, sinCsp] of [["preview", false], ["preview-sin-csp", true]] as const) {
      const m = await medir(() => sondearPreview({ navegador, dir, sonda, sinCsp }));
      r[nombre] = { cuenta: m.cuenta, hostil: m.valor.resultado.hostil, violaciones: m.valor.violaciones };
    }
    const navega = `(location.href = "http://localhost:${puertos.navegacion}/n", new Promise((ok) => setTimeout(() => ok(true), 1500)))`;
    for (const [nombre, marcoSinCsp] of [["navegacion", false], ["navegacion-sin-csp", true]] as const) {
      const m = await medir(() => sondearPreview({ navegador, dir, sonda: navega, marcoSinCsp }).catch(() => undefined));
      r[nombre] = { cuenta: m.cuenta };
    }
    for (const [nombre, d] of [["render", dir], ["render-sin-csp", sin]] as const) {
      const mp4 = path.join(tmp, `${nombre}.mp4`);
      const m = await medir(() => renderizar(motor!, d, mp4, path.join(tmp, "hf-home"), { comprobar: false }));
      r[nombre] = { cuenta: m.cuenta, marcaRoja: await marcaRoja(mp4) };
    }
    fs.writeFileSync(path.join(tmp, "resultados.json"), JSON.stringify(r, null, 2));
    console.info(`csp-integracion: resultados en ${path.join(tmp, "resultados.json")}\n${JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.cuenta])))}`);
  }, 900_000);

  afterAll(() => {
    for (const s of servidores) s.close();
  });

  const NO_MIDE = "el control no conectó: la prueba no mide nada";

  it("control positivo: sin CSP la pieza hostil se ejecuta y conecta en preview y render", () => {
    expect(r["preview-sin-csp"].hostil, "hostil.js no se ejecutó en la preview").toBe(true);
    expect(r["render-sin-csp"].marcaRoja, "hostil.js no se ejecutó en el render").toBe(true);
    expect(r["preview-sin-csp"].cuenta.red, NO_MIDE).toBeGreaterThan(0);
    expect(r["render-sin-csp"].cuenta.red, NO_MIDE).toBeGreaterThan(0);
  });

  it("una pieza hostil no llega a la red ni en la preview ni en el render (I2 a)", () => {
    // La pieza se ejecutó (si no, el 0 no significaría nada) y la CSP no bloqueó el script.
    expect(r.preview.hostil).toBe(true);
    expect(r.render.marcaRoja).toBe(true);
    const v = r.preview.violaciones!;
    expect(v.filter((x) => x.directiva.startsWith("script-src") && x.bloqueada.includes("hostil.js"))).toEqual([]);
    expect(v.some((x) => x.directiva === "connect-src" && x.bloqueada.includes(`127.0.0.1:${puertos.red}`))).toBe(true);
    expect(v.some((x) => x.directiva === "connect-src" && x.bloqueada.includes("203.0.113.1"))).toBe(true);
    expect(v.some((x) => x.directiva === "connect-src" && x.bloqueada.startsWith("ws://"))).toBe(true);
    expect(v.some((x) => x.directiva === "img-src" && x.bloqueada.includes(`127.0.0.1:${puertos.red}`))).toBe(true);
    expect(v.some((x) => x.directiva === "img-src" && x.bloqueada.includes("ejemplo.test"))).toBe(true);
    expect(r.preview.cuenta.red).toBe(0);
    expect(r.render.cuenta.red).toBe(0);
  });

  it("control positivo: sin frame-src en el marco, el iframe navega al sumidero", () => {
    expect(r["navegacion-sin-csp"].cuenta.navegacion, NO_MIDE).toBeGreaterThan(0);
  });

  it("sonda (a): el iframe de la preview no puede navegar a otro origen (frame-src del marco)", () => {
    expect(r.navegacion.cuenta.navegacion).toBe(0);
  });

  it("control positivo: sin CSP, WebRTC llega al sumidero UDP en preview y render", () => {
    expect(r["preview-sin-csp"].cuenta.rtc, NO_MIDE).toBeGreaterThan(0);
    expect(r["render-sin-csp"].cuenta.rtc, NO_MIDE).toBeGreaterThan(0);
  });

  // Medido (2026-10-29): la CSP no gobierna WebRTC (Chrome no implementa la directiva webrtc): STUN llega al sumidero
  // UDP con y sin CSP. Dueño: diseño de la preview de la fase 1 (WebView2 additionalBrowserArgs con
  // --force-webrtc-ip-handling-policy=disable_non_proxied_udp). No se borra: cuando lo cierre, quitar el .fails.
  it.fails("sonda (b): WebRTC no llega al sumidero UDP en la preview [falla conocida: diseño de la preview]", () => {
    expect(r.preview.cuenta.rtc).toBe(0);
  });

  // Dueño: W1.3 (--force-webrtc-ip-handling-policy=disable_non_proxied_udp en el Chrome del render).
  it.fails("sonda (b): WebRTC no llega al sumidero UDP en el render [falla conocida: W1.3]", () => {
    expect(r.render.cuenta.rtc).toBe(0);
  });

  // Medido: chrome-headless-shell 152 no abre la conexión de <link rel="preconnect"> ni sin CSP, así que las dos
  // sondas de preconnect no miden nada hoy. Se mantienen: si un Chrome futuro empieza a preconectar, este control
  // pasa (it.fails lo avisará) y la sonda empezará a medir.
  it.fails("control positivo: sin CSP, preconnect conecta en preview y render [no conecta en headless-shell 152]", () => {
    expect(r["preview-sin-csp"].cuenta.preconexion, NO_MIDE).toBeGreaterThan(0);
    expect(r["render-sin-csp"].cuenta.preconexion, NO_MIDE).toBeGreaterThan(0);
  });

  it("sonda (c): preconnect no conecta en la preview", () => {
    expect(r.preview.cuenta.preconexion).toBe(0);
  });

  it("sonda (c): preconnect no conecta en el render", () => {
    expect(r.render.cuenta.preconexion).toBe(0);
  });

  it("control positivo: sin CSP, speculationrules conecta en el render", () => {
    expect(r["render-sin-csp"].cuenta.especulacion, NO_MIDE).toBeGreaterThan(0);
  });

  // En la preview no conecta ni sin CSP (iframe sandbox opaco): sin control positivo posible, se deja como guarda.
  it("sonda (c): dns-prefetch y speculationrules no conectan en la preview", () => {
    expect(r.preview.cuenta.especulacion).toBe(0);
    expect(r["preview-sin-csp"].cuenta.especulacion).toBe(0);
  });

  // Medido: en el render, <script type="speculationrules"> (permitido por script-src 'unsafe-inline') prefetchea o
  // prerenderiza localhost con la CSP puesta; connect-src no lo gobierna. Dueño: W1.3 (desactivar prefetch/prerender
  // en el Chrome del render) y W3.1 (urlsDeRed debe rechazar speculationrules en las piezas). Ojo: el
  // host-resolver-rules de W1.3 excluye localhost y Chrome no pasa loopback por el proxy: no lo cerrará por sí solo.
  it.fails("sonda (c): dns-prefetch y speculationrules no conectan en el render [falla conocida: W1.3/W3.1]", () => {
    expect(r.render.cuenta.especulacion).toBe(0);
  });
});
