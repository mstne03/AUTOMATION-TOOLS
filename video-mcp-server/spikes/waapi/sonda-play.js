// Sonda de reproducción (se evalúa en la página con sondear.mjs): play desde 0 y, en cada rAF, el tiempo del
// reproductor, el texto del contador del bloque 1, la escala del titular del gancho y si llegó un hf-seek.
(async () => {
  const P = window.__player, muestras = [];
  let seeks = 0;
  window.addEventListener("hf-seek", () => seeks++);
  const num = document.getElementById("bloque1-num"), tit = document.getElementById("gancho-titular");
  P.seek(0);
  await new Promise((r) => setTimeout(r, 200));
  seeks = 0;
  P.play();
  const t0 = performance.now();
  await new Promise((fin) => {
    const paso = () => {
      muestras.push({ ms: Math.round(performance.now() - t0), t: +P.getTime().toFixed(3), num: num.textContent, escala: getComputedStyle(tit).scale, seeks });
      if (performance.now() - t0 < 2500) requestAnimationFrame(paso); else fin();
    };
    requestAnimationFrame(paso);
  });
  P.pause();
  const distintos = new Set(muestras.map((m) => m.num)).size;
  return { muestras: muestras.length, seeksDuranteElPlay: seeks, textosDistintos: distintos, escalasDistintas: new Set(muestras.map((m) => m.escala)).size, tFinal: muestras.at(-1).t, ejemplo: muestras.filter((_, i) => i % 15 === 0) };
})()
