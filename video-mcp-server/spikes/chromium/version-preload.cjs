// Spike Chromium, SOLO medición (nunca en el producto): el preflight de `hyperframes render` ejecuta
// `<navegador> --version`, que en Windows solo responde chrome-headless-shell; chrome.exe y content_shell
// arrancan el navegador entero y el preflight cae por timeout. Este preload contesta esa única llamada con la
// versión del snapshot para poder medir el render en sí. Uso: node --require <este fichero> cli.js render …
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = cp.spawn;
cp.spawn = function (command, args, options) {
  if (command === process.env.HYPERFRAMES_BROWSER_PATH && Array.isArray(args) && args.length === 1 && args[0] === "--version") {
    return original.call(this, process.execPath, ["-e", "console.log('Chromium 152.0.7977.0')"], options);
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
