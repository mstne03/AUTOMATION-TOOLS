"""Clave de ElevenLabs (BYOK): guardado en el almacén y validación contra /v1/user (MockTransport)."""

import httpx
import pytest

from app_backend.main import create_app

TOKEN = "token-de-prueba"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def _handler(request: httpx.Request) -> httpx.Response:
    assert request.url == "https://api.elevenlabs.io/v1/user"
    if request.headers.get("xi-api-key") == "xi-buena":
        return httpx.Response(200, json={"subscription": {}})
    return httpx.Response(401, json={"detail": {"status": "invalid_api_key"}})


def _sin_red(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("sin red", request=request)


def _estado(codigo: int):
    return lambda request: httpx.Response(codigo)


async def _cliente(tmp_path, fake_anthropic, handler):
    app = create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
        elevenlabs_transport=httpx.MockTransport(handler),
    )
    return app


@pytest.fixture
def make_client(tmp_path, fake_anthropic):
    async def _make(handler=_handler):
        return await _cliente(tmp_path, fake_anthropic, handler)

    return _make


async def _con(app):
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c,
    ):
        yield c


@pytest.fixture
async def client(make_client):
    async for c in _con(await make_client()):
        yield c


async def test_guardar_y_borrar_clave_elevenlabs(client):
    r = await client.put("/settings", json={"elevenlabs_api_key": "xi-buena"}, headers=AUTH)
    assert r.json()["has_elevenlabs_key"] is True
    assert "xi-buena" not in r.text
    r = await client.put("/settings", json={"elevenlabs_api_key": ""}, headers=AUTH)
    assert r.json()["has_elevenlabs_key"] is False


async def test_validar_clave_elevenlabs_buena(client):
    r = await client.post("/settings/validate-elevenlabs-key", json={"api_key": "xi-buena"}, headers=AUTH)
    assert r.json() == {"valida": True, "detalle": None}


async def test_validar_clave_elevenlabs_guardada(client):
    await client.put("/settings", json={"elevenlabs_api_key": "xi-buena"}, headers=AUTH)
    r = await client.post("/settings/validate-elevenlabs-key", json={}, headers=AUTH)
    assert r.json() == {"valida": True, "detalle": None}
    await client.put("/settings", json={"elevenlabs_api_key": ""}, headers=AUTH)


async def test_clave_pegada_con_espacios_se_recorta(client):
    # Al copiar la clave del panel de ElevenLabs suele venir un salto de línea detrás.
    r = await client.post("/settings/validate-elevenlabs-key", json={"api_key": " xi-buena\n"}, headers=AUTH)
    assert r.json()["valida"] is True
    try:
        await client.put("/settings", json={"elevenlabs_api_key": "xi-buena\r\n"}, headers=AUTH)
        r = await client.post("/settings/validate-elevenlabs-key", json={}, headers=AUTH)
        assert r.json()["valida"] is True
    finally:
        await client.put("/settings", json={"elevenlabs_api_key": ""}, headers=AUTH)


async def test_validar_clave_elevenlabs_mala(client):
    r = await client.post("/settings/validate-elevenlabs-key", json={"api_key": "xi-mala"}, headers=AUTH)
    assert r.json() == {"valida": False, "detalle": "ElevenLabs no reconoce esta clave."}
    assert "xi-mala" not in r.text


async def test_validar_sin_clave_400(client, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    assert (await client.post("/settings/validate-elevenlabs-key", json={}, headers=AUTH)).status_code == 400


async def test_sin_conexion_502(make_client):
    async for c in _con(await make_client(_sin_red)):
        r = await c.post("/settings/validate-elevenlabs-key", json={"api_key": "xi-secreta"}, headers=AUTH)
        assert r.status_code == 502 and "ElevenLabs" in r.json()["detail"]
        assert "xi-secreta" not in r.text


async def test_otro_estado_502(make_client):
    async for c in _con(await make_client(_estado(500))):
        r = await c.post("/settings/validate-elevenlabs-key", json={"api_key": "xi"}, headers=AUTH)
        assert r.status_code == 502
        assert r.json()["detail"] == "ElevenLabs respondió con un error (500)."
