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
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../src/raiz.js";
import {
  accesos,
  BYPASS,
  chunk,
  cli,
  conecta,
  conEspia,
  copiaSinParche,
  DIST,
  ENTORNO_CERRADO,
  entornoLimpio,
  FLAGS_RED,
  GPU_SIN_SANDBOX,
  HASHES,
  HF,
  MARCADOR,
  PARCHE,
  PROXY_NULO,
  QUIC,
  RENDER_ESPIADO,
  RESOLVER,
  sumidero,
  type Sumidero,
  WEBRTC,
} from "./hyperframes-comun.js";

type Args = string[];
type Marcador = (args?: Args) => Args;

const MARCA_PARCHE = "SEO Studio (parche local, SEO-109";
/** Ficheros que toca el parche, relativos a node_modules/hyperframes (las claves del .sha256.json). */
const PARCHEADOS = [
  "dist/chunk-4UMPIPCQ.js",
  "dist/chunk-CMDVJP4T.js",
  "dist/chunk-K4MJX7SR.js",
  "dist/chunk-L5MFWGGU.js",
  "dist/chunk-MFHYBSJC.js",
  "dist/chunk-N7ZMDVAK.js",
  "dist/chunk-OZUAVHFE.js",
  "dist/chunk-PBNWRWKA.js",
  "dist/chunk-RDDVQSNQ.js",
  "dist/chunk-X7RXXBYM.js",
  "dist/cli.js",
  "dist/seo-studio-cierre.js",
  "dist/warmCheck.js",
];
/** El error de todo hunk que corta una salida de red de Node (I14). */
const CERRADO = "SEO Studio: HyperFrames no descarga recursos remotos en modo cerrado (I14)";

let cacheLineas: { fichero: string; linea: number; texto: string }[] | undefined;
/** Los `dist/*.js` de HyperFrames (sin las skills) con sus líneas. */
function lineasDist(): { fichero: string; linea: number; texto: string }[] {
  if (cacheLineas) return cacheLineas;
  const out: { fichero: string; linea: number; texto: string }[] = [];
  for (const f of fs.readdirSync(DIST).filter((n) => n.endsWith(".js")).sort()) {
    fs.readFileSync(path.join(DIST, f), "utf8")
      .split("\n")
      .forEach((texto, i) => out.push({ fichero: f, linea: i + 1, texto }));
  }
  cacheLineas = out;
  return out;
}

type Linea = { fichero: string; linea: number; texto: string };

/** Diferencia entre lo que casa con `re` en `lineas` y la lista cerrada: lo sin clasificar y lo que falta. */
function sinClasificar(lineas: Linea[], re: RegExp, lista: Record<string, Record<string, number[]>>): string[] {
  const halladas = lineas.filter((l) => re.test(l.texto)).map((l) => `${l.fichero}:${l.linea}`);
  const esperadas = Object.values(lista).flatMap((g) => Object.entries(g).flatMap(([f, ls]) => ls.map((n) => `${f}:${n}`)));
  return [...halladas.filter((h) => !esperadas.includes(h)), ...esperadas.filter((e) => !halladas.includes(e)).map((e) => `falta ${e}`)];
}

/** «fichero:línea» de cada línea del dist que casa con `re`. */
function inventario(re: RegExp): string[] {
  return lineasDist()
    .filter((l) => re.test(l.texto))
    .map((l) => `${l.fichero}:${l.linea}`);
}

/**
 * Formas conocidas de abrir red desde Node, también por alias o importación dinámica. No es «cualquier
 * forma»: PROCESOS_NODE cubre los hijos, y queda fuera lo que no sea dist/*.js de primer nivel
 * (@puppeteer/browsers y puppeteer-core, por ejemplo).
 */
