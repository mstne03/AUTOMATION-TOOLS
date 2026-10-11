"""Criterio de aceptacion del paso 4: busqueda exacta, busqueda semantica y latencia.

Las aserciones sobre el fixture se filtran por `platform="test-suite"`, que solo
lleva la copia temporal de esta ejecucion. Asi los tests dan el mismo resultado
con la base vacia o con cien fuentes reales dentro.
"""

import time

import pytest

from ingest import cli
from kb import search
from tests.conftest import borrar_documento, requires_embeddings, requires_reader, requires_writer

SUITE = "test-suite"


@pytest.fixture(scope="module")
def fixture_ingerido(fuente_fixture):
    """Deja la copia temporal del fixture en la BD para todo el modulo."""
    cli.ingest_one(fuente_fixture)
    yield fuente_fixture
    borrar_documento(fuente_fixture["url"])


@requires_writer
@requires_reader
@requires_embeddings
def test_busqueda_de_termino_exacto(fixture_ingerido):
    """La rama full-text debe encontrar 'CTR' tal cual."""
    results = search.search("CTR", platform=SUITE, k=5)
    assert results, "CTR no devolvio nada"
    assert any("CTR" in r["content"] for r in results)
    assert results[0]["url"] == fixture_ingerido["url"]
    assert results[0]["title"] == "Retencion y CTR en YouTube Shorts"


@requires_writer
@requires_reader
@requires_embeddings
def test_busqueda_semantica(fixture_ingerido):
    """La rama vectorial debe entender la pregunta sin compartir palabras clave."""
    results = search.search(
        "por que la gente deja de ver mi video a los 3 segundos", platform=SUITE, k=5
    )
    assert results, "la busqueda semantica no devolvio nada"
    juntos = " ".join(r["content"].lower() for r in results)
    assert "tres segundos" in juntos or "abandono" in juntos or "gancho" in juntos


@requires_writer
@requires_reader
@requires_embeddings
def test_latencia_por_debajo_de_un_segundo(fixture_ingerido):
    """Sin filtro de plataforma, o sea contra toda la base."""
    search.search("retencion", k=8)  # calienta la conexion y el modelo
    inicio = time.perf_counter()
    search.search("como mejorar el CTR de mis miniaturas", k=8)
    transcurrido = time.perf_counter() - inicio
    assert transcurrido < 1.0, f"tardo {transcurrido:.3f}s, el limite es 1s"


@requires_writer
@requires_reader
@requires_embeddings
def test_filtro_por_plataforma(fixture_ingerido):
    assert search.search("retencion", platform=SUITE, k=5)
    assert search.search("retencion", platform="no-existe-esta-plataforma", k=5) == []

    # El fixture es youtube/test-suite, nunca debe salir filtrando por instagram.
    de_instagram = search.search("retencion", platform="instagram", k=20)
    assert all(r["url"] != fixture_ingerido["url"] for r in de_instagram)


@requires_writer
@requires_reader
@requires_embeddings
def test_filtro_por_fecha(fixture_ingerido):
    """El fixture es de 2025-01-15."""
    assert search.search("retencion", platform=SUITE, since="2024-01-01", k=5)
    assert search.search("retencion", platform=SUITE, since="2030-01-01", k=5) == []


@requires_writer
@requires_reader
@requires_embeddings
def test_campos_devueltos(fixture_ingerido):
    r = search.search("CTR", platform=SUITE, k=1)[0]
    for campo in ("content", "title", "url", "author", "published_at", "platforms", "score"):
        assert campo in r, f"falta el campo {campo}"
    assert r["published_at"] == "2025-01-15"
    assert r["author"] == "Fixture de prueba"
    assert set(r["platforms"]) == {"youtube", SUITE}
    assert r["score"] > 0


@requires_reader
def test_query_vacia_no_toca_la_base():
    assert search.search("   ") == []
