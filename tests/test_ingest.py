"""Criterio de aceptacion del paso 3: ingerir el fixture y comprobar idempotencia."""

import pytest

from ingest import cli
from kb import config, db
from tests.conftest import requires_ollama, requires_writer

FIXTURE = config.PROJECT_ROOT / "tests" / "fixtures" / "prueba.md"

SOURCE = {
    "url": str(FIXTURE),
    "type": "local",
    "platforms": ["youtube", "general"],
    "published_at": "2025-01-15",
    "author": "Fixture de prueba",
    "topics": ["retencion", "ctr", "shorts"],
}


@pytest.fixture
def documento_limpio():
    """Borra el documento del fixture antes y despues. Solo datos de la BD."""
    def _wipe():
        with db.writer() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM documents WHERE url = %s", (SOURCE["url"],))
            conn.commit()

    _wipe()
    yield
    _wipe()


@requires_writer
@requires_ollama
def test_ingerir_el_fixture_crea_documento_y_chunks(documento_limpio):
    result = cli.ingest_one(SOURCE)

    assert result["skipped"] is False
    assert result["chunks"] > 0

    with db.writer() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, title, source_type, platforms, published_at, topics "
            "FROM documents WHERE url = %s",
            (SOURCE["url"],),
        )
        doc = cur.fetchone()
        assert doc is not None, "el documento no se creo"

        doc_id, title, source_type, platforms, published_at, topics = doc
        assert title == "Retencion y CTR en YouTube Shorts"
        assert source_type == "local"
        assert set(platforms) == {"youtube", "general"}
        assert str(published_at) == "2025-01-15"
        assert "ctr" in topics

        cur.execute("SELECT count(*) FROM chunks WHERE document_id = %s", (doc_id,))
        assert cur.fetchone()[0] == result["chunks"]

        # Cada chunk lleva su cabecera de contexto y su embedding.
        cur.execute(
            "SELECT content FROM chunks WHERE document_id = %s ORDER BY chunk_index",
            (doc_id,),
        )
        for (content,) in cur.fetchall():
            assert content.startswith("[Retencion y CTR en YouTube Shorts |")


@requires_writer
@requires_ollama
def test_reingerir_sin_cambios_no_duplica(documento_limpio):
    primera = cli.ingest_one(SOURCE)
    segunda = cli.ingest_one(SOURCE)

    assert primera["skipped"] is False
    assert segunda["skipped"] is True, "deberia saltarse: el content_hash no cambio"

    with db.writer() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM documents WHERE url = %s", (SOURCE["url"],))
        assert cur.fetchone()[0] == 1

        cur.execute(
            "SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id "
            "WHERE d.url = %s",
            (SOURCE["url"],),
        )
        assert cur.fetchone()[0] == primera["chunks"]


@requires_writer
@requires_ollama
def test_si_cambia_el_contenido_se_reemplazan_los_chunks(documento_limpio, tmp_path):
    temporal = tmp_path / "cambiante.md"
    temporal.write_text("# Titulo\n\nTexto original corto.\n", encoding="utf-8")
    source = {"url": str(temporal), "type": "local", "platforms": ["general"]}

    try:
        cli.ingest_one(source)
        with db.writer() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id "
                "WHERE d.url = %s",
                (str(temporal),),
            )
            ids_antes = {r[0] for r in cur.fetchall()}

        parrafos = "\n\n".join(f"Parrafo nuevo numero {i}. " * 30 for i in range(6))
        temporal.write_text(f"# Titulo\n\n{parrafos}\n", encoding="utf-8")

        segunda = cli.ingest_one(source)
        assert segunda["skipped"] is False

        with db.writer() as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM documents WHERE url = %s", (str(temporal),))
            assert cur.fetchone()[0] == 1, "no debe crear un documento nuevo"

            cur.execute(
                "SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id "
                "WHERE d.url = %s",
                (str(temporal),),
            )
            ids_despues = {r[0] for r in cur.fetchall()}

        assert not (ids_antes & ids_despues), "los chunks viejos deberian haberse reemplazado"
    finally:
        with db.writer() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM documents WHERE url = %s", (str(temporal),))
            conn.commit()


def test_guess_type():
    assert cli.guess_type("https://www.youtube.com/watch?v=abc") == "youtube"
    assert cli.guess_type("https://youtu.be/abc") == "youtube"
    assert cli.guess_type("https://ejemplo.com/articulo") == "web"
    assert cli.guess_type("https://ejemplo.com/paper.pdf") == "pdf"
    assert cli.guess_type("C:/ruta/notas.md") == "local"
    assert cli.guess_type("C:/ruta/notas.txt") == "local"


def test_video_id_de_varios_formatos():
    from ingest.extractors import youtube_video_id

    assert youtube_video_id("https://www.youtube.com/watch?v=Dz7L_HKkeSg") == "Dz7L_HKkeSg"
    assert youtube_video_id("https://youtu.be/Dz7L_HKkeSg") == "Dz7L_HKkeSg"
    assert youtube_video_id("https://www.youtube.com/shorts/Dz7L_HKkeSg") == "Dz7L_HKkeSg"
    assert youtube_video_id("Dz7L_HKkeSg") == "Dz7L_HKkeSg"
    assert youtube_video_id("https://ejemplo.com/no-es-youtube") is None
