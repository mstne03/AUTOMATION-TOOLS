// Parche local de HyperFrames 0.8.206 (SEO-109): aplicado, flags de Chrome en Windows (I3, I2b),
// cierre de la búsqueda del navegador (I13) y servidores solo en loopback (I7). Rápido: npm test y CI.
// El render real con la integridad medida está en sandbox-render.test.ts (npm run render:sandbox).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../src/raiz.js";
import { HYPERFRAMES_BIN } from "../src/musica.js";
import { ejecutar } from "../src/proceso.js";
import {
  BYPASS,
  chunk,
  conecta,
  DIST,
  ENTORNO_CERRADO,
  entornoLimpio,
  FLAGS_RED,
  GPU_SIN_SANDBOX,
  HASHES,
  HF,
  ipNoInterna,
  MARCADOR,
  PARCHE,
  PROXY_NULO,
  RESOLVER,
  sumidero,
  type Sumidero,
  WEBRTC,
} from "./hyperframes-comun.js";

type Args = string[];
type Marcador = (args?: Args) => Args;

const MARCA_PARCHE = "SEO Studio (parche local, SEO-109";
/** Ficheros que toca el parche, relativos a node_modules/hyperframes (las claves del .sha256.json). */
const PARCHEADOS = ["dist/chunk-G6W55MTX.js", "dist/chunk-K4MJX7SR.js", "dist/chunk-OZUAVHFE.js", "dist/chunk-RDDVQSNQ.js"];

/** Los `dist/*.js` de HyperFrames (sin las skills) con sus líneas. */
function lineasDist(): { fichero: string; linea: number; texto: string }[] {
  const out: { fichero: string; linea: number; texto: string }[] = [];
  for (const f of fs.readdirSync(DIST).filter((n) => n.endsWith(".js")).sort()) {
    fs.readFileSync(path.join(DIST, f), "utf8")
      .split("\n")
      .forEach((texto, i) => out.push({ fichero: f, linea: i + 1, texto }));
  }
  return out;
}

/** «fichero:línea» de cada línea del dist que casa con `re`. */
function inventario(re: RegExp): string[] {
  return lineasDist()
    .filter((l) => re.test(l.texto))
    .map((l) => `${l.fichero}:${l.linea}`);
}

