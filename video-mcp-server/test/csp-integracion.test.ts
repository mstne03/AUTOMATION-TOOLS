// I2 (a) en ejecución: una pieza hostil (fetch, WebSocket, imágenes, WebRTC, navegación del iframe y de primer nivel,
// dns-prefetch, preconnect y speculationrules hacia sumideros locales) no llega a la red ni en la preview (iframe
// sandbox con la cabecera CSP) ni en el render real de HyperFrames, solo por la CSP. Cada sonda lleva su control
// positivo (la misma pieza sin la protección SÍ llega): si el control no llega, la sonda no mide nada y el test lo dice.
// Lo que la CSP no para se registra como «falla conocida» con el paquete dueño; nunca se borra la sonda.
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
// M4: el salto tiene que verse en la salida (vitest oculta la consola de los archivos que se saltan enteros).
if (!motor) process.stderr.write("\n[AVISO] I2 (a) NO verificada en ejecución: csp-integracion.test.ts se salta porque falta VIDEO_ENGINE_DIR (carpeta video-engine con Chrome y ffmpeg).\n");

const CANALES = ["red", "especulacion", "preconexion", "navegacion", "location", "ventana", "refresco", "rtc"] as const;
type Canal = (typeof CANALES)[number];
type Cuenta = Record<Canal, number>;
type Violacion = { directiva: string; bloqueada: string; origen: string };
type Medida = { cuenta: Cuenta; hostil?: boolean; violaciones?: Violacion[]; marcaRoja?: boolean; hf?: { contexto: boolean; opacidad: number }; netlog?: { prefetch: boolean; instrumento: boolean }; error?: string };

/**
 * Falla conocida: la sonda HOY llega a la red y su aserción falla. A diferencia de it.fails, un TypeError (medición que
 * no existe) o cualquier otro error no la da por buena: solo cuenta un fallo de aserción. Cuando el dueño lo cierre, el
 * test falla y avisa de quitar la marca.
 */
function fallaConocida(nombre: string, dueño: string, medida: () => Medida | undefined, asercion: (m: Medida) => void) {
  it(`${nombre} [falla conocida: ${dueño}]`, () => {
    const m = medida();
    expect(m, "la medición no existe: la sonda no corrió").toBeDefined();
    let error: unknown;
    try {
      asercion(m!);
    } catch (e) {
      error = e;
    }
    expect(error, `ya no falla: ${dueño} lo cerró; convierte la sonda en un test normal`).toBeDefined();
    expect((error as Error).name, String(error)).toBe("AssertionError");
  });
}

