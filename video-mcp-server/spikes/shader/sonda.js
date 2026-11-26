// W1.1 (SEO-114): se inyecta con evaluateOnNewDocument (en cada documento, también en el iframe).
// Registra cada `hf-seek` (tiempo pedido, performance.now) y cada escritura de window.__hfTypegpuTime, y las
// violaciones de CSP. Lo expone en window.__traza. Solo observa: no cambia el comportamiento de la página.
(() => {
  const MAX = 50000;
  const traza = { seeks: [], escrituras: [], csp: [] };
  Object.defineProperty(window, "__traza", { value: traza, configurable: false });
  // En captura y registrado antes que nadie: ve el evento antes que el listener de shaders.iife.js.
  window.addEventListener("hf-seek", (e) => { traza.seeks.length < MAX && traza.seeks.push([performance.now(), e.detail && e.detail.time]); }, true);
  let valor;
  Object.defineProperty(window, "__hfTypegpuTime", {
    configurable: true,
    get: () => valor,
    set: (v) => { valor = v; traza.escrituras.length < MAX && traza.escrituras.push([performance.now(), v]); },
  });
  document.addEventListener("securitypolicyviolation", (e) => {
    traza.csp.push({ directiva: e.violatedDirective, bloqueado: e.blockedURI, muestra: e.sample, fuente: e.sourceFile, linea: e.lineNumber });
  });
})();
