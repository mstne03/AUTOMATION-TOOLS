// Arnés de SEO-111: sirve una composición como la servirá la preview (iframe sandbox sin allow-same-origin, runtime
// de HyperFrames inyectado justo después del <meta> de la CSP, la misma política como cabecera con el origen
// explícito) y evalúa una sonda dentro del iframe con chrome-headless-shell.
// Uso: node scripts/sondear-preview.mjs <navegador.exe> <dirComposicion> [sonda.js]
// Solo desarrollo: no se empaqueta. Servidor solo en 127.0.0.1, puerto aleatorio, solo GET, clave de capacidad.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { entornoMinimo } from "./comparar-fotogramas.mjs";

const RUNTIME = fileURLToPath(new URL("../node_modules/hyperframes/dist/hyperframe.runtime.iife.js", import.meta.url));
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const META_CSP = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*\/?>/;

/** Política del `<meta>` de la composición (con las entidades HTML decodificadas). */
export function politicaDeIndex(html) {
  const m = META_CSP.exec(html);
  return m ? m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&") : undefined;
}

/**
 * Servidor de la composición. `sinCsp`: quita el <meta> y no envía la cabecera (control positivo de las sondas).
 * `marcoSinCsp`: el marco no envía su `frame-src` (control de la sonda de navegación). `reescribirMeta`: cambia
 * `'self'` por el origen exacto en el <meta> (salida preaprobada por el orquestador si el iframe opaco no casa `'self'`).
 * `sinDnsPrefetchOff`: quita el <meta x-dns-prefetch-control> (control positivo de la sonda de dns-prefetch).
 */