describe("parche de HyperFrames (I3, I2b, I9)", () => {
  it("node_modules tiene hyperframes 0.8.206 exacta, igual que package.json", () => {
    const instalado = JSON.parse(fs.readFileSync(path.join(HF, "package.json"), "utf8")) as { version: string };
    const propio = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(instalado.version).toBe("0.8.206");
    expect(propio.dependencies.hyperframes).toBe("0.8.206");
  });

  it("el parche está aplicado: git apply --reverse --check, marca y SHA-256 en cada fichero parcheado", () => {
    // Dentro del repo, git apply interpreta las rutas desde la raíz y se SALTA en silencio las que caen
    // fuera del cwd: con GIT_CEILING_DIRECTORIES no sube al repo y trata las rutas relativas al cwd.
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(SERVER_ROOT) };
    const r = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--verbose", "--reverse", "--check", PARCHE], { cwd: SERVER_ROOT, env, encoding: "utf8" });
    expect(r.status, `git apply --reverse --check: ${r.stderr}`).toBe(0);
    expect(r.stderr + r.stdout).not.toMatch(/Skipped/i);
    for (const rel of PARCHEADOS) expect(r.stderr + r.stdout).toContain(`Checking patch node_modules/hyperframes/${rel}`);
    // git apply puede saltarse un fichero sin avisar: se mira el contenido de cada uno.
    const fijados = JSON.parse(fs.readFileSync(HASHES, "utf8")) as { version: string; ficheros: Record<string, string> };
    expect(fijados.version).toBe("0.8.206");
    expect(Object.keys(fijados.ficheros).sort()).toEqual(PARCHEADOS);
    for (const rel of PARCHEADOS) {
      const contenido = fs.readFileSync(path.join(HF, rel));
      expect(contenido.toString("utf8"), rel).toContain(MARCA_PARCHE);
      expect(createHash("sha256").update(contenido).digest("hex"), rel).toBe(fijados.ficheros[rel]);
    }
  });

  // Listas cerradas por fichero y línea (dist ya parcheado): cualquier aparición nueva tras una subida
  // de versión rompe el test y obliga a revisar el parche.
  it("inventario: literales \"--no-sandbox\" solo en los sitios conocidos", () => {
    expect(inventario(/"--no-sandbox"/)).toEqual([
      "capture-KKD5GMAF.js:199", // captura de webs, solo Linux (I14: el motor no la usa)
      "chunk-4UMPIPCQ.js:53", // shellStarts: solo sin HYPERFRAMES_BROWSER_PATH (desarrollo), --dump-dom about:blank
      "chunk-K4MJX7SR.js:28", // el propio hunk A (lo detecta para quitarlo)
      "chunk-RDDVQSNQ.js:1252", // getHardwareGpuProbeArgs → marcador
      "chunk-RDDVQSNQ.js:1529", // buildChromeArgs → marcador
      "chunk-RDDVQSNQ.js:15804", // efectos de audio → marcador
      "chunk-RDDVQSNQ.js:18338", // buildHdrChromeArgs → marcador (HDR cerrado por el hunk B2)
    ]);
  });

  it("inventario: spawn/execFile de un ejecutable de navegador solo en los sitios conocidos", () => {
    expect(inventario(/\b(spawn|spawnSync|execFile|execFileSync|runCancellableProcess)\(\s*(options\.)?(binary|executablePath|browserPath|chromePath)\s*,/)).toEqual([
      "chunk-4UMPIPCQ.js:54", // shellStarts (ver arriba)
      "chunk-L5MFWGGU.js:14195", // ffmpeg -version (no es un navegador; casa por el nombre `binary`)
      "chunk-MNNK7RV5.js:46", // openBrowser de la vista previa de HyperFrames (el motor no la usa)
      "chunk-QVTCXN42.js:216", // preflight `--version` del navegador
    ]);
  });

  it("inventario: todo .launch del dist es conocido y los que lanzan Chrome pasan por el marcador", () => {
    const sitios = inventario(/\.launch\b/);
    expect(sitios).toEqual([
      "chunk-RDDVQSNQ.js:810", // this.options.launch: delega en launchManagedBrowser
      "chunk-RDDVQSNQ.js:936", // sonda de GPU (probeLifecycle.launch / ppt.launch)
      "chunk-RDDVQSNQ.js:1402", // launchBrowser del render
      "chunk-RDDVQSNQ.js:18325", // HDR
      "chunk-T6SD37JZ.js:163", // launchOwnedBrowser (check, snapshot, sonda gestionada)
    ]);
    const lineas = lineasDist();
    for (const s of sitios.slice(1)) {
      const [f, n] = s.split(":");
      const ventana = lineas.filter((l) => l.fichero === f && l.linea >= Number(n) - 8 && l.linea <= Number(n) + 6).map((l) => l.texto);
      expect(ventana.join("\n"), s).toContain("withHyperframesBrowserMarker(");
    }
  });

  it("inventario: \"--single-process\" solo en sandboxDenied (HIGH-1)", () => {
    expect(inventario(/"--single-process"/)).toEqual(["chunk-DKPNNYBZ.js:10"]);
  });

  describe.runIf(process.platform === "win32")("flags de Chrome en Windows", () => {
    let marcador: Marcador;
    let casos: [string, Args][];
    beforeAll(async () => {
      marcador = ((await import(chunk("chunk-K4MJX7SR.js"))) as { withHyperframesBrowserMarker: Marcador }).withHyperframesBrowserMarker;
      const m = (await import(chunk("chunk-RDDVQSNQ.js"))) as {
        buildChromeArgs: (o: object, c: object) => Args;
        buildHdrChromeArgs: (w: number, h: number) => Args;
      };
      const o = { width: 540, height: 960, captureMode: "screenshot" };
      casos = [
        ["render", m.buildChromeArgs(o, {})],
        ["render con GPU", m.buildChromeArgs(o, { browserGpuMode: "hardware" })],
        ["render sin GPU", m.buildChromeArgs(o, { disableGpu: true })],
        ["HDR", m.buildHdrChromeArgs(100, 100)],
        ["efectos de audio", ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"]],
      ];
    });

    it("los args salen con sandbox de renderer y red cerrada", () => {
      for (const [nombre, args] of casos) {
        expect(args, nombre).toContain("--no-sandbox"); // si no, el caso no prueba nada
        const a = marcador(args);
        expect(a, nombre).not.toContain("--no-sandbox");
        expect(a, nombre).not.toContain("--disable-setuid-sandbox");
        for (const f of [GPU_SIN_SANDBOX, ...FLAGS_RED]) expect(a.filter((x) => x === f), `${nombre}: ${f}`).toHaveLength(1);
        expect(a.at(-1), nombre).toBe(MARCADOR);
      }
    });

    it("no debilita lanzamientos que ya tenían sandbox", () => {
      const a = marcador(["--headless"]);
      expect(a).not.toContain(GPU_SIN_SANDBOX);
      for (const f of FLAGS_RED) expect(a).toContain(f);
    });

    it("es idempotente (doble paso por el marcador)", () => {
      for (const [nombre, args] of [...casos, ["con sandbox", ["--headless"]] as [string, Args]]) {
        expect(marcador(marcador(args)), nombre).toEqual(marcador(args));
      }
    });

    it("anula proxies propios de HyperFrames", () => {
      const a = marcador([
        "--no-sandbox",
        "--proxy-server=http://203.0.113.1:8080",
        "--proxy-bypass-list=*",
        "--no-proxy-server",
        "--proxy-pac-url=http://203.0.113.1/p.pac",
        "--host-resolver-rules=MAP * 203.0.113.1",
        "--force-webrtc-ip-handling-policy=default",
      ]);
      expect(a.filter((x) => x.startsWith("--proxy-server"))).toEqual([PROXY_NULO]);
      expect(a.filter((x) => x.startsWith("--proxy-bypass-list"))).toEqual([BYPASS]);
      expect(a.filter((x) => x.startsWith("--proxy-pac-url"))).toEqual([]);
      expect(a).not.toContain("--no-proxy-server");
      expect(a.filter((x) => x.startsWith("--host-resolver-rules"))).toEqual([RESOLVER]);
      expect(a.filter((x) => x.startsWith("--force-webrtc-ip-handling-policy="))).toEqual([WEBRTC]);
    });

    it("rechaza un solo proceso: el renderer saldría del sandbox (HIGH-1)", async () => {
      const { oneProcessOverPipe } = (await import(chunk("chunk-DKPNNYBZ.js"))) as { oneProcessOverPipe: (o: { args: Args }) => { args: Args } };
      expect(() => marcador(oneProcessOverPipe({ args: ["--no-sandbox"] }).args)).toThrow(/--single-process.*I3/);
      expect(() => marcador(["--in-process-gpu"])).toThrow(/I3/);
    });
  });
});

/** Ejecuta `código` (ESM) en un node hijo y devuelve la última línea JSON que imprime. */
function enHijo(codigo: string, env: NodeJS.ProcessEnv): { ok?: boolean; ruta?: string; error?: string } {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", codigo], { env, encoding: "utf8", timeout: 60000, windowsHide: true });
  const linea = r.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).at(-1);
  if (!linea) throw new Error(`el hijo no dio respuesta (código ${r.status}): ${r.stderr}`);
  return JSON.parse(linea);
}

