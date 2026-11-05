// hf-tiempo.js: motor de tiempo de las piezas (SEO-111; nace del spike descrito en spikes/INFORME-waapi.md).
// Código propio de SEO Studio (Marc Serra), sin código de terceros; misma licencia que el repositorio.
//  - tween: una animación desde/hasta con WAAPI. El runtime de HyperFrames la encuentra y fija su currentTime en
//    cada seek; el tiempo de WAAPI es el del documento, así que el retardo suma el inicio absoluto del host.
//  - reloj: para lo que WAAPI no anima (texto, three.js): fn(tLocal) en cada evento `hf-seek`.
//  - envoltura: fundido, punch y golpe de las escenas.
// Las curvas se muestrean a `linear()` de CSS para que WAAPI las reproduzca; origen en LICENCIAS.md.
// Ante un dato no válido (curva, selector, id, tiempo, número no finito) lanza: nunca anima con basura en silencio
// (I1, I11).
// Envoltura: las escenas la reciben en {{ENVOLTURA_DATOS}}; las fotos (bloque-foto, también el bucle) la llevan dentro
// de su {{DATOS}} ({duracion, dx, dy, movimiento, fundido, punch, golpes}) y la pieza migrada llama a
// hf.envoltura(DATOS): solo lee fundido, punch y golpes.
(function () {
  "use strict";
  var ID_RE = /^[a-z][a-z0-9-]*$/;
  function finito(v) {
    return typeof v === "number" && isFinite(v);
  }
  function tiempo(v, que) {
    if (!finito(v) || v < 0) throw new Error("hf-tiempo: " + que + " no finito o negativo: " + String(v));
    return v;
  }
  // Guards de las piezas, con el mismo mensaje en todas: se lanza antes de crear ninguna animación.
  function numero(v, que) {
    if (!finito(v)) throw new Error("hf-tiempo: " + que + " no finito: " + String(v));
    return v;
  }
  function positivo(v, que) {
    if (!finito(v) || v <= 0) throw new Error("hf-tiempo: " + que + " no positivo: " + String(v));
    return v;
  }
  function validarId(v) {
    if (typeof v !== "string" || !ID_RE.test(v)) throw new Error("hf-tiempo: id no válido " + String(v));
    return v;
  }

  // Cada familia se define por su `in`; out e inOut se derivan de ella.
  var ENTRADA = Object.create(null);
  ENTRADA.expo = function (p) { return Math.pow(2, 10 * (p - 1)) * p + p * p * p * p * p * p * (1 - p); };
  ENTRADA.sine = function (p) { return p === 1 ? 1 : 1 - Math.cos((p * Math.PI) / 2); };
  [1, 2, 3, 4].forEach(function (n) {
    ENTRADA["power" + n] = function (p) { return Math.pow(p, n + 1); };
  });
  // Sin prototipo: "constructor" o "__proto__" no son curvas (L3).
  var CURVAS = Object.create(null);
  CURVAS.none = function (t) { return t; };
  Object.keys(ENTRADA).forEach(function (k) {
    var i = ENTRADA[k];
    CURVAS[k + ".in"] = i;
    CURVAS[k + ".out"] = function (p) { return 1 - i(1 - p); };
    CURVAS[k + ".inOut"] = function (p) { return p < 0.5 ? i(p * 2) / 2 : 1 - i((1 - p) * 2) / 2; };
  });
  function curva(nombre) {
    var n = nombre === undefined ? "none" : nombre;
    var back = /^back\.out(?:\(([\d.]+)\))?$/.exec(n);
    if (back) {
      var s = back[1] ? Number(back[1]) : 1.70158;
      if (!finito(s)) throw new Error("hf-tiempo: curva desconocida " + n);
      return function (p) { return p ? --p * p * ((s + 1) * p + s) + 1 : 0; };
    }
    var f = typeof n === "string" ? CURVAS[n] : undefined;
    if (!f) throw new Error("hf-tiempo: curva desconocida " + n);
    return f;
  }
  var cacheLinear = Object.create(null);
  function linear(nombre) {
    var f = curva(nombre), clave = nombre === undefined ? "none" : nombre;
    if (cacheLinear[clave]) return cacheLinear[clave];
    var N = 256, puntos = [];
    for (var i = 0; i <= N; i++) puntos.push(+f(i / N).toFixed(5));
    return (cacheLinear[clave] = "linear(" + puntos.join(", ") + ")");
  }

  // Propiedades → CSS. x/y y los % comparten `translate`: un tween no puede mover solo una de las dos si otro tween
  // mueve la otra en el mismo elemento; se detecta y se lanza un error.
  var TRANSFORMADAS = ["x", "y", "xPercent", "yPercent", "scale", "rotation"];
  // Solo cuentan las propiedades propias (no las del prototipo).
  function propia(p, k) {
    return Object.prototype.hasOwnProperty.call(p, k);
  }
  function aCss(p) {
    var css = {};
    Object.keys(p).forEach(function (k) {
      // Las transformadas tienen que ser números finitos; cualquier otro valor numérico (opacity…), también.
      if ((TRANSFORMADAS.indexOf(k) >= 0 || typeof p[k] === "number") && !finito(p[k])) {
        throw new Error("hf-tiempo: " + k + " no finito: " + String(p[k]));
      }
    });
    if (propia(p, "x") || propia(p, "y") || propia(p, "xPercent") || propia(p, "yPercent")) {
      var x = (propia(p, "xPercent") ? p.xPercent + "%" : "") + (propia(p, "x") ? (propia(p, "xPercent") ? " + " : "") + p.x + "px" : "");
      var y = (propia(p, "yPercent") ? p.yPercent + "%" : "") + (propia(p, "y") ? (propia(p, "yPercent") ? " + " : "") + p.y + "px" : "");
      css.translate = "calc(" + (x || "0px") + ") calc(" + (y || "0px") + ")";
    }
    if (propia(p, "scale")) css.scale = String(p.scale);
    if (propia(p, "rotation")) css.rotate = p.rotation + "deg";
    Object.keys(p).forEach(function (k) {
      if (TRANSFORMADAS.indexOf(k) < 0) css[k] = p[k];
    });
    return css;
  }

  // `inicio`: segundo absoluto del host, que pone composicion.ts ({{INICIO}}). No se lee del DOM: el runtime
  // desenvuelve la raíz de la subcomposición y quita atributos del host (data-duration) al montarla.
  function contexto(id, inicio) {
    validarId(id);
    var base = tiempo(inicio, "inicio");
    var raiz = document.querySelector('[data-composition-id="' + id + '"]');
    if (!raiz) throw new Error("hf-tiempo: no hay composición " + id);
    var ejes = new WeakMap();
    function elementos(sel) {
      if (typeof sel !== "string") return [sel];
      var l = raiz.querySelectorAll(sel);
      if (!l.length) throw new Error("hf-tiempo: " + sel + " no existe en " + id);
      return Array.prototype.slice.call(l);
    }
    // tween(sel, desde, hasta, t, d, curva, opciones): anima de `desde` a `hasta` entre t y t + d.
    // `antes: false`: no pinta el valor inicial antes de empezar.
    function tween(sel, desde, hasta, t, d, nombre, op) {
      tiempo(t, "t");
      tiempo(d, "d");
      var antes = !op || op.antes !== false;
      var kf = [aCss(desde), aCss(hasta)];
      var opciones = { delay: (base + t) * 1000, duration: Math.max(d, 0.001) * 1000, easing: linear(nombre), fill: antes ? "both" : "forwards" };
      elementos(sel).forEach(function (el) {
        var ejesTween = (propia(desde, "x") || propia(desde, "xPercent") ? "x" : "") + (propia(desde, "y") || propia(desde, "yPercent") ? "y" : "");
        if (ejesTween) {
          var previo = ejes.get(el);
          if (previo && previo !== ejesTween) throw new Error("hf-tiempo: " + el.id + " mezcla tweens de x e y por separado");
          ejes.set(el, ejesTween);
        }
        el.animate(kf, opciones).pause();
      });
    }
    // Envoltura de escena ({{ENVOLTURA_DATOS}}).
    function envoltura(e) {
      if (!e || typeof e !== "object" || !finito(e.fundido) || e.fundido < 0 || typeof e.punch !== "boolean" || !Array.isArray(e.golpes) || !e.golpes.every(function (g) { return finito(g) && g >= 0; })) {
        throw new Error("hf-tiempo: envoltura no válida en " + id);
      }
      if (e.fundido > 0) tween("#" + id + "-fundido", { opacity: 0 }, { opacity: 1 }, 0, e.fundido, "none");
      if (e.punch) tween("#" + id + "-punch", { scale: 1.07 }, { scale: 1 }, 0, 0.45, "expo.out");
      var f = 1 / 30, p = [[0, 0], [22, -14], [-16, 10], [8, -4], [0, 0]];
      e.golpes.forEach(function (t) {
        for (var i = 0; i < 4; i++) tween("#" + id + "-golpe", { x: p[i][0], y: p[i][1] }, { x: p[i + 1][0], y: p[i + 1][1] }, t + i * f, f, "none", { antes: false });
      });
    }
    return {
      inicio: base,
      tween: tween,
      // fn(tLocal) en cada seek del runtime; tLocal = segundos desde el inicio de esta composición. Cualquier script
      // de la página puede despachar `hf-seek`: un tiempo que no sea número finito se ignora.
      reloj: function (fn) {
        window.addEventListener("hf-seek", function (e) {
          var t = e && e.detail ? e.detail.time : undefined;
          if (finito(t)) fn(t - base);
        });
        fn(-base);
      },
      envoltura: envoltura,
      curva: curva,
      numero: numero,
      positivo: positivo,
      id: validarId,
    };
  }
  window.HF = { contexto: contexto, curva: curva, linear: linear };
})();
