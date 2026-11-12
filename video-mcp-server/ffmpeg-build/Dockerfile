# Imagen de construcción del ffmpeg LGPL (W1.5 · SEO-115). Cadena de suministro (I9, R0 M4):
#   - Base fijada por digest.
#   - apt solo del snapshot de Debian con marca de tiempo fija; su InRelease se ancla por SHA-256
#     en fuentes.lock (comprobar-inrelease.sh), lo que fija también cada dependencia transitiva.
#     La firma de apt sigue activa con el keyring de la base.
#   - Cada paquete con versión exacta. Sin pip, npm ni instaladores por tubería.
# ca-certificates no viene en la imagen slim: es lo único que se instala por http (la integridad
# la dan la firma de apt y el InRelease anclado); después la fuente pasa a https y se vuelve a
# comprobar el InRelease antes de instalar el resto.
# Redirecciones: snapshot.debian.org responde a cada fichero con un 302 a /file/<sha1> del mismo
# host, así que apt sin redirecciones no puede ni bajar el InRelease (comprobado en la Tarea 10).
# No resta integridad: el InRelease está anclado por SHA-256 y firmado, y apt verifica contra él
# cada índice y cada .deb; apt tampoco acepta un salto de https a http.
# Pins de la Tarea 10 (2026-11-12): digest del índice multiarquitectura de trixie-slim y versiones
# del snapshot (apt-cache policy dentro de esta misma base).
FROM docker.io/library/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ENV LC_ALL=C TZ=UTC DEBIAN_FRONTEND=noninteractive

COPY fuentes.lock comprobar-inrelease.sh /opt/ffbuild/

RUN rm -f /etc/apt/sources.list.d/* /etc/apt/sources.list \
 && echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261109T224401Z/ trixie main' >/etc/apt/sources.list \
 && apt-get update --error-on=any \
 && bash /opt/ffbuild/comprobar-inrelease.sh /var/lib/apt/lists/*_InRelease /opt/ffbuild/fuentes.lock \
 && apt-get install -y --no-install-recommends -oAcquire::Retries=5 ca-certificates=20250419 \
 && sed -i 's|http://snapshot.debian.org|https://snapshot.debian.org|' /etc/apt/sources.list \
 && rm -rf /var/lib/apt/lists/*

RUN apt-get update --error-on=any \
 && bash /opt/ffbuild/comprobar-inrelease.sh /var/lib/apt/lists/*_InRelease /opt/ffbuild/fuentes.lock \
 && apt-get install -y --no-install-recommends -oAcquire::Retries=5 \
      gcc-mingw-w64-x86-64-posix=14.2.0-19+27+b1 \
      binutils-mingw-w64-x86-64=2.44-3+12+b1 \
      mingw-w64-x86-64-dev=12.0.0-5 \
      nasm=2.16.03-1 \
      meson=1.7.0-1 \
      ninja-build=1.12.1-1 \
      pkgconf=1.8.1-4 \
      make=4.4.1-2 \
      gpg=2.4.7-21+deb13u1+b5 \
      curl=8.14.1-2+deb13u5 \
      git=1:2.47.3-0+deb13u1 \
      xz-utils=5.8.1-1+deb13u1 \
 && update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /bin/bash build \
 && mkdir -p /build && chown build:build /build

WORKDIR /build
USER build
