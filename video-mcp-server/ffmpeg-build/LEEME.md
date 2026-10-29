# ffmpeg LGPL propio y mínimo (W1.5 · SEO-115)

Build reproducible de `ffmpeg.exe` + `ffprobe.exe` para win64, LGPL-2.1-o-posterior, con solo lo
que usan HyperFrames y el motor de vídeo. Sustituirá al ffmpeg de BtbN del instalador en W3.2.

**Estado:** tareas 1–9 hechas sin red. Quedan marcadores `PENDIENTE-TAREA-10` (hashes, commits,
huellas, anclajes, digest de la imagen, snapshot de Debian, versiones de paquetes, SHA de dos
acciones). Ninguna construcción real arranca mientras quede uno: `comprobar-pendientes.sh` es la
primera orden de `construir.sh` y del job `construir`, antes de cualquier descarga.

## Archivos

| Archivo | Qué hace |
|---|---|
| `componentes.conf` | **Fuente única**: `--disable-everything` + listas exactas, lista blanca, prohibidos, excluidos conocidos |
| `autoseleccionados.txt` | Lo que configure activa por su cuenta; revisado a mano contra el primer build (Tarea 10) |
| `fuentes.lock` | Versión, URL, SHA-256, commit, firma, huella y anclaje de cada fuente; InRelease de Debian; `SOURCE_DATE_EPOCH` |
| `claves/` | Claves públicas de firma (se commitean en la Tarea 10) |
| `Dockerfile` | Imagen de construcción: base por digest, paquetes del snapshot con versión exacta, usuario no root |
| `comprobar-pendientes.sh` | Puerta: ningún `PENDIENTE-TAREA-10` en las entradas del build |
| `comprobar-inrelease.sh` | Ancla el InRelease del snapshot (SHA-256 y `Date:` ≤ marca de tiempo) |
| `descargar-fuentes.sh` | Única fase con red: HTTPS sin redirecciones, SHA-256, GPG con huella exacta y anclaje en dos canales, git por commit + `git archive` + espejo |
| `compilar.sh` | Dentro del contenedor y sin red: zlib → dav1d → nv-codec-headers → AMF → ffmpeg |
| `construir.sh` | Orquesta: puerta, imagen, descarga (un contenedor) y compilación (otro, `--network none`) |
| `verificar-configuracion.sh` | Puerta de licencia y superficie sobre `-buildconf`/`FFMPEG_CONFIGURATION` |
| `verificar-binario.sh` | Sobre el `.exe` real en Windows: listados exactos, `-L`, PE, decodificación, tubería, protocolos, rutas |
| `recopilar-avisos.sh`, `empaquetar-fuente.sh` | `LICENSES/`, `LEEME-FFMPEG.txt` y el tarball reproducible del código fuente correspondiente |
| `comparar-builds.sh` | Dos construcciones deben ser idénticas bit a bit |
| `tests/` | `run.sh` y un `*.test.sh` por pieza; `muestras/` (≤ 30 KB, sintéticas, ver `PROCEDENCIA.md`) |

## Qué lleva y qué no

Codificadores: `prores_ks` (intermedio 4444), `h264_mf`, `h264_nvenc`, `h264_amf`, `aac`, `png`,
`pcm_s16le`, `rawvideo`. Decodifica H.264, HEVC, VP9, AV1 (dav1d), JPEG, PNG, WebP, ProRes, AAC,
MP3, FLAC, Vorbis, Opus y PCM. Protocolos: solo `file` y `pipe`. Detalle y motivos en
`componentes.conf`. Fuera, con su decisión:

- **libvpl / `h264_qsv`** (ruling R0): una fuente sin firma y una vía de carga de DLL menos; en
  Intel, `h264_mf` usa el MFT de hardware. Con QSV fuera tampoco hacen falta `d3d11va`/`dxva2`
  (AMF crea su propio dispositivo D3D11); si configure demostrara lo contrario, el build falla.
- **LAME** (R1), **libvpx/libopus** (R2: sin WebM de reserva; si falta disco, error visible),
  **zimg** (R3: HDR no se atenúa en silencio, lo resuelve I15 al normalizar).
- `--enable-gpl`, `--enable-nonfree`, `--enable-version3`, x264/x265/openh264, cualquier
  `--enable-hwaccel`, y los filtros `movie`, `amovie`, `zmq`, `azmq`, `sendcmd`, `asendcmd`.

## Puerta W3.2

Este ffmpeg **no sustituye a BtbN** en el instalador hasta que se cumpla todo:

1. `FF_EXCLUIDOS_CONOCIDOS` vacío. Hoy: `libmp3lame` (R1, `musica.ts`); pasar `musica.ts` a AAC
   en `.m4a` o a WAV es de otro paquete. `tests/componentes.test.sh` lo imprime en cada ejecución.
