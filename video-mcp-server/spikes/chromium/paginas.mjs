// Spike Chromium: lee chrome://version, chrome://terms y chrome://credits de un navegador (identidad y licencias).
// Uso: node spikes/chromium/paginas.mjs <navegador.exe> <html de salida de chrome://credits>
import puppeteer from "puppeteer-core";
import fs from "node:fs";
const [exe, salida] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: exe, headless: true });
const out = {};
try {
  const p = await b.newPage();
  for (const u of ["chrome://version", "chrome://terms", "chrome://credits"]) {
    try {
      await p.goto(u, { waitUntil: "load", timeout: 20000 });
      const texto = await p.evaluate(() => document.body.innerText);
      out[u] = { chars: texto.length, inicio: texto.slice(0, 500) };
      if (u === "chrome://credits") fs.writeFileSync(salida, await p.content());
    } catch (e) { out[u] = { error: e.message.slice(0, 200) }; }
  }
} finally { await b.close(); }
console.log(JSON.stringify(out, null, 2));
