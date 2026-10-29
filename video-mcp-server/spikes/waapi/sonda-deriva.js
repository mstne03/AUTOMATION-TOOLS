// Sonda (sondear.mjs): (1) desfase entre el reloj de las animaciones WAAPI y el del reproductor durante el play;
// (2) estado tras un seek en frío frente al mismo seek después de reproducir 12 s.
(async () => {
  const P = window.__player, espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = document.getAnimations().find((x) => x.effect.target.id === "gancho-titular");
  const estado = () => [...document.querySelectorAll("[id]")].filter((e) => /-(num|etq|grupo|luz|golpe|punch|fundido|titular|stage)$/.test(e.id)).map((e) => { const c = getComputedStyle(e); return e.id + "=" + [c.opacity, c.translate, c.scale, e.id.endsWith("-num") ? e.textContent : ""].join(","); }).join(";");
  P.seek(0); await espera(200);
  const desfases = [];
  P.play();
  const t0 = performance.now();
  while (performance.now() - t0 < 3000) { await new Promise((r) => requestAnimationFrame(r)); desfases.push(Math.abs(a.currentTime - P.getTime() * 1000)); }
  P.pause();
  const frio = {};
  for (const t of [1, 4.2, 6.9, 10]) { P.seek(t); await espera(150); frio[t] = estado(); }
  P.seek(0); await espera(150); P.play(); await espera(12500); P.pause();
  const tras = {};
  for (const t of [1, 4.2, 6.9, 10]) { P.seek(t); await espera(150); tras[t] = estado() === frio[t] ? "igual" : "DISTINTO: " + estado().slice(0, 300); }
  desfases.sort((x, y) => x - y);
  return { muestras: desfases.length, desfaseMedianaMs: desfases[desfases.length >> 1], desfaseMaxMs: desfases.at(-1), playState: a.playState, trasReproducir: tras };
})()
