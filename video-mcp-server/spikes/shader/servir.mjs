// W1.1 (SEO-114): servidor estático de la reproducción. Solo 127.0.0.1, puerto aleatorio, solo GET.
// Inyecta tras <head> el runtime de HyperFrames y el CONTROL_JS de la preview (como spike_preview.py),
// aplica en memoria las variantes pedidas y registra cada petición (I2).
// Rutas propias: /__runtime.js, /__control.js, /__host.html (anfitrión con <iframe sandbox="allow-scripts">),
// /__vacio.html (página sin CSP para el control positivo de red).
// Autotest: node spikes/shader/servir.mjs --autotest
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUNTIME, aplicar } from "./variantes.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_PREVIEW = path.join(AQUI, "..", "..", "..", "app-backend", "app_backend", "spike_preview.py");
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" };

// CONTROL_JS de la preview, copiado literalmente del fuente de Python (nada de reescribirlo a mano).
function controlOriginal() {
  const py = fs.readFileSync(SPIKE_PREVIEW, "utf8").replace(/\r\n/g, "\n");
  const m = /CONTROL_JS = r"""([\s\S]*?)"""/.exec(py);
  if (!m) throw new Error("no encuentro CONTROL_JS en spike_preview.py");
  return m[1];
}

// Única ampliación permitida (R0 §6): dentro del `case "seek"` existente, justo tras `p.seek(t)`, con la misma `t`
// ya acotada por num(d.t, 0, duración). Si la función no existe, error explícito; nunca se salta en silencio y la
// referencia no se guarda al cargar.
const SEEK_ORIGINAL = "          const t0 = performance.now();\n          p.seek(t);\n";
const SEEK_RESEEK =
  '          if (typeof window.__hfReseekGpu !== "function") return responder({ tipo: "error", id: d.id, motivo: "reseek-no-disponible" });\n' +
  "          const t0 = performance.now();\n          p.seek(t);\n          window.__hfReseekGpu(t);\n";
export function control(reseek) {
  const js = controlOriginal();
  if (!reseek) return js;
  if (js.split(SEEK_ORIGINAL).length !== 2) throw new Error("CONTROL_JS: el case seek no coincide con el esperado");
  return js.replace(SEEK_ORIGINAL, () => SEEK_RESEEK);
}

// Anfitrión: hace de app-ui. Habla con el iframe SOLO por postMessage, como PreviewSpike.tsx.
const HOST = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}iframe{border:0;display:block}</style></head>
<body><iframe id="f" sandbox="allow-scripts" allow="autoplay" src="/" width="1080" height="1920"></iframe>
<script>
  const f = document.getElementById("f"); let n = 0; const esperas = new Map(); window.__listo = null;
  addEventListener("message", (e) => {
    if (e.source !== f.contentWindow || !e.data || typeof e.data !== "object") return;
    if (e.data.tipo === "listo") window.__listo = e.data;
    const r = esperas.get(e.data.id); if (r) { esperas.delete(e.data.id); r(e.data); }
  });
  window.__enviar = (m, conRespuesta) => new Promise((ok) => { const id = ++n; if (conRespuesta) esperas.set(id, ok); f.contentWindow.postMessage({ ...m, id }, "*"); if (!conRespuesta) ok(null); });
