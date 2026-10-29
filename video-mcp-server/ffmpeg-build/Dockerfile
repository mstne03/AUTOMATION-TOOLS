# Imagen de construcción del ffmpeg LGPL (W1.5 · SEO-115). Cadena de suministro (I9, R0 M4):
#   - Base fijada por digest.
#   - apt solo del snapshot de Debian con marca de tiempo fija; su InRelease se ancla por SHA-256
#     en fuentes.lock (comprobar-inrelease.sh), lo que fija también cada dependencia transitiva.
#     La firma de apt sigue activa con el keyring de la base.
#   - Cada paquete con versión exacta. Sin pip, npm ni instaladores por tubería.
# ca-certificates no viene en la imagen slim: es lo único que se instala por http (la integridad
# la dan la firma de apt y el InRelease anclado); después la fuente pasa a https y se vuelve a
# comprobar el InRelease antes de instalar el resto.
# Los valores PENDIENTE-TAREA-10 se rellenan en la Tarea 10; con ellos `docker build` falla al
# leer el FROM (referencia no válida) sin bajar nada, y construir.sh ni siquiera llega a lanzarlo.
FROM docker.io/library/debian:trixie-slim@sha256:PENDIENTE-TAREA-10

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV LC_ALL=C TZ=UTC DEBIAN_FRONTEND=noninteractive

COPY fuentes.lock comprobar-inrelease.sh /opt/ffbuild/

RUN rm -f /etc/apt/sources.list.d/* /etc/apt/sources.list \
 && echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/PENDIENTE-TAREA-10/ trixie main' >/etc/apt/sources.list \
 && apt-get update \
 && bash /opt/ffbuild/comprobar-inrelease.sh /var/lib/apt/lists/*_InRelease /opt/ffbuild/fuentes.lock \
 && apt-get install -y --no-install-recommends ca-certificates=PENDIENTE-TAREA-10 \
 && sed -i 's|http://snapshot.debian.org|https://snapshot.debian.org|' /etc/apt/sources.list \
 && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
 && bash /opt/ffbuild/comprobar-inrelease.sh /var/lib/apt/lists/*_InRelease /opt/ffbuild/fuentes.lock \
 && apt-get install -y --no-install-recommends \
      gcc-mingw-w64-x86-64-posix=PENDIENTE-TAREA-10 \
      binutils-mingw-w64-x86-64=PENDIENTE-TAREA-10 \
      mingw-w64-x86-64-dev=PENDIENTE-TAREA-10 \
      nasm=PENDIENTE-TAREA-10 \
      meson=PENDIENTE-TAREA-10 \
      ninja-build=PENDIENTE-TAREA-10 \
      pkgconf=PENDIENTE-TAREA-10 \
      make=PENDIENTE-TAREA-10 \
      gpg=PENDIENTE-TAREA-10 \
      curl=PENDIENTE-TAREA-10 \
      git=PENDIENTE-TAREA-10 \
      xz-utils=PENDIENTE-TAREA-10 \
 && update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /bin/bash build \
 && mkdir -p /build && chown build:build /build

WORKDIR /build
USER build
