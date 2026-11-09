# Pendientes de T6 (montaje de preview y de render)

Rama `feat/6-montaje`, desde `feat/2-audio-wav` (`78e5672`). Sin PR ni fusión.

## Hecho

- `video_montar_preview {id, webgpu}` → `{carpeta: "r<n>", duracion, avisos, fondo: {pedido, usado}}`. El número sale de un
  contador del motor (el mayor del disco o del proceso, más uno) y se conservan la nueva y la inmediatamente anterior
  (la preview abierta puede estar leyendo la anterior); el resto se borra con `borrarArbol`. Un montaje a la vez (`enSerie`).
- `video_renderizar {id, modo}`: `modo` ∈ `auto|rapido|compatible`, validado en la tool y en `encolarRender`
  (`modo inválido`). Con `proyecto.json` en la carpeta, el job monta el Proyecto en `_render/<job>/` y la borra al acabar
  (`finally` + `borrarArbol`); nunca toca `_composicion/`. `Job.modoPedido` y `Job.fondo` salen en `video_estado_render`.
  En integrado el MP4 no sale como ruta absoluta (`mp4: null`, sin ruta en el texto).
- `prepararProyecto` (`src/montaje.ts`): voz por frases → `construirLinea` → audio ensamblado → **normalizado en caché**
  por el hash del ensamblado (`voz/normalizada-<hash>.wav`, se conservan 2). Cambiar un texto que no se narra no repite
  `loudnorm` ni lanza ffmpeg (`edicion_texto_no_normaliza`, `montaje_edicion_rapido`).
- `voz_pendiente` con la lista de ids de frase (preview y render, sin job). Reserva de fondo (I11): sin WebGPU y con fondo de
  shader, `job.reserva = "Fondo <x> sustituido por el degradado CSS."` y `fondo.usado = "css"`.
- R0-6: `barridoAlArrancar` (al arrancar, solo win32, sin bloquear) y tool `video_barrer_procesos` (sin entrada, sin rutas ni pids
  en la respuesta). El backend ya no lee `/proc` en win32 (`_descendientes`) y pide el barrido por la tool; se quitó el `skip`
  de `test_real_el_motor_expone_el_barrido`.
- R0-1: el parche rechaza `--remote-debugging-port` y `--remote-debugging-address` (error «depuración remota … I7»);
  `--remote-debugging-pipe` sigue valiendo. Manifiesto SHA-256 de `chunk-K4MJX7SR.js` actualizado en el mismo commit.
- R0-2: test `servidor_hf_solo_render`.

## Pendiente

1. **Motor no preparado.** `render:mock`, el render real y la parte con sockets de `render_sin_puerto_cdp` no se ejecutaron: no
   hay Chrome del motor. El zip local (`chrome-headless-shell-152.0.7977.30`, 119 527 247 B, SHA-256 `5d7df999…4275`) no
   coincide con ningún hash fijado: el backend fija **156.0.8078.73** (`e6d26810…8628`, 125 506 562 B). No se descargó nada.
   Si se quiere esa versión: `chrome-headless-shell-win64.zip`, `storage.googleapis.com/chrome-for-testing-public/156.0.8078.73/win64/`,
   ≈ 125,5 MB (decide Marc; HyperFrames 0.8.206 fija la 152).
2. **`render_sin_puerto_cdp` completo** (enumerar sockets en escucha de los PID bajo la carpeta del CfT durante un render real,
   `Get-NetTCPConnection -State Listen -OwningProcess`): solo está la mitad unitaria (el parche rechaza el flag). Falta la
   mitad en vivo con el motor preparado.
3. **«Tras una cancelación».** El motor no tiene tool de cancelar: la cancelación es del backend, que para el motor del render
   y pide `video_barrer_procesos` al nuevo (`reiniciar_motor_render`). Si más adelante el motor gana cancelación propia
   (`AbortSignal` en `ejecutar`), `lanzar` debe barrer también en ese caso.
4. **Aviso si GPU de UI y de Chrome difieren** (plan: «Si difieren, aviso»): no hecho; el montaje usa lo que dice la UI
   (`webgpu`). Se puede comparar con `hayWebgpu` en el render y avisar en `Job.avisos`.
5. **Música y recursos (T7).** `PreparadoProyecto` no lleva música ni fotos/clips: `EscenaPlan` solo trae `base`.
6. **`opciones.subtitulos`** (pendiente de T3): `desdeProyecto` sigue leyendo `p.subtitulos.estilo`.
7. Colores del perfil: se usa `temaDePerfil(cargarPerfil(...))`; el tema por defecto de `plantilla/tema.json` solo entra en los
   tests de otros módulos.
8. SSIM de piezas (`w2refs`) sigue sin medirse (referencias ausentes, igual que en T2 y T3).
9. `tests/test_video_t11.py::test_real_el_motor_expone_el_barrido` necesita `video-mcp-server/dist` (`npm run build`).
10. Hallazgos Low de la auditoría (L-1, L-2, L-4, L-5, L-6, L-7): ver `seguridad-T6.md`.
11. LOW-R1 (fallo de CLI con ffmpeg elevado ajeno → `exit(70)`) e Info (normalizada borrada mientras el job espera en cola):
    anotados, sin tocar.
12. `pasaPorEnlace` también rechaza un `VIDEO_ROOT` colgado de un enlace legítimo (comprueba todos los padres): si Marc lo usa,
    acotar a la carpeta del proyecto.
