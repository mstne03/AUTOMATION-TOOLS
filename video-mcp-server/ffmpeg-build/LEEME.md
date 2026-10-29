# ffmpeg LGPL propio y mínimo (W1.5 · SEO-115)

Build reproducible de `ffmpeg.exe` + `ffprobe.exe` para win64, LGPL-2.1-o-posterior, con solo lo
que usan HyperFrames y el motor de vídeo. Sustituirá al ffmpeg de BtbN del instalador en W3.2.

**Estado:** tareas 1–9 hechas sin red. Quedan marcadores `PENDIENTE-TAREA-10` (hashes, commits,
huellas, digest de la imagen, snapshot de Debian, SHA de dos acciones): ninguna construcción real
arranca mientras quede uno (`comprobar-pendientes.sh`).

## Fuente única

`componentes.conf` define qué se habilita (`--disable-everything` + listas exactas) y qué está
prohibido. Todo lo demás (configure, lista blanca, listados del binario) sale de ahí.

## Puerta W3.2

Este ffmpeg **no sustituye a BtbN** en el instalador mientras `FF_EXCLUIDOS_CONOCIDOS` no esté
vacío. Hoy: `libmp3lame` (R1, `musica.ts`). Pasar `musica.ts` a AAC en `.m4a` o a WAV es de otro
paquete; `tests/componentes.test.sh` lo imprime como «EXCLUIDO CONOCIDO» en cada ejecución.

## Tests

```bash
bash video-mcp-server/ffmpeg-build/tests/run.sh             # sin red ni Docker
bash video-mcp-server/ffmpeg-build/tests/run.sh --estricto  # además: ningún PENDIENTE-TAREA-10
```
