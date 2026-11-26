// node --import espia-red.mjs render-espiado.mjs <URL de chunk-L5MFWGGU.js> <carpeta>
// Corre el render del producer sin la CLI; el espía bloquea los hijos, así que no arranca ningún Chrome.
import path from "node:path";

// Con <vídeo> y la URL de snapshot-*.js: la extracción de fotograma de `snapshot`, que la CLI hace ya con Chrome abierto.
const [url, dir, video] = process.argv.slice(2);
const m = await import(url);
if (video) {
  await m.extractVideoFrameToBuffer(video, 0);
  process.exit(0);
}
const job =m.createRenderJob({ fps: 30, quality: "draft", format: "webm" });
try {
  await m.executeRenderJob(job, dir, path.join(dir, "s.webm"));
  console.log(JSON.stringify({ ok: true }));
} catch (e) {
  console.log(JSON.stringify({ error: String(e?.message ?? e), pila: String(e?.stack) }));
}
process.exit(0);
