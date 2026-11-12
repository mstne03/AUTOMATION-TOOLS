# ffmpeg LGPL propio y mínimo (W1.5 · SEO-115)

Build reproducible de `ffmpeg.exe` + `ffprobe.exe` para win64, LGPL-2.1-o-posterior, con solo lo
que usan HyperFrames y el motor de vídeo. Sustituirá al ffmpeg de BtbN del instalador en W3.2.

**Estado:** tareas 1–9 hechas sin red y descargas locales de la Tarea 10 hechas (ver «Estado de la
Tarea 10»). Quedan marcadores `PENDIENTE-TAREA-10` (hashes, commits,
huellas, anclajes, digest de la imagen, snapshot de Debian y versiones de paquetes). Ninguna
construcción real arranca mientras quede uno: `comprobar-pendientes.sh` es la primera orden de
`construir.sh` y del job `construir`, antes de cualquier descarga.

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
| `descargar-fuentes.sh` | Única fase con red: HTTPS, redirecciones solo dentro del operador, SHA-256, GPG con huella exacta y anclaje en dos canales, git por commit + `git archive` + espejo |
| `compilar.sh` | Dentro del contenedor y sin red: zlib → dav1d → nv-codec-headers → AMF → ffmpeg |
| `construir.sh` | Orquesta: puerta, imagen, descarga (un contenedor) y compilación (otro, `--network none`) |
| `verificar-configuracion.sh` | Puerta de licencia y superficie sobre `-buildconf`/`FFMPEG_CONFIGURATION` |
| `verificar-binario.sh` | Sobre el `.exe` real en Windows: listados exactos, `-L`, PE, decodificación, tubería, protocolos, rutas |
| `pe.sh` | Lector PE32+ (banderas y tabla de importación) y lista cerrada de DLL; lo carga `verificar-binario.sh` |
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

1. `FF_EXCLUIDOS_CONOCIDOS` vacío (cumplido desde T2: `musica.ts` escribe WAV `pcm_s16le`, sin `libmp3lame`).
   `tests/componentes.test.sh` falla si el motor vuelve a usar algo que este build no lleva.
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

NVENC y AMF cargan su DLL en tiempo de ejecución: `compilar.sh` exige que sea por `win32_dlopen`,
que llama a `LoadLibraryExW` con `LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32`.
Con esas banderas **la carpeta del `.exe` se busca antes que System32**: una `nvEncodeAPI64.dll` o
`amfrt64.dll` plantada junto a `ffmpeg.exe` se cargaría en lugar de la del driver. Por `dlopen`
nunca se usan el cwd ni el PATH; eso vale solo para esa vía: las DLL de la tabla de importación
estática las resuelve el cargador de Windows con su orden normal, que también empieza por la
carpeta del `.exe`. Lo que cierra ambas vías es requisito de W3.2: el ffmpeg vive en una carpeta
propia de la instalación con un manifiesto cerrado de ficheros (SHA-256 de
`ffmpeg.exe`/`ffprobe.exe` y nada más), y el motor rechaza cualquier `.dll` extra en ella antes de
invocarlo, como hace con el navegador (I4). `verificar-binario.sh` comprueba además que la tabla
de importación solo nombra DLL de System32 de una lista cerrada (`pe.sh`); esa lista cubre solo
la tabla **estática**, no las delay-imports ni lo que se carga en ejecución.

## Cadena de suministro

- **Fuentes**: versión exacta, HTTPS (`--proto =https --tlsv1.2`, tamaño máximo; URL con host en
  lista blanca de caracteres, sin usuario ni puerto). curl no sigue redirecciones: el script
  comprueba cada salto antes de hacerlo y debe seguir en HTTPS y en el mismo operador (los assets
  de GitHub saltan a `*.githubusercontent.com`). Si el proyecto firma, GPG en un
  `GNUPGHOME` temporal: `claves/<nombre>.asc` con exactamente una clave primaria, la de la columna
  `huella`; gpg debe salir con 0; se rechazan `EXPKEYSIG`/`REVKEYSIG`/`BADSIG`/`ERRSIG`/`EXPSIG`
  (gpg sale con 0 con clave caducada o revocada: esa línea es la única barrera, y el test lo
  demuestra quitándola); `VALIDSIG` de esa primaria y con SHA-256/384/512. No hay excepciones
  escritas; añadir una exige cambiar el script.
