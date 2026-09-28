"""Tests del filtro `sources` de search(), contra la base real."""

import pytest

from kb import search
from tests.conftest import requires_ollama, requires_reader


@requires_reader
@requires_ollama
def test_filtra_por_subcadena_de_url():
    r = search.search("hashtags", sources="buffer.com", k=5)
    assert r, "buffer.com deberia devolver algo"
    assert all("buffer.com" in x["url"] for x in r)


@requires_reader
@requires_ollama
def test_no_distingue_mayusculas():
    minus = search.search("hashtags", sources="buffer.com", k=5)
    mayus = search.search("hashtags", sources="BUFFER.COM", k=5)
    assert {x["url"] for x in minus} == {x["url"] for x in mayus}


@requires_reader
@requires_ollama
def test_filtra_por_subcadena_de_titulo():
    r = search.search("reels", sources="Centro de Transparencia", k=5)
    assert r
    assert all("Transparencia" in (x["title"] or "") for x in r)


@requires_reader
@requires_ollama
def test_una_lista_es_un_or():
    r = search.search("etiquetas", sources=["metricool", "howyoutubeworks"], k=8)
    assert r
    for x in r:
        texto = (x["url"] + (x["title"] or "")).lower()
        assert "metricool" in texto or "howyoutubeworks" in texto


@requires_reader
@requires_ollama
def test_sin_coincidencias_devuelve_vacio():
    assert search.search("hashtags", sources="no-existe-esta-fuente-xyz", k=5) == []


@requires_reader
@requires_ollama
def test_se_combina_con_plataforma_y_fecha():
    # buffer.com es tiktok y de 2025-12-17.
    assert search.search("hashtags", sources="buffer.com", platform="tiktok", k=5)
    assert search.search("hashtags", sources="buffer.com", platform="instagram", k=5) == []
    assert search.search("hashtags", sources="buffer.com", since="2030-01-01", k=5) == []


@requires_reader
@requires_ollama
def test_el_filtro_actua_antes_de_la_similitud():
    """Con `fuente` deben salir k resultados de ese documento, no las migajas
    que sobrevivan a un top-k global."""
    sin_filtro = search.search("hashtags", k=3)
    con_filtro = search.search("hashtags", sources="buffer.com", k=3)
    assert len(con_filtro) == 3
    # Si filtrara despues, como buffer no domina el top-3 global, saldrian menos.
    assert not all("buffer.com" in x["url"] for x in sin_filtro)


@requires_reader
@requires_ollama
def test_devuelve_document_id_y_chunk_index():
    r = search.search("retencion", k=3)
    assert r
    for x in r:
        assert isinstance(x["document_id"], int)
        assert isinstance(x["chunk_index"], int)


@requires_reader
@requires_ollama
def test_archivo_local_trae_url_original_y_se_filtra_por_ella():
    url = "transparency.meta.com/features/explaining-ranking/ig-reels-chaining"
    r = search.search("reels", sources=url, k=3)
    assert r, "fuente con la url original deberia casar con el archivo local"
    for x in r:
        assert x["url"].endswith("meta-instagram-reels-en-cadena.md")
        assert url in x["url_original"]


@requires_reader
@requires_ollama
def test_las_fuentes_web_no_tienen_url_original():
    r = search.search("hashtags", sources="buffer.com", k=3)
    assert r and all(x["url_original"] is None for x in r)


@requires_reader
def test_listar_titulos():
    todos = search.listar_titulos()
    assert todos
    assert all(isinstance(t, str) and isinstance(u, str) for t, u in todos)

    solo_tiktok = search.listar_titulos(platform="tiktok")
    assert 0 < len(solo_tiktok) < len(todos)


@pytest.mark.parametrize(
    "entrada,esperado",
    [
        (None, None),
        ("", None),
        ("  ", None),
        ("uno", ["uno"]),
        (["uno", "dos"], ["uno", "dos"]),
        ([" uno ", "", "dos"], ["uno", "dos"]),
        ([], None),
    ],
)
def test_normalizacion_de_sources(entrada, esperado):
    assert search._as_sources(entrada) == esperado
