// W1.1 (SEO-114): transformaciones EN MEMORIA del runtime de HyperFrames y de shaders.iife.js al servirlos.
// Nunca se escriben en node_modules, plantilla/vendor ni el repo. Cada variante exige que su ancla aparezca
// exactamente una vez; si no, aborta con un mensaje claro (una versión distinta del runtime no pasa en silencio).
// Autotest: node spikes/shader/variantes.mjs --autotest
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME = path.join(AQUI, "..", "..", "node_modules", "hyperframes", "dist", "hyperframe.runtime.iife.js");
export const SHADERS = path.join(AQUI, "..", "..", "plantilla", "vendor", "shaders.iife.js");

const OE_ORIGINAL =
  "Ji=YE(),T0=Promise.resolve();function OE(e){return T0=T0.then(()=>Ji.renderSyntheticFrame(e-Ji.__testing.getFrameDiagnostics().globalElapsedTime)),T0}";

// Cada variante: a qué fichero se aplica (runtime | shaders), el ancla y su sustituto.
export const VARIANTES = {
  // Expone Ji y los contadores de la cola serie T0 (encolados / resueltos / rechazados). Conserva la semántica
  // de la cadena: un rechazo sigue propagándose igual que en el original.
  instrumentarShaders: {
    fichero: "shaders",
    ancla: OE_ORIGINAL,
    nuevo:
      "Ji=YE(),T0=Promise.resolve();var __q={encolados:0,resueltos:0,rechazados:0,ultimoPedido:null,vaciado:null,deltas:[]};" +
      "window.__dbgShader={Ji:Ji,q:__q,diag:()=>Ji.__testing.getFrameDiagnostics()};" +
      "function OE(e){__q.encolados++;__q.ultimoPedido=e;return T0=T0.then(()=>{var d=e-Ji.__testing.getFrameDiagnostics().globalElapsedTime;" +
      "__q.deltas.length<20000&&__q.deltas.push([performance.now(),e,d]);return Ji.renderSyntheticFrame(d)})" +
      ".then(v=>{__q.resueltos++;__q.resueltos+__q.rechazados===__q.encolados&&(__q.vaciado=performance.now());return v}," +
      "x=>{__q.rechazados++;__q.resueltos+__q.rechazados===__q.encolados&&(__q.vaciado=performance.now());throw x}),T0}",
  },
  // Arreglo candidato (equivalente en memoria del parche que se describe para W2.6): «el último gana». En vez de
  // encadenar un renderSyntheticFrame por cada hf-seek, guarda solo el último tiempo pedido y un único bucle lo
  // renderiza; la promesa de cada llamada se resuelve cuando ya está pintado un tiempo igual o posterior en la cola.
  // Lleva los mismos contadores que instrumentarShaders (q.renders = renders hechos) para poder medir.
  shadersUltimoGana: {
    fichero: "shaders",
    ancla: OE_ORIGINAL,
    nuevo:
      "Ji=YE(),T0=null,__p=null;var __q={encolados:0,resueltos:0,rechazados:0,renders:0,ultimoPedido:null,vaciado:null,deltas:[]};" +
      "window.__dbgShader={Ji:Ji,q:__q,diag:()=>Ji.__testing.getFrameDiagnostics()};" +
      "function OE(e){__q.encolados++;__q.ultimoPedido=e;__p=e;T0||(T0=(async()=>{try{for(;__p!==null;){let t=__p;__p=null;" +
      "let d=t-Ji.__testing.getFrameDiagnostics().globalElapsedTime;__q.deltas.length<20000&&__q.deltas.push([performance.now(),t,d]);" +
      "await Ji.renderSyntheticFrame(d);__q.renders++}}finally{T0=null}})());let n=__q.encolados;" +
      "return T0.then(v=>{__q.resueltos=Math.max(__q.resueltos,n);__q.resueltos+__q.rechazados===__q.encolados&&(__q.vaciado=performance.now());return v}," +
      "x=>{__q.rechazados++;throw x})}",
  },
  // El diff exacto que se propone a W2.6 (INFORME-shader.md §6), sin contadores. Corrección de la ronda 1:
  // indicador `hfHay` aparte (null ya no es centinela), tiempos no finitos ignorados, `await null` como primera
  // sentencia (T0 queda asignada antes de ejecutar el cuerpo, así un throw síncrono no la deja resuelta para siempre)
  // y, tras un rechazo con peticiones nuevas pendientes, se relanza el bucle. Lo prueba spikes/shader/glue.test.mjs.
  shadersParcheW26: {
    fichero: "shaders",
    ancla: OE_ORIGINAL,
    nuevo:
      "Ji=YE(),T0=null,hfPendiente=0,hfHay=!1;function OE(e){if(!Number.isFinite(e))return T0||Promise.resolve();hfPendiente=e;hfHay=!0;" +
      "return T0||(T0=(async()=>{await null;try{for(;hfHay;){hfHay=!1;let t=hfPendiente;" +
      "await Ji.renderSyntheticFrame(t-Ji.__testing.getFrameDiagnostics().globalElapsedTime)}}finally{T0=null;hfHay&&OE(hfPendiente).catch(()=>{})}})())}",
  },
  // Pista del informe de preview: play() del adaptador typegpu no pone su tiempo a null.
  runtimeSinNullEnPlay: { fichero: "runtime", ancla: "play:()=>{r(),e=null}", nuevo: "play:()=>{r()}" },
  // seek() del adaptador typegpu despacha siempre (Cs) en vez de deduplicar (_s).
  runtimeSeekForzado: { fichero: "runtime", ancla: "window.__hfTypegpuTime=e,_s(e)}", nuevo: "window.__hfTypegpuTime=e,Cs(e)}" },
};

/** Aplica las variantes de `nombres` que tocan `fichero` ("runtime" | "shaders") a `texto`. */
export function aplicar(nombres, fichero, texto) {
  for (const n of nombres) {
    const v = VARIANTES[n];
    if (!v) throw new Error(`variante desconocida: ${n}`);
    if (v.fichero !== fichero) continue;
    const veces = texto.split(v.ancla).length - 1;
    if (veces !== 1) throw new Error(`variante ${n}: el ancla aparece ${veces} veces en ${fichero} (se esperaba 1)`);
    texto = texto.replace(v.ancla, () => v.nuevo);
  }
  return texto;
}

if (process.argv.includes("--autotest") && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const assert = (await import("node:assert/strict")).default;
  const textos = { runtime: fs.readFileSync(RUNTIME, "utf8"), shaders: fs.readFileSync(SHADERS, "utf8") };
  for (const f of ["runtime", "shaders"]) assert.equal(aplicar([], f, textos[f]), textos[f], `sin variante ${f} cambia`);
  for (const [n, v] of Object.entries(VARIANTES)) {
    const out = aplicar([n], v.fichero, textos[v.fichero]);
    assert.notEqual(out, textos[v.fichero], `${n} no cambió nada`);
    assert.equal(out.split(v.nuevo).length - 1, 1, `${n}: el sustituto no aparece una vez`);
    assert.throws(() => aplicar([n], v.fichero, "texto sin ancla"), /aparece 0 veces/);
    assert.throws(() => aplicar([n], v.fichero, v.ancla + v.ancla), /aparece 2 veces/);
  }
  assert.throws(() => aplicar(["noExiste"], "runtime", ""), /desconocida/);
  console.log(`autotest de variantes: OK (${Object.keys(VARIANTES).length} variantes)`);
}