- **Anclaje de huellas (R0 H1, R1 LOW-2/3)**: dos canales de **operadores** distintos entre sí y
  del de la descarga y la firma, según la tabla cerrada `OPERADORES` de `descargar-fuentes.sh`
  (p. ej. `zlib.net` y `madler.net` son el mismo; `downloads.`/`code.videolan.org` también); nunca
  un keyserver ni el propio `.asc`. El PKGBUILD de Arch va citado por URL fijada a un commit.
  **La columna `anclaje` es declarativa** (la rellena y revisa un humano en la Tarea 10) **salvo
  el canal `debian:<paquete>`**, que el script verifica de verdad: InRelease anclado →
  `Sources.xz` → `.dsc` y `debian.tar.*` por SHA-256 → `debian/upstream/signing-key.asc` debe
  contener la huella.
- **git** (nv-codec-headers): commit de 40 hex, la etiqueta debe apuntar a él, SHA-256 del
  `git archive` (con `core.autocrlf=false`) y `canal2` debe ser otro repositorio `.git` de otro
  operador que dé el mismo commit y archive (L1). El SHA del `git archive` que se commitea se
  recalcula **dentro de la imagen fijada** (con su git) antes de escribirlo en el lock.
- **Tarball sin firma** (AMF, ruling del orquestador): asset `AMF-headers-v….tar.gz` de la release
  de GitHub, con SHA-256 y `canal2` = PKGBUILD de Arch fijado a commit, cuyo `sha256sums` debe
  contener ese hash. A confirmar en la Tarea 10: la URL exacta del asset; el reparto del tarball
  (`copiar_amf` toma el directorio que contiene `core/Version.h`, esté donde esté) y que
  `core/Platform.h` existe a un nivel de la raíz con el MIT en la cabecera (regla de
  `recopilar-avisos.sh`). Si no cuadra, el build o los avisos fallan, no se omite nada.
- **Imagen**: base por digest; apt solo de `snapshot.debian.org` con marca de tiempo fija, cada
  paquete con `=versión` y el InRelease anclado por SHA-256 (fija también las dependencias);
  `apt-get update --error-on=any` sin redirecciones, y nada de `trusted=yes` ni repositorios
  inseguros. Única excepción a HTTPS: `ca-certificates`, que la imagen slim no trae, se instala
  por HTTP; la integridad la dan la firma de apt y el InRelease anclado, y después todo va por
  HTTPS. `.dockerignore` deja en el contexto solo lo que copia el Dockerfile.
- **Contenedores**: descarga y compilación separadas; la compilación con `--network none`;
  ambos con `--cap-drop ALL`, `no-new-privileges`, raíz de solo lectura, el usuario del host,
  `ffmpeg-build/` y (al compilar) `fuentes/` en solo lectura, sin socket de Docker. Sin caché de
  capas (`--no-cache`). `construir.sh` es el único sitio con órdenes `docker`; con
  `--sin-descarga` recompila unas fuentes ya presentes (las del tarball de fuente).
- **Determinismo**: `SOURCE_DATE_EPOCH` del lock, `TZ=UTC`, `LC_ALL=C`, `umask 022`,
  `-ffile-prefix-map`, `-fno-ident`, `--no-insert-timestamp`, `--build-id=none`, `strip --strip-all`.
  Endurecimiento: ASLR de 64 bits, DEP, `-fstack-protector-strong`, enlace estático.
- **I11**: configure falla si no encuentra algo pedido; además `compilar.sh` rechaza cualquier
  `WARNING:` o `did not match anything` y comprueba en `config_components.h` que cada componente
  declarado está activo y que no hay hwaccel, protocolo no declarado ni nada prohibido.

## Construir y probar

```bash
bash video-mcp-server/ffmpeg-build/tests/run.sh             # sin red ni Docker
bash video-mcp-server/ffmpeg-build/tests/run.sh --estricto  # los tests de pendientes, Dockerfile y
                                                            # workflow dejan de tolerar el marcador
FFMPEG_DIR=/ruta/con/ffmpeg.exe bash video-mcp-server/ffmpeg-build/tests/run.sh   # + verificar-binario
bash video-mcp-server/ffmpeg-build/construir.sh --fuentes <dir vacío> --salida <dir vacío>  # con red
```

## Publicación (R0 H2)