export async function servirComposicion({ dir, sinCsp = false, marcoSinCsp = false, reescribirMeta = false, sinDnsPrefetchOff = false }) {
  const raiz = fs.realpathSync(path.resolve(dir));
  const clave = crypto.randomBytes(32).toString("hex");
  let origen = "";
  let politica;
  const servidor = http.createServer((req, res) => {
    const enviar = (codigo, cabeceras = {}, cuerpo) => res.writeHead(codigo, cabeceras).end(cuerpo);
    if (req.headers.host !== origen.slice("http://".length)) return enviar(421);
    if (req.method !== "GET") return enviar(405);
    const ruta = new URL(req.url, origen).pathname;
    if (!ruta.startsWith(`/${clave}/`)) return enviar(404);
    let rel;
    try {
      rel = decodeURIComponent(ruta.slice(clave.length + 2));
    } catch {
      return enviar(404);
    }
    if (rel.includes("\0")) return enviar(404);
    const comunes = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
    if (rel === "__marco.html") {
      const c = marcoSinCsp ? comunes : { ...comunes, "Content-Security-Policy": `default-src 'none'; frame-src ${origen}` };
      return enviar(200, { ...c, "Content-Type": TIPOS[".html"] }, `<!doctype html><html><body><iframe sandbox="allow-scripts" src="/${clave}/index.html" width="1080" height="1920"></iframe></body></html>`);
    }
    // El origen del iframe es opaco: fetch de subcomposiciones y fuentes es CORS (decisión del spike de preview).
    const cabeceras = { ...comunes, "Access-Control-Allow-Origin": "*" };
    if (!sinCsp && politica) cabeceras["Content-Security-Policy"] = `${politica.replaceAll("'self'", origen)}; sandbox allow-scripts`;
    if (rel === "__runtime.js") return enviar(200, { ...cabeceras, "Content-Type": TIPOS[".js"] }, fs.readFileSync(RUNTIME));
    const f = path.resolve(raiz, rel);
    if (!f.startsWith(raiz + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return enviar(404);
    if (!fs.realpathSync(f).startsWith(raiz + path.sep)) return enviar(404);
    let cuerpo = fs.readFileSync(f);
    if (rel === "index.html") {
      let html = cuerpo.toString("utf8");
      const runtime = `<script src="/${clave}/__runtime.js"></script>`;
      if (sinDnsPrefetchOff) html = html.replace(/<meta http-equiv="x-dns-prefetch-control"[^>]*>/i, "");
      if (sinCsp) html = html.replace(META_CSP, "").replace(/<meta charset="UTF-8" \/>/i, (m) => m + runtime);
      else {
        if (reescribirMeta) html = html.replace(META_CSP, (m) => m.replaceAll("&#39;self&#39;", origen).replaceAll("'self'", origen));
        // M3: el runtime va justo después del <meta> de la CSP, para que la política ya cubra su carga.
        html = html.replace(META_CSP, (m) => m + runtime);
      }
      cuerpo = html;
    }
    enviar(200, { ...cabeceras, "Content-Type": TIPOS[path.extname(f).toLowerCase()] ?? "application/octet-stream" }, cuerpo);
  });
  await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
  const puerto = servidor.address().port;
  origen = `http://127.0.0.1:${puerto}`;
  const index = path.join(raiz, "index.html");
  politica = fs.existsSync(index) ? politicaDeIndex(fs.readFileSync(index, "utf8")) : undefined;
  return {
    puerto,
    origen,
    base: `${origen}/${clave}/`,
    cerrar: () => new Promise((ok) => (servidor.closeAllConnections(), servidor.close(() => ok()))),
  };
}

// Registra en cada documento (marco e iframe) las violaciones de CSP y los errores.
const REGISTRO = `(() => {
  window.__violaciones = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__violaciones.push({ directiva: e.effectiveDirective, bloqueada: e.blockedURI, origen: e.sourceFile || "" }));
})();`;

/** Abre el marco, espera al runtime en el iframe y evalúa `sonda` (expresión JS, puede ser una promesa) en el iframe. */
/** `argsExtra`: argumentos de Chrome adicionales (p. ej. `--log-net-log=<ruta>` para la sonda de dns-prefetch). */
export async function sondearPreview({ navegador, dir, sonda, sinCsp = false, marcoSinCsp = false, reescribirMeta = false, sinDnsPrefetchOff = false, esperarPlayer = true, argsExtra = [] }) {
  if (!navegador || !fs.existsSync(navegador)) throw new Error(`Falta el navegador (executablePath obligatorio): ${navegador}`);
  const s = await servirComposicion({ dir, sinCsp, marcoSinCsp, reescribirMeta, sinDnsPrefetchOff });
  // Entorno mínimo para Chrome (L4): nada del entorno del desarrollador.
  // Sin DNS ni salida (R2-L6): las reglas también cubren literales IP (medido en CfT 152 y 156) y sin proxy del sistema.
  const args = ["--autoplay-policy=no-user-gesture-required", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", ...argsExtra];
  const browser = await puppeteer.launch({ executablePath: navegador, headless: true, pipe: true, env: entornoMinimo(), args });
  const erroresPagina = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });
    await page.evaluateOnNewDocument(REGISTRO);
    page.on("pageerror", (e) => erroresPagina.push(e.message));
    page.on("console", (m) => m.type() === "error" && erroresPagina.push(`[consola] ${m.text().slice(0, 300)}`));
    await page.goto(`${s.base}__marco.html`, { waitUntil: "load" });
    const marco = page.mainFrame();
    let frame;
    for (let i = 0; i < 100 && !frame; i++) {
      frame = page.frames().find((f) => f !== marco && f.url().endsWith("/index.html"));
      if (!frame) await new Promise((r) => setTimeout(r, 100));
    }
    if (!frame) throw new Error("el iframe de la composición no cargó");
    if (esperarPlayer) await frame.waitForFunction(() => window.__player && document.querySelectorAll("[data-composition-id]").length > 1, { timeout: 30_000 });
    const resultado = sonda ? await frame.evaluate(sonda) : undefined;
    const violaciones = [];
    for (const f of [frame, marco]) {
      try {
        violaciones.push(...(await f.evaluate(() => window.__violaciones ?? [])));
      } catch {
        /* el iframe pudo navegar (sonda de navegación) */
      }
    }
    return { resultado, violaciones, erroresPagina, origen: s.origen };
  } finally {
    await browser.close();
    await s.cerrar();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [navegador, dir, sondaArchivo] = process.argv.slice(2);
  if (!navegador || !dir) {
    console.error("Uso: node scripts/sondear-preview.mjs <navegador.exe> <dirComposicion> [sonda.js]");
    process.exit(2);
  }
  const sonda = sondaArchivo ? fs.readFileSync(sondaArchivo, "utf8") : "({ player: !!window.__player, composiciones: document.querySelectorAll('[data-composition-id]').length })";
  const r = await sondearPreview({ navegador: path.resolve(navegador), dir, sonda, reescribirMeta: process.argv.includes("--reescribir-meta") });
  console.log(JSON.stringify(r, null, 2));
}
