// I2 (a) en ejecución: una pieza hostil (fetch, WebSocket, imágenes, WebRTC, navegación del iframe y de primer nivel,
// dns-prefetch, preconnect y speculationrules hacia sumideros locales) no llega a la red ni en la preview (iframe
// sandbox con la cabecera CSP) ni en el render real de HyperFrames. En el render manda el proxy nulo, por puerto exacto
// (R2-M1): también sin CSP da 0, así que su control es el mismo Chrome con la lista antigua (controlBypass). Si el
// control no llega, la sonda no mide nada y el test lo dice. Sin DNS ni salida: Chrome corre siempre con las reglas de
// resolución, los destinos «de fuera» son hosts `.test` que no se resuelven y las escuchas son todas de loopback.
// Lo que la CSP no para se registra como «falla conocida» con el paquete dueño; nunca se borra la sonda.
// Necesita los binarios del motor: VIDEO_ENGINE_DIR=<…/binaries/video-engine> (variable solo de tests).
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import puppeteer from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { montar } from "../scripts/montar.mjs";
import { sondearPreview } from "../scripts/sondear-preview.mjs";
import { entornoMinimo, renderizar } from "../scripts/comparar-fotogramas.mjs";
import { BYPASS, bypassDe, chunk, sumidero, type Sumidero } from "./hyperframes-comun.js";

const motor = process.env.VIDEO_ENGINE_DIR;
/** La lista de antes de R2-M1: exceptúa cualquier puerto de loopback. Solo como control. */
const LISTA_ANTIGUA = `${BYPASS};localhost;127.0.0.1`;
// M4: el salto tiene que verse en la salida (vitest oculta la consola de los archivos que se saltan enteros).
if (!motor) process.stderr.write("\n[AVISO] I2 (a) NO verificada en ejecución: csp-integracion.test.ts se salta porque falta VIDEO_ENGINE_DIR (carpeta video-engine con Chrome y ffmpeg).\n");

