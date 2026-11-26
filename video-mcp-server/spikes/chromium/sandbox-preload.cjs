// Spike, SOLO medición: HyperFrames lanza el navegador del render con --no-sandbox (buildChromeArgs). Este preload
// quita ese flag (y --disable-setuid-sandbox) de cada arranque del navegador para ver si el render funciona con el
// sandbox de Chromium activo, y deja en SANDBOX_LOG las líneas de comando que vio. Uso: node --require <esto> cli.js …
const cp = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const QUITAR = new Set(["--no-sandbox", "--disable-setuid-sandbox"]);
const original = cp.spawn;
cp.spawn = function (command, args, options) {
  if (command === process.env.HYPERFRAMES_BROWSER_PATH && Array.isArray(args) && args.length > 1) {
    const limpios = args.filter((a) => !QUITAR.has(a));
    const quitados = args.length - limpios.length;
    // SANDBOX_GPU=off: mantiene el sandbox del renderer y desactiva solo el del proceso de GPU.
    if (process.env.SANDBOX_GPU === "off") limpios.push("--disable-gpu-sandbox");
    if (process.env.SANDBOX_LOG) fs.appendFileSync(process.env.SANDBOX_LOG, `quitados=${quitados} gpu-sandbox-off=${limpios.includes("--disable-gpu-sandbox")} ${limpios.join(" ").slice(0, 300)}\n`);
    return original.call(this, command, limpios, options);
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