const llamada = (fichero: string, expr: string): string =>
  `import(${JSON.stringify(chunk(fichero))}).then((m) => ${expr}).then(` +
  `(r) => console.log(JSON.stringify({ ok: true, ruta: r?.executablePath })),` +
  `(e) => console.log(JSON.stringify({ error: String(e?.message ?? e) })));`;

describe("I13: HyperFrames no busca otro navegador", () => {
  let tmp: string;
  let casa: string;
  let senuelo: string;
  let sumi: Sumidero;
  let entorno: (extra: Record<string, string | undefined>) => NodeJS.ProcessEnv;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video i13 "));
    casa = path.join(tmp, "casa");
    const pf = path.join(tmp, "pf");
    fs.mkdirSync(casa);
    fs.mkdirSync(path.join(tmp, "pf86"));
    fs.mkdirSync(path.join(tmp, "lad"));
    fs.mkdirSync(path.join(pf, "Google", "Chrome", "Application"), { recursive: true });
    // Señuelo: a findSystemBrowser le basta con que exista (Program Files simulado con ProgramW6432).
    senuelo = path.join(pf, "Google", "Chrome", "Application", "chrome.exe");
    fs.writeFileSync(senuelo, "");
    sumi = await sumidero();
    const proxy = `http://127.0.0.1:${sumi.puerto}`;
    entorno = (extra) =>
      entornoLimpio(process.env, {
        ...ENTORNO_CERRADO,
        USERPROFILE: casa,
        HOME: casa,
        LOCALAPPDATA: path.join(tmp, "lad"),
        ProgramW6432: pf,
        PROGRAMFILES: pf,
        "PROGRAMFILES(X86)": path.join(tmp, "pf86"),
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        ...extra,
      });
  });

  afterAll(async () => {
    await sumi?.cerrar();
    if (tmp?.startsWith(os.tmpdir())) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Error de I13 que nombra la variable y no menciona el señuelo (salvo dentro del propio valor rechazado). */
  const fallaSinSenuelo = (r: { ok?: boolean; ruta?: string; error?: string }, nombre = "HYPERFRAMES_BROWSER_PATH", valor?: string) => {
    expect(r.ok, JSON.stringify(r)).toBeUndefined();
    expect(r.error).toContain(nombre);
    expect(r.error).toContain("no es la ruta absoluta de un fichero");
    expect(valor ? r.error!.replace(valor, "") : r.error).not.toContain(senuelo);
  };
  /** Rutas de todo lo que hay bajo `dir`. */
  const arbol = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? [p, ...arbol(p)] : [p];
    });
  const buscar = (extra: Record<string, string | undefined>) => enHijo(llamada("chunk-G6W55MTX.js", "m.findBrowser()"), entorno(extra));

  it("control: sin la variable, findBrowser encontraría el señuelo", () => {
    expect(buscar({})).toEqual({ ok: true, ruta: senuelo });
  });

  it("control: con la ruta absoluta de un fichero, la usa", () => {
    expect(buscar({ HYPERFRAMES_BROWSER_PATH: senuelo })).toEqual({ ok: true, ruta: senuelo });
  });

  it("variable con ruta inexistente: error y ni rastro del señuelo", () => {
    fallaSinSenuelo(buscar({ HYPERFRAMES_BROWSER_PATH: path.join(tmp, "no-existe.exe") }));
  });

  it("variable apuntando a una carpeta: error", () => {
    fallaSinSenuelo(buscar({ HYPERFRAMES_BROWSER_PATH: tmp }));
  });

  it("variable vacía: error", () => {
    fallaSinSenuelo(buscar({ HYPERFRAMES_BROWSER_PATH: "" }));
  });

  it("PRODUCER_HEADLESS_SHELL_PATH también se valida (inexistente y vacía)", () => {
    fallaSinSenuelo(buscar({ PRODUCER_HEADLESS_SHELL_PATH: path.join(tmp, "no-existe.exe") }), "PRODUCER_HEADLESS_SHELL_PATH");
    fallaSinSenuelo(buscar({ PRODUCER_HEADLESS_SHELL_PATH: "" }), "PRODUCER_HEADLESS_SHELL_PATH");
    // Aunque HYPERFRAMES_BROWSER_PATH sea buena, la otra no puede estar rota.
    fallaSinSenuelo(buscar({ HYPERFRAMES_BROWSER_PATH: senuelo, PRODUCER_HEADLESS_SHELL_PATH: "" }), "PRODUCER_HEADLESS_SHELL_PATH");
  });

  describe.runIf(process.platform === "win32")("forma de la ruta en Windows (LOW-1)", () => {
    it("ruta relativa: error aunque el fichero exista", () => {
      const env = entorno({ HYPERFRAMES_BROWSER_PATH: "chrome.exe" });
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", llamada("chunk-G6W55MTX.js", "m.findBrowser()")], {
        env,
        cwd: path.dirname(senuelo),
        encoding: "utf8",
        windowsHide: true,
      });
      fallaSinSenuelo(JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!));
    });

    it("ruta UNC: error", () => {
      fallaSinSenuelo(buscar({ HYPERFRAMES_BROWSER_PATH: "\\\\127.0.0.1\\c$\\x\\chrome.exe" }));
    });

    it("flujo alternativo (ADS, «:» fuera de la unidad): error", () => {
      fs.writeFileSync(`${senuelo}:flujo`, "x");
      fallaSinSenuelo(buscar({ HYPERFRAMES_BROWSER_PATH: `${senuelo}:flujo` }), "HYPERFRAMES_BROWSER_PATH", `${senuelo}:flujo`);
    });

    it("enlace simbólico a un fichero: error", (ctx) => {
      const enlace = path.join(tmp, "enlace.exe");
      // Crear el enlace necesita el modo de desarrollador o ser administrador. En la CI (los runners lo
      // son) un EPERM es un fallo; en un equipo de desarrollo se salta con aviso explícito, no en silencio.
      try {
        fs.symlinkSync(senuelo, enlace, "file");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM" || process.env.CI) throw e;
        process.stderr.write("AVISO: sin permiso para crear enlaces simbólicos (modo de desarrollador); se salta el caso del enlace de I13.\n");
        ctx.skip();
      }
      expect(fs.lstatSync(enlace).isSymbolicLink()).toBe(true);
      fallaSinSenuelo(buscar({ HYPERFRAMES_BROWSER_PATH: enlace }));
    });
  });

  it("ensureBrowser tampoco descarga ni toca la caché", () => {
    const r = enHijo(llamada("chunk-G6W55MTX.js", "m.ensureBrowser()"), entorno({ HYPERFRAMES_BROWSER_PATH: path.join(tmp, "no-existe.exe") }));
    fallaSinSenuelo(r);
    expect(sumi.conexiones()).toBe(0);
    expect(fs.readdirSync(casa)).toEqual([]);
  });

  it("HDR: con la variable definida, el render HDR falla en vez de buscar Chrome en la caché (MEDIUM-3)", () => {
    for (const valor of [senuelo, ""]) {
      const r = enHijo(llamada("chunk-RDDVQSNQ.js", "m.launchHdrBrowser(16, 16)"), entorno({ HYPERFRAMES_BROWSER_PATH: valor }));
      expect(r.error, JSON.stringify(r)).toContain("el render HDR no está soportado en modo cerrado (I13)");
    }
  });

  it(
    "prueba negativa de la spec: render con ruta inexistente y chrome.exe en Program Files",
    async () => {
      const comp = path.join(tmp, "comp");
      fs.mkdirSync(comp);
      fs.writeFileSync(
        path.join(comp, "index.html"),
        `<!doctype html><html><body><div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="540" data-height="960" style="width:540px;height:960px;background:#123"></div>` +
          `<script>window.__timelines={};</script></body></html>`,
      );
      const mp4 = path.join(tmp, "salida.mp4");
      const r = await ejecutar(process.execPath, [HYPERFRAMES_BIN, "render", comp, "-o", mp4, "--fps", "30", "--format", "mp4", "--quality", "delivery"], {
        cwd: comp,
        env: entorno({ HYPERFRAMES_BROWSER_PATH: path.join(tmp, "no-existe.exe") }),
        timeoutMs: 120000,
      });
      const salida = r.stdout + r.stderr;
      expect(r.timeout).toBeFalsy();
      expect(r.code, salida).not.toBe(0);
      expect(salida).toContain("HYPERFRAMES_BROWSER_PATH");
      expect(salida).not.toContain(senuelo);
      expect(fs.existsSync(mp4)).toBe(false);
      // La CLI deja su estado en HOME (.hyperframes/config.json; redirigir HOME es de W1.6), pero
      // ninguna caché de navegador ni ningún ejecutable: no ha buscado ni descargado otro Chrome.
      const dejado = arbol(casa).map((p) => path.relative(casa, p));
      expect(dejado.filter((p) => /(^|[\\/])\.cache\b|chrome|puppeteer|\.(exe|dll|zip)$/i.test(p)), dejado.join(", ")).toEqual([]);
      expect(sumi.conexiones()).toBe(0);
    },
    150000,
  );
});

