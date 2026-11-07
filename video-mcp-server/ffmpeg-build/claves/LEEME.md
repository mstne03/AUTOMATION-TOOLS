# Claves públicas de firma

Vacía hasta la Tarea 10. Una clave por fuente firmada de `fuentes.lock`, con el nombre de la fila:
`descargar-fuentes.sh` importa `claves/<nombre>.asc` en un `GNUPGHOME` temporal y exige que
contenga **exactamente una** clave primaria, que sea la de la columna `huella`, y que la firma dé
`VALIDSIG` con esa primaria y SHA-256/384/512. La huella debe estar confirmada por los dos canales
de la columna `anclaje`, de operadores distintos entre sí y del de la descarga (R0 H1, R1 LOW-2).
Las claves se commitean: no se bajan en cada build.

| Fichero | Clave | Huella candidata (sin confirmar) | Anclaje propuesto |
|---|---|---|---|
| `ffmpeg.asc` | FFmpeg release signing key | `FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8` | `debian:ffmpeg` + `validpgpkeys` del PKGBUILD de Arch (`gitlab.archlinux.org/…/-/raw/<commit>/PKGBUILD`) |
| `dav1d.asc` | VideoLAN (J.-B. Kempf) | `65F7 C6B4 206B D057 A7EB 7378 7180 713B E58D 1ADC` | `debian:dav1d` + PKGBUILD de Arch fijado a commit |
| `zlib.asc` | Mark Adler | `5ED4 6A67 21D3 6558 7791 E2AA 783F CD8E 58BC AFBA` | `debian:zlib` + PKGBUILD de Arch fijado a commit (no madler.net: es el mismo operador que zlib.net) |

Las huellas candidatas vienen del plan (de memoria o leídas del propio `.asc`): **no valen** como
anclaje. El canal `debian:` lo verifica el script; el de Arch lo revisa un humano. Procedimiento
en `../LEEME.md`, «Tarea 10».