const RED_NODE = /\b(fetch|fetchImpl|doFetch|axios|undici)\b|\bhttps?\.(get|request)\b|\bhttps?(Get|Request)\b|\b(net|tls)\.(connect|createConnection)\b|\bdns\.[a-zA-Z]+|\bnew (dns\.)?Resolver\b|\bnew (WebSocket|EventSource)\b|(\bfrom|\bimport|require\(|import\()\s*["'`](node:)?(https?|http2|net|tls|dgram|dns(\/promises)?|undici|ws)["'`]|\bgetBuiltinModule\b|\b(http2\.(connect|createSecureServer)|dgram\.createSocket)\b|\bimport\(\s*(?!["'`]\.\.?\/)|["'`](curl|wget|certutil|bitsadmin)(\.exe)?["'`]/;
/**
 * Toda llamada a child_process y toda importación suya, también con el alias numerado del empaquetador y las
 * versiones promisificadas: `execFileAsync(` y la propia `promisify(execFile)`. Un alias con otro nombre se ve
 * en su declaración, no en cada llamada.
 */
const PROCESO_NODE = /(?<![\w$])(spawn|spawnSync|execSync|execFile|execFileSync|fork)\d*\(|(?<![.\w$])exec\d*\(|(\bfrom|\bimport|require\(|import\()\s*["'`](node:)?child_process["'`]|(?<![.\w$])exec\w*Async\d*\(|\bpromisify\d*\(\s*(exec|execFile|spawn)\d*\s*\)/;

// Lista cerrada de TODAS las coincidencias de RED_NODE en el dist parcheado. Una línea nueva o movida
// rompe el test: tras subir de versión hay que clasificarla, no copiarla. Detalle en el informe de W1.3.
const SALIDAS_NODE: Record<string, Record<string, number[]>> = {
  // Alcanzables desde render/check/snapshot y cortadas por un hunk (no llegan a ejecutarse).
  cerradas: {
    "chunk-L5MFWGGU.js": [6643], // inlineExternalScripts
    "chunk-N7ZMDVAK.js": [4181, 4200, 4571, 4577], // Google Fonts: fetchFontResource lanza antes
    "chunk-RDDVQSNQ.js": [11429], // fetchWithValidatedRedirects: pasa antes por assertPublicHttpsUrl
  },
  // Alcanzables, pero solo contra el servidor propio en 127.0.0.1 o por un par de sockets en memoria.
  loopback: {
    "chunk-2S263R6D.js": [40, 69],
    "chunk-3R6SXPHD.js": [93, 166],
    "chunk-543U46OR.js": [13, 14, 49, 139, 228, 236, 315, 324, 335, 345, 349, 370, 372, 378, 380],
    "chunk-AJSU6KGS.js": [259],
    "chunk-RDDVQSNQ.js": [5745],
  },
  // RESIDUAL: alcanzables, y solo las apaga el entorno (ENTORNO_CERRADO); W1.6 tiene que fijarlo siempre.
  soloEntorno: {
    "chunk-FJW757TF.js": [86, 111], // telemetría: HYPERFRAMES_NO_TELEMETRY / DO_NOT_TRACK
    "chunk-G6W55MTX.js": [140], // @puppeteer/browsers: ensureBrowser no llega con HYPERFRAMES_BROWSER_PATH (I13, W1.6 la fija siempre)
    "chunk-K4WIOZFP.js": [9, 19], // hostAnswers: DNS de telemetría, skills y versión, con sus mismas variables
    "chunk-NNLQTG3M.js": [293], // skills: HYPERFRAMES_SKIP_SKILLS / sin comprobación de versión
    "chunk-XOM3XTJ4.js": [198], // versión nueva: HYPERFRAMES_NO_UPDATE_CHECK
    "renderSetupWorker.js": [49], // ídem: instala el navegador solo si lo pide ensureBrowser
  },
  // Código que corre dentro de Chrome (sujeto a CSP, sandbox y proxy nulo), no en Node.
  enChrome: {
    "capture-KKD5GMAF.js": [1690],
    "chunk-KLIPVNCO.js": [4574],
    "chunk-RDDVQSNQ.js": [4024, 6138],
    "hyperframe.runtime.iife.js": [43, 366, 373, 1130],
  },
  // Otros comandos o flags que el motor no usa con render/check/snapshot.
  otrosComandos: {
    "audio-VYWWM4DB.js": [309, 317, 325, 336, 1789, 1804], // servicio de pago de `audio` (ver informe)
    "capture-KKD5GMAF.js": [210, 211, 1232],
    "catalog-6IJGNN3T.js": [492], // video_catalogo: no se registra en modo integrado (I14)
    "chunk-2MLMO25E.js": [10805], // lintMediaUrls: sin llamadores en el dist
    "chunk-4DGLKB2H.js": [2802],
    "chunk-6A45RKAK.js": [28, 32, 48],
    "chunk-7SXL476O.js": [9328, 9804],
    "chunk-CE7EQUBV.js": [14, 15, 39, 45, 59, 114, 122],
    "chunk-CZUAX3BV.js": [20, 24],
    "chunk-ELP5QZWL.js": [422, 426, 446, 543, 664, 759, 767, 785, 824, 887, 893, 919, 926, 963, 971],
    "chunk-HJAJ6W4V.js": [34],
    "chunk-MNNK7RV5.js": [55],
    "chunk-N7ZMDVAK.js": [529, 530, 578, 579, 2085, 2086, 2134, 2135], // cargador wasm: el binario va en data:
    "chunk-RDDVQSNQ.js": [9077], // declareProbeFactsUrl: solo renders distribuidos
    "chunk-SFYLZX5C.js": [31, 33, 34, 35, 120, 129, 196],
    "chunk-TSJVPPXT.js": [111, 139],
    "chunk-WQ6ZXHFQ.js": [11, 50],
    "chunk-WYB3VKLK.js": [303],
    "cloudrun-7UOH335V.js": [110, 111],
    "deploy-NXD3Q3KD.js": [56],
    "feedback-K5ZMMLTA.js": [94, 119],
    "lambda-SBNUYEQE.js": [245],
    "progress-PX3PVAIM.js": [23],
    "render-5J5PP3UK.js": [372, 374, 659, 732],
    "render-QS3YJCBR.js": [50],
    "render-batch-Q2LQ3D4P.js": [57],
    "sites-Q2S3DZY4.js": [20],
    "studioServer-ZS5RA6U3.js": [1470],
    "timeline-BDO5DYWP.js": [1264, 1272],
    "usage-HG4WMM7A.js": [2116],
  },
  // No abren red: homónimos, textos de error, comentarios, importaciones de librerías locales, servidores y sockets locales.
  sinRed: {
    "capture-252WNPCD.js": [155, 269],
    "capture-KKD5GMAF.js": [378, 1688],
    "catalog-6IJGNN3T.js": [997],
    "chunk-2MLMO25E.js": [6333, 6349, 9871, 9876],
    "chunk-2RY2LWAA.js": [3336, 3340, 3354, 3374, 3383, 3427, 3431],
    "chunk-4DGLKB2H.js": [2853, 2914, 2952, 2955],
    "chunk-6ZFDNEMY.js": [295],
    "chunk-7SXL476O.js": [8414, 9938],
    "chunk-CMDVJP4T.js": [224],
    "chunk-DEVZJ4AL.js": [228],
    "chunk-DPVXBVLL.js": [14766, 14771, 16138, 16842, 16843, 16844, 16973],
    "chunk-EXAX37XR.js": [242, 243],
    "chunk-FULMZCDW.js": [711],
    "chunk-L5MFWGGU.js": [1024, 16104, 17412, 17826],
    "chunk-MFHYBSJC.js": [840, 2091],
    "chunk-MOEGCMKI.js": [93],
    "chunk-N7ZMDVAK.js": [4120, 4138, 4206],
    "chunk-RDDVQSNQ.js": [915, 918, 5497, 5820, 6218, 11090, 11184, 11459, 11516, 11519, 12644, 18029, 18314, 18321],
    "chunk-WYB3VKLK.js": [277, 297],
    "cli.js": [168],
    "get-JVIDYMVP.js": [64],
    "help-XPPSLIRY.js": [134],
    "logout-JYFWWUGK.js": [90],
    "motionShot-DC47S7BT.js": [312],
    "play-S562STR4.js": [213, 214, 240],
    "present-PGOHZT3L.js": [182, 183, 204],
    "preview-JU75H4QN.js": [1792, 1858, 1861],
    "render-5J5PP3UK.js": [1510],
    "skills-3RFMPMJA.js": [375],
    "snapshot-5PHA43DK.js": [412, 895],
    "studioServer-ZS5RA6U3.js": [641, 1224],
    "timeline-BDO5DYWP.js": [1267, 1268],
    "video-ECWXMY4F.js": [63],
    "warmCheck.js": [123, 160],
    "warmCheckClient.js": [24],
  },
};

// Lista cerrada de todo proceso hijo e importación de child_process: un spawn nuevo, aunque no nombre la red
// (npm, curl con la orden en una variable), rompe el test y hay que clasificarlo.
const PROCESOS_NODE: Record<string, Record<string, number[]>> = {
  // RESIDUAL: npm install de opcionales (HYPERFRAMES_NO_OPTIONAL_INSTALL), autoactualización y comprobaciones
  // en segundo plano (HYPERFRAMES_NO_AUTO_INSTALL, HYPERFRAMES_NO_UPDATE_CHECK) y envío de telemetría.
  soloEntorno: {
    "autoUpdate-GJUDDLLO.js": [29, 56, 112, 172],
    "backgroundChecks-BTMSW34Z.js": [26, 48],
    "chunk-EXAX37XR.js": [187],
    "chunk-FJW757TF.js": [107],
  },
  // Del grafo de render/check/snapshot: ffmpeg, ffprobe, Chrome, sondas de sistema con orden constante, y
  // ramas que no se dan en el motor (docker con --docker, apt-get y ps fuera de Windows). Sin red propia.
  locales: {
    "chunk-2MLMO25E.js": [3893, 10841, 10843, 10883, 10993],
    "chunk-4CY5RXXC.js": [18, 34, 57, 88, 110, 126, 140, 169],
    "chunk-4UMPIPCQ.js": [9, 55],
    "chunk-543U46OR.js": [15, 18, 109, 120],
    "chunk-5QKJPCQ4.js": [21],
    "chunk-7FMUTGOH.js": [9, 184],
    "chunk-7SXL476O.js": [424, 436, 3682, 3689, 4322, 8913, 9119, 9154, 9177],
    "chunk-AXEEZKIL.js": [43, 46, 382, 843, 1189],
    "chunk-CMDVJP4T.js": [42, 561],
    "chunk-EXAX37XR.js": [12],
    "chunk-FJW757TF.js": [43],
    "chunk-G6W55MTX.js": [24, 300, 443],
    "chunk-KGPLIH7B.js": [9, 46, 68],
    "chunk-L5MFWGGU.js": [8783, 9174, 13968, 14190],
    "chunk-QSFWGZG6.js": [15, 392, 397],
    "chunk-RDDVQSNQ.js": [680, 1490, 4768, 4816, 4929, 4935, 4990, 4997, 8264, 8492, 8578, 8712, 8776, 8828, 8907, 9101, 10504, 10750, 14854, 14895, 17222, 17228],
    "chunk-T6SD37JZ.js": [32, 37, 53],
    "chunk-UIOZIIB7.js": [9, 109],
    "chunk-VAS6HQX3.js": [9, 97],
    "chunk-VDVVQNTK.js": [28, 43, 341],
    "chunk-VEA7Z4PZ.js": [21, 46, 49, 151],
    "chunk-WMQNIQDJ.js": [407],
    "chunk-X7A7C4JS.js": [66, 71, 77, 96, 151],
    "chunk-XDMZY3H7.js": [42, 214],
    "chunk-ZF3R2IPC.js": [1132, 1134],
    "render-5J5PP3UK.js": [183, 277, 391, 435, 486, 522, 542],
    "render-VUVTK2JM.js": [971, 974, 990, 1031, 1624, 1646, 1758],
    "seo-studio-cierre.js": [7],
  },
  // Fuera del grafo de render/check/snapshot.
  otrosComandos: {
    "audio-VYWWM4DB.js": [118, 123],
    "chunk-2RT7MXFL.js": [18, 110],
    "chunk-5ETJX6WM.js": [9, 12, 32, 39, 59, 74],
    "chunk-BBUK6A7Q.js": [57, 68, 80, 196],
    "chunk-CPSGXAYD.js": [41, 124, 294],
    "chunk-DEVZJ4AL.js": [58, 77, 88],
    "chunk-HU2SPFNG.js": [12, 28, 34],
    "chunk-JZIEZCQM.js": [15, 33, 49],
    "chunk-MNNK7RV5.js": [18, 46],
    "chunk-NNLQTG3M.js": [20, 26, 303],
    "chunk-RW4DMP2Y.js": [30, 503],
    "chunk-SFYLZX5C.js": [30, 135],
    "chunk-X5HHHFTX.js": [34, 151, 278, 464, 486],
    "chunk-XNFDDVJS.js": [9, 14, 23, 80, 97, 119, 156],
    "cloudrun-7UOH335V.js": [57, 303, 309, 347],
    "deploy-NXD3Q3KD.js": [36, 125, 140, 183, 206, 339],
    "history-OFOPRD27.js": [62, 204],
    "init-NTIXWA3D.js": [186, 328, 393],
    "media-treatment-4OLWVHUY.js": [110, 153, 323],
    "media-use-JBN57JE3.js": [18, 78],
    "preview-JU75H4QN.js": [126, 146, 273, 1705, 1738],
    "skills-3RFMPMJA.js": [61, 349, 357, 366],
    "synthesize-QCRP3NI7.js": [24, 144],
    "upgrade-KIF5Z4J3.js": [43, 217],
    "usage-HG4WMM7A.js": [1725, 1918, 1965],
    "warmCheckClient.js": [21, 126],
  },
};

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
    expect(fs.readFileSync(PARCHE, "utf8"), "cabecera canónica del fichero nuevo").toContain("diff --git a/node_modules/hyperframes/dist/seo-studio-cierre.js b/node_modules/hyperframes/dist/seo-studio-cierre.js\nnew file mode 100644\n--- /dev/null\n+++ b/node_modules/hyperframes/dist/seo-studio-cierre.js\n@@ -0,0 +1,88 @@\n");
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

  describe("scripts/aplicar-parche.mjs", () => {
    const script = path.join(SERVER_ROOT, "scripts", "aplicar-parche.mjs");
    const aplicar = (dir?: string) => spawnSync(process.execPath, [script, ...(dir ? [dir] : [])], { encoding: "utf8", windowsHide: true });
    /** Copia solo lo parcheado, tal como está ahora, en una carpeta con node_modules/hyperframes. */
    const copia = (): string => {
      const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "video parche "));
      for (const rel of [...PARCHEADOS, "bin/hyperframes.mjs"]) {
        fs.mkdirSync(path.dirname(path.join(raiz, "node_modules", "hyperframes", rel)), { recursive: true });
        fs.copyFileSync(path.join(HF, rel), path.join(raiz, "node_modules", "hyperframes", rel));
      }
      return raiz;
    };

    it("es idempotente sobre node_modules", () => {
      const r = aplicar();
      expect(r.status, r.stderr).toBe(0);
    });

    it("aplica el parche sobre el dist original, sin convertir finales de línea", () => {
      const raiz = copia();
      try {
        const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(raiz) };
        const q = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--reverse", PARCHE], { cwd: raiz, env, encoding: "utf8" });
        expect(q.status, q.stderr).toBe(0);
        expect(fs.readFileSync(path.join(raiz, "node_modules", "hyperframes", PARCHEADOS[0]), "utf8")).not.toContain(MARCA_PARCHE);
        const r = aplicar(raiz);
        expect(r.status, r.stderr).toBe(0);
        expect(fs.readFileSync(path.join(raiz, "node_modules", "hyperframes", PARCHEADOS[0]), "utf8")).toContain(MARCA_PARCHE);
      } finally {
        fs.rmSync(raiz, { recursive: true, force: true });
      }
    });

    it("LOW-6: falla con error claro si git solo se resuelve dentro de la carpeta destino", () => {
      const raiz = copia();
      try {
        fs.writeFileSync(path.join(raiz, process.platform === "win32" ? "git.exe" : "git"), "");
        const env = { ...entornoLimpio(process.env, { PATH: raiz }) };
        const r = spawnSync(process.execPath, [script, raiz], { encoding: "utf8", windowsHide: true, cwd: raiz, env });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("git no se resuelve fuera de");
      } finally {
        fs.rmSync(raiz, { recursive: true, force: true });
      }
    });

    it("falla con bin/hyperframes.mjs cambiado: sinParche también se comprueba", () => {
      const raiz = copia();
      try {
        fs.appendFileSync(path.join(raiz, "node_modules", "hyperframes", "bin", "hyperframes.mjs"), "// tocado");
        const r = aplicar(raiz);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("bin/hyperframes.mjs: SHA-256 inesperado");
      } finally {
        fs.rmSync(raiz, { recursive: true, force: true });
      }
    });

    it.each(["ficheros", "sinParche"])("R0 M1: un JSON sin %s no da por bueno el dist", (clave) => {
      const servidor = fs.mkdtempSync(path.join(os.tmpdir(), "video hashes "));
      const raiz = copia();
      try {
        fs.cpSync(path.dirname(script), path.join(servidor, "scripts"), { recursive: true });
        fs.cpSync(path.dirname(PARCHE), path.join(servidor, "patches"), { recursive: true });
        const j = JSON.parse(fs.readFileSync(HASHES, "utf8")) as Record<string, unknown>;
        delete j[clave];
        fs.writeFileSync(path.join(servidor, "patches", path.basename(HASHES)), JSON.stringify(j));
        const r = spawnSync(process.execPath, [path.join(servidor, "scripts", "aplicar-parche.mjs"), raiz], { encoding: "utf8", windowsHide: true });
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("no lista ficheros");
      } finally {
        fs.rmSync(servidor, { recursive: true, force: true });
        fs.rmSync(raiz, { recursive: true, force: true });
      }
    });

    it("falla con un dist que no cuadra", () => {
      const raiz = copia();
      try {
        const rel = path.join(raiz, "node_modules", "hyperframes", PARCHEADOS[0]);
        fs.appendFileSync(rel, "// tocado");
        const r = aplicar(raiz);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("Parche de HyperFrames sin aplicar");
      } finally {
        fs.rmSync(raiz, { recursive: true, force: true });
      }
    });
  });

  // Listas cerradas por fichero y línea (dist ya parcheado): cualquier aparición nueva tras una subida
  // de versión rompe el test y obliga a revisar el parche.
  it("inventario: literales \"--no-sandbox\" solo en los sitios conocidos", () => {
    expect(inventario(/"--no-sandbox"/)).toEqual([
      "capture-KKD5GMAF.js:199", // captura de webs, solo Linux (I14: el motor no la usa)
      "chunk-4UMPIPCQ.js:54", // shellStarts: solo sin HYPERFRAMES_BROWSER_PATH (desarrollo), --dump-dom about:blank
      "chunk-K4MJX7SR.js:41", // el propio hunk A (lo detecta para quitarlo)
      "chunk-RDDVQSNQ.js:1254", // getHardwareGpuProbeArgs → marcador
      "chunk-RDDVQSNQ.js:1531", // buildChromeArgs → marcador
      "chunk-RDDVQSNQ.js:15810", // efectos de audio → marcador
      "chunk-RDDVQSNQ.js:18344", // buildHdrChromeArgs → marcador (HDR cerrado por el hunk B2)
    ]);
  });

  it("inventario: spawn/execFile de un ejecutable de navegador solo en los sitios conocidos", () => {
    expect(inventario(/\b(spawn|spawnSync|execFile|execFileSync|runCancellableProcess)\(\s*(options\.)?(binary|executablePath|browserPath|chromePath)\s*,/)).toEqual([
      "chunk-4UMPIPCQ.js:55", // shellStarts (ver arriba)
      "chunk-L5MFWGGU.js:14190", // ffmpeg -version (no es un navegador; casa por el nombre `binary`)
      "chunk-MNNK7RV5.js:46", // openBrowser de la vista previa de HyperFrames (el motor no la usa)
      "chunk-QVTCXN42.js:216", // preflight `--version` del navegador
    ]);
  });

  it("inventario: todo .launch del dist es conocido y los que lanzan Chrome pasan por el marcador", () => {
    const sitios = inventario(/\.launch\b/);
    expect(sitios).toEqual([
      "chunk-RDDVQSNQ.js:812", // this.options.launch: delega en launchManagedBrowser
      "chunk-RDDVQSNQ.js:938", // sonda de GPU (probeLifecycle.launch / ppt.launch)
      "chunk-RDDVQSNQ.js:1404", // launchBrowser del render
      "chunk-RDDVQSNQ.js:18331", // HDR
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
    let bypass: (url: string) => Args;
    let casos: [string, Args][];
    beforeAll(async () => {
      const k = (await import(chunk("chunk-K4MJX7SR.js"))) as { withHyperframesBrowserMarker: Marcador; seoStudioBypass: (url: string) => Args };
      marcador = k.withHyperframesBrowserMarker;
      bypass = k.seoStudioBypass;
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

    it("la sonda de preview lleva los flags de red del parche; en modo csp, proxy nulo y reglas igual (C4)", async () => {
      const { flagsDeRed } = await import("../scripts/sondear-preview.mjs");
      const a = marcador(["--proxy-bypass-list=<-loopback>;127.0.0.1:4321"]);
      for (const f of flagsDeRed("parche", 4321)) expect(a).toContain(f);
      expect(flagsDeRed("parche", 4321)).toEqual(expect.arrayContaining([PROXY_NULO, RESOLVER, "--proxy-bypass-list=<-loopback>;127.0.0.1:4321", WEBRTC, QUIC]));
      expect(flagsDeRed("csp", 4321)).toEqual(expect.arrayContaining([PROXY_NULO, RESOLVER]));
      expect(() => flagsDeRed("otra", 4321)).toThrow(/desconocidas/);
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

    const listas = (a: Args) => a.filter((x) => x.startsWith("--proxy-bypass-list"));

    it("sin URL no exceptúa nada: loopback va al proxy nulo (R2-M1)", () => {
      expect(listas(marcador(["--no-sandbox"]))).toEqual(["--proxy-bypass-list=<-loopback>"]);
    });

    it.each([
      ["http://localhost:51234", "localhost:51234"],
      ["http://127.0.0.1:51234/", "127.0.0.1:51234"],
    ])("exceptúa solo %s", (url, regla) => {
      expect(listas(marcador(["--no-sandbox", ...bypass(url)]))).toEqual([`--proxy-bypass-list=<-loopback>;${regla}`]);
    });

    it.each(["http://hyperframes-1.localhost/", "http://127.0.0.2:5000/", "http://ejemplo.test:5000/", "http://localhost/"])("sin excepción para %s", (url) => {
      expect(bypass(url)).toEqual([]);
    });

    it.each(["--proxy-bypass-list=<-loopback>;localhost:1;*", "--proxy-bypass-list=<-loopback>;localhost", "--proxy-bypass-list=*"])("rechaza %s y queda cerrado", (flag) => {
      expect(listas(marcador([flag]))).toEqual(["--proxy-bypass-list=<-loopback>"]);
    });

    it("la excepción propia sobrevive al doble paso por el marcador", () => {
      expect(listas(marcador(marcador(bypass("http://localhost:51234"))))).toEqual(["--proxy-bypass-list=<-loopback>;localhost:51234"]);
    });

    it("el prelanzamiento está anulado: prelaunchCompositionBrowser devuelve undefined", () => {
      // En un hijo y con una ruta que no existe: si el hunk faltara, ensureBrowser falla en vez de lanzar un navegador.
      const env = entornoLimpio(process.env, { ...ENTORNO_CERRADO, HYPERFRAMES_BROWSER_PATH: path.join(os.tmpdir(), "no-existe.exe") });
      const r = enHijo(llamada("chunk-CMDVJP4T.js", `({ executablePath: String(m.prelaunchCompositionBrowser("<html></html>", "software")) })`), env);
      expect(r).toEqual({ ok: true, ruta: "undefined" });
    });

    it("funde --disable-features: Chrome solo atiende el último", () => {
      const a = marcador(["--no-sandbox", "--disable-features=Translate,BackForwardCache", "--disable-features=Otra"]);
      expect(a.filter((x) => x.startsWith("--disable-features="))).toEqual(["--disable-features=Translate,BackForwardCache,Otra,WebRtcHideLocalIpsWithMdns"]);
      expect(marcador(["--headless"]).filter((x) => x.startsWith("--disable-features="))).toEqual(["--disable-features=WebRtcHideLocalIpsWithMdns"]);
    });

    it("el ancla no se come flags con el mismo prefijo", () => {
      expect(marcador(["--no-sandbox-and-elevated"])).toContain("--no-sandbox-and-elevated");
      expect(marcador(["--no-sandbox=1"])).not.toContain("--no-sandbox=1");
    });

    it("rechaza un solo proceso: el renderer saldría del sandbox (HIGH-1)", async () => {
      const { oneProcessOverPipe } = (await import(chunk("chunk-DKPNNYBZ.js"))) as { oneProcessOverPipe: (o: { args: Args }) => { args: Args } };
      expect(() => marcador(oneProcessOverPipe({ args: ["--no-sandbox"] }).args)).toThrow(/--single-process.*I3/);
      expect(() => marcador(["--in-process-gpu"])).toThrow(/I3/);
    });

    it("render_sin_puerto_cdp: rechaza --remote-debugging-port y --remote-debugging-address; el pipe sigue valiendo (R0-1)", () => {
      for (const flag of ["--remote-debugging-port=9222", "--remote-debugging-port", "--remote-debugging-port=0", "--remote-debugging-address=0.0.0.0", "-remote-debugging-port=9222", "/remote-debugging-port=9222", "--Remote-Debugging-Port=9222", "--REMOTE-DEBUGGING-ADDRESS=0.0.0.0", "/Remote-Debugging-Address", "--remote-debugging-port 9222", " --remote-debugging-port=9222"]) {
        expect(() => marcador(["--no-sandbox", flag]), flag).toThrow(/depuración remota.*I7/);
      }
      expect(marcador(["--remote-debugging-pipe"])).toContain("--remote-debugging-pipe");
      // El valor suelto tras el flag (forma con espacio en dos argumentos) no se confunde con el flag: el flag ya falla antes.
      expect(() => marcador(["--remote-debugging-port", "9222"])).toThrow(/depuración remota/);
    });
  });
});

/** Ejecuta `código` (ESM) en un node hijo y devuelve la última línea JSON que imprime. */
function enHijo(codigo: string, env: NodeJS.ProcessEnv): { ok?: boolean; ruta?: string; error?: string } {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", codigo], { env, encoding: "utf8", timeout: 60000, windowsHide: true });
  if (r.error) throw new Error(`no se pudo lanzar el hijo: ${r.error.message}`);
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

    it("LOW-3: la forma se comprueba antes de tocar el disco; un UNC no llega a lstat", () => {
      const log = path.join(tmp, "lstat.log");
      const env = conEspia(entorno({ HYPERFRAMES_BROWSER_PATH: "\\\\h.invalid\\s\\chrome.exe" }), log);
      fallaSinSenuelo(enHijo(llamada("chunk-G6W55MTX.js", "m.findBrowser()"), env));
      expect(accesos(log)).toEqual([]);
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
    const r = enHijo(llamada("chunk-RDDVQSNQ.js", "m.launchHdrBrowser(16, 16)"), entorno({ HYPERFRAMES_BROWSER_PATH: senuelo }));
    expect(r.error, JSON.stringify(r)).toContain("el render HDR no está soportado en modo cerrado (I13)");
    for (const nombre of ["HYPERFRAMES_BROWSER_PATH", "PRODUCER_HEADLESS_SHELL_PATH"]) {
      fallaSinSenuelo(enHijo(llamada("chunk-RDDVQSNQ.js", "m.launchHdrBrowser(16, 16)"), entorno({ [nombre]: "" })), nombre);
    }
  });

  it("resolveHeadlessShellPath valida igual que findBrowser (LOW-1)", () => {
    const resolver = (extra: Record<string, string>) => enHijo(llamada("chunk-RDDVQSNQ.js", "({ executablePath: m.resolveHeadlessShellPath() })"), entorno(extra));
    expect(resolver({ HYPERFRAMES_BROWSER_PATH: senuelo })).toEqual({ ok: true, ruta: senuelo });
    fallaSinSenuelo(resolver({ HYPERFRAMES_BROWSER_PATH: tmp }));
    fallaSinSenuelo(resolver({ PRODUCER_HEADLESS_SHELL_PATH: "" }), "PRODUCER_HEADLESS_SHELL_PATH");
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
      const r = await cli(["render", comp, "-o", mp4, "--fps", "30", "--format", "mp4", "--quality", "delivery"], {
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

describe("I14: HyperFrames no sale a la red desde Node", () => {
  let tmp: string;
  let sumi: Sumidero;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video i14 "));
    sumi = await sumidero();
    env = entornoLimpio(process.env, { ...ENTORNO_CERRADO, HYPERFRAMES_FONT_CACHE_DIR: path.join(tmp, "fuentes") });
  });

  afterAll(async () => {
    await sumi?.cerrar();
    if (tmp?.startsWith(os.tmpdir())) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Ejecuta `expr` (con `m`, el módulo de `fichero`) y devuelve el mensaje de error, o undefined si no falla. */
  const errorDe = (fichero: string, expr: string): string | undefined => enHijo(llamada(fichero, expr), env).error;

  it("assertPublicHttpsUrl lanza siempre", () => {
    expect(errorDe("chunk-RDDVQSNQ.js", `m.assertPublicHttpsUrl("https://example.com/")`)).toContain(CERRADO);
  });

  it.each([
    ["downloadToTemp", "chunk-RDDVQSNQ.js", (u: string) => `m.downloadToTemp("${u}", ${JSON.stringify(path.join(os.tmpdir(), "no-se-crea"))})`],
    ["ffprobe (vídeo)", "chunk-RDDVQSNQ.js", (u: string) => `m.extractMediaMetadata("${u}")`],
    ["ffprobe (audio)", "chunk-RDDVQSNQ.js", (u: string) => `m.extractAudioMetadata("${u}")`],
    ["ffprobe en mayúsculas", "chunk-RDDVQSNQ.js", (u: string) => `m.extractMediaMetadata("${u.replace("http", "HTTP")}")`],
    ["mediaPath (<img>, <video> y <audio> de check)", "chunk-X7RXXBYM.js", (u: string) => `m.mediaPath("${u}", ".")`],
  ])("%s: error sin conexión", (_n, fichero, expr) => {
    expect(errorDe(fichero, expr(`http://127.0.0.1:${sumi.puerto}/x.mp4`))).toContain(CERRADO);
    expect(errorDe(fichero, expr(`https://127.0.0.1:${sumi.puerto}/x.mp4`))).toContain(CERRADO);
    expect(sumi.conexiones()).toBe(0);
  });

  it("resolveMediaSrc: compileHtml no llega a sondear una URL", () => {
    const html = `<div data-composition-id="m" data-start="0" data-duration="1"><video id="v" src="http://127.0.0.1:${sumi.puerto}/x.mp4" data-start="0"></video></div>`;
    const expr = `m.compileHtml(${JSON.stringify(html)}, ".", async () => { throw new Error("ha sondeado la URL"); })`;
    expect(errorDe("chunk-MFHYBSJC.js", expr)).toContain(CERRADO);
  });

  it.each([
    ["<img>", "localizeRemoteImageSources", `<img src="https://example.invalid/x.png">`],
    ["<video>", "localizeRemoteMediaSources", `<video src="https://example.invalid/x.mp4"></video>`],
    ["@font-face", "localizeRemoteFontFaces", `<style>@font-face{font-family:x;src:url(https://example.invalid/x.woff2)}</style>`],
    ["<link rel=stylesheet>", "localizeRemoteFontFaces", `<link rel="stylesheet" href="https://example.invalid/x.css">`],
  ])("%s: la descarga fallida aborta en vez de avisar (I11)", (_n, funcion, html) => {
    const dir = JSON.stringify(path.join(tmp, "descargas"));
    expect(errorDe("chunk-L5MFWGGU.js", `m.${funcion}(${JSON.stringify(html)}, ${dir})`)).toContain(CERRADO);
  });

  it("fuentes: una familia sin @font-face no sale a Google Fonts; queda sin resolver, y aborta en modo estricto", () => {
    const html = `<html><head><style>p{font-family:"Fuente Sin Declarar",sans-serif}</style></head><body><p>x</p></body></html>`;
    const con = (extra: string) =>
      `m.injectDeterministicFontFaces(${JSON.stringify(html)}, { ${extra} fetchImpl: () => { console.log('{"error":"ha llamado a fetchImpl"}'); process.exit(0); } })`;
    expect(errorDe("chunk-N7ZMDVAK.js", con(""))).toBeUndefined();
    expect(errorDe("chunk-N7ZMDVAK.js", con("failClosedFontFetch: true,"))).toContain("(I14)");
  });

  it("inventario: toda salida de red de Node y todo proceso hijo están clasificados, por fichero y línea", () => {
    expect(sinClasificar(lineasDist(), RED_NODE, SALIDAS_NODE)).toEqual([]);
    expect(sinClasificar(lineasDist(), PROCESO_NODE, PROCESOS_NODE)).toEqual([]);
  });

  // Sobre una copia del texto: ninguna de estas líneas se ejecuta.
  it.each([
    `fetch("https://nuevo.invalid/");`,
    `import("node:dns").then((d) => d.lookup("nuevo.invalid", () => {}));`,
    `import("node:https").then((h) => h.default.get("https://nuevo.invalid/"));`,
    `import("node:tls").then((t) => t.connect(443, "nuevo.invalid"));`,
    `import("node:net").then((n) => n.createConnection(443, "nuevo.invalid"));`,
    `new WebSocket("wss://nuevo.invalid/");`,
    `new EventSource("https://nuevo.invalid/");`,
    `import("node:child_process").then((c) => c.spawn("curl", ["https://nuevo.invalid/"]));`,
    `const r = require("node:dns");`,
    `const r = require('https');`,
    `const r = require("net");`,
    `const r = require('tls');`,
    `import { lookup } from "dns";`,
    `import { request } from 'undici';`,
    `undici.request(u);`,
    `net.connect(443, h);`,
    `tls.connect(443, h);`,
    `dns.lookup(h, cb);`,
    `dns.resolve4(h, cb);`,
    `spawn("wget", [u]);`,
    `spawnSync("certutil.exe", ["-urlcache", u]);`,
    `execFile("bitsadmin", ["/transfer", u]);`,
    `spawn(orden, args);`,
    `spawn3(orden, args);`,
    `import(modulo);`,
    `const c = require("child_process");`,
    `const n = __require("net");`,
    `const n = process.getBuiltinModule("net");`,
    `import "node:dns";`,
    `import 'node:net';`,
    `await execFileAsync(orden);`,
    `const r = promisify(execFile);`,
    `const r = promisify3(exec2);`,
    `http2.connect("https://nuevo.invalid/");`,
    `dgram.createSocket("udp4");`,
  ])("el inventario no deja pasar: %s", (texto) => {
    const mutado = [...lineasDist(), { fichero: "chunk-MFHYBSJC.js", linea: 999999, texto }];
    const nuevas = [...sinClasificar(mutado, RED_NODE, SALIDAS_NODE), ...sinClasificar(mutado, PROCESO_NODE, PROCESOS_NODE)];
    expect(nuevas).toContain("chunk-MFHYBSJC.js:999999");
  });

  it.each([`import("./chunk-X.js");`, `const a = /x/.exec(y);`, `const texto = "red";`, `await runCommand(main);`, `import { x } from "./y.js";`])("control: el inventario no salta con %s", (texto) => {
    expect(sinClasificar([{ fichero: "x.js", linea: 1, texto }], RED_NODE, {})).toEqual([]);
    expect(sinClasificar([{ fichero: "x.js", linea: 1, texto }], PROCESO_NODE, {})).toEqual([]);
  });

  it("LOW-5: el error nombra I14 y la URL truncada, sin su consulta", () => {
    const larga = `https://example.invalid/${"a".repeat(200)}.png?texto=secreto`;
    const error = errorDe("chunk-RDDVQSNQ.js", `m.assertPublicHttpsUrl(${JSON.stringify(larga)})`);
    expect(error).toContain(CERRADO);
    expect(error).toContain("https://example.invalid/aaa");
    expect(error!.length).toBeLessThan(CERRADO.length + 200);
    expect(errorDe("chunk-RDDVQSNQ.js", `m.assertPublicHttpsUrl("https://example.invalid/x.png?texto=secreto")`)).not.toContain("secreto");
  });
});

describe.runIf(process.platform === "win32")("I14: rutas UNC y referencias con otro esquema", () => {
  const FORMAS = [
    "//h.invalid/s/x",
    "\\\\h.invalid\\s\\x",
    "/\\h.invalid\\s\\x",
    "\\/h.invalid/s/x",
    "\\\\?\\UNC\\h.invalid\\s\\x",
    "\\\\.\\UNC\\h.invalid\\s\\x",
    "%5C%5Ch.invalid%5Cs%5Cx",
    "file://h.invalid/s/x",
    "smb://h.invalid/s/x",
  ];
  const ETIQUETAS: [string, (r: string) => string][] = [
    ["<video>", (r) => `<video id="v" src="${r}.mp4" data-start="0" data-duration="1"></video>`],
    ["<video> sin duración", (r) => `<video id="v" src="${r}.mp4" data-start="0"></video>`],
    ["<audio>", (r) => `<audio id="a" src="${r}.mp3" data-start="0" data-duration="1"></audio>`],
    ["<img>", (r) => `<img src="${r}.png" alt="">`],
    ["<img> gif", (r) => `<img src="${r}.gif" alt="">`],
    ["CSS url() en <style>", (r) => `<style>#root{background:url(${r}.png)}</style>`],
    ["CSS url() en style=", (r) => `<div style="background:url(${r}.png)"></div>`],
    ["@font-face", (r) => `<style>@font-face{font-family:x;src:url(${r}.woff2)}</style>`],
    ["@import", (r) => `<style>@import url(${r}.css);</style>`],
    ["<link>", (r) => `<link rel="stylesheet" href="${r}.css">`],
    ["<script>", (r) => `<script src="${r}.js"></script>`],
    ["subcomposición", (r) => `<div data-composition-src="${r}.html" data-composition-id="s" data-start="0" data-duration="1"></div>`],
  ];
  let tmp: string;
  let sin: { bin: string; borrar(): void };
  let n = 0;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video unc "));
    sin = copiaSinParche();
  });
  afterAll(() => {
    sin?.borrar();
    if (tmp?.startsWith(os.tmpdir())) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Render sin Chrome ni ffprobe (el espía bloquea los hijos): compila y falla o llega a lanzar el navegador. */
  async function render(cuerpo: string, url = chunk("chunk-L5MFWGGU.js")) {
    const dir = path.join(tmp, `c${n++}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="540" data-height="960" style="width:540px;height:960px">${cuerpo}</div><script>window.__timelines={};</script></body></html>`,
    );
    const log = path.join(dir, "espia.log");
    const env = conEspia(entornoLimpio(process.env, { ...ENTORNO_CERRADO, HYPERFRAMES_BROWSER_PATH: path.join(tmp, "falso.exe") }), log);
    const r = await cli([url, dir], { cwd: dir, env, timeoutMs: 120000, bin: RENDER_ESPIADO });
    return { salida: r.stdout + r.stderr, ok: r.stdout.includes('{"ok":true}'), accesos: accesos(log) };
  }
  const sinParche = (cuerpo: string) => render(cuerpo, pathToFileURL(path.join(path.dirname(sin.bin), "..", "dist", "chunk-L5MFWGGU.js")).href);

  it.each(ETIQUETAS)("%s: 0 accesos y el render falla con I14, en cada forma", async (_n, html) => {
    const r = await Promise.all(FORMAS.map(async (f) => ({ f, ...(await render(html(f))) })));
    for (const { f, salida, ok, accesos: vistos } of r) {
      expect(vistos, f).toEqual([]);
      expect(ok, f).toBe(false);
      expect(salida, f).toContain("(I14)");
    }
  }, 180000);

  it.each(ETIQUETAS.slice(0, 7))("control sin parche, %s: el espía ve el acceso y no hay error de I14", async (_n, html) => {
    const r = await sinParche(html(FORMAS[1]));
    expect(r.accesos.join("\n"), r.salida.slice(-500)).toMatch(/h\.invalid/);
    expect(r.salida).not.toContain("(I14)");
  }, 120000);

  it("control sin parche: <video> con // también llega a ffprobe o a fs", async () => {
    expect((await sinParche(ETIQUETAS[0][1](FORMAS[0]))).accesos.join("\n")).toMatch(/h\.invalid/);
  }, 120000);

  it("fuentes: League Gothic e Inter salen de la cara incrustada, sin red ni aviso; sin parche, antes piden Google Fonts", () => {
    const html = `<html><head><style>h1{font-family:"League Gothic",sans-serif}p{font-family:"Inter",sans-serif}</style></head><body><h1>x</h1><p>y</p></body></html>`;
    const expr = `(async () => { let llamadas = 0; const avisos = []; const h = await m.injectDeterministicFontFaces(${JSON.stringify(html)}, { logger: { warn: (t) => avisos.push(t), info() {}, error() {}, debug() {} }, fetchImpl: async () => { llamadas++; return new Response("", { status: 404 }); } }); return { executablePath: JSON.stringify({ llamadas, avisos: avisos.length, caras: h.match(/@font-face/g)?.length ?? 0 }) }; })()`;
    const entorno = entornoLimpio(process.env, { ...ENTORNO_CERRADO, HYPERFRAMES_FONT_CACHE_DIR: path.join(tmp, "fuentes") });
    const con = JSON.parse(enHijo(llamada("chunk-N7ZMDVAK.js", expr), entorno).ruta!);
    expect(con.llamadas).toBe(0);
    expect(con.avisos).toBe(0);
    expect(con.caras).toBeGreaterThan(0);
    const urlSin = pathToFileURL(path.join(path.dirname(sin.bin), "..", "dist", "chunk-N7ZMDVAK.js")).href;
    const sinP = JSON.parse(enHijo(llamada("chunk-N7ZMDVAK.js", expr).replace(chunk("chunk-N7ZMDVAK.js"), urlSin), entorno).ruta!);
    expect(sinP.llamadas).toBeGreaterThan(0);
    expect(sinP.caras).toBeGreaterThan(0);
  });

  it("control: rutas relativas, data: y file: relativo no disparan I14", async () => {
    for (const ref of ["assets/mi vídeo.png", "./a.png", "../a.png", "file:a.png", "data:image/gif;base64,R0lGODlhAQABAAAAACw=", "a.png?v=1#t=0:10"]) {
      const r = await render(`<img src="${ref}" alt="">`);
      expect(r.salida, ref).not.toContain("(I14)");
      expect(r.accesos, ref).toEqual([]);
    }
  }, 180000);

  it("texto plano con una ruta UNC no aborta: no es una referencia", async () => {
    const r = await render(`<p>url(\\\\h.invalid\\s\\x.png) \\\\h.invalid\\s\\x.mp4</p>`);
    expect(r.salida).not.toContain("(I14)");
    expect(r.accesos).toEqual([]);
  }, 120000);

  it("LOW-5: un texto del guion con background:url(https://…) da un error legible", async () => {
    const r = await render(`<p>background:url(HTTPS://example.invalid/fondo.png)</p>`);
    expect(r.ok).toBe(false);
    expect(r.salida).toContain(CERRADO);
    expect(r.salida).toContain("HTTPS://example.invalid/fondo.png");
    expect(r.accesos).toEqual([]);
  }, 120000);

  it("LOW-1: resolveMediaDuration aborta ella misma, sin esperar a localizeRemoteMediaSources", async () => {
    const r = await render(`<video id="v" src="https://example.invalid/x.mp4" data-start="0"></video>`);
    expect(r.accesos).toEqual([]);
    expect(r.salida).toContain(CERRADO);
    expect(r.salida).toContain("resolveMediaDuration");
  }, 120000);

  it.each([
    ["resolveProjectRelativeSrc", "chunk-PBNWRWKA.js", (r: string) => `m.resolveProjectRelativeSrc(${JSON.stringify(r)}, ".", ".")`],
    ["collectSubCompositionSrcs", "chunk-PBNWRWKA.js", (r: string) => `m.collectSubCompositionSrcs(${JSON.stringify(`<div data-composition-src="${r}.html"></div>`)})`],
    ["mediaPath", "chunk-X7RXXBYM.js", (r: string) => `m.mediaPath(${JSON.stringify(r)}, ".")`],
    [
      "resolveMediaSrc",
      "chunk-MFHYBSJC.js",
      (r: string) =>
        `m.compileHtml(${JSON.stringify(`<div data-composition-id="m" data-start="0" data-duration="1"><video id="v" src="${r}.mp4" data-start="0"></video></div>`)}, ".", async () => { throw new Error("ha sondeado"); })`,
    ],
  ])("%s rechaza cada forma", (_n, fichero, expr) => {
    for (const f of FORMAS) expect(enHijo(llamada(fichero, expr(f)), entornoLimpio(process.env, ENTORNO_CERRADO)).error, f).toContain("(I14)");
  }, 120000);

  describe("barrera de fs y child_process (ruta ya resuelta)", () => {
    const UNC = JSON.stringify("\\\\h.invalid\\s\\x");
    const CASOS: [string, string][] = [
      ["existsSync, aunque se trague el error", `try { fs.existsSync(${UNC}); } catch {}`],
      ["statSync", `try { fs.statSync(${UNC}); } catch {}`],
      ["readFileSync con /\\", `try { fs.readFileSync(${JSON.stringify("/\\h.invalid\\s\\x")}); } catch {}`],
      ["promises.stat", `await fs.promises.stat(${UNC}).catch(() => {});`],
      ["promises.readFile", `await fs.promises.readFile(${UNC}).catch(() => {});`],
      ["createReadStream", `try { fs.createReadStream(${UNC}).on("error", () => {}); } catch {}`],
      ["realpathSync.native", `try { fs.realpathSync.native(${UNC}); } catch {}`],
      ["copyFileSync al destino", `try { fs.copyFileSync("a", ${UNC}); } catch {}`],
      ["URL file://host", `try { fs.existsSync(new URL("file://h.invalid/s/x")); } catch {}`],
      ["spawn", `try { cp.spawn("ffprobe.exe", ["-i", ${UNC}]).on("error", () => {}); } catch {}`],
      ["execFileSync", `try { cp.execFileSync("ffprobe.exe", [${UNC}]); } catch {}`],
      ["ffprobe con URL", `try { cp.spawn("C:/x/ffprobe.exe", ["--", "http://h.invalid/x.mp4"]).on("error", () => {}); } catch {}`],
      ["promisify(execFile)", `await promisify(cp.execFile)("ffprobe.exe", [${UNC}]).catch(() => {});`],
      ["promisify(exec)", `await promisify(cp.exec)(${UNC}).catch(() => {});`],
      ["ffmpeg con rtmp://", `try { cp.execFile("ffmpeg", ["-i", "rtmp://h.invalid/x"], () => {}).on("error", () => {}); } catch {}`],
    ];
    const corre = (codigo: string, cierre: boolean) => {
      const log = path.join(tmp, `barrera${n++}.log`);
      const pre = cierre ? `await import(${JSON.stringify(chunk("seo-studio-cierre.js"))});` : "";
      const fuente = `import fs from "node:fs"; import cp from "node:child_process"; import { promisify } from "node:util"; ${pre} ${codigo} console.log("SIGUIÓ"); await new Promise((r) => setTimeout(r, 200));`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", fuente], { env: conEspia(process.env, log), encoding: "utf8", windowsHide: true, timeout: 30000 });
      return { r, vistos: accesos(log) };
    };

    it.each(CASOS)("%s: aborta con I14 y no llega al espía", (_n, codigo) => {
      const { r, vistos } = corre(codigo, true);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("(I14)");
      expect(r.stdout).not.toContain("SIGUIÓ");
      expect(vistos).toEqual([]);
    });

    it.each(CASOS)("control sin barrera, %s: el espía lo ve", (_n, codigo) => {
      const { r, vistos } = corre(codigo, false);
      expect(r.stdout, r.stderr).toContain("SIGUIÓ");
      expect(vistos.length).toBeGreaterThan(0);
    });

    it.each([
      ["sin captura", `process.exit = () => {}; fs.statSync(${UNC});`, false],
      ["dentro de try/catch", `process.exit = () => {}; try { fs.statSync(${UNC}); } catch {}`, true],
      ["en un hijo", `process.exit = () => {}; try { cp.execFileSync("ffprobe.exe", [${UNC}]); } catch {}`, true],
    ])("LOW-A: con process.exit sustituido, %s, el acceso no llega al espía", (_n, codigo, sigue) => {
      const { r, vistos } = corre(codigo, true);
      expect(r.stderr).toContain("(I14)");
      expect(vistos).toEqual([]);
      if (!sigue) expect(r.stdout).not.toContain("SIGUIÓ");
    });

    // Sin espía: el del test envuelve child_process con una función lisa y perdería la versión propia de
    // promisify (promisify.custom), que es justo la que esquivaba la barrera. El hijo de abajo es node, que ignora el UNC.
    describe("LOW-B: util.promisify(exec|execFile) pasa por la barrera", () => {
      const sinEspia = (codigo: string, cierre: boolean) => {
        const pre = cierre ? `await import(${JSON.stringify(chunk("seo-studio-cierre.js"))});` : "";
        const fuente = `import cp from "node:child_process"; import { promisify } from "node:util"; const antes = [promisify(cp.exec), promisify(cp.execFile)]; ${pre} ${codigo}`;
        return spawnSync(process.execPath, ["--input-type=module", "-e", fuente], { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", windowsHide: true, timeout: 30000 });
      };
      const llamada = `await promisify(cp.execFile)(process.execPath, ["-e", "", ${UNC}]); console.log("SIGUIÓ");`;

      it("execFile con un UNC en los argumentos aborta con I14", () => {
        const r = sinEspia(llamada, true);
        expect(r.status, r.stderr).toBe(1);
        expect(r.stderr).toContain("(I14)");
        expect(r.stdout).not.toContain("SIGUIÓ");
      });

      it("control sin barrera: el mismo hijo se ejecuta", () => {
        const r = sinEspia(llamada, false);
        expect(r.stdout, r.stderr).toContain("SIGUIÓ");
      });

      it("la versión propia de exec y de execFile ya no es la original de Node", () => {
        const r = sinEspia(`console.log(antes[0] !== promisify(cp.exec), antes[1] !== promisify(cp.execFile), promisify(cp.exec) === promisify(cp.exec));`, true);
        expect(r.stdout.trim(), r.stderr).toBe("true true true");
      });
    });

    it("no molesta a rutas locales ni a datos que empiezan por //", () => {
      const f = JSON.stringify(path.join(tmp, "local.txt"));
      const { r, vistos } = corre(`fs.writeFileSync(${f}, "// comentario"); fs.statSync(${f}); fs.readFileSync(${f});`, true);
      expect(r.stdout, r.stderr).toContain("SIGUIÓ");
      expect(vistos).toEqual([]);
    });
  });
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
    const { createFileServer } = (await import(chunk("chunk-RDDVQSNQ.js"))) as {
      createFileServer: (o: object) => Promise<{ port: number; close: () => unknown }>;
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "video i7 "));
    const srv = await createFileServer({ projectDir: tmp, compiledDir: tmp, port: 0 });
    try {
      expect(await conecta("127.0.0.1", srv.port)).toBe(true);
      expect(await conecta("127.0.0.2", srv.port)).toBe(false); // en 0.0.0.0 respondería también aquí, sin salir de loopback
    } finally {
      await srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("servidor_hf_solo_render: el servidor de ficheros de HyperFrames sirve solo la carpeta del render (R0-2)", async () => {
    const { createFileServer } = (await import(chunk("chunk-RDDVQSNQ.js"))) as {
      createFileServer: (o: object) => Promise<{ port: number; close: () => unknown }>;
    };
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "video r02 "));
    const render = path.join(raiz, "_render");
    fs.mkdirSync(render);
    fs.writeFileSync(path.join(render, "index.html"), "<html></html>");
    fs.writeFileSync(path.join(raiz, "proyecto.json"), '{"secreto":1}');
    const srv = await createFileServer({ projectDir: render, compiledDir: render, port: 0 });
    // Ruta cruda: `fetch` normalizaría los `..` antes de enviarlos.
    const pide = (ruta: string) =>
      new Promise<{ estado: number; cuerpo: string }>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: srv.port, path: ruta }, (res) => {
          let cuerpo = "";
          res.on("data", (c) => (cuerpo += c));
          res.on("end", () => resolve({ estado: res.statusCode ?? 0, cuerpo }));
        }).on("error", reject);
      });
    try {
      expect((await pide("/index.html")).estado).toBe(200);
      for (const ruta of ["/../proyecto.json", "/%2e%2e/proyecto.json", "/..%2fproyecto.json", "/..\proyecto.json", "/%2e%2e%5cproyecto.json"]) {
        const r = await pide(ruta);
        expect(r.estado, ruta).toBe(404);
        expect(r.cuerpo, ruta).not.toContain("secreto");
      }
      // `/../../` se normaliza a la raíz del servidor: sirve su index.html, nunca el directorio de arriba.
      const arriba = await pide("/../../");
      expect(arriba.cuerpo).not.toContain("proyecto.json");
      expect([200, 404]).toContain(arriba.estado);
      if (arriba.estado === 200) expect(arriba.cuerpo).toBe("<html></html>");
    } finally {
      await srv.close();
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  it("todo servidor TCP del dist declara host loopback", () => {
    const sinHost = lineasDist()
      .filter((l) => /\.listen\(|\bserve\d?\(\{/.test(l.texto) && !/127\.0\.0\.1/.test(l.texto))
      .map((l) => `${l.fichero}:${l.linea}`);
    expect(sinHost).toEqual([
      "chunk-543U46OR.js:28", // probe.listen({ port, host }): host = 127.0.0.1 salvo HYPERFRAMES_PREVIEW_HOST (fuera de la lista blanca de I5)
      "chunk-543U46OR.js:249", // server.listen(port, host): ídem (vista previa de HyperFrames)
      "chunk-L5MFWGGU.js:17826", // startServer del producer: servidor HTTP aparte, la CLI no lo arranca
      "warmCheck.js:211", // tubería con nombre, no TCP
    ]);
  });
});
