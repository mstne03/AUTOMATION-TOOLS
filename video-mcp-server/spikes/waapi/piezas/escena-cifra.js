        // Escena cifra sin GSAP: lo visual con WAAPI y la cuenta del número con el reloj (hf-seek).
        (function () {
          var hf = HF.contexto(RAIZ_ID, INICIO);
          var id = RAIZ_ID; // la raíz es el host (h-…): el runtime quita el div interno
          var d = JSON.parse(document.getElementById(id + "-datos").textContent);
          var e = ENV; // inyectado por montar.mjs desde la envoltura que generó composicion.ts
          var s = "#" + id;
          if (e.fundido > 0) hf.tween(s + "-fundido", { opacity: 0 }, { opacity: 1 }, 0, e.fundido, "none");
          if (e.punch) hf.tween(s + "-punch", { scale: 1.07 }, { scale: 1 }, 0, 0.45, "expo.out");
          var f = 1 / 30, p = [[0, 0], [22, -14], [-16, 10], [8, -4], [0, 0]];
          e.golpes.forEach(function (t) {
            for (var i = 0; i < 4; i++) hf.tween(s + "-golpe", { x: p[i][0], y: p[i][1] }, { x: p[i + 1][0], y: p[i + 1][1] }, t + i * f, f, "none", { antes: false });
          });
          var num = document.getElementById(id + "-num");
          var fmt = function (v) {
            return d.prefijo + v.toLocaleString("en-US", { minimumFractionDigits: d.decimales, maximumFractionDigits: d.decimales }) + d.sufijo;
          };
          var cuenta = HF.curva("power2.out");
          hf.reloj(function (t) {
            var u = Math.min(1, Math.max(0, (t - d.empieza) / d.cuenta));
            num.textContent = fmt(d.valor * cuenta(u));
          });
          hf.tween(s + "-grupo", { opacity: 0, y: 40 }, { opacity: 1, y: 0 }, d.empieza - 0.1, 0.4, "power3.out");
          hf.tween(s + "-etq", { opacity: 0, y: 20 }, { opacity: 1, y: 0 }, d.aterriza, 0.35, "power2.out");
          hf.tween(s + "-num", { scale: 1.12 }, { scale: 1 }, d.aterriza, 0.3, "expo.out", { antes: false });
          hf.tween(s + "-luz", { opacity: 0 }, { opacity: 0.35 }, d.aterriza, 0.03, "none", { antes: false });
          hf.tween(s + "-luz", { opacity: 0.35 }, { opacity: 0 }, d.aterriza + 0.03, 0.15, "power2.out", { antes: false });
        })();