</script></body></html>`;

/**
 * servir({dir, variantes, csp, reseek}) → {url, puerto, peticiones, cerrar}
 * csp: "ninguna" | "producto"
 */
export async function servir({ dir, variantes = [], csp = "ninguna", reseek = false }) {
  const raiz = path.resolve(dir);
  const runtime = aplicar(variantes, "runtime", fs.readFileSync(RUNTIME, "utf8"));
  const controlJs = control(reseek);
  const peticiones = [];
  let puerto = 0;
  const origen = () => `http://127.0.0.1:${puerto}`;
  const cabecerasCsp = () =>
    csp === "producto"
      ? {
          // Lo mínimo medido (ver INFORME-shader.md §Seguridad). Sin 'unsafe-eval'.
          "Content-Security-Policy": [
            "default-src 'none'",
            `script-src ${origen()} data: blob:`,
            `connect-src ${origen()} data: blob:`,
            `img-src ${origen()} data: blob:`,
            "style-src 'unsafe-inline'",
            "sandbox allow-scripts",
          ].join("; "),
          "X-Content-Type-Options": "nosniff",
        }
      : {};

  const servidor = http.createServer((req, res) => {
    const reg = { metodo: req.method, url: req.url, host: req.headers.host, estado: 0 };
    peticiones.push(reg);
    const fin = (estado, cuerpo = "", cab = {}) => {
      reg.estado = estado;
      // CORS solo para el origen opaco del iframe sandboxed / CSP `sandbox` (Origin: null). No se traslada al producto (I8).
      const cors = req.headers.origin === "null" ? { "Access-Control-Allow-Origin": "null" } : {};
      res.writeHead(estado, { "Cache-Control": "no-store", ...cors, ...cab }).end(cuerpo);
    };
    try {
      if (req.method !== "GET") return fin(405);
      if (req.headers.host !== `127.0.0.1:${puerto}`) return fin(421);
      const ruta = decodeURIComponent(new URL(req.url, origen()).pathname); // %E0 lanza → 400
      if (/[\0:\\]/.test(ruta)) return fin(400);
      if (ruta === "/__runtime.js") return fin(200, runtime, { "Content-Type": TIPOS[".js"], ...cabecerasCsp() });
      if (ruta === "/__control.js") return fin(200, controlJs, { "Content-Type": TIPOS[".js"], ...cabecerasCsp() });
      if (ruta === "/__host.html") return fin(200, HOST, { "Content-Type": TIPOS[".html"] });
      if (ruta === "/__vacio.html") return fin(200, "<!doctype html><title>vacío</title>", { "Content-Type": TIPOS[".html"] });
      const f = path.resolve(raiz, "." + (ruta === "/" ? "/index.html" : ruta));
      if (!f.startsWith(raiz + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return fin(404);
      let cuerpo = fs.readFileSync(f);
      if (f === path.join(raiz, "index.html")) {
        cuerpo = cuerpo.toString("utf8").replace("<head>", '<head><script src="/__runtime.js"></script><script src="/__control.js"></script>');
      } else if (f.endsWith(path.join("vendor", "shaders.iife.js"))) {
        cuerpo = aplicar(variantes, "shaders", cuerpo.toString("utf8"));
      }
      return fin(200, cuerpo, { "Content-Type": TIPOS[path.extname(f)] ?? "application/octet-stream", ...cabecerasCsp() });
    } catch {
      return fin(400);
    }
  });
  await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
  puerto = servidor.address().port;
  return {
    url: `${origen()}/`,
    puerto,
    peticiones,
    cerrar: () => new Promise((ok) => servidor.close(ok)),
  };
}

if (process.argv.includes("--autotest") && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const assert = (await import("node:assert/strict")).default;
  const comp = path.join(AQUI, "..", "salidas", "shader", "comp");
  if (!fs.existsSync(path.join(comp, "index.html"))) throw new Error("ejecuta antes node spikes/shader/montar.mjs");
  const s = await servir({ dir: comp });
  const pedir = (ruta, { metodo = "GET", host = `127.0.0.1:${s.puerto}` } = {}) =>
    new Promise((ok, mal) => {
      const r = http.request({ host: "127.0.0.1", port: s.puerto, path: ruta, method: metodo, headers: { Host: host } }, (res) => {
        res.resume();
        res.on("end", () => ok(res.statusCode));
      });
      r.on("error", mal);
      r.end();
    });
  const casos = [
    ["/..%5C..%5Cpackage.json", {}, 400],
    ["/%2e%2e/%2e%2e/package.json", {}, 404],
    ["/%00", {}, 400],
    ["/%E0", {}, 400],
    ["/C:%5CWindows%5Cwin.ini", {}, 400],
    ["/", { host: "evil.test" }, 421],
    ["/", { metodo: "POST" }, 405],
    ["/no-existe.html", {}, 404],
  ];
  for (const [ruta, op, esperado] of casos) assert.equal(await pedir(ruta, op), esperado, `${op.metodo ?? "GET"} ${ruta} host=${op.host ?? "-"}`);
  assert.equal(await pedir("/"), 200, "el servidor sigue vivo tras los casos malos");
  assert.equal(await pedir("/__runtime.js"), 200);
  assert.ok(control(true).includes("window.__hfReseekGpu(t);") && !control(false).includes("__hfReseekGpu"));
  await s.cerrar();
  console.log(`autotest de servir: OK (${casos.length} casos 4xx, servidor vivo)`);
}
