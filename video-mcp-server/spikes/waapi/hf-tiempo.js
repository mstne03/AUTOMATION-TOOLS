// Motor de tiempo de las plantillas sin GSAP (spike). Dos piezas:
//  - HF.tween: un fromTo de GSAP como animación WAAPI. El runtime de HyperFrames la busca y la mueve en
//    cada seek; el tiempo de WAAPI es el del documento, así que el retardo suma el inicio absoluto del host.
//  - HF.reloj: para lo que WAAPI no anima (texto, three.js): fn(tLocal) en cada evento `hf-seek`.
// Las curvas son las fórmulas de GSAP, muestreadas a `linear()` de CSS para que WAAPI las reproduzca.
(function () {
  // Como gsap-core.js 3.15: cada familia se define por su `in`; out e inOut se derivan igual que allí.
  var ENTRADA = {
    expo: function (p) { return Math.pow(2, 10 * (p - 1)) * p + p * p * p * p * p * p * (1 - p); },
    sine: function (p) { return p === 1 ? 1 : 1 - Math.cos((p * Math.PI) / 2); },
  };
  [1, 2, 3, 4].forEach(function (n) {
    ENTRADA["power" + n] = function (p) { return Math.pow(p, n + 1); };
  });
  var CURVAS = { none: function (t) { return t; } };
  Object.keys(ENTRADA).forEach(function (k) {
    var i = ENTRADA[k];
    CURVAS[k + ".in"] = i;
    CURVAS[k + ".out"] = function (p) { return 1 - i(1 - p); };
    CURVAS[k + ".inOut"] = function (p) { return p < 0.5 ? i(p * 2) / 2 : 1 - i((1 - p) * 2) / 2; };
  });
  function curva(nombre) {
    var back = /^back\.out(?:\(([\d.]+)\))?$/.exec(nombre || "none");
    if (back) {
      var s = back[1] ? Number(back[1]) : 1.70158;
      return function (p) { return p ? --p * p * ((s + 1) * p + s) + 1 : 0; };
    }
    var f = CURVAS[nombre || "none"];
    if (!f) throw new Error("hf-tiempo: curva desconocida " + nombre);
    return f;
  }
  var cacheLinear = {};
  function linear(nombre) {
    if (cacheLinear[nombre]) return cacheLinear[nombre];
    var f = curva(nombre), N = 64, puntos = [];
    for (var i = 0; i <= N; i++) puntos.push(+f(i / N).toFixed(5));
    return (cacheLinear[nombre] = "linear(" + puntos.join(", ") + ")");
  }

  // Propiedades de GSAP → CSS. x/y y los % comparten `translate`: un tween no puede mover solo una de las dos si
  // otro tween mueve la otra en el mismo elemento (con GSAP sí se podía); se detecta y se lanza un error.
  function aCss(p, el) {
    var css = {};
    if ("x" in p || "y" in p || "xPercent" in p || "yPercent" in p) {
      var x = ("xPercent" in p ? p.xPercent + "%" : "") + ("x" in p ? (p.xPercent !== undefined ? " + " : "") + p.x + "px" : "");
      var y = ("yPercent" in p ? p.yPercent + "%" : "") + ("y" in p ? (p.yPercent !== undefined ? " + " : "") + p.y + "px" : "");
      css.translate = "calc(" + (x || "0px") + ") calc(" + (y || "0px") + ")";
    }
    if ("scale" in p) css.scale = String(p.scale);
    if ("rotation" in p) css.rotate = p.rotation + "deg";
    for (var k in p) if (!/^(x|y|xPercent|yPercent|scale|rotation)$/.test(k)) css[k] = p[k];
    return css;
  }

  // `inicio`: segundo absoluto del host, que pone composicion.ts. No se lee del DOM: el runtime desenvuelve la
  // raíz de la subcomposición y quita atributos del host (data-duration) al montarla.
  function contexto(id, inicio) {
    var raiz = document.querySelector('[data-composition-id="' + id + '"]');
    if (!raiz) throw new Error("hf-tiempo: no hay composición " + id);
    var base = inicio;
    var ejes = new WeakMap();
    function elementos(sel) {
      if (typeof sel !== "string") return [sel];
      var l = raiz.querySelectorAll(sel);
      if (!l.length) throw new Error("hf-tiempo: " + sel + " no existe en " + id);
      return Array.prototype.slice.call(l);
    }
    return {
      inicio: base,
      // tween(sel, desde, hasta, t, d, curva, opciones): como tl.fromTo(sel, desde, {…hasta, duration: d, ease}, t).
      // `antes: false` equivale a immediateRender: false (no pinta el valor inicial antes de empezar).
      tween: function (sel, desde, hasta, t, d, nombre, op) {
        var antes = !op || op.antes !== false;
        elementos(sel).forEach(function (el) {
          var ejesTween = ("x" in desde || "xPercent" in desde ? "x" : "") + ("y" in desde || "yPercent" in desde ? "y" : "");
          if (ejesTween) {
            var previo = ejes.get(el);
            if (previo && previo !== ejesTween) throw new Error("hf-tiempo: " + el.id + " mezcla tweens de x e y por separado");
            ejes.set(el, ejesTween);
          }
          var a = el.animate([aCss(desde, el), aCss(hasta, el)], {
            delay: (base + t) * 1000,
            duration: Math.max(d, 0.001) * 1000,
            easing: linear(nombre),
            fill: antes ? "both" : "forwards",
          });
          a.pause();
        });
      },
      // fn(tLocal) en cada seek del runtime; tLocal = segundos desde el inicio de esta composición.
      reloj: function (fn) {
        window.addEventListener("hf-seek", function (e) { fn(e.detail.time - base); });
        fn(-base);
      },
      curva: curva,
    };
  }
  window.HF = { contexto: contexto, curva: curva, linear: linear };
})();