Workflow `.github/workflows/ffmpeg-lgpl.yml`. En `push` (solo a `main`) corre únicamente
`pruebas`; `construir` (a y b) → `verificar` (Windows; `SIN_MF` solo como entrada explícita) →
`empaquetar` → `publicar` van solo con `workflow_dispatch`. `verificar` calcula el SHA-256 de lo
descargado antes de ejecutarlo y lanza `verificar-binario.sh` sin `GITHUB_ENV/OUTPUT/PATH`;
`empaquetar` revalida las fuentes contra `fuentes.lock` y expone el SHA-256 del tarball; `publicar`
compara ambos. Pensado para vivir en el **repositorio público** de la oferta de código fuente (R7,
pendiente de Marc), sin PAT:

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
   `git archive` de las fuentes git; si `claves/<nombre>.asc` ya está, verifica la firma e
   imprime la huella que firma. Contrastar con un canal independiente (dav1d `.sha256`, página de
   la etiqueta en GitHub). El SHA del `git archive` que se escribe en el lock es el calculado
   **dentro de la imagen fijada** (`docker run … descargar-fuentes.sh --arranque`), no en Windows.
2. AMF: leer en el `configure` de 7.1.5 la versión mínima (`grep -n "AMF_VERSION" configure`),
   fijar en `version` y en la URL del asset la release mínima que la cumpla (candidata `v1.4.36`),
   elegir el commit del PKGBUILD de `amf-headers` que lleve esa versión (columna `canal2`) y
   repetir el paso 1 para esa fila. Comprobar también el mínimo de nv-codec-headers (`n12.1.14.0`).
3. Claves: exportar cada una a `claves/<nombre>.asc`, comparar su huella con los dos canales de
   anclaje (tabla en `claves/LEEME.md`) y escribir `huella` y `anclaje` en `fuentes.lock`.
4. `SOURCE_DATE_EPOCH` = fecha de la release de ffmpeg 7.1.5 (p. ej. la mtime de su `VERSION`).

**Permiso B (runner de GitHub y la construcción local de testigo):**

5. Digest de `debian:trixie-slim`, marca de tiempo del snapshot, versión exacta de cada paquete
   en ese snapshot y SHA-256 de su `InRelease` (en `Dockerfile` y `fuentes.lock`).
6. `bash tests/run.sh --estricto` en verde → `workflow_dispatch`. `comparar-builds` debe dar
   idéntico; si no, diffoscope antes de seguir (aceptar un residuo exige una lista cerrada de
   secciones PE en `comparar-builds.sh`, con test).
7. Revisar los listados reales contra `autoseleccionados.txt` y quitar su línea `PENDIENTE`.
8. **Testigo (M5):** Marc ejecuta `construir.sh` en su máquina; su `SHA256SUMS` debe coincidir con
   el de CI. Marc prueba `h264_nvenc` y `h264_mf` (RTX 4060). QSV fuera; AMF sin GPU AMD dedicada.
9. Anotar aquí los SHA-256 de `ffmpeg.exe`/`ffprobe.exe` y la URL del asset para W3.2.

### Estado de la Tarea 10 (permiso A hecho el 2026-10-30; permiso B sin hacer)

Verificado a mano contra las fuentes reales (los patrones de `compilar.sh` cuadran con 7.1.5):
`win32_dlopen`/`w32dlfcn.h`, `dynlink_loader.h`, `AMF_DLL_NAME` (`comprobar_carga_dll` pasa sobre el
árbol real), rutas de licencia (`COPYING.LGPLv2.1`, `COPYING`, `LICENSE`, `nvEncodeAPI.h`,
`core/Platform.h`), `copiar_amf` sobre el asset real, mínimos (`configure` l. 6783 y 7423-7425:
nv-codec-headers ≥ 12.1.14.0 y AMF ≥ 1.4.33.0, por eso la fila AMF es **v1.4.33** y no la v1.4.36
candidata) y las opciones de `componentes.conf` (existen todas). Corregido: en 7.1.5 los demuxers
de imagen por tubería se llaman `image_png_pipe`, `image_jpeg_pipe` e `image_webp_pipe` (el binario
los lista como `png_pipe`…); con los nombres antiguos configure los habría ignorado y `compilar.sh`
habría fallado. `autoseleccionados.txt` se revisó contra el configure (+`rotate`, −`rtp`), pero no
contra un binario: su línea `PENDIENTE` sigue.

Lo que **no** se ha podido cerrar, y por qué:

- **Huellas y anclajes (ffmpeg, dav1d, zlib):** falta el canal `debian:<paquete>` (exige bajar el
  `Sources.xz` y los `.dsc`/`debian.tar.*` de `snapshot.debian.org`, fuera de lo autorizado). El
  PKGBUILD de Arch confirma 65F7…1ADC (dav1d) y 5ED4…AFBA (zlib), pero **no** la clave de
  FFmpeg: Arch verifica la etiqueta git con otra clave (DD1E…8D64) y no empaqueta 7.1.5.
