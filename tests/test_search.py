"""Criterio de aceptacion del paso 4: busqueda exacta, busqueda semantica y latencia."""

import time

import pytest

from ingest import cli
from kb import config, search
from tests.conftest import requires_ollama, requires_reader, requires_writer

FIXTURE = config.PROJECT_ROOT / "tests" / "fixtures" / "prueba.md"

SOURCE = {
    "url": str(FIXTURE),
    "type": "local",
    "platforms": ["youtube", "general"],
    "published_at": "2025-01-15",
    "author": "Fixture de prueba",
    "topics": ["retencion", "ctr", "shorts"],
}


@pytest.fixture(scope="module")
def fixture_ingerido():
    """Deja el fixture en la BD para todo el modulo."""
    from kb import db

    cli.ingest_one(SOURCE)
    yield
    with db.writer() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM documents WHERE url = %s", (SOURCE["url"],))
        conn.commit()


@requires_writer
@requires_reader
@requires_ollama
def test_busqueda_de_termino_exacto(fixture_ingerido):
    """La rama full-text debe encontrar 'CTR' tal cual."""
    results = search.search("CTR", k=5)
    assert results, "CTR no devolvio nada"
    assert any("CTR" in r["content"] for r in results)
    assert results[0]["url"] == SOURCE["url"]
    assert results[0]["title"] == "Retencion y CTR en YouTube Shorts"


@requires_writer
@requires_reader
@requires_ollama
def test_busqueda_semantica(fixture_ingerido):
    """La rama vectorial debe entender la pregunta sin compartir palabras clave."""
    results = search.search(
        "por que la gente deja de ver mi video a los 3 segundos", k=5
    )
    assert results, "la busqueda semantica no devolvio nada"
    juntos = " ".join(r["content"].lower() for r in results)
    assert "tres segundos" in juntos or "abandono" in juntos or "gancho" in juntos


@requires_writer
@requires_reader
@requires_ollama
def test_latencia_por_debajo_de_un_segundo(fixture_ingerido):
    search.search("retencion", k=8)  # calienta la conexion y el modelo
    inicio = time.perf_counter()
    search.search("como mejorar el CTR de mis miniaturas", k=8)
    transcurrido = time.perf_counter() - inicio
    assert transcurrido < 1.0, f"tardo {transcurrido:.3f}s, el limite es 1s"


@requires_writer
@requires_reader
@requires_ollama
def test_filtro_por_plataforma(fixture_ingerido):
    assert search.search("retencion", platform="youtube", k=5)
    assert search.search("retencion", platform="tiktok", k=5) == []


@requires_writer
@requires_reader
@requires_ollama
def test_filtro_por_fecha(fixture_ingerido):
    assert search.search("retencion", since="2024-01-01", k=5)
    assert search.search("retencion", since="2030-01-01", k=5) == []


@requires_writer
@requires_reader
@requires_ollama
def test_campos_devueltos(fixture_ingerido):
    r = search.search("CTR", k=1)[0]
    for campo in ("content", "title", "url", "author", "published_at", "platforms", "score"):
        assert campo in r, f"falta el campo {campo}"
    assert r["published_at"] == "2025-01-15"
    assert r["author"] == "Fixture de prueba"
    assert set(r["platforms"]) == {"youtube", "general"}
    assert r["score"] > 0


@requires_reader
def test_query_vacia_no_toca_la_base():
    assert search.search("   ") == []
