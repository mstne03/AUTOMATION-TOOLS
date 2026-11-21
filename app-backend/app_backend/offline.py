"""Cinturón del modo offline (SEO-131): si algo intenta salir de loopback, falla y queda anotado.

Los E2E comprueban que el fichero de anotaciones no existe al terminar (`zz-hermetico.spec.ts`).
Límite: es un parche del `socket` de este proceso, así que solo vigila al sidecar. La UI que carga
Playwright, el motor de vídeo (Node) y el Chrome que lanza el motor quedan fuera.
Cubre `getaddrinfo` (todo nombre de host) y `connect`/`connect_ex` (también IP literales con el
bucle de selector). ponytail: con el bucle Proactor de Windows una IP literal llega a ConnectEx sin
pasar por `socket.connect`; si hiciera falta cerrar ese hueco, medirlo con Get-NetTCPConnection."""

import ipaddress
import socket
from pathlib import Path

_original = {}


def _es_loopback(host) -> bool:
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    if host in (None, "", "localhost") or str(host).endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(str(host).split("%")[0]).is_loopback
    except ValueError:
        return False


def instalar(registro: Path) -> None:
    """Idempotente: parchea `socket` una sola vez; cada intento fuera de loopback se anota en `registro`."""
    if _original:
        return

    def vetar(host) -> None:
        if _es_loopback(host):
            return
        with registro.open("a", encoding="utf-8") as f:
            f.write(f"{host}\n")
        raise OSError(f"Modo offline (APP_BACKEND_OFFLINE): conexión a {host!r} bloqueada.")

    _original["getaddrinfo"] = socket.getaddrinfo
    _original["connect"] = socket.socket.connect
    _original["connect_ex"] = socket.socket.connect_ex

    def getaddrinfo(host, *a, **k):
        vetar(host)
        return _original["getaddrinfo"](host, *a, **k)

    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            vetar(address[0])
        return _original["connect"](self, address)

    def connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            vetar(address[0])
        return _original["connect_ex"](self, address)

    socket.getaddrinfo = getaddrinfo
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
