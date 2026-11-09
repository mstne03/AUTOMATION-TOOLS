# Seguridad de T3 · R1 conjunta T1 + T3 + T9

Auditor: subagente Opus `cyber-security-auditor`, solo lectura, sobre `3c618e7..540e67e` (T3) y el código de T1 y T9.
Detalle completo del auditor (escenarios y correcciones propuestas): carpeta de notas de la sesión, `R1-T1-T3-T9.md`.

**Veredicto: 0 Critical, 0 High.** Con los cierres de abajo, las cinco condiciones de `R1-T1-T9.md` §136-164 quedan
cumplidas. No se hizo una segunda ronda con el auditor: las correcciones se verificaron con tests (ver «Cierre»).

## Condiciones

| # | Condición | Resultado |
|---|---|---|
| 1 | N1 (sustituto suelto → 422) y N2 (`/video/capacidades` sin rutas) | Cumple, con test |
| 2 | XSS con POST real, `_composicion/**` sin texto crudo, `urlsDeRed` vacío | Cumple tras M-1 y M-2 |
| 3 | Negativas de T3 (`script_y_llaves_escapados`, `sin_url_de_red`, `clave_no_llega`, `numero_no_finito_lanza`, `ids_por_indice`) | Cumple; única exclusión de `urlsDeRed`: `VENDOR_FIJADO` por hash |
| 4 | T3 consume solo el `Proyecto` validado; `escribirPlan` rechaza `rel` fuera de `destino` | Cumple tras L-1 |
| 5 | Patrones compartidos, escape por contexto en una pasada, capas z fijas | Cumple (z probado con 90 escenas) |

## Hallazgos y cierre

| Id | Sev. | Hallazgo | Cierre |
|---|---|---|---|
| M-1 | Medium | `{{ID}}` sin aserción en el test REST: una doble pasada pasaría en verde | El test exige que el ataque llegue literal a algún fichero y que no quede ningún `{{X}}` sin sustituir |
| M-2 | Medium | `opciones.etiqueta`, `subtitulos.correcciones` y `titulo3d` no se ejercitaban (con todas las escenas gráficas la etiqueta no se emite) | `composicion-n.test.ts` «etiqueta, correcciones y titulo3d con ataque»: comprueba que `etiqueta.html` existe y que nada queda sin escapar |
| L-1 | Low | `escribirPlan` no contenía las rutas (la condición 4 lo daba por hecho) | Comprueba todas las rutas de `archivos` y `copias` antes de borrar o escribir; test con `../` y `..\` |
| L-3 | Low | `ESTILO` iba a un atributo `class` sin validar y N no tenía tope | El plan lanza con estilo fuera de la lista y con más de 90 escenas |
| L-2 | Low | La barrera `hallazgosDeRed` no incluye `ESQUEMA_GENERICO_RE` (`ftp://`, `data:` en un `Proyecto` a mano) | **Abierto, aceptado:** el texto va escapado y los patrones de red de la barrera cubren `http(s)`, `ws(s)`, `file:` y `//`. Hay que decidir si se unifican al montar T6 |
| L-4 | Low | El test REST salta `vendor` por la ruta, no por el hash | **Abierto:** lo que se salta es JS de terceros ya escaneado por `urlsDeRed` con hash fijado |
| – | – | `desdeProyecto` ignoraba `p.subtitulos.estilo` | Corregido: usa el estilo que edita el usuario |

## Cómo se ha probado

- `npm test` (motor), tras los cierres: 1062 pasan, 67 saltados. `npx tsc`: limpio.
- `VIDEO_ENGINE_R1=1 uv run pytest tests/test_video_rest.py`: 74 pasan, 3 saltados (tras los cierres). `uv run pytest -q` completo (antes de los cierres): 601 pasan, 12 saltados.
- El test de XSS real muerde: con `escaparHtml` anulado en `dist/` fallan 6 de 10 variantes.
- No se ejecutó render, SSIM ni nada fuera de loopback (ver `estado-T3.md`).
