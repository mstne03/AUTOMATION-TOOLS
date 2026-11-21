# Claves públicas de firma

Vacía hasta la Tarea 10. Una clave por fuente firmada de `fuentes.lock`, con el nombre de la fila:
`descargar-fuentes.sh` importa `claves/<nombre>.asc` en un `GNUPGHOME` temporal y exige que
contenga **exactamente una** clave primaria, que sea la de la columna `huella`, y que la firma dé
`VALIDSIG` con esa primaria y SHA-256/384/512. La huella debe estar confirmada por los dos canales
de la columna `anclaje`, de operadores distintos entre sí y del de la descarga (R0 H1, R1 LOW-2).
Las claves se commitean: no se bajan en cada build.

| Fichero | Clave | Huella | Anclaje |
|---|---|---|---|
| `ffmpeg.asc` (de `https://ffmpeg.org/ffmpeg-devel.asc`) | FFmpeg release signing key | `FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8` | `debian:ffmpeg` (lo verifica el script) + `sources` del dist-git de Fedora fijado a commit, que fija por SHA-512 su `ffmpeg.keyring` del lookaside (revisado a mano el 2026-11-12: primaria FCF9…58D8) |

Sin clave, por decisión de la Tarea 10 (2026-11-12):

- **dav1d y zlib**: firman con DSA y resumen SHA-1, que `verificar_firma` no acepta. Van como
  tarball sin firma: SHA-256 fijado + `canal2` = PKGBUILD de Arch fijado a commit, que debe listar
  el SHA-512 de esos mismos bytes. zlib sube a 1.4: zlib.net ya no sirve la 1.3.2 y Arch la
  parchea por el CVE-2026-85091.
- **AMF**: fuente `git` en el commit `e8c7cd7c…` (etiqueta `v1.4.33`, solo `amf/public/include`);
  `canal2` = PKGBUILD de Arch 1.4.33-1 fijado a commit, que nombra ese commit.
