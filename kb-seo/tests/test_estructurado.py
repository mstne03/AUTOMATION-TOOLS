"""Versiones estructuradas de buscar_kb y listar_fuentes (las que pinta la UI)."""

import pytest

from ingest import cli
from kb import config
from mcp_server import server
from tests.conftest import requires_embeddings

TEXTO = (
    "Los shorts con gancho en los primeros dos segundos retienen un 40% mas.\n\n"
    "Los videos largos de tutoriales tienen mejor CTR por la tarde."
)


@pytest.fixture
def kb_privada(tmp_path, monkeypatch):
    target = tmp_path / "privada.sqlite"
    monkeypatch.setattr(config, "KB_BACKEND", "sqlite")
    monkeypatch.setattr(config, "KB_SQLITE_PATH", str(tmp_path / "no-existe.sqlite"))
    monkeypatch.setattr(config, "KB_PRIVATE_SQLITE_PATH", str(target))
    return target


@requires_embeddings
def test_fuentes_estructuradas_con_origen(kb_privada):
    cli.ingest_text(kb_privada, "analitica:2026-10", "Resumen de analíticas", TEXTO, platforms=["youtube"], published_at="2026-10-11")
    assert server.fuentes_estructuradas() == [
        {"titulo": "Resumen de analíticas", "plataforma": "youtube", "plataformas": ["youtube"], "fecha": "2026-10-11", "url": "analitica:2026-10", "origen": "privada"}
    ]
    assert server.fuentes_estructuradas("tiktok") == []


@requires_embeddings
def test_buscar_estructurado_devuelve_tarjetas(kb_privada):
    cli.ingest_text(kb_privada, "analitica:2026-10", "Resumen de analíticas", TEXTO, platforms=["youtube"], published_at="2026-10-11")
    r = server.buscar_estructurado("retencion en shorts", k=3)
    assert len(r) == 1
    tarjeta = r[0]
    assert set(tarjeta) == {"titulo", "plataforma", "plataformas", "fecha", "url", "origen", "fragmento"}
    assert (tarjeta["titulo"], tarjeta["plataforma"], tarjeta["origen"], tarjeta["fecha"]) == ("Resumen de analíticas", "youtube", "privada", "2026-10-11")
    assert "gancho" in tarjeta["fragmento"] and not tarjeta["fragmento"].startswith("[")  # sin la cabecera interna del chunk


def test_buscar_estructurado_con_consulta_vacia_no_busca(kb_privada):
    assert server.buscar_estructurado("   ") == []
