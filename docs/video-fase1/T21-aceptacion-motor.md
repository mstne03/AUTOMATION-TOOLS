# T21: aceptación del motor de vídeo (CA1, CA5, CA7, CA8)

Fichero: `video-mcp-server/test/aceptacion.test.ts`. Fixtures: `video-mcp-server/test/fixtures-guiones/{futbol,cocina}.json`
(cada uno con `perfil` y `guion`). Script: `npm run render:aceptacion` (también ejecuta `fidelidad-preview.test.ts`).
`npm test` excluye `aceptacion`, `fidelidad-preview` y `rendimiento-180s`.

## Cómo corre
Motor real: CfT copiado a un temporal con su manifiesto SHA-256 (`verificarNavegador`), ffmpeg LGPL del bundle,
ElevenLabs simulado con un `fetch` inyectado en `vozGenerar` (MP3 real de 2,5 s por frase; comprueba que cada llamada va a
`https://api.elevenlabs.io/` con la clave centinela en `xi-api-key` y no sale a la red). Flujo de punta a punta por fixture:
`perfilDuplicar`+`perfilGuardar` → `guionGuardar` → `proyectoCrear` → `vozCoste`/`vozGenerar` → `renderizar` (tool) →
`esperarJob` → `estadoRender`. `dependencias.sondear = async () => []` (sondeo vacío) y `VIDEO_FORZAR_SIN_GPU=1`.
Si falta `FFMPEG_DIR`/`VIDEO_E2E_FFMPEG`, `VIDEO_E2E_NAVEGADOR` o no es Windows, el `beforeAll` falla (no se salta).

```
FFMPEG_DIR=<bin LGPL> VIDEO_E2E_FFMPEG=<bin LGPL> VIDEO_E2E_NAVEGADOR=<carpeta con chrome-headless-shell-win64> \
  npx vitest run test/aceptacion.test.ts
```

## Casos
- **CA1 dos_temas_dos_perfiles**: un MP4 por fixture con el mismo build (13,12 s, `h264_mf`); los dos MP4 difieren, y cada
  composición lleva el acento y la fuente de su perfil y no los del otro. `grep` en `src/` y `plantilla/` (todos los
  ficheros de texto, incluido `vendor/`) sin literales de fútbol (fútbol, portero, balón, penalti, delantero, árbitro, estadio) ni de
  cocina (receta, sartén, tortilla, cebolla, patata, ingrediente, horno, cocina).
- **CA5**: `sondear(soloMp4)` + `verificarMp4(info, duraciónPlanificada, "h264_mf")` sobre los dos MP4 (1080×1920, 30 fps,
  1 pista de audio, duraciones de vídeo y audio = la del montaje ±0,1 s). Un MP4 1080×1920 sin audio (generado con el ffmpeg LGPL, `h264_mf`) lanza «sin pista de audio».
- **CA7 clave_ausente**: sobre el render real de CA1, la clave centinela no aparece en ningún fichero de `videos/`, `perfiles/`
  y la carpeta de estado (incluye `video.log` y `hf-home`), en la composición montada de cada proyecto, en las respuestas de
  `renderizar`/`estadoRender`/`vozCoste`/`vozGenerar`, en los args de las tools, en el JSON de los jobs ni en `entornoHijo()`.
  Control: un `log.warn` con la clave sale como `***` en `video.log`.
- **CA8 sin_webgpu_y_sin_gpu**: `ordenSegundaPasada([])` = `["h264_mf"]`, `elegirModo` → `compatible`; el fixture con fondo `aurora`
  sale con `fondo {pedido: aurora, usado: css}`, `job.reserva` «degradado CSS», visible en `estadoRender` (texto «Reserva:» y `datos.reserva`) y
  `codificador h264_mf`; el de fondo `gradiente` no necesita reserva.

## Resultado
`11 passed (11)`; ejecución completa 611 s: render futbol 166 s, cocina 423 s (13,12 s de vídeo cada uno, en software, sin GPU). Sin procesos
propios vivos al terminar; el temporal se borra en `afterAll`.

## Hallazgo: bug del motor (no arreglado)
Un proyecto cuya **primera escena es `cartel` o `cifra`** (y, por extensión, cualquier escena con texto en la mitad superior) falla en
`hyperframes check` con `error content_overlap: Two text blocks overlap [esc1.html @0.726s]` (3 errores con `cartel`, 1 con `cifra`),
y el render termina en `error`. Causa: el gancho (`gancho.html`, top 200 px, hasta 2,3 s) solo se recorta con las escenas de
`ventanas.slice(1)` (`src/composicion.ts` ~l. 544); la escena del bloque 1 siempre coincide con el gancho. En el flujo de proyectos
la primera escena puede ser cualquiera de los 5 tipos, así que el editor puede producir proyectos que no se pueden renderizar.
Con `mapa` como primera escena (sin texto en la franja del gancho) el render pasa; por eso los dos fixtures empiezan por `mapa`.
Conviene un test propio y un arreglo en la composición (recortar o ocultar el gancho cuando la escena 1 es de texto, o mover el texto).
