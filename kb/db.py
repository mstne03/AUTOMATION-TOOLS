"""Conexiones a Postgres y aplicacion de migraciones."""

import sys
from contextlib import contextmanager

import psycopg
from pgvector.psycopg import register_vector

from kb import config


@contextmanager
def connect(dsn: str):
    """Abre una conexion con el tipo vector ya registrado."""
    with psycopg.connect(dsn) as conn:
        register_vector(conn)
        yield conn


def writer():
    return connect(config.writer_dsn())


def reader():
    return connect(config.reader_dsn())


def migrate_main() -> int:
    """Aplica sql/migrate.sql como superusuario. Entrypoint de `uv run kb-migrate`."""
    path = config.PROJECT_ROOT / "sql" / "migrate.sql"
    if not path.exists():
        print(f"No existe {path}", file=sys.stderr)
        return 1

    sql = path.read_text(encoding="utf-8")
    with psycopg.connect(config.admin_dsn()) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
    print(f"Migracion aplicada desde {path}")
    return 0