2. El SHA-256 de CI coincide con el de la construcción de Marc como segundo testigo (R0 M5).
3. Marc ha probado `h264_nvenc` y `h264_mf` en su máquina (bloqueante si CI corrió con `SIN_MF=1`).
4. W3.2 fija el SHA-256 en `prepare-video-engine.sh`: ese es el control final, no la release.

## Protocolos y UNC (R0 M2)

El build no tiene protocolos de red, pero `file` en Windows resuelve rutas UNC (SMB/WebDAV). La
defensa está en el motor: nunca pasa rutas que empiecen por `\\` o `//`, nunca usa `-safe 0` con
listas que no genera él, y toda invocación sobre bytes no generados por nosotros lleva `-f` y
`-format_whitelist` sin `concat`, `image2`, `lavfi` ni `nut`. `verificar-binario.sh` lo prueba con
`trampa.ffconcat` (UNC y `..\`): con `-f mp3 -format_whitelist …` falla; sin whitelist, deja en el
resumen qué pasó (con el `safe=1` por defecto del demuxer concat, BtbN la rechaza).

NVENC y AMF cargan su DLL en tiempo de ejecución: `compilar.sh` exige que sea por `win32_dlopen`
(solo System32 y la carpeta del `.exe`). Por eso la carpeta del ffmpeg instalado no debe admitir
DLL ajenas (ver riesgos).

## Cadena de suministro

- **Fuentes**: versión exacta, HTTPS (`--proto =https --tlsv1.2`, sin redirecciones, tamaño
  máximo), SHA-256 y, si el proyecto firma, GPG en un `GNUPGHOME` temporal exigiendo `VALIDSIG`
  con la huella primaria exacta y rechazando `EXPKEYSIG`/`REVKEYSIG`/`BADSIG`/`ERRSIG` (no hay
  excepciones escritas; añadir una exige cambiar el script). La huella debe estar anclada en dos
  canales de hosts distintos al de descarga (`debian:<paquete>` = su `signing-key.asc` en el mismo
  snapshot, o una página HTTPS del proyecto); nunca un keyserver ni el propio `.asc` (R0 H1).
- **git** (nv-codec-headers, AMF): commit de 40 hex, la etiqueta debe apuntar a él, SHA-256 del
  `git archive` (con `core.autocrlf=false`, calculado en la imagen fijada) y el espejo de `canal2`
  debe dar lo mismo (L1). AMF: solo el subárbol `amf/public/include`.
- **Imagen**: base por digest; apt solo de `snapshot.debian.org` con marca de tiempo fija, cada
  paquete con `=versión` y el InRelease anclado por SHA-256 (fija también las dependencias). Única
  excepción a HTTPS: `ca-certificates`, que la imagen slim no trae, se instala por HTTP; la
  integridad la dan la firma de apt y el InRelease anclado, y después todo va por HTTPS.
- **Contenedores**: descarga y compilación separadas; la compilación con `--network none`;
  ambos con `--cap-drop ALL`, `no-new-privileges`, raíz de solo lectura, el usuario del host,
  `ffmpeg-build/` y (al compilar) `fuentes/` en solo lectura, sin socket de Docker. Sin caché de
  capas (`--no-cache`).
- **Determinismo**: `SOURCE_DATE_EPOCH` del lock, `TZ=UTC`, `LC_ALL=C`, `umask 022`,
  `-ffile-prefix-map`, `-fno-ident`, `--no-insert-timestamp`, `--build-id=none`, `strip --strip-all`.
  Endurecimiento: ASLR de 64 bits, DEP, `-fstack-protector-strong`, enlace estático.
- **I11**: configure falla si no encuentra algo pedido; además `compilar.sh` rechaza cualquier
  `WARNING:` o `did not match anything` y comprueba en `config_components.h` que cada componente
  declarado está activo y que no hay hwaccel, protocolo no declarado ni nada prohibido.

## Construir y probar

```bash
bash video-mcp-server/ffmpeg-build/tests/run.sh             # sin red ni Docker
bash video-mcp-server/ffmpeg-build/tests/run.sh --estricto  # además: ningún PENDIENTE-TAREA-10
FFMPEG_DIR=/ruta/con/ffmpeg.exe bash video-mcp-server/ffmpeg-build/tests/run.sh   # + verificar-binario
bash video-mcp-server/ffmpeg-build/construir.sh --fuentes <dir vacío> --salida <dir vacío>  # con red
```

## Publicación (R0 H2)

Workflow `.github/workflows/ffmpeg-lgpl.yml`: `pruebas` → `construir` (a y b) → `verificar`
(Windows; `SIN_MF` solo como entrada explícita) → `empaquetar` → `publicar` (manual). Pensado para
vivir en el **repositorio público** de la oferta de código fuente (R7, pendiente de Marc), sin PAT:

- Variable de repositorio `REPO_FUENTE` = `owner/repo` público; `publicar` falla si no es este repo.
- Environment `release` con revisores obligatorios y *deployment branches* = solo `main`.
- Releases inmutables activadas y un ruleset de etiquetas `ffmpeg-lgpl-*` (sin borrado ni
  actualización, solo creación por el workflow).
- La release lleva `ffmpeg.exe`, `ffprobe.exe`, `SHA256SUMS`, `LEEME-FFMPEG.txt`, `LICENSES/*`,
  el tarball del código fuente correspondiente y la atestación de procedencia. Se mantiene
  mientras se distribuya el binario y tres años más.

## Tarea 10 (con permiso de Marc; nada de esto se ha ejecutado)

**Permiso A (portátil de Marc, ≈ 20 MB):**

1. `bash descargar-fuentes.sh --arranque` → SHA-256 de los tarballs y commit + SHA-256 del
   `git archive` de las fuentes git. Contrastar con un canal independiente (dav1d `.sha256`,
   zlib.net, página de la etiqueta en GitHub).
2. AMF: leer en el `configure` de 7.1.5 la versión mínima (`grep -n "AMF_VERSION" configure`),
   fijar en `version` la etiqueta mínima que la cumpla (candidata `v1.4.36`) y repetir el paso 1
   para esa fila. Comprobar también el mínimo de nv-codec-headers (`n12.1.14.0`).
3. Claves: exportar cada una a `claves/<nombre>.asc`, comparar su huella con los dos canales de
   anclaje (tabla en `claves/LEEME.md`) y escribir `huella` y `anclaje` en `fuentes.lock`.
4. `SOURCE_DATE_EPOCH` = fecha de la release de ffmpeg 7.1.5 (p. ej. la mtime de su `VERSION`).

**Permiso B (runner de GitHub y la construcción local de testigo):**

5. Digest de `debian:trixie-slim`, marca de tiempo del snapshot, versión exacta de cada paquete
   en ese snapshot y SHA-256 de su `InRelease` (en `Dockerfile` y `fuentes.lock`).
6. SHA de `actions/download-artifact` (v4) y `actions/attest-build-provenance` (v2) de una
   etiqueta con ≥ 2 semanas (`gh api repos/actions/<acción>/git/ref/tags/<tag>`), comprobados
   con zizmor.
7. `bash tests/run.sh --estricto` en verde → `workflow_dispatch`. `comparar-builds` debe dar
   idéntico; si no, diffoscope antes de seguir (aceptar un residuo exige una lista cerrada de
   secciones PE en `comparar-builds.sh`, con test).
8. Revisar los listados reales contra `autoseleccionados.txt` y quitar su línea `PENDIENTE`.
9. **Testigo (M5):** Marc ejecuta `construir.sh` en su máquina; su `SHA256SUMS` debe coincidir con
   el de CI. Marc prueba `h264_nvenc` y `h264_mf` (RTX 4060). QSV fuera; AMF sin GPU AMD dedicada.
10. Anotar aquí los SHA-256 de `ffmpeg.exe`/`ffprobe.exe` y la URL del asset para W3.2.

### Descargas que pedirá la Tarea 10

| # | Qué | Origen | Tamaño aprox. | Permiso |
|---|---|---|---|---|
| 1 | `ffmpeg-7.1.5.tar.xz` + `.asc` | https://ffmpeg.org/releases/ | ~11 MB + <1 KB | A |
| 2 | Clave de firma de FFmpeg | https://ffmpeg.org/ffmpeg-devel.asc | ~4 KB | A |
| 3 | `dav1d-1.5.4.tar.xz` + `.asc` + `.sha256` | https://downloads.videolan.org/pub/videolan/dav1d/1.5.4/ | ~1 MB | A |
| 4 | `zlib-1.3.2.tar.xz` + `.asc` | https://zlib.net/ | ~1,3 MB | A |
| 5 | nv-codec-headers `n12.1.14.0` (clon parcial) | GitHub FFmpeg/nv-codec-headers y git.videolan.org | ~1 MB ×2 | A |
| 6 | AMF headers (clon parcial, solo `amf/public/include`) | GitHub GPUOpen-LibrariesAndSDKs/AMF | ~1–5 MB | A |
| 7 | Anclajes: `signing-key.asc` de ffmpeg, dav1d y zlib en Debian; PKGBUILD de Arch; madler.net | snapshot.debian.org, gitlab.archlinux.org, madler.net | < 50 KB | A |
| 8 | Imagen `debian:trixie-slim` | Docker Hub (por digest) | ~30 MB | B |
| 9 | Paquetes de Debian (MinGW-w64, nasm, meson, ninja, pkgconf, gpg, git, curl…) | snapshot.debian.org | ~400–600 MB, ~1,2 GB instalados | B |
| 10 | Ejecución del workflow (repite 1–9 en el runner) | GitHub Actions | — | B |
