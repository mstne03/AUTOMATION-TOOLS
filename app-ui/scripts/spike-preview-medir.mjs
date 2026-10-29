// Spike D6 (desechable): conduce la página /#/spike-preview con Playwright y guarda las mediciones.
// Uso (Git Bash, con el backend con APP_BACKEND_SPIKES=1 y Vite en :1420 ya en marcha):
//   node scripts/spike-preview-medir.mjs --variante aurora --canal chrome --salidas <carpeta> [--fotogramas] [--sin-medir]
//   node scripts/spike-preview-medir.mjs --variante aurora --cdp http://127.0.0.1:9222 ...   (WebView2 real de `tauri dev`)
// Va HEADED (headless:false): con headless no hay GPU/WebGPU reales y la medición no vale.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const variante = arg("variante", "aurora");
const canal = arg("canal", "chrome");
const cdp = arg("cdp", "");
const salidas = path.resolve(arg("salidas", "."));
fs.mkdirSync(salidas, { recursive: true });
const URL_PAGINA = (escala) => `http://localhost:1420/#/spike-preview?escala=${escala}`;

let browser, contexto, pagina;
if (cdp) {
  browser = await chromium.connectOverCDP(cdp);
  contexto = browser.contexts()[0];
  pagina = contexto.pages()[0] ?? (await contexto.newPage());
} else {
  // "chrome" = Chrome estable instalado (155, misma versión mayor que el WebView2 155)
  browser = await chromium.launch({ headless: false, channel: canal === "chromium" ? undefined : canal, args: ["--window-size=1300,1000"] });
  contexto = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  pagina = await contexto.newPage();
}
const consola = [];
pagina.on("console", (m) => consola.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
pagina.on("pageerror", (e) => consola.push(`[pageerror] ${e.message}`.slice(0, 300)));

const info = { variante, navegador: cdp ? `CDP ${cdp}` : canal, version: browser.version() };
console.log("Navegador:", info.navegador, info.version);

async function abrir(escala) {
  if (!cdp) await pagina.goto("about:blank");
  await pagina.goto(URL_PAGINA(escala));
  await pagina.getByTestId("listo").filter({ hasText: "Runtime listo" }).waitFor({ timeout: 90_000 });
  const marco = pagina.frames().find((f) => f !== pagina.mainFrame() && f.url().includes("/spike/preview/"));
  return marco;
}

async function diagnostico(marco) {
  return marco.evaluate(async () => {
    let adaptador = null;
    try {
      const a = navigator.gpu && (await navigator.gpu.requestAdapter());
      adaptador = a ? { vendor: a.info?.vendor, arquitectura: a.info?.architecture, descripcion: a.info?.description } : "sin adaptador";
    } catch (e) { adaptador = `error: ${e.message}`; }
    return { origen: location.origin, isSecureContext, webgpu: !!navigator.gpu, adaptador, audio: !!document.querySelector("audio"), medios: document.querySelectorAll("audio,video").length };
  });
}

if (!arg("sin-medir", false)) {
  const marco = await abrir(0.4);
  info.diagnostico = await diagnostico(marco);
  console.log("Diagnóstico del iframe:", JSON.stringify(info.diagnostico));
  await pagina.getByRole("button", { name: "Seek 0 s" }).click(); // gesto de usuario para el autoplay
  await pagina.getByTestId("medir").click();
  const t0 = Date.now();
  await pagina.waitForFunction(() => window.__spikeResultados, null, { timeout: 180_000, polling: 1000 });
  const res = await pagina.evaluate(() => window.__spikeResultados);
  info.resultados = res;
  info.minutos = Number(((Date.now() - t0) / 60000).toFixed(2));
  console.log(JSON.stringify(res, null, 2));
  await pagina.screenshot({ path: path.join(salidas, `pagina_${variante}.png`) });
}

if (arg("fotogramas", false)) {
  await pagina.setViewportSize({ width: 1140, height: 1980 }).catch(() => {});
  let marco = await abrir(1);
  // Por postMessage (el mismo protocolo que la página): con la preview a 1080 px los botones quedan fuera de la ventana.
  const mandar = (m) => pagina.evaluate((m) => document.querySelector("iframe").contentWindow.postMessage(m, "*"), m);
  const capturar = async (prefijo) => {
    for (const t of [1, 10, 25, 45]) {
      await mandar({ tipo: "seek", t });
      await pagina.waitForTimeout(1500); // dos rAF + imágenes + un par de fotogramas de shader
      const real = await marco.evaluate(() => window.__player.getTime());
      if (Math.abs(real - t) > 0.01) throw new Error(`seek ${t}: el reproductor está en ${real}`);
      await pagina.getByTestId("preview").screenshot({ path: path.join(salidas, `${variante}_${prefijo}_${t}s.png`) });
      console.log("capturado", prefijo, t, "s");
    }
  };
  // 1) Página recién cargada (un goto a la misma URL con otro hash no recarga el iframe: se fuerza con reload()).
  await pagina.reload();
  marco = await abrir(1);
  await capturar("fresco");
  // 2) Tras reproducir 4 s y pausar: lo que ve el usuario al reproducir y luego arrastrar el cursor.
  await mandar({ tipo: "play" });
  await pagina.waitForTimeout(4000);
  await mandar({ tipo: "pause" });
  await capturar("trasplay");
  // 3) Tras reproducir el vídeo entero (52 s > 50,4 s) y volver atrás: ¿el shader conserva estado de la reproducción?
  await mandar({ tipo: "seek", t: 0 });
  await mandar({ tipo: "play" });
  await pagina.waitForTimeout(52000);
  await mandar({ tipo: "pause" });
  await capturar("trasfin");
}

info.consola = consola.slice(-40);
fs.writeFileSync(path.join(salidas, `medidas_${variante}_${cdp ? "webview2" : canal}.json`), JSON.stringify(info, null, 2));
if (!cdp) await browser.close();
else await browser.close().catch(() => {});
