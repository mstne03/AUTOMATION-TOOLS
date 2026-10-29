// W1.1 (SEO-114), ronda 1: prueba en Node, sin navegador, del glue «el último gana» propuesto a W2.6
// (variante shadersParcheW26). Evalúa el texto literal de la variante con un `Ji` falso.
// Uso: node spikes/shader/glue.test.mjs   (sale con 0 si todo pasa)
import assert from "node:assert/strict";
import { VARIANTES } from "./variantes.mjs";

const tick = () => new Promise((ok) => setTimeout(ok, 0));

// Ji falso: renderSyntheticFrame(delta) suma el delta a Pe tras un tick; cuenta renders en curso y su máximo.
// Se le puede pedir que lance síncrono en getFrameDiagnostics o que rechace el siguiente render.
function crear(texto) {
  const f = { Pe: 0, enCurso: 0, maxEnCurso: 0, renders: 0, lanzarDiag: 0, rechazar: 0 };
  const YE = () => ({
    __testing: {
      getFrameDiagnostics() {
        if (f.lanzarDiag > 0) { f.lanzarDiag--; throw new Error("diag síncrono"); }
        return { globalElapsedTime: f.Pe };
      },
    },
    async renderSyntheticFrame(d) {
      f.enCurso++;
      f.maxEnCurso = Math.max(f.maxEnCurso, f.enCurso);
      await tick();
      f.enCurso--;
      if (f.rechazar > 0) { f.rechazar--; throw new Error("render rechazado"); }
      f.Pe += d;
      f.renders++;
    },
  });
  // El texto de la variante empieza dentro de una lista `var` del bundle: se reproduce ese contexto.
  const OE = new Function("YE", `var ${texto};return OE;`)(YE);
  return { OE, f };
}

const casos = {
  async "OE(null) y no finitos no congelan"({ OE, f }) {
    await OE(null);
    await OE(NaN);
    await OE(Infinity);
    await OE(5);
    assert.equal(f.Pe, 5);
  },
  async "throw síncrono de getFrameDiagnostics no congela"({ OE, f }) {
    f.lanzarDiag = 1;
    await assert.rejects(OE(3), /diag síncrono/);
    await OE(7);
    assert.equal(f.Pe, 7);
  },
  async "tras un rechazo vuelve a pintar"({ OE, f }) {
    f.rechazar = 1;
    await assert.rejects(OE(2), /render rechazado/);
    await OE(9);
    assert.equal(f.Pe, 9);
  },
  async "rechazo con peticiones nuevas pendientes: se relanza y pinta la última"({ OE, f }) {
    f.rechazar = 1;
    const p = OE(1);
    await Promise.resolve(); // deja arrancar el cuerpo (tras su `await null`): el render de 1 queda en curso
    assert.equal(f.enCurso, 1);
    OE(4).catch(() => {}); // llega mientras el primer render está en curso
    await assert.rejects(p, /render rechazado/);
    for (let i = 0; i < 10 && f.Pe !== 4; i++) await tick();
    assert.equal(f.Pe, 4);
  },
  async "60 llamadas seguidas: un solo render en curso y pinta el último valor"({ OE, f }) {
    const ps = [];
    for (let i = 1; i <= 60; i++) ps.push(OE(i / 2));
    await Promise.all(ps);
    assert.equal(f.maxEnCurso, 1);
    assert.equal(f.Pe, 30);
    assert.ok(f.renders <= 2, `renders=${f.renders}`);
  },
};

let fallos = 0;
for (const [nombre, prueba] of Object.entries(casos)) {
  try {
    await prueba(crear(VARIANTES.shadersParcheW26.nuevo));
    console.log(`ok   ${nombre}`);
  } catch (e) {
    fallos++;
    console.log(`MAL  ${nombre}: ${e.message}`);
  }
}
// Referencia: el glue original se congela tras un rechazo (defecto latente descrito en el informe §5.6).
{
  const { OE, f } = crear(VARIANTES.shadersParcheW26.ancla);
  f.rechazar = 1;
  await OE(2).catch(() => {});
  await OE(9).catch(() => {});
  console.log(`info glue original tras un rechazo: Pe=${f.Pe} (se queda en 0: congelado)`);
}
process.exitCode = fallos ? 1 : 0;
