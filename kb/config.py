"""Carga de configuracion desde .env."""

import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent

load_dotenv(PROJECT_ROOT / ".env")


def _req(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Falta {name} en el entorno. Copia .env.example a .env y rellenalo."
        )
    return value


PGHOST = os.getenv("PGHOST", "127.0.0.1")
PGPORT = int(os.getenv("PGPORT", "5433"))
PGDATABASE = os.getenv("PGDATABASE", "kb_seo")

# 127.0.0.1 y no "localhost" a proposito: localhost resuelve tambien a ::1,
# Ollama solo escucha en IPv4, y cada conexion nueva perdia ~2s esperando
# a que fallara el intento IPv6.
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
EMBED_MODEL = os.getenv("EMBED_MODEL", "bge-m3")
EMBED_DIM = int(os.getenv("EMBED_DIM", "1024"))


def writer_dsn() -> str:
    """DSN del rol de escritura (ingesta)."""
    return _dsn(_req("KB_WRITER_USER"), _req("KB_WRITER_PASSWORD"))


def reader_dsn() -> str:
    """DSN del rol de solo lectura (servidor MCP)."""
    return _dsn(_req("KB_READER_USER"), _req("KB_READER_PASSWORD"))


def admin_dsn() -> str:
    """DSN del superusuario. Solo para migraciones."""
    return _dsn(_req("POSTGRES_USER"), _req("POSTGRES_PASSWORD"))


def _dsn(user: str, password: str) -> str:
    from urllib.parse import quote

    return (
        f"postgresql://{quote(user)}:{quote(password)}"
        f"@{PGHOST}:{PGPORT}/{PGDATABASE}"
    )
