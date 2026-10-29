# Claves públicas de firma

Vacía hasta la Tarea 10. Una clave por fuente firmada de `fuentes.lock`, con el nombre de la fila:
`descargar-fuentes.sh` importa `claves/<nombre>.asc` en un `GNUPGHOME` temporal y exige que la
firma dé `VALIDSIG` con la huella primaria **exacta** de la columna `huella`, confirmada por los
dos canales de la columna `anclaje` (R0 H1). Las claves se commitean: no se bajan en cada build.

| Fichero | Clave | Huella candidata (sin confirmar) | Anclaje propuesto |
|---|---|---|---|
| `ffmpeg.asc` | FFmpeg release signing key | `FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8` | `debian:ffmpeg` + `validpgpkeys` del PKGBUILD de Arch (gitlab.archlinux.org) |
| `dav1d.asc` | VideoLAN (J.-B. Kempf) | `65F7 C6B4 206B D057 A7EB 7378 7180 713B E58D 1ADC` | `debian:dav1d` + segundo canal fuera de videolan.org |
| `zlib.asc` | Mark Adler | `5ED4 6A67 21D3 6558 7791 E2AA 783F CD8E 58BC AFBA` | `debian:zlib` + https://madler.net/madler/pgp.html |

Las huellas candidatas vienen del plan (de memoria o leídas del propio `.asc`): **no valen** como
anclaje. Procedimiento en `../LEEME.md`, «Tarea 10».
