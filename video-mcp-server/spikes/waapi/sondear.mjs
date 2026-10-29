// Spike GSAP → WAAPI: sirve una composición con el runtime de HyperFrames inyectado (como la preview) y la
// abre con puppeteer para inspeccionar el estado tras cada seek. Solo 127.0.0.1.
// Uso: node spikes/waapi/sondear.mjs <dir composición> <navegador.exe> [js a evaluar tras cargar]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(AQUI, "..", "..", "node_modules", "hyperframes", "dist", "hyperframe.runtime.iife.js");
const [dir, navegador, codigo] = process.argv.slice(2);
const raiz = path.resolve(dir);
const TIPOS = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".jpg": "image/jpeg", ".png": "image/png" };

const servidor = http.createServer((req, res) => {
  const ruta = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (ruta === "/__runtime.js") return res.end(fs.readFileSync(RUNTIME));
  const f = path.resolve(raiz, "." + (ruta === "/" ? "/index.html" : ruta));
  if (!f.startsWith(raiz + path.sep) || !fs.existsSync(f)) return res.writeHead(404).end();
  let cuerpo = fs.readFileSync(f);
  if (ruta === "/") cuerpo = cuerpo.toString().replace("<head>", '<head><script src="/__runtime.js"></script>');
  res.writeHead(200, { "Content-Type": TIPOS[path.extname(f)] ?? "application/octet-stream" }).end(cuerpo);
});
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${servidor.address().port}/`;

const browser = await puppeteer.launch({ executablePath: navegador, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  page.on("console", (m) => console.error("[consola]", m.type(), m.text().slice(0, 300)));
  page.on("pageerror", (e) => console.error("[error]", e.message));
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__player && document.querySelector("#gancho-titular"), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  const salida = await page.evaluate(codigo ?? "Object.keys(window.__player)");
  console.log(JSON.stringify(salida, null, 2));
} finally {
  await browser.close();
  servidor.close();
}
