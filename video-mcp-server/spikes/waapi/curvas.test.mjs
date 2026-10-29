// Comprobación del spike: las curvas de hf-tiempo.js coinciden con las de gsap 3.15 (diferencia < 1e-9).
// Uso: node spikes/waapi/curvas.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
globalThis.window = {};
new Function(fs.readFileSync(new URL("./hf-tiempo.js", import.meta.url), "utf8"))();
const { gsap } = require("gsap");
const nombres = ["none", "back.out(1.7)", "back.out(3)", "back.out"];
for (const f of ["power1", "power2", "power3", "power4", "expo", "sine"]) for (const t of ["in", "out", "inOut"]) nombres.push(`${f}.${t}`);
for (const n of nombres) {
  const nuestra = window.HF.curva(n), suya = gsap.parseEase(n);
  for (let i = 0; i <= 1000; i++) assert.ok(Math.abs(nuestra(i / 1000) - suya(i / 1000)) < 1e-9, `${n} en ${i / 1000}`);
}
console.log(`ok: ${nombres.length} curvas iguales a gsap`);
