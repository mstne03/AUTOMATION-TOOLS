"""SEO-131: el modo offline bloquea lo que no es loopback y nunca se activa en el binario congelado."""

import os
import socket
import subprocess
import sys

import pytest

from app_backend import offline


def test_bloquea_fuera_de_loopback_y_lo_anota(tmp_path, monkeypatch):
    monkeypatch.setattr(offline, "_original", {})
    originales = (socket.getaddrinfo, socket.socket.connect, socket.socket.connect_ex)
    registro = tmp_path / "red.log"
    try:
        offline.instalar(registro)
        with pytest.raises(OSError, match="bloqueada"):
            socket.getaddrinfo("huggingface.co", 443)
        with socket.socket() as s, pytest.raises(OSError, match="bloqueada"):
            s.connect(("192.0.2.1", 443))  # TEST-NET-1: nunca enruta
        assert registro.read_text().split() == ["huggingface.co", "192.0.2.1"]
        with socket.create_server(("127.0.0.1", 0)) as srv, socket.socket() as c:
            c.connect(srv.getsockname())  # loopback sigue funcionando
    finally:
        socket.getaddrinfo, socket.socket.connect, socket.socket.connect_ex = originales


def test_offline_no_se_hereda_en_el_binario_congelado():
    """Subproceso: `config` evalúa FROZEN al importarse y no se recarga sin efectos en el resto de tests."""
    env = {**os.environ, "APP_BACKEND_OFFLINE": "1"}
    codigo = "import sys; sys.frozen = True; from app_backend import config; print(config.OFFLINE, config.FROZEN)"
    r = subprocess.run([sys.executable, "-c", codigo], env=env, capture_output=True, text=True, check=True)
    assert r.stdout.split() == ["False", "True"]