describe("I7: servidores de HyperFrames solo en loopback", () => {
  it("listenOnFreePort escucha en 127.0.0.1", async () => {
    const { listenOnFreePort } = (await import(chunk("chunk-OZUAVHFE.js"))) as { listenOnFreePort: (s: http.Server, p: number) => Promise<number> };
    const s = http.createServer();
    try {
      await listenOnFreePort(s, 0);
      expect((s.address() as net.AddressInfo).address).toBe("127.0.0.1");
    } finally {
      s.close();
    }
  });

  it("createFileServer del motor de HyperFrames escucha en 127.0.0.1", async () => {
    const ip = ipNoInterna();
    const { createFileServer } = (await import(chunk("chunk-RDDVQSNQ.js"))) as {
      createFileServer: (o: object) => Promise<{ port: number; close: () => unknown }>;
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video i7 "));
    const srv = await createFileServer({ projectDir: tmp, compiledDir: tmp, port: 0 });
    try {
      expect(await conecta("127.0.0.1", srv.port)).toBe(true);
      expect(await conecta(ip, srv.port)).toBe(false);
    } finally {
      await srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("todo servidor TCP del dist declara host loopback", () => {
    const sinHost = lineasDist()
      .filter((l) => /\.listen\(|\bserve\(\{/.test(l.texto) && !/127\.0\.0\.1/.test(l.texto))
      .map((l) => `${l.fichero}:${l.linea}`);
    expect(sinHost).toEqual([
      "chunk-543U46OR.js:28", // probe.listen({ port, host }): host = 127.0.0.1 salvo HYPERFRAMES_PREVIEW_HOST (fuera de la lista blanca de I5)
      "chunk-543U46OR.js:249", // server.listen(port, host): ídem (vista previa de HyperFrames)
      "warmCheck.js:210", // tubería con nombre, no TCP
    ]);
  });
});
