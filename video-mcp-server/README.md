# video-mcp-server

Motor de vídeo de SEO Studio. Es un servidor MCP (stdio) que produce vídeos verticales de 1080×1920:
la voz sale de ElevenLabs con marcas de tiempo por carácter (subtítulos palabra a palabra sin
transcripción) y el vídeo se compone y renderiza con la CLI de HyperFrames, instalada como
dependencia local. Sirve para cualquier canal y temática.

Se ejecuta de dos formas:

- **Integrado**: lo lanza como proceso hijo el backend de SEO Studio, con `VIDEO_ENGINE_EMBEDDED=1`.
  Toda la configuración llega por variables de entorno y no se lee ningún `.env`.
- **Suelto** (desarrollo): como servidor MCP stdio, leyendo `.env` de la carpeta del servidor.

`stdout` es del protocolo MCP; los logs van a `stderr` y a `STATE_DIR/video.log`.

## Herramientas

`video_listar`, `video_guardar_guion`, `video_estado`, `video_generar_voz`, `video_renderizar`,
`video_estado_render`, `video_fotograma`, `video_ayuda`, `video_capacidades`, `video_vista_previa`,
`video_musica` y `video_catalogo`. El formato del guion (6 bloques) está en `video_ayuda`.

Flujo habitual: `video_guardar_guion` → fotos `img1…img6` en la carpeta del vídeo →
`video_generar_voz` → `video_vista_previa` (opcional) → `video_renderizar` → `video_estado_render`
→ `video_fotograma`. Cada vídeo vive en `VIDEO_ROOT/videoNNN` (`video001`, `video002`…).

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `ELEVENLABS_API_KEY` | para la voz | Clave de la API. Nunca se escribe en logs ni en errores. |
| `ELEVENLABS_VOICE_ID` | para la voz | Id de la voz. |
| `ELEVENLABS_MODEL_ID` | no | Por defecto `eleven_multilingual_v2`. |
| `VIDEO_ROOT` | no | Carpeta de los vídeos. Por defecto `~/Videos/SEO Studio`. |
| `VIDEO_STATE_DIR` | no | Dónde se escriben `video.log`, `capacidades.json` y `musica-cache.json`. Por defecto `logs/` junto al motor; instalado en una carpeta de solo lectura hay que fijarla. |
| `VIDEO_ENGINE_EMBEDDED` | no | `1` para el modo integrado: no se lee ningún `.env`. |
| `VIDEO_MUSICA_VOLUMEN` | no | 0-1, por defecto `0.12`. Cada guion puede pisarlo con `musica_volumen`. |
| `VIDEO_FORZAR_SIN_GPU` | no | `1` para no usar WebGPU aunque haya (fondos con el degradado de reserva). Para pruebas. |
| `HYPERFRAMES_BROWSER_PATH` | no | Solo si la CLI no encuentra Chrome. |
| `FFMPEG_DIR` | no | Carpeta `bin` de FFmpeg si no está en el PATH. |

La telemetría de HyperFrames queda desactivada (`HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`).

## Compilar y probar

Requisitos: Node 22 o superior y FFmpeg.

```bash
npm install
npm run build
npm test
```

`npm test` compila y ejecuta la batería (los tests corren en serie porque lanzan ffmpeg y Chrome).
Las ejecuciones de render completas, más lentas, van aparte:

```bash
npm run render:mock
npm run render:matriz
```

`render:matriz` deja una hoja de contacto por vídeo en `test/salidas/`.

## Seguridad

- Nada sale de `VIDEO_ROOT`: los ids se validan (`^video\d{3}$`) y las rutas se resuelven dentro de la raíz.
- Los procesos hijos se lanzan con `spawn` sin shell y con los argumentos en array.
- El motor no abre puertos.
