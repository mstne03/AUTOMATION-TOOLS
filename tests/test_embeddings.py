"""Criterio de aceptacion del paso 2."""

import math

from kb import config, embeddings
from tests.conftest import requires_ollama


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb)


@requires_ollama
def test_devuelve_vectores_de_1024_dimensiones():
    vectors = embeddings.embed(["hola mundo", "hello world"])
    assert len(vectors) == 2
    for v in vectors:
        assert len(v) == config.EMBED_DIM == 1024


@requires_ollama
def test_similitud_alta_entre_espanol_e_ingles():
    """bge-m3 es multilingue: la misma idea en dos idiomas debe quedar cerca."""
    es = "como aumentar la retencion en los primeros segundos de un video corto"
    en = "how to improve viewer retention in the first seconds of a short video"
    lejos = "receta de tortilla de patatas con cebolla"

    v_es, v_en, v_lejos = embeddings.embed([es, en, lejos])

    sim_par = _cosine(v_es, v_en)
    sim_lejos = _cosine(v_es, v_lejos)

    assert sim_par > 0.7, f"similitud es/en demasiado baja: {sim_par:.3f}"
    assert sim_par > sim_lejos, f"{sim_par:.3f} deberia superar a {sim_lejos:.3f}"


@requires_ollama
def test_lista_vacia_no_llama_a_ollama():
    assert embeddings.embed([]) == []


@requires_ollama
def test_lote_mayor_que_el_batch_size():
    """Mas textos que _BATCH_SIZE, para ejercitar el troceado en lotes."""
    textos = [f"texto de prueba numero {i}" for i in range(embeddings._BATCH_SIZE + 5)]
    vectors = embeddings.embed(textos)
    assert len(vectors) == len(textos)
    assert all(len(v) == 1024 for v in vectors)
