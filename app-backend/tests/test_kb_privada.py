"""KB privada: notas por la API, busqueda marcada como privada y borrado.

Usa el modelo de embeddings real (fastembed) sobre el directorio de estado temporal
de los tests; no necesita Postgres ni red mas alla de la primera descarga del modelo.
"""

import httpx
import pytest

from app_backend import config
from app_backend.main import create_app

TOKEN = "token-de-prueba"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
async def client(tmp_path, fake_anthropic):
    app = create_app(
        TOKEN, client_factory=fake_anthropic([]).factory, jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=120) as c:
            yield c


async def test_nota_privada_se_busca_y_se_borra(client):
    assert (await client.get("/kb/privada/fuentes", headers=AUTH)).json() == []

    r = await client.post("/kb/privada/notas", headers=AUTH, json={
        "identificador": "analitica:2026-10",
        "titulo": "Analiticas de octubre",
        "texto": "Los shorts con gancho en los primeros dos segundos retienen un 40% mas.",
        "platforms": ["youtube"],
        "published_at": "2026-10-11",
    })
    assert r.status_code == 201, r.text
    assert r.json()["chunks"] == 1
    assert config.KB_PRIVATE_PATH.exists()
    assert config.KB_PRIVATE_PATH.is_relative_to(config.STATE_DIR)

    fuentes = (await client.get("/kb/privada/fuentes", headers=AUTH)).json()
    assert [f["url"] for f in fuentes] == ["analitica:2026-10"]

    texto = (await client.get("/kb/buscar", headers=AUTH, params={"q": "retencion en shorts"})).json()["texto"]
    assert "| analitica:2026-10 | KB privada" in texto

    estado = (await client.get("/kb/estado", headers=AUTH)).json()["texto"]
    assert "KB privada: 1 documentos" in estado

    r = await client.request("DELETE", "/kb/privada/fuentes", headers=AUTH, json={"url": "analitica:2026-10"})
    assert r.status_code == 200
    assert (await client.get("/kb/privada/fuentes", headers=AUTH)).json() == []
    r = await client.request("DELETE", "/kb/privada/fuentes", headers=AUTH, json={"url": "analitica:2026-10"})
    assert r.status_code == 404


async def test_fuente_privada_solo_urls_http(client):
    r = await client.post("/kb/privada/fuentes", headers=AUTH, json={"url": "C:/secretos/x.md"})
    assert r.status_code == 400


async def test_la_tool_de_guardar_es_write():
    from app_backend import registry

    specs = registry.by_name(registry.build())
    assert specs["guardar_en_kb_privada"].risk == "write"


async def test_busqueda_y_fuentes_en_json_para_la_ui(client):
    await client.post("/kb/privada/notas", headers=AUTH, json={
        "identificador": "analitica:2026-10",
        "titulo": "Analiticas de octubre",
        "texto": "Los shorts con gancho en los primeros dos segundos retienen un 40% mas.",
        "platforms": ["youtube"],
        "published_at": "2026-10-11",
    })
    try:
        r = await client.get("/kb/buscar", headers=AUTH, params={"q": "retencion en shorts", "formato": "json", "k": 5})
        assert r.status_code == 200, r.text
        tarjeta = next(t for t in r.json() if t["url"] == "analitica:2026-10")
        assert (tarjeta["titulo"], tarjeta["plataforma"], tarjeta["origen"]) == ("Analiticas de octubre", "youtube", "privada")
        assert "gancho" in tarjeta["fragmento"]

        r = await client.get("/kb/fuentes", headers=AUTH, params={"formato": "json"})
        assert r.status_code == 200
        assert {"titulo": "Analiticas de octubre", "plataforma": "youtube", "plataformas": ["youtube"], "fecha": "2026-10-11",
                "url": "analitica:2026-10", "origen": "privada"} in r.json()
        # sin formato sigue siendo el texto del agente
        assert "texto" in (await client.get("/kb/fuentes", headers=AUTH)).json()
    finally:
        await client.request("DELETE", "/kb/privada/fuentes", headers=AUTH, json={"url": "analitica:2026-10"})