- **Firmas de dav1d y zlib:** son DSA con resumen **SHA-1**; `verificar_firma` las rechaza a
  propósito. Hay que decidir: tratarlas como fuentes sin firma con `canal2` (los PKGBUILD de Arch
  traen sha512/b2, no SHA-256: `descargar-fuentes.sh` tendría que aceptar sha512) o aceptar SHA-1.
  Comprobado a mano: el tarball de ambas coincide con el sha512 y el b2 del PKGBUILD de Arch.
- **AMF `canal2`:** el PKGBUILD de `amf-headers` descarga por git (`#tag=<commit>`), no lleva ningún
  hash del tarball. Lo que sí está comprobado: el asset `AMF-headers-v1.4.33.tar.gz` es idéntico
  (salvo CRLF→LF) a `amf/public/include` del commit e8c7cd7c… que fija Arch (PKGBUILD 1.4.33-1,
  commit e5d45472…). Su layout es `amf-headers-v1.4.33/{core,components}/` y **no trae licencia**
  propia: la del MIT va en la cabecera de cada fichero (`core/Platform.h`).
- **SHA-256 del `git archive` de nv-codec-headers:** calculado con Git para Windows; idéntico en
  GitHub y en git.videolan.org (mismo commit 1889e62e…). Debe reconfirmarse dentro de la imagen
  fijada (permiso B).

### Permiso B, paso 5 (2026-11-12)

Imagen fijada: `debian:trixie-slim@sha256:a72b4433…b6b2` (índice multiarquitectura), snapshot
`20261109T224401Z`, InRelease `0584fba3…6675` (`Date:` 2026-09-12) y la versión de cada paquete
leída con `apt-cache policy` dentro de esa base. `docker build --no-cache` termina y deja
`x86_64-w64-mingw32-gcc 14-posix` con usuario `build`. Dos cambios en el Dockerfile:

- **Sin `AllowRedirect=false`** (deroga R1 LOW-9): snapshot.debian.org responde a todo con un 302
  a `/file/<sha1>` del mismo host y apt no llegaba ni al InRelease. La integridad no cambia (el
  InRelease está anclado y firmado; apt verifica cada índice y `.deb` contra él, y no admite
  saltos de https a http).
- `-oAcquire::Retries=5` en los `apt-get install`: snapshot corta conexiones con 100 MB seguidos.

### Descargas que pedirá la Tarea 10

| # | Qué | Origen | Tamaño aprox. | Permiso |
|---|---|---|---|---|
| 1 | `ffmpeg-7.1.5.tar.xz` + `.asc` | https://ffmpeg.org/releases/ | ~11 MB + <1 KB | A |
| 2 | Clave de firma de FFmpeg | https://ffmpeg.org/ffmpeg-devel.asc | ~4 KB | A |
| 3 | `dav1d-1.5.4.tar.xz` + `.asc` + `.sha256` | https://downloads.videolan.org/pub/videolan/dav1d/1.5.4/ | ~1 MB | A |
| 4 | `zlib-1.3.2.tar.xz` + `.asc` | https://zlib.net/ | ~1,3 MB | A |
| 5 | nv-codec-headers `n12.1.14.0` (clon parcial) | GitHub FFmpeg/nv-codec-headers y git.videolan.org | ~1 MB ×2 | A |
| 6 | `AMF-headers-v….tar.gz` y el PKGBUILD de `amf-headers` fijado a commit | GitHub GPUOpen-LibrariesAndSDKs/AMF (releases), gitlab.archlinux.org | < 1 MB | A |
| 7 | Anclajes: `InRelease`, `Sources.xz`, `.dsc` y `debian.tar.*` de ffmpeg, dav1d y zlib del snapshot (los baja y verifica el propio script); PKGBUILD de Arch fijados a commit | snapshot.debian.org, gitlab.archlinux.org | ~3 MB | A |
| 8 | Imagen `debian:trixie-slim` | Docker Hub (por digest) | ~30 MB | B |
| 9 | Paquetes de Debian (MinGW-w64, nasm, meson, ninja, pkgconf, gpg, git, curl…) | snapshot.debian.org | ~400–600 MB, ~1,2 GB instalados | B |
| 10 | Ejecución del workflow (repite 1–9 en el runner) | GitHub Actions | — | B |
