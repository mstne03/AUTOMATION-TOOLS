        // Gancho sin GSAP: los mismos tweens que plantilla/piezas/gancho.html, uno a uno.
        (function () {
          var hf = HF.contexto(RAIZ_ID, INICIO);
          var D = DURACION;
          var IN = 0.72, OUT = 0.46, LAND = 0.58, F = 1 / 30;
          if (D < IN + OUT) { var k = D / (IN + OUT); IN *= k; OUT *= k; LAND *= k; F *= k; }
          hf.tween("#gancho-titular", { scale: 1.12 }, { scale: 1 }, 0, LAND, "expo.out");
          var pasos = [[0, 0], [6, -6], [-4, 4], [0, 0]];
          for (var i = 0; i < 3; i++) {
            hf.tween("#gancho-stage", { x: pasos[i][0], y: pasos[i][1] }, { x: pasos[i + 1][0], y: pasos[i + 1][1] }, LAND + i * F, F, "power2.out", { antes: false });
          }
          var hold = Math.max(0, D - IN - OUT);
          // El original fija y: 0 en el primer tween; aquí lo pone el de espera (o la salida si no hay espera).
          if (hold > 0) hf.tween("#gancho-titular", { y: 0 }, { y: -6 }, IN, hold, "sine.inOut");
          hf.tween("#gancho-titular", { y: hold > 0 ? -6 : 0 }, { y: -900 }, IN + hold, OUT, "power4.in", { antes: hold === 0 });
        })();