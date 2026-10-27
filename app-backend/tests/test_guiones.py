"""GET /guiones/retencion: la tool de momentos de retención sin pasar por el modelo."""

from unittest.mock import patch

import httpx
import pytest

from app_backend import registry
from app_backend.main import create_app

TOKEN = "t-guiones"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
VIDEO_ID = "abcdefghijk"


@pytest.fixture
async def client(tmp_path):
    app = create_app(TOKEN, jobs_path=tmp_path / "jobs.sqlite", kb_auto_update=False)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest.fixture
def dobles():
    """Sustituye lo que la tool pide a YouTube: vídeo de 100 s con una caída a los 10 s."""
    filas = [
        {
            "elapsedVideoTimeRatio": (i + 1) / 100,
            "audienceWatchRatio": 1.0 if i < 10 else 0.8,
            "relativeRetentionPerformance": 0.5,
        }
        for i in range(100)
    ]
    video = {"id": VIDEO_ID, "title": "Mi video", "published_at": "2026-09-01T00:00:00Z", "duration_seconds": 100}
    transcripcion = {"source": "official_api", "segments": [{"text": "aqui", "start": 6.0, "duration": 5.0}]}
    with (
        patch("youtube_mcp.tools.retention.youtube_get_video", return_value=video) as get_video,
        patch("youtube_mcp.tools.retention.youtube_analytics_retention", return_value={"results": filas}),
        patch("youtube_mcp.tools.retention.youtube_get_transcript", return_value=transcripcion) as transcript,
    ):
        yield get_video, transcript


async def test_devuelve_los_momentos(client, dobles):
    r = await client.get(
        "/guiones/retencion", headers=AUTH, params={"video_id": VIDEO_ID, "format": "short", "language": "en"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["format"] == "short"
    assert body["drops"][0]["quote"] == "aqui"
    _, transcript = dobles
    assert transcript.call_args.args == (VIDEO_ID, "en")


async def test_valores_por_defecto(client, dobles):
    body = (await client.get("/guiones/retencion", headers=AUTH, params={"video_id": VIDEO_ID})).json()
    assert body["format"] == "long"
    _, transcript = dobles
    assert transcript.call_args.args == (VIDEO_ID, "es")


@pytest.mark.parametrize("video_id", ["corto", "abcdefghijk' OR 1", "abcdefghij;k", "a" * 12])
async def test_rechaza_ids_invalidos_sin_llamar_a_youtube(client, dobles, video_id):
    r = await client.get("/guiones/retencion", headers=AUTH, params={"video_id": video_id})
    assert r.status_code == 422
    get_video, _ = dobles
    get_video.assert_not_called()


async def test_rechaza_formato_desconocido(client, dobles):
    r = await client.get("/guiones/retencion", headers=AUTH, params={"video_id": VIDEO_ID, "format": "reel"})
    assert r.status_code == 422


async def test_error_de_la_tool_llega_como_200_con_error(client, dobles):
    get_video, _ = dobles
    get_video.return_value = {"error": f"Video not found: {VIDEO_ID}"}
    r = await client.get("/guiones/retencion", headers=AUTH, params={"video_id": VIDEO_ID})
    assert r.status_code == 200
    assert r.json() == {"error": f"Video not found: {VIDEO_ID}"}


async def test_exige_token(client, dobles):
    r = await client.get("/guiones/retencion", params={"video_id": VIDEO_ID})
    assert r.status_code == 401


def test_la_tool_es_de_lectura_y_declara_su_cuota():
    spec = registry.by_name(registry.build())["youtube_retention_moments"]
    assert spec.risk == "read"
    assert spec.quota == {"bucket": "general", "cost": 103}
