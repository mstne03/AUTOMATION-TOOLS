"""Utilidades comunes para los tests.

Los tests que necesitan servicios externos (Postgres, Ollama) se saltan solos
si el servicio no esta levantado, en vez de fallar con un error de conexion.
"""

import shutil
from uuid import uuid4

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


def borrar_documento(url: str) -> None:
    """Borra un documento de la BD por url. Solo filas, ningun archivo."""
    if not _writer_up():
        return
    with psycopg.connect(config.writer_dsn()) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM documents WHERE url = %s", (url,))
        conn.commit()


@pytest.fixture(scope="session")
def fuente_fixture(tmp_path_factory):
    """El fixture de prueba, copiado a un temporal con nombre unico.

    Los tests ingieren ESTA COPIA y nunca `tests/fixtures/prueba.md` directamente.
    El motivo: los fixtures limpian la BD borrando el documento cuya url es la
    del archivo, y cuando esa url era la del fixture del repo, ejecutar la suite
    se llevaba por delante una ingesta legitima del usuario. Con una url unica
    por ejecucion, los tests no comparten ninguna fila con las fuentes reales.
    """
    origen = config.PROJECT_ROOT / "tests" / "fixtures" / "prueba.md"
    destino = tmp_path_factory.mktemp("kb-seo") / f"prueba-{uuid4().hex[:8]}.md"
    shutil.copyfile(origen, destino)

    source = {
        "url": str(destino),
        "type": "local",
        # Plataforma propia de la suite: aisla al fixture de las fuentes
        # reales, para que los tests no dependan de que mas haya en la BD.
        "platforms": ["youtube", "test-suite"],
        "published_at": "2025-01-15",
        "author": "Fixture de prueba",
        "topics": ["retencion", "ctr", "shorts"],
    }

    yield source

    borrar_documento(source["url"])