describe.skipIf(!motor)("CSP en ejecución: pieza hostil en preview y render (I2 a)", () => {
  const cuentas = Object.fromEntries(CANALES.map((c) => [c, 0])) as Cuenta;
  const servidores: (net.Server | dgram.Socket)[] = [];
  const puertos = {} as Record<Canal, number>;
  const r: Record<string, Medida> = {};
  const host = `hostil-${Date.now().toString(36)}`;
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
    for (const k of CANALES) cuentas[k] = 0;
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

  /** Copia `dir` en `destino` con `html` como index.html y, si `sinCsp`, sin el <meta> de la CSP. */
  function variante(dir: string, destino: string, html: string, sinCsp: boolean) {
    fs.cpSync(dir, destino, { recursive: true });
    fs.writeFileSync(path.join(destino, "index.html"), sinCsp ? html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "") : html);
    return destino;
  }

  beforeAll(async () => {
    for (const c of CANALES) if (c !== "rtc") await sumideroTcp(c);
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
var i2 = new Image(); i2.src = "http://${host}-instrumento.test/i.png"; document.documentElement.appendChild(i2);
try { var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${puertos.rtc}" }] }); pc.createDataChannel("x"); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }); window.__pc = pc; } catch (e) {}
`;
    fs.writeFileSync(path.join(dir, "assets", "hostil.js"), hostil);
    const cabeza = `<link rel="dns-prefetch" href="http://${host}-prefetch.test/" />
    <link rel="preconnect" href="http://localhost:${puertos.preconexion}/" />
    <script type="speculationrules">{"prefetch":[{"source":"list","urls":["http://localhost:${puertos.especulacion}/s"]}],"prerender":[{"source":"list","urls":["http://localhost:${puertos.especulacion}/p"]}]}</script>
  </head>`;
    const cuerpo = `<img src="http://ejemplo.test/x.png" /><script src="assets/hostil.js"></script>\n  </body>`;
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8").replace("</head>", cabeza).replace("</body>", cuerpo);
    fs.writeFileSync(path.join(dir, "index.html"), html);
    // Desde SEO-109 (I14) el compilador de HyperFrames rechaza todo src/href http(s) estático: la <img> remota y los dos
    // <link> no entran en el render (siguen en la preview). El resto de la pieza hostil, que va por JS, sí se ejecuta.
    const htmlRender = html.replace(/<img src="http:\/\/ejemplo[^>]*>/, "").replace(/<link rel="(?:dns-prefetch|preconnect)"[^>]*>\s*/g, "");
    const dirRender = variante(dir, path.join(tmp, "con-csp"), htmlRender, false);
    const sin = variante(dir, path.join(tmp, "sin-csp"), htmlRender, true);

    const navegador = path.join(motor!, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    // Q1: además de la pieza hostil, hf-tiempo.js se carga bajo la CSP y anima de verdad: un tween de opacidad 0→1 en
    // 1 s sobre un elemento del host bloque1 (inicio 0); tras un seek del runtime a 0,5 s, la opacidad calculada es 0,5.
    const sonda = `new Promise((ok) => setTimeout(async () => {
      const hf = { contexto: typeof window.HF?.contexto === "function", opacidad: -1 };
      try {
        const raiz = document.querySelector('[data-composition-id="bloque1"]');
        const el = document.createElement("div"); el.id = "q1-prueba"; raiz.appendChild(el);
        window.HF.contexto("bloque1", 0).tween("#q1-prueba", { opacity: 0 }, { opacity: 1 }, 0, 1, "none");
        window.__player.seek(0.5);
        await new Promise((r) => setTimeout(r, 300));
        hf.opacidad = Number(getComputedStyle(el).opacity);
      } catch (e) { hf.error = String(e); }
      ok({ hostil: window.__hostil === true, hf });
    }, 3000))`;
    for (const [nombre, sinCsp] of [["preview", false], ["preview-sin-csp", true]] as const) {
      const netlog = path.join(tmp, `netlog-${nombre}.json`);
      // sinDnsPrefetchOff en el control: sin CSP y sin el <meta x-dns-prefetch-control>.
      const m = await medir(() => sondearPreview({ navegador, dir, sonda, sinCsp, sinDnsPrefetchOff: sinCsp, argsExtra: [`--log-net-log=${netlog}`] }));
      const t = fs.existsSync(netlog) ? fs.readFileSync(netlog, "utf8") : "";
      r[nombre] = {
        cuenta: m.cuenta,
        hostil: m.valor.resultado.hostil,
        hf: m.valor.resultado.hf,
        violaciones: m.valor.violaciones,
        netlog: { prefetch: t.includes(`${host}-prefetch.test`), instrumento: t.includes(`${host}-instrumento.test`) },
      };
    }
    const navega = `(location.href = "http://localhost:${puertos.navegacion}/n", new Promise((ok) => setTimeout(() => ok(true), 1500)))`;
    for (const [nombre, marcoSinCsp] of [["navegacion", false], ["navegacion-sin-csp", true]] as const) {
      const m = await medir(() => sondearPreview({ navegador, dir, sonda: navega, marcoSinCsp }).catch(() => undefined));
      r[nombre] = { cuenta: m.cuenta };
    }
    for (const [nombre, d] of [["render", dirRender], ["render-sin-csp", sin]] as const) {
      const mp4 = path.join(tmp, `${nombre}.mp4`);
      const m = await medir(() => renderizar(motor!, d, mp4, path.join(tmp, "hf-home"), { comprobar: false }));
      r[nombre] = { cuenta: m.cuenta, marcaRoja: await marcaRoja(mp4) };
    }

    // Navegación de primer nivel en el render (Medium 3): window.open y location (misma composición, el open va
    // primero) y meta refresh (aparte: navega antes). Se mide hacia loopback, que el sumidero ve. Hacia fuera solo se
    // lanza window.open a 203.0.113.1 (TEST-NET-3), sin medir: ningún sumidero local lo observa y HyperFrames lanza su
    // Chrome sin net-log. Medir la salida real corresponde a W1.3.
    const base = fs.readFileSync(path.join(dir, "index.html"), "utf8").replace(/<link rel="dns-prefetch"[\s\S]*?<\/script>\n/, "").replace(/<img src="http:\/\/ejemplo[^\n]*\n/, "");
    const abreYVa = `<script>try { window.open("http://127.0.0.1:${puertos.ventana}/o"); window.open("http://203.0.113.1/o"); } catch (e) {}
setTimeout(function () { location.href = "http://127.0.0.1:${puertos.location}/l"; }, 300);</script>\n</body>`;
    const refresco = `<meta http-equiv="refresh" content="1;url=http://127.0.0.1:${puertos.refresco}/r" />\n</head>`;
    const navs: [string, string][] = [
      ["nav-abre", base.replace("</body>", abreYVa)],
      ["nav-refresco", base.replace("</head>", refresco)],
    ];
    for (const [nombre, h] of navs) {
      for (const sinCsp of [false, true]) {
        const clave = sinCsp ? `${nombre}-sin-csp` : nombre;
        const d = variante(dir, path.join(tmp, clave), h, sinCsp);
        let error: string | undefined;
        // Si la página se va, el render puede fallar o colgarse: se mide igual (tope de 3 min).
        const m = await medir(() =>
          renderizar(motor!, d, path.join(tmp, `${clave}.mp4`), path.join(tmp, "hf-home"), { comprobar: false, timeoutMs: 180_000 }).catch((e: Error) => {
            // Sin codificador la página ni se abre: el 0 no sería una medida. Se para la prueba, no se cuenta.
            if (/encoder unavailable/i.test(e.message)) throw e;
            error = e.message.slice(0, 200);
          }),
        );
        r[clave] = { cuenta: m.cuenta, error };
      }
    }
    fs.writeFileSync(path.join(tmp, "resultados.json"), JSON.stringify(r, null, 2));
    console.info(`csp-integracion: resultados en ${path.join(tmp, "resultados.json")}\n${JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.cuenta])))}`);
  }, 1_800_000);

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
    // Con CSP tampoco se llega a resolver el host de la imagen (el instrumento del net-log tiene su control abajo).
    expect(r.preview.netlog?.instrumento).toBe(false);
  });

  it("Q1: bajo la CSP, hf-tiempo.js se carga y un tween real se mueve con el seek del runtime", () => {
    expect(r.preview.hf, "la sonda no devolvió el estado de hf-tiempo").toBeDefined();
    expect(r.preview.hf!.contexto).toBe(true);
    expect(r.preview.hf!.opacidad).toBeCloseTo(0.5, 1);
  });

  it("control positivo: sin frame-src en el marco, el iframe navega al sumidero", () => {
    expect(r["navegacion-sin-csp"].cuenta.navegacion, NO_MIDE).toBeGreaterThan(0);
  });

  it("sonda (a): el iframe de la preview no puede navegar a otro origen (frame-src del marco)", () => {
    expect(r.navegacion.cuenta.navegacion).toBe(0);
  });

  it("control positivo: sin CSP, WebRTC llega al sumidero UDP en la preview", () => {
    expect(r["preview-sin-csp"].cuenta.rtc, NO_MIDE).toBeGreaterThan(0);
  });
  // Sin control en el render: el flag de W1.3 va en la CLI parcheada y también cierra la variante sin CSP (0 medido),
  // así que ese 0 prueba el cierre del parche, no el de la CSP.

  // La CSP no gobierna WebRTC (Chrome no implementa la directiva webrtc): STUN llega con y sin CSP.
  fallaConocida("sonda (b): WebRTC no llega al sumidero UDP en la preview", "diseño de la preview (WebView2 --force-webrtc-ip-handling-policy=disable_non_proxied_udp)", () => r.preview, (m) =>
    expect(m.cuenta.rtc).toBe(0),
  );
  it("sonda (b): WebRTC no llega al sumidero UDP en el render (--force-webrtc-ip-handling-policy=disable_non_proxied_udp, W1.3)", () => {
    expect(r.render.marcaRoja, "hostil.js no se ejecutó en el render").toBe(true);
    expect(r.render.cuenta.rtc).toBe(0);
  });

  // preconnect: chrome-headless-shell 152 no abre la conexión ni sin CSP, así que hoy no hay sonda posible. Los
  // controles quedan como fallas conocidas por entorno: si un Chrome futuro preconecta, fallarán y habrá que medir.
  fallaConocida("control positivo: sin CSP, preconnect conecta en la preview", "headless-shell 152 no preconecta", () => r["preview-sin-csp"], (m) =>
    expect(m.cuenta.preconexion, NO_MIDE).toBeGreaterThan(0),
  );
  fallaConocida("control positivo: sin CSP, preconnect conecta en el render", "headless-shell 152 no preconecta", () => r["render-sin-csp"], (m) =>
    expect(m.cuenta.preconexion, NO_MIDE).toBeGreaterThan(0),
  );
  it.skip("sonda (c): preconnect no conecta en preview ni render — sin control positivo posible en headless-shell 152 (ver los dos controles de arriba)", () => {});

  // dns-prefetch (bloqueante R1-1): solo resuelve DNS, el sumidero TCP no lo ve. Se mide con el net-log de Chrome en la
  // preview: el instrumento funciona (sin CSP la imagen a <host>-instrumento.test sí se resuelve y aparece), pero el
  // iframe sandbox no hace dns-prefetch ni sin CSP ni sin <meta x-dns-prefetch-control>, así que el control positivo
  // falla y la sonda no puede medir. La protección queda en la aserción estática del <meta> (csp.test.ts). En el render
  // no se puede medir (HyperFrames lanza su Chrome sin net-log); allí la cubre el host-resolver-rules de W1.3.
  it("instrumento: sin CSP, el net-log de la preview registra la resolución de un host único", () => {
    expect(r["preview-sin-csp"].netlog?.instrumento, "el net-log no registra resoluciones: la sonda de dns-prefetch no mide nada").toBe(true);
  });
  fallaConocida("control positivo: sin CSP ni <meta x-dns-prefetch-control>, la preview hace dns-prefetch", "diseño de la preview (el iframe sandbox de headless-shell no prefetchea)", () => r["preview-sin-csp"], (m) =>
    expect(m.netlog!.prefetch, NO_MIDE).toBe(true),
  );
  it.skip("sonda (c): dns-prefetch no resuelve en la preview — sin control positivo posible (ver el control de arriba)", () => {});

  it("control positivo: sin CSP, speculationrules conecta en el render", () => {
    expect(r["render-sin-csp"].cuenta.especulacion, NO_MIDE).toBeGreaterThan(0);
  });
  it.skip("sonda (c): speculationrules no conecta en la preview — el iframe sandbox no especula ni sin CSP (0 medido), sin control positivo", () => {});
  // Con script-src 'unsafe-inline', <script type="speculationrules"> prefetchea o prerenderiza localhost con la CSP
  // puesta; connect-src no lo gobierna. W1.3 no lo cierra (medido: 39 conexiones a loopback con el parche; su
  // host-resolver-rules excluye localhost): solo lo cierra W3.1.
  fallaConocida("sonda (c): speculationrules no conecta en el render", "W3.1 (urlsDeRed rechaza speculationrules)", () => r.render, (m) =>
    expect(m.cuenta.especulacion).toBe(0),
  );

  // Navegación de primer nivel en el render (Medium 3). La CSP no gobierna la navegación (navigate-to no existe).
  it("control positivo: sin CSP, window.open, location y meta refresh llegan al sumidero en el render", () => {
    expect(r["nav-abre-sin-csp"].cuenta.ventana, NO_MIDE).toBeGreaterThan(0);
    expect(r["nav-abre-sin-csp"].cuenta.location, NO_MIDE).toBeGreaterThan(0);
    expect(r["nav-refresco-sin-csp"].cuenta.refresco, NO_MIDE).toBeGreaterThan(0);
  });
  fallaConocida("sonda (d): window.open no llega a loopback en el render", "W1.3", () => r["nav-abre"], (m) => expect(m.cuenta.ventana).toBe(0));
  fallaConocida("sonda (d): location no llega a loopback en el render", "W1.3", () => r["nav-abre"], (m) => expect(m.cuenta.location).toBe(0));
  fallaConocida("sonda (d): meta refresh no llega a loopback en el render", "W1.3", () => r["nav-refresco"], (m) => expect(m.cuenta.refresco).toBe(0));
  it.skip("sonda (d): navegación de primer nivel hacia fuera (window.open, location, meta refresh a 203.0.113.1) — salida real sin medir con sumidero; dueño W1.3", () => {});
});
