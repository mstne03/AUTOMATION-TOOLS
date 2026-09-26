"""Utilidades comunes para los tests.

Los tests que necesitan servicios externos (Postgres, Ollama) se saltan solos
si el servicio no esta levantado, en vez de fallar con un error de conexion.
"""

import httpx
import psycopg
import pytest

from kb import config


def _ollama_up() -> bool:
    try:
        r = httpx.get(f"{config.OLLAMA_URL}/api/tags", timeout=3.0)
        return r.status_code == 200
    except Exception:
        return False


def _db_up(dsn: str) -> bool:
    try:
        with psycopg.connect(dsn, connect_timeout=3):
            return True
    except Exception:
        return False


requires_ollama = pytest.mark.skipif(
    not _ollama_up(), reason=f"Ollama no responde en {config.OLLAMA_URL}"
)


def _reader_up() -> bool:
    try:
        return _db_up(config.reader_dsn())
    except Exception:
        return False


def _writer_up() -> bool:
    try:
        return _db_up(config.writer_dsn())
    except Exception:
        return False


requires_reader = pytest.mark.skipif(
    not _reader_up(), reason="kb_reader no conecta (docker compose up -d)"
)

requires_writer = pytest.mark.skipif(
    not _writer_up(), reason="kb_writer no conecta (docker compose up -d)"
)
