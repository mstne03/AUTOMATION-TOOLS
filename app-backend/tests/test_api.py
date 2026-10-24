"""API HTTP con el registro real de tools; Anthropic falso solo en /chat."""

import asyncio
import json

import httpx
import pytest

from app_backend import config
from app_backend.main import create_app
from tests.conftest import sse_message

TOKEN = "token-de-prueba"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
async def client(tmp_path, fake_anthropic):
    fake = fake_anthropic([
        sse_message(
            [{"type": "tool_use", "id": "t1", "name": "youtube_auth_status", "input": {}}], "tool_use"
        ),
        sse_message([{"type": "text", "text": "No estas autenticado."}], "end_turn"),
    ])
    app = create_app(
        TOKEN, client_factory=fake.factory, jobs_path=tmp_path / "jobs.sqlite", kb_auto_update=False
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            c.fake = fake
            yield c


async def test_token_required(client):
    assert (await client.get("/settings")).status_code == 401
    assert (await client.get("/settings", headers={"Authorization": "Bearer malo"})).status_code == 401
    assert (await client.get("/settings", headers=AUTH)).status_code == 200


async def test_settings_roundtrip(client):
    r = await client.get("/settings", headers=AUTH)
    assert r.json()["model"] == "claude-opus-5-5"
    assert r.json()["has_anthropic_key"] is False
    assert r.json()["secret_store"] == "FileSecretStore"

    r = await client.put(
        "/settings",
        headers=AUTH,
        json={
            "model": "claude-sonnet-5-5",
            "allowed_dirs": [{"path": "C:/Videos", "language": "es"}],
            "profile": "Smooth",
            "anthropic_api_key": "sk-ant-prueba",
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["model"] == "claude-sonnet-5-5"
    assert data["profile"] == "smooth"
    assert data["has_anthropic_key"] is True
    assert data["allowed_dirs"] == [{"path": "C:/Videos", "language": "es"}]
    assert config.load_settings()["model"] == "claude-sonnet-5-5"
    assert "C:/Videos=es" in __import__("os").environ["YOUTUBE_MCP_ALLOWED_DIRS"]
    assert "sk-ant" not in r.text  # la clave nunca vuelve al cliente

    r = await client.put("/settings", headers=AUTH, json={"model": "gpt-9"})
    assert r.status_code == 400
    r = await client.put("/settings", headers=AUTH, json={"profile": "../x"})
    assert r.status_code == 400
    # restaurar
    await client.put("/settings", headers=AUTH, json={"model": "claude-opus-5-5", "profile": "default", "anthropic_api_key": ""})


async def test_client_secret_import(client):
    r = await client.post("/settings/client-secret", headers=AUTH, json={"json_text": "{}"})
    assert r.status_code == 400
    incompleto = json.dumps({"installed": {"client_id": "id", "client_secret": "s"}})
    r = await client.post("/settings/client-secret", headers=AUTH, json={"json_text": incompleto})
    assert r.status_code == 400 and "auth_uri" in r.json()["detail"]
    bueno = '{"installed": {"client_id": "id", "client_secret": "s", "auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": "https://oauth2.googleapis.com/token"}}'
    r = await client.post("/settings/client-secret", headers=AUTH, json={"json_text": bueno})
    assert r.status_code == 200 and r.json()["has_client_secret"] is True


def _cliente(client_id: str, project_id: str) -> str:
    return json.dumps({"installed": {"client_id": client_id, "client_secret": "s", "project_id": project_id, "auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": "https://oauth2.googleapis.com/token"}})


async def test_un_solo_proyecto_de_google_para_todos_los_canales(client):
    from app_backend.main import yt_auth

    # Sin proyecto no se puede autorizar ningún canal: se dice qué falta, no un fallo de OAuth.
    r = await client.delete("/settings/client-secret", headers=AUTH)
    assert r.status_code == 200 and r.json()["google_project"] is None and r.json()["has_client_secret"] is False
    r = await client.post("/youtube/auth", headers=AUTH, json={"profile": "default"})
    assert r.status_code == 409 and "client_secret.json" in r.json()["detail"]

    r = await client.post("/settings/client-secret", headers=AUTH, json={"json_text": _cliente("111111111111-aaaa.apps.googleusercontent.com", "proyecto-a")})
    assert r.status_code == 200 and r.json()["google_project"] == {"project_id": "proyecto-a", "client_id": "111111…aaaa"}
    yt_auth.store.set("token:default", json.dumps({"token": "t", "refresh_token": "r", "client_id": "111111111111-aaaa.apps.googleusercontent.com", "client_secret": "s", "token_uri": "https://oauth2.googleapis.com/token", "expiry": "2099-01-01T00:00:00Z"}))

    # Otro proyecto desautoriza los canales: el sidecar no lo sustituye sin confirmación.
    otro = _cliente("222222222222-bbbb.apps.googleusercontent.com", "proyecto-b")
    r = await client.post("/settings/client-secret", headers=AUTH, json={"json_text": otro})
    assert r.status_code == 409 and "default" in r.json()["detail"]
    assert (await client.get("/settings", headers=AUTH)).json()["google_project"]["project_id"] == "proyecto-a"
    r = await client.post("/settings/client-secret", headers=AUTH, json={"json_text": otro, "replace": True})
    assert r.status_code == 200 and r.json()["desautorizados"] == ["default"]
    assert r.json()["google_project"]["project_id"] == "proyecto-b"
    assert yt_auth.profiles() == []

    r = await client.delete("/settings/client-secret", headers=AUTH)
    assert r.status_code == 200 and r.json()["has_client_secret"] is False
    assert (await client.delete("/settings/client-secret")).status_code == 401

async def test_youtube_status_and_tools(client):
    r = await client.get("/youtube/status", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["auth"]["authenticated"] is False
    assert r.json()["quota"]["buckets"]["video_insert"]["limit"] == 100
    tools = (await client.get("/youtube/tools", headers=AUTH)).json()
    assert {"name": "youtube_delete_video", "risk": "destructive", "quota": {"bucket": "general", "cost": 50},
            "job_kind": None} in tools


async def test_jobs_endpoint_runs_real_transcribe_and_reports_failure(client):
    r = await client.post("/jobs", headers=AUTH, json={"kind": "nope", "args": {}})
    assert r.status_code == 400
    r = await client.post("/jobs", headers=AUTH, json={"kind": "transcribe", "args": {"file": "nada.mp4"}})
    assert r.status_code == 202
    job_id = r.json()["id"]
    for _ in range(50):
        job = (await client.get(f"/jobs/{job_id}", headers=AUTH)).json()
        if job["status"] in ("done", "failed"):
            break
        await asyncio.sleep(0.05)
    assert job["status"] == "failed"
    assert "allowed" in job["error"].lower()  # sin carpetas permitidas: rechazado, no leido
    assert (await client.get("/jobs", headers=AUTH)).json()[0]["id"] == job_id
    assert (await client.get("/jobs/nope", headers=AUTH)).status_code == 404


async def test_approvals_endpoint(client):
    r = await client.post("/approvals/nope", headers=AUTH, json={"decision": "approve"})
    assert r.status_code == 404
    assert (await client.get("/approvals", headers=AUTH)).json() == []


async def test_chat_requires_api_key_then_streams(client):
    r = await client.post("/chat", headers=AUTH, json={"message": "hola"})
    assert r.status_code == 409  # sin clave de Anthropic

    await client.put("/settings", headers=AUTH, json={"anthropic_api_key": "sk-ant-prueba"})
    r = await client.post("/chat", headers=AUTH, json={"message": "estoy autenticado?"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    eventos = [json.loads(l[5:]) for l in r.text.splitlines() if l.startswith("data:")]
    tipos = [e["type"] for e in eventos]
    assert tipos == ["tool_use", "tool_result", "text", "done"]
    assert eventos[0]["name"] == "youtube_auth_status"
    assert json.loads(eventos[1]["content"])["auth"]["authenticated"] is False
    assert eventos[2]["delta"] == "No estas autenticado."
    conv = eventos[3]["conversation_id"]

    # Segundo turno en la misma conversacion: el historial viaja entero.
    client.fake.responses.append(sse_message([{"type": "text", "text": "Si."}], "end_turn"))
    r = await client.post("/chat", headers=AUTH, json={"message": "seguro?", "conversation_id": conv})
    assert r.status_code == 200
    assert len(client.fake.requests[-1]["messages"]) == 5
    await client.put("/settings", headers=AUTH, json={"anthropic_api_key": ""})


async def test_cors_solo_origenes_de_tauri(client):
    pre = {"Origin": "http://tauri.localhost", "Access-Control-Request-Method": "GET",
           "Access-Control-Request-Headers": "authorization"}
    r = await client.options("/settings", headers=pre)
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://tauri.localhost"
    r = await client.options("/settings", headers={**pre, "Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in r.headers
    # Sin token sigue siendo 401 aunque el origen sea el bueno.
    r = await client.get("/settings", headers={"Origin": "http://tauri.localhost"})
    assert r.status_code == 401


async def test_validate_key_con_clave_buena_mala_y_sin_clave(client):
    antes = (await client.get("/settings", headers=AUTH)).json()["has_anthropic_key"]
    if not antes:
        r = await client.post("/settings/validate-key", headers=AUTH, json={})
        assert r.status_code == 400  # sin clave guardada ni enviada

    r = await client.post("/settings/validate-key", headers=AUTH, json={"api_key": "sk-ant-buena"})
    assert r.status_code == 200 and r.json() == {"valida": True, "detalle": None}
    assert client.fake.headers[-1]["x-api-key"] == "sk-ant-buena"

    r = await client.post("/settings/validate-key", headers=AUTH, json={"api_key": "sk-ant-mala"})
    assert r.status_code == 200
    assert r.json()["valida"] is False and "no reconoce" in r.json()["detalle"]
    assert (await client.get("/settings", headers=AUTH)).json()["has_anthropic_key"] == antes  # validar no guarda nada

    assert (await client.post("/settings/validate-key", json={"api_key": "x"})).status_code == 401


async def test_cancelar_autorizacion_sin_flujo_en_curso(client):
    assert (await client.post("/youtube/auth/cancel")).status_code == 401
    r = await client.post("/youtube/auth/cancel", headers=AUTH)
    assert r.status_code == 200 and r.json() == {"cancelada": False}


async def test_alta_de_canal_interrumpida_se_cancela_y_deja_el_perfil_anterior(client):
    """El usuario cierra la pestaña de Google: sin cancelar, POST /youtube/auth no respondería nunca."""
    from unittest.mock import patch

    from app_backend.main import yt_auth

    bueno = '{"installed": {"client_id": "id", "client_secret": "s", "auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": "https://oauth2.googleapis.com/token"}}'
    assert (await client.post("/settings/client-secret", headers=AUTH, json={"json_text": bueno})).status_code == 200
    previo = yt_auth.profile
    with patch("google_auth_oauthlib.flow.webbrowser"):  # nadie visita la URL de consentimiento
        alta = asyncio.create_task(client.post("/youtube/auth", headers=AUTH, json={"profile": "nuevo", "reauthorize": True}))
        for _ in range(100):  # hasta que el flujo está esperando a Google
            await asyncio.sleep(0.05)
            if yt_auth._en_curso is not None:
                break
        r = await client.post("/youtube/auth/cancel", headers=AUTH)
        assert r.json() == {"cancelada": True}
        r = await asyncio.wait_for(alta, timeout=10)
    assert r.status_code == 400 and r.json()["detail"] == "Autorización cancelada."
    assert yt_auth.profile == previo
