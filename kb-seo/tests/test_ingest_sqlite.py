"""Ingesta con destino SQLite (modo VPS y KB privada). No necesita Postgres."""

from ingest import cli
from kb import config, embeddings, formatting, sqlite_kb
from tests.conftest import requires_embeddings


@requires_embeddings
def test_ingest_one_a_sqlite_es_idempotente(fuente_fixture, tmp_path):
    target = tmp_path / "kb.sqlite"
    r = cli.ingest_one(fuente_fixture, target=target)
    assert r["skipped"] is False and r["chunks"] > 0
    assert cli.ingest_one(fuente_fixture, target=target) == {"skipped": True, "chunks": 0}

    conn = sqlite_kb.connect(target)
    try:
        sqlite_kb.check_compatible(conn)
        assert conn.execute("SELECT count(*) FROM documents").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM chunks_vec").fetchone()[0] == r["chunks"]
        qvec = embeddings.embed_query("CTR")
        hit = sqlite_kb.search(conn, "CTR", qvec, platform="test-suite", k=3)[0]
        assert hit["title"] == "Retencion y CTR en YouTube Shorts"
    finally:
        conn.close()


@requires_embeddings
def test_ingest_text_y_origen_privado(tmp_path, monkeypatch):
    target = tmp_path / "privada.sqlite"
    r = cli.ingest_text(
        target, "analitica:2026-10", "Resumen de analiticas de octubre",
        "Los shorts con gancho en los primeros dos segundos retienen un 40% mas.\n\n"
        "Los videos largos de tutoriales tienen mejor CTR por la tarde.",
        platforms=["youtube"], published_at="2026-10-11",
    )
    assert r == {"skipped": False, "chunks": 1}
    assert cli.ingest_text(target, "analitica:2026-10", "x", "Los shorts con gancho en los primeros dos segundos retienen un 40% mas.\n\n"
        "Los videos largos de tutoriales tienen mejor CTR por la tarde.")["skipped"]

    # buscar_kb con backend sqlite y solo KB privada: el bloque sale marcado.
    monkeypatch.setattr(config, "KB_BACKEND", "sqlite")
    monkeypatch.setattr(config, "KB_SQLITE_PATH", str(tmp_path / "no-existe.sqlite"))
    monkeypatch.setattr(config, "KB_PRIVATE_SQLITE_PATH", str(target))
    from kb import search

    results = search.search("retencion en shorts", k=3)
    assert results and results[0]["origen"] == "privada"
    assert results[0]["document_id"] < 0
    salida = formatting.formatear(results, "retencion en shorts")
    assert "| analitica:2026-10 | KB privada" in salida