const CANALES = ["red", "especulacion", "preconexion", "navegacion", "location", "ventana", "refresco", "rtc"] as const;
type Canal = (typeof CANALES)[number];
type Cuenta = Record<Canal, number>;
type Violacion = { directiva: string; bloqueada: string; origen: string };
type Medida = { cuenta: Cuenta; servida?: number; hostil?: boolean; violaciones?: Violacion[]; marcaRoja?: boolean; hf?: { contexto: boolean; opacidad: number }; netlog?: { prefetch: boolean; instrumento: boolean }; error?: string };

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
  let sumiderosHost: Sumidero[] = [];
  const llegadas: { nueva: string[]; literal: string[]; antigua: string[] } = { nueva: [], literal: [], antigua: [] };
  let ventanasFin = "";
  let chromesVivos: number[] = [];

  let servidorControl: http.Server;
  let puertoPropio: number;
  let htmlControl = "";
  let paginasServidas = 0;
  let navegador: string;
  let marcador: (a: string[]) => string[];

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

  /**
   * El Chrome del render (mismos flags, salidos del marcador del parche) con solo `--proxy-bypass-list` cambiada por
   * `lista`, abriendo `html` desde un servidor propio en localhost. Cuenta lo que llega a cada sumidero y si se sirvió.
   */
  async function controlBypass(html: string, lista: string, hostPropio = "localhost"): Promise<Medida> {
    htmlControl = html;
    paginasServidas = 0;
    const m = await medir(async () => {
      const dd = fs.mkdtempSync(path.join(tmp, "control-"));
      const args = marcador([]).map((a) => (a.startsWith("--proxy-bypass-list") ? lista : a));
      const browser = await puppeteer.launch({ executablePath: navegador, headless: true, pipe: true, env: entornoMinimo(), userDataDir: dd, args });
      try {
        const page = await browser.newPage();
        await page.goto(`http://${hostPropio}:${puertoPropio}/`, { waitUntil: "load" }).catch(() => undefined);
        await new Promise((ok) => setTimeout(ok, 4000));
      } finally {
        await browser.close();
      }
    });
    return { cuenta: m.cuenta, servida: paginasServidas };
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
    navegador = path.join(motor!, "browser", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    marcador = ((await import(chunk("chunk-K4MJX7SR.js"))) as { withHyperframesBrowserMarker: (a: string[]) => string[] }).withHyperframesBrowserMarker;
    servidorControl = http.createServer((_q, res) => {
      paginasServidas++;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(htmlControl);
    });
    await new Promise<void>((ok) => servidorControl.listen(0, "127.0.0.1", ok));
    puertoPropio = (servidorControl.address() as net.AddressInfo).port;
    const { dir } = await montar(motor!, path.join(tmp, "montaje"), "GUION_FOTOS", { duracionVoz: 6, gpu: false });
    // La marca va antes de nada; la URL de cada canal lleva esquema explícito (H1).
    const hostil = `document.documentElement.dataset.hostil = "1"; window.__hostil = true;
var m = document.createElement("div"); m.style.cssText = "position:fixed;left:0;top:0;width:200px;height:200px;background:#ff0000;z-index:2147483647"; document.documentElement.appendChild(m);
fetch("http://127.0.0.1:${puertos.red}/f").catch(function () {});
fetch("http://${host}-salida.test/").catch(function () {});
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
    // Desde SEO-109 (I14) la <img> remota estática aborta el render (código 1): solo va en la preview. Los dos <link>
    // de dns-prefetch y preconnect compilan y renderizan con código 0, así que siguen en la pieza del render.
    const htmlRender = html.replace(/<img src="http:\/\/ejemplo[^>]*>/, "");
    const dirRender = variante(dir, path.join(tmp, "con-csp"), htmlRender, false);
    const sin = variante(dir, path.join(tmp, "sin-csp"), htmlRender, true);

    // Q1: además de la pieza hostil, hf-tiempo.js se carga bajo la CSP y anima de verdad: un tween de opacidad 0→1 en
    // 1 s sobre un elemento del host esc1 (inicio 0); tras un seek del runtime a 0,5 s, la opacidad calculada es 0,5.
    const sonda = `new Promise((ok) => setTimeout(async () => {
      const hf = { contexto: typeof window.HF?.contexto === "function", opacidad: -1 };
      try {
        const raiz = document.querySelector('[data-composition-id="esc1"]');
        const el = document.createElement("div"); el.id = "q1-prueba"; raiz.appendChild(el);
        window.HF.contexto("esc1", 0).tween("#q1-prueba", { opacity: 0 }, { opacity: 1 }, 0, 1, "none");
        window.__player.seek(0.5);
        await new Promise((r) => setTimeout(r, 300));
        hf.opacidad = Number(getComputedStyle(el).opacity);
      } catch (e) { hf.error = String(e); }
      ok({ hostil: window.__hostil === true, hf });
    }, 3000))`;
    for (const [nombre, sinCsp] of [["preview", false], ["preview-sin-csp", true]] as const) {
      const netlog = path.join(tmp, `netlog-${nombre}.json`);
      // sinDnsPrefetchOff en el control: sin CSP y sin el <meta x-dns-prefetch-control>.
      const m = await medir(() => sondearPreview({ navegador, dir, sonda, sinCsp, sinDnsPrefetchOff: sinCsp, reglas: "csp", argsExtra: [`--log-net-log=${netlog}`] }));
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
      const m = await medir(() => sondearPreview({ navegador, dir, sonda: navega, marcoSinCsp, reglas: "csp" }).catch(() => undefined));
      r[nombre] = { cuenta: m.cuenta };
    }
    for (const [nombre, d] of [["render", dirRender], ["render-sin-csp", sin]] as const) {
      const mp4 = path.join(tmp, `${nombre}.mp4`);
      const m = await medir(() => renderizar(motor!, d, mp4, path.join(tmp, "hf-home"), { comprobar: false }));
      r[nombre] = { cuenta: m.cuenta, marcaRoja: await marcaRoja(mp4) };
    }

    // Navegación de primer nivel en el render (Medium 3): window.open y location (misma composición, el open va
    // primero) y meta refresh (aparte: navega antes). Se mide hacia loopback, que el sumidero ve. Hacia fuera solo se
    // abre un host `.test`, sin medir: ningún sumidero local lo observa; lo corta el mismo proxy nulo.
    const base = fs.readFileSync(path.join(dir, "index.html"), "utf8").replace(/<link rel="dns-prefetch"[\s\S]*?<\/script>\n/, "").replace(/<img src="http:\/\/ejemplo[^\n]*\n/, "");
    const abreYVa = `<script>try { window.open("http://127.0.0.1:${puertos.ventana}/o"); window.open("http://${host}-salida.test/o"); } catch (e) {}
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
    // Mismo Chrome y flags con cada lista (R2-M1): la antigua llega, la de puerto exacto no.
    const pieza = `<!doctype html><html><head><link rel="preconnect" href="http://localhost:${puertos.preconexion}/" />
<script type="speculationrules">{"prefetch":[{"source":"list","urls":["http://localhost:${puertos.especulacion}/s"]}],"prerender":[{"source":"list","urls":["http://localhost:${puertos.especulacion}/p"]}]}</script></head><body><script>
fetch("http://127.0.0.1:${puertos.red}/f", { mode: "no-cors" }).catch(function () {});
try { new WebSocket("ws://127.0.0.1:${puertos.red}/w"); } catch (e) {}
window.open("http://127.0.0.1:${puertos.ventana}/o");
setTimeout(function () { location.href = "http://127.0.0.1:${puertos.location}/l"; }, 2000);
</script></body></html>`;
    const piezaRefresco = `<!doctype html><html><head><meta http-equiv="refresh" content="1;url=http://127.0.0.1:${puertos.refresco}/r" /></head><body></body></html>`;
    const nueva = bypassDe("localhost", puertoPropio);
    r["lista-antigua"] = await controlBypass(pieza, LISTA_ANTIGUA);
    r["lista-nueva"] = await controlBypass(pieza, nueva);
    r["refresco-antigua"] = await controlBypass(piezaRefresco, LISTA_ANTIGUA);
    r["refresco-nueva"] = await controlBypass(piezaRefresco, nueva);

    // Variantes de host (R0 M2 y L-3): con cualquiera de las dos reglas, nada de esto es el servidor propio. Van a un
    // puerto ajeno y al propio (127.1 y 2130706433 no: con la regla del literal son el mismo servidor).
    const s4 = await sumidero("127.0.0.1");
    const s2 = await sumidero("127.0.0.2");
    const s6 = await sumidero("::1");
    const s2P = await sumidero("127.0.0.2", puertoPropio);
    const s6P = await sumidero("::1", puertoPropio);
    sumiderosHost = [s4, s2, s6, s2P, s6P];
    const variantes = [
      [`[::1]:${puertoPropio}`, "seisP"],
      [`127.0.0.2:${puertoPropio}`, "dosP"],
      [`0.0.0.0:${puertoPropio}`, "ceroP"],
      [`[::1]:${s6.puerto}`, "seis"],
      [`127.0.0.2:${s2.puerto}`, "dos"],
      [`0.0.0.0:${s4.puerto}`, "cero"],
      [`localhost.:${s4.puerto}`, "punto"],
      [`x.localhost:${s4.puerto}`, "sub"],
      [`127.1:${s4.puerto}`, "corto"],
      [`2130706433:${s4.puerto}`, "entero"],
      [`127.0.0.1:${s4.puerto}`, "cruce"],
    ];
    const piezaHosts = `<!doctype html><html><body><script>${variantes.map(([h, n]) => `fetch("http://${h}/${n}", { mode: "no-cors" }).catch(function () {});`).join("\n")}</script></body></html>`;
    const peticiones = () => sumiderosHost.flatMap((x) => x.peticiones().map((p) => /^GET \/(\w+)/.exec(p)?.[1] ?? "?"));
    r["hosts-nueva"] = await controlBypass(piezaHosts, nueva);
    llegadas.nueva = peticiones();
    // `127.0.0.1:P`, la regla de check y snapshot. Aquí el cruce a `127.0.0.1:Q` sigue fuera: el puerto no coincide.
    r["hosts-literal"] = await controlBypass(piezaHosts, bypassDe("127.0.0.1", puertoPropio), "127.0.0.1");
    llegadas.literal = peticiones().slice(llegadas.nueva.length);
    r["hosts-antigua"] = await controlBypass(piezaHosts, LISTA_ANTIGUA);
    llegadas.antigua = peticiones().slice(llegadas.nueva.length + llegadas.literal.length);

    // Review Focus 1: una composición que abre ventanas a su propio servidor sigue exenta, solo gasta memoria.
    const ventanas = path.join(tmp, "ventanas");
    fs.mkdirSync(ventanas, { recursive: true });
    fs.writeFileSync(
      path.join(ventanas, "index.html"),
      `<!doctype html><html><head><meta charset="UTF-8" /></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="540" data-height="960" style="width:540px;height:960px;background:#123"></div>
<script>window.__timelines={};setInterval(function(){try{window.open("/x")}catch(e){}},50);</script></body></html>`,
    );
    const { listarProcesos } = await import("../src/proceso.js");
    const antesVentanas = new Set((await listarProcesos()).map((p) => p.pid));
    try {
      await renderizar(motor!, ventanas, path.join(tmp, "ventanas.mp4"), path.join(tmp, "hf-home"), { comprobar: false, timeoutMs: 180_000 });
      ventanasFin = "terminó";
    } catch (e) {
      ventanasFin = (e as Error).message.slice(0, 200);
    }
    await new Promise((ok) => setTimeout(ok, 2000));
    chromesVivos = (await listarProcesos()).filter((p) => !antesVentanas.has(p.pid) && p.ruta.toLowerCase() === navegador.toLowerCase()).map((p) => p.pid);
    fs.writeFileSync(path.join(tmp, "resultados.json"), JSON.stringify(r, null, 2));
    console.info(`csp-integracion: resultados en ${path.join(tmp, "resultados.json")}\n${JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.cuenta])))}`);
  }, 1_800_000);

  afterAll(async () => {
    for (const s of servidores) s.close();
    servidorControl?.close();
    await Promise.all(sumiderosHost.map((x) => x.cerrar()));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const NO_MIDE = "el control no conectó: la prueba no mide nada";

  it("control positivo: sin CSP la pieza hostil se ejecuta y conecta en la preview; en el render, con la lista antigua", () => {
    expect(r["preview-sin-csp"].hostil, "hostil.js no se ejecutó en la preview").toBe(true);
    expect(r["render-sin-csp"].marcaRoja, "hostil.js no se ejecutó en el render").toBe(true);
    expect(r["preview-sin-csp"].cuenta.red, NO_MIDE).toBeGreaterThan(0);
    expect(r["lista-antigua"].cuenta.red, NO_MIDE).toBeGreaterThan(0);
  });

  const CERO = Object.fromEntries(CANALES.map((c) => [c, 0]));

  it("el proxy cierra solo: render sin CSP, con el JS hostil ejecutado, 0 en todos los canales (R2-M1)", () => {
    for (const clave of ["render-sin-csp", "nav-abre-sin-csp", "nav-refresco-sin-csp"]) expect(r[clave].cuenta, clave).toEqual(CERO);
  });

  it("lista de puerto exacto: sirve la página y 0 en todos los canales, con el mismo Chrome que el control", () => {
    for (const clave of ["lista-nueva", "refresco-nueva", "hosts-nueva", "hosts-literal"]) {
      expect(r[clave].servida, `${clave}: la página propia no se sirvió`).toBeGreaterThan(0);
      expect(r[clave].cuenta, clave).toEqual(CERO);
    }
  });

  it("variantes de host (R0 M2, L-3): con las reglas localhost:P y 127.0.0.1:P no llega ninguna; con la lista antigua, las de 127.0.0.1", () => {
    expect(llegadas.nueva).toEqual([]);
    expect(llegadas.literal).toEqual([]);
    expect(llegadas.antigua, NO_MIDE).toEqual(expect.arrayContaining(["corto", "entero", "cruce"]));
    for (const fuera of ["seis", "dos", "punto", "sub"]) expect(llegadas.antigua, fuera).not.toContain(fuera);
  });

  it("Review Focus 1: abrir ventanas a su propio servidor en bucle termina o cae por timeout, sin dejar Chrome vivo", () => {
    expect(ventanasFin === "terminó" || /superó/.test(ventanasFin), ventanasFin).toBe(true);
    expect(chromesVivos).toEqual([]);
  });

  it("una pieza hostil no llega a la red ni en la preview ni en el render (I2 a)", () => {
    // La pieza se ejecutó (si no, el 0 no significaría nada) y la CSP no bloqueó el script.
    expect(r.preview.hostil).toBe(true);
    expect(r.render.marcaRoja).toBe(true);
    const v = r.preview.violaciones!;
    expect(v.filter((x) => x.directiva.startsWith("script-src") && x.bloqueada.includes("hostil.js"))).toEqual([]);
    expect(v.some((x) => x.directiva === "connect-src" && x.bloqueada.includes(`127.0.0.1:${puertos.red}`))).toBe(true);
    expect(v.some((x) => x.directiva === "connect-src" && x.bloqueada.includes(`${host}-salida.test`))).toBe(true);
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

  // preconnect: chrome-headless-shell 152 y 156 no abren la conexión ni sin CSP ni con la lista antigua, así que hoy no
  // hay sonda posible. Los controles quedan como fallas conocidas por entorno: si un Chrome futuro preconecta, fallarán.
  fallaConocida("control positivo: sin CSP, preconnect conecta en la preview", "headless-shell no preconecta", () => r["preview-sin-csp"], (m) =>
    expect(m.cuenta.preconexion, NO_MIDE).toBeGreaterThan(0),
  );
  fallaConocida("control positivo: con la lista antigua, preconnect conecta en el render", "headless-shell no preconecta", () => r["lista-antigua"], (m) =>
    expect(m.cuenta.preconexion, NO_MIDE).toBeGreaterThan(0),
  );
  it.skip("sonda (c): preconnect no conecta en preview ni render — sin control positivo posible en headless-shell (ver los dos controles de arriba)", () => {});

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

  it("control positivo: con la lista antigua, speculationrules conecta en el render", () => {
    expect(r["lista-antigua"].cuenta.especulacion, NO_MIDE).toBeGreaterThan(0);
  });
  it.skip("sonda (c): speculationrules no conecta en la preview — el iframe sandbox no especula ni sin CSP (0 medido), sin control positivo", () => {});
  // Con script-src 'unsafe-inline', <script type="speculationrules"> prefetchea o prerenderiza localhost con la CSP
  // puesta; connect-src no lo gobierna. Lo cierra el proxy por puerto exacto (R2-M1).
  it("sonda (c): speculationrules no conecta en el render", () => {
    expect(r.render.cuenta.especulacion).toBe(0);
  });

  // Navegación de primer nivel en el render (Medium 3). La CSP no gobierna la navegación (navigate-to no existe).
  it("control positivo: con la lista antigua, window.open, location y meta refresh llegan al sumidero", () => {
    expect(r["lista-antigua"].cuenta.ventana, NO_MIDE).toBeGreaterThan(0);
    expect(r["lista-antigua"].cuenta.location, NO_MIDE).toBeGreaterThan(0);
    expect(r["refresco-antigua"].cuenta.refresco, NO_MIDE).toBeGreaterThan(0);
  });
  it("sonda (d): window.open no llega a loopback en el render", () => {
    expect(r["nav-abre"].cuenta.ventana).toBe(0);
  });
  it("sonda (d): location no llega a loopback en el render", () => {
    expect(r["nav-abre"].cuenta.location).toBe(0);
  });
  it("sonda (d): meta refresh no llega a loopback en el render", () => {
    expect(r["nav-refresco"].cuenta.refresco).toBe(0);
  });
});
