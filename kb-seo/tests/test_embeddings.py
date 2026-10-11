"""Criterio de aceptacion del paso 2."""

import math

from kb import config, embeddings
from tests.conftest import requires_embeddings


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb)


@requires_embeddings
def test_devuelve_vectores_de_la_dimension_configurada():
    vectors = embeddings.embed(["hola mundo", "hello world"])
    assert len(vectors) == 2
    for v in vectors:
        assert len(v) == config.EMBED_DIM


@requires_embeddings
def test_similitud_alta_entre_espanol_e_ingles():
    """El modelo es multilingue: la misma idea en dos idiomas debe quedar cerca."""
    es = "como aumentar la retencion en los primeros segundos de un video corto"
    en = "how to improve viewer retention in the first seconds of a short video"
    lejos = "receta de tortilla de patatas con cebolla"

    v_es, v_en, v_lejos = embeddings.embed([es, en, lejos])

    sim_par = _cosine(v_es, v_en)
    sim_lejos = _cosine(v_es, v_lejos)

    assert sim_par > 0.7, f"similitud es/en demasiado baja: {sim_par:.3f}"
    assert sim_par > sim_lejos, f"{sim_par:.3f} deberia superar a {sim_lejos:.3f}"


def test_lista_vacia_no_llama_al_backend():
    assert embeddings.embed([]) == []


def test_prefijos_e5(monkeypatch):
    """Los modelos e5 llevan 'query: ' / 'passage: '; el resto, nada."""
    monkeypatch.setattr(config, "EMBED_MODEL", "intfloat/multilingual-e5-small")
    assert embeddings._prefixes() == ("query: ", "passage: ")
    monkeypatch.setattr(config, "EMBED_MODEL", "bge-m3")
    assert embeddings._prefixes() == ("", "")


@requires_embeddings
def test_query_y_pasaje_se_parecen():
    """Con los prefijos puestos, una pregunta queda mas cerca del pasaje que la responde."""
    q = embeddings.embed_query("como mejorar la retencion de un video")
    bueno, malo = embeddings.embed(
        ["how to improve viewer retention in a video", "receta de tortilla de patatas"]
    )
    assert _cosine(q, bueno) > _cosine(q, malo)


@requires_embeddings
def test_lote_mayor_que_el_batch_size():
    """Mas textos que _BATCH_SIZE, para ejercitar el troceado en lotes."""
    textos = [f"texto de prueba numero {i}" for i in range(embeddings._BATCH_SIZE + 5)]
    vectors = embeddings.embed(textos)
    assert len(vectors) == len(textos)
    assert all(len(v) == config.EMBED_DIM for v in vectors)
