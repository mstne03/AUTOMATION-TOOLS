# Estado de T3 (composición de N escenas)

Rama `feat/3-n-escenas`, desde `fix/borrar-arbol` (`3c618e7`). Sin PR ni fusión.

## Hecho

- `src/composicion.ts`: `EntradaPlan` / `EscenaPlan` / `OpcionesPlan`; `planificarComposicion(EntradaPlan)` sin los
  literales `[1..6]`, `k === 5`, `k < 5` ni `segmentos.length !== 6`; ids HTML `esc1…esc90` por índice; capas fijas
  bucle 199, capas 200, gancho 210, etiqueta 211, subtítulos 220, flash 230 (la escena n va en 10 + n);
  `desdeGuionV2` (adaptador de los tests del guion de 6 bloques, se borra en la fase 2); `cabeGancho` y aviso si el
  gancho no cabe ni al mínimo del tema; validaciones previas (segmentos = escenas, tiempos finitos, destellos en rango);
  barrera `hallazgosDeRed` sobre todos los ficheros antes de devolver el plan (I2, también para un `Proyecto` a mano).
- `src/linea.ts`: `construirLinea(proyecto, voz)` (recorte con la misma regla que `ensamblarVoz`, `ajusteCorte` pegado a la
  palabra más cercana, correcciones y cortes de subtítulos) y `desdeProyecto` (puente `Proyecto` → `EntradaPlan`; el golpe
  `{frase, palabra}` se resuelve a la palabra de su escena). T6 lo reutiliza; no hace falta escribirlo otra vez.
- `src/render.ts`: usa `desdeGuionV2`; el número de segmentos sale de `guion.bloques`, ya no es un 6 fijo.
- Tests: `composicion-n.test.ts`, `linea.test.ts`, `ayudas-n.ts`; ids `bloqueN` → `escN` en los tests existentes.
- R1: `test_real_xss_en_la_composicion` (10 variantes: 5 ataques × ataque en prefijo o en sufijo) con POST real,
  `scripts/componer-proyecto.mjs` sobre `dist/` y `urlsDeRed` vacío. Comprobado que muerde: con `escaparHtml` anulado
  fallan 6 de 10.

## Pendiente (no hecho en esta sesión)

1. **SSIM de las piezas no medido.** `VIDEO_ENGINE_DIR=…\Temp\motor152` y `W2_REFS=…\Temp\w2refs` **no existen** en esta
   máquina (ni en otra ruta de `AppData`, `Documents` o `Desktop`); `piezas-comun.ts` salta la comparación con un aviso.
   Existe `…\AppData\Local\seo-studio-dev\descargas\` con Chrome 152, ffmpeg y Node en zip, pero no las referencias
   `ref.mp4`. Hay que repetir `npx vitest run test/piezas-w21…w25.test.ts` con las referencias de Marc (umbral ≥ 0,99).
2. **`piezaMapa` `empieza` en `DATOS` (bug W2.3) sin hacer.** La pieza `escena-mapa.html` no lee `d.empieza` y los tests
   fijan el comportamiento actual (el mapa entra a 0,45 s, igual que la referencia congelada). Cambiarlo mueve el mapa
   ~0,3 s y exige regenerar la referencia SSIM del mapa en una copia de `W2_REFS`; sin referencias no se puede medir.
3. Audio interno en WAV (T2) y montaje (T6): otra sesión.
