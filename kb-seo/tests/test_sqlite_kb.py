"""KB en SQLite: esquema, escritura, busqueda y paridad con Postgres.

Los tests de escritura y busqueda usan una base temporal con vectores inventados
y no necesitan ni Postgres ni el modelo. Los de paridad exportan la base real y
comparan la misma consulta en los dos backends.
"""

import pytest

from kb import config, embeddings, export, search, sqlite_kb
from tests.conftest import requires_embeddings, requires_reader

DIM = 4


def _doc(url, title, platforms, published_at, chunks):
    return {
        "url": url, "title": title, "source_type": "web", "platforms": platforms,
        "author": None, "published_at": published_at, "lang": "es", "topics": [],
        "content_hash": "h-" + url,
    }, chunks


@pytest.fixture
def kb(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "EMBED_DIM", DIM)
    conn = sqlite_kb.connect(tmp_path / "kb.sqlite", readonly=False)
    sqlite_kb.init_schema(conn, dim=DIM)
    doc, chunks = _doc(
        "https://a.example/hashtags", "Guia de hashtags", ["tiktok"], "2025-03-01",
        ["[Guia | tiktok | 2025-03-01]\nLos hashtags en TikTok importan.",
         "[Guia | tiktok | 2025-03-01]\nPublica a las 18:00 para mas alcance."],
    )
    sqlite_kb.upsert_document(conn, doc, chunks, [[1, 0, 0, 0], [0, 1, 0, 0]])
    doc, chunks = _doc(
        "fuentes/local.md", "Capturado a mano", ["instagram"], "2024-01-01",
        ["[Capturado | instagram | 2024-01-01]\n# Titulo\n> Original: https://b.example/reels\n\nLos reels encadenados."],
    )
    sqlite_kb.upsert_document(conn, doc, chunks, [[0, 0, 1, 0]])
    conn.commit()
    yield conn
    conn.close()


def test_fts_query_equivale_a_plainto_tsquery():
    assert sqlite_kb.fts_query("Hashtags de TikTok!") == '"hashtags" "de" "tiktok"'
    assert sqlite_kb.fts_query('"comillas"') == '"comillas"'
    assert sqlite_kb.fts_query("???") == ""


def test_rama_vectorial_y_textual(kb):
    r = sqlite_kb.search(kb, "hashtags", [0, 1, 0, 0], k=5)
    assert [x["chunk_index"] for x in r[:2]] == [0, 1] or {x["chunk_index"] for x in r[:2]} == {0, 1}
    textual = next(x for x in r if x["text_rank"])
    assert "hashtags" in textual["content"]
    assert textual["platforms"] == ["tiktok"]
    assert textual["published_at"] == "2025-03-01"


def test_filtros(kb):
    de_instagram = sqlite_kb.search(kb, "hashtags", [1, 0, 0, 0], platform="instagram", k=5)
    assert {x["url"] for x in de_instagram} == {"fuentes/local.md"}
    assert sqlite_kb.search(kb, "hashtags", [1, 0, 0, 0], platform="no-existe", k=5) == []
    assert sqlite_kb.search(kb, "hashtags", [1, 0, 0, 0], since="2026-01-01", k=5) == []
    por_url_original = sqlite_kb.search(kb, "reels", [0, 0, 1, 0], sources="b.example", k=5)
    assert [x["url"] for x in por_url_original] == ["fuentes/local.md"]
    assert por_url_original[0]["url_original"] == "https://b.example/reels"
    assert sqlite_kb.search(kb, "reels", [0, 0, 1, 0], sources="NO-EXISTE", k=5) == []
    assert sqlite_kb.search(kb, "   ", [0, 0, 1, 0], k=5) == []


def test_upsert_reemplaza_y_delete_borra(kb):
    doc, _ = _doc("https://a.example/hashtags", "Nuevo titulo", ["tiktok"], "2025-03-01", [])
    sqlite_kb.upsert_document(kb, doc, ["[x]\nTexto nuevo"], [[0, 0, 0, 1]])
    assert kb.execute("SELECT count(*) FROM chunks").fetchone()[0] == 2
    assert kb.execute("SELECT count(*) FROM chunks_vec").fetchone()[0] == 2
    assert kb.execute("SELECT count(*) FROM chunks_fts").fetchone()[0] == 2
    tras = sqlite_kb.search(kb, "hashtags", [1, 0, 0, 0], k=5)
    assert all("hashtags" not in x["content"] for x in tras)  # el chunk viejo se fue
    assert all(x["text_rank"] is None for x in tras)
    assert sqlite_kb.delete_document(kb, "https://a.example/hashtags")
    assert kb.execute("SELECT count(*) FROM chunks").fetchone()[0] == 1
    assert not sqlite_kb.delete_document(kb, "https://a.example/hashtags")


def test_listados_y_estado(kb):
    assert sqlite_kb.listar_titulos(kb) == [
        ("Guia de hashtags", "https://a.example/hashtags"),
        ("Capturado a mano", "fuentes/local.md"),
    ]
    assert len(sqlite_kb.listar_fuentes(kb, "tiktok")) == 1
    e = sqlite_kb.estado(kb)
    assert (e["documentos"], e["chunks"]) == (2, 3)
    assert e["meta"]["embed_dim"] == str(DIM)


def test_modelo_distinto_se_rechaza(kb, monkeypatch):
    monkeypatch.setattr(config, "EMBED_MODEL", "otro-modelo")
    with pytest.raises(RuntimeError):
        sqlite_kb.check_compatible(kb)


# ------------------------------------------------------------------ paridad

CONSULTAS = [
    {"query": "mejor hora para publicar en TikTok"},
    {"query": "hashtags", "sources": "buffer.com"},
    {"query": "CTR miniaturas"},
    {"query": "como funciona el algoritmo de recomendaciones", "platform": "youtube", "since": "2025-01-01"},
]


@pytest.fixture(scope="module")
def snapshot(tmp_path_factory):
    try:
        urls = {url for _, url in search.listar_titulos()}
    except Exception:  # noqa: BLE001 - sin BD, requires_reader ya salta
        pytest.skip("Postgres no disponible")
    if not any("buffer.com" in u for u in urls):
        pytest.skip("sources.yaml no esta ingerido (uv run ingest all)")
    out = tmp_path_factory.mktemp("snapshot")
    manifest = export.export(out)
    return out, manifest


@requires_reader
@requires_embeddings
def test_export_es_determinista_y_el_manifest_cuadra(snapshot, tmp_path):
    out, manifest = snapshot
    assert manifest["embed_dim"] == config.EMBED_DIM
    assert (out / "kb-public.sqlite").stat().st_size == manifest["size"]
    assert export._sha256(out / "kb-public.sqlite") == manifest["sha256"]
    assert export.export(tmp_path)["sha256"] == manifest["sha256"]


@requires_reader
@requires_embeddings
@pytest.mark.parametrize("consulta", CONSULTAS, ids=[c["query"] for c in CONSULTAS])
def test_misma_consulta_mismos_resultados(snapshot, consulta):
    out, _ = snapshot
    qvec = embeddings.embed_query(consulta["query"])
    pg = search.search(**consulta, k=8, qvec=qvec)
    conn = sqlite_kb.connect(out / "kb-public.sqlite")
    try:
        sq = sqlite_kb.search(conn, qvec=qvec, k=8, **consulta)
    finally:
        conn.close()
    def clave(r):
        return (r["url"], r["chunk_index"])

    assert [clave(r) for r in pg] == [clave(r) for r in sq]
    assert [r["vector_rank"] for r in pg] == [r["vector_rank"] for r in sq]
