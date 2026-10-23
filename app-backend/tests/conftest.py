"""Fixtures: estado en un temporal, secretos en fichero y un Anthropic falso por SSE."""

import json
import os
import tempfile
from pathlib import Path

# Antes de importar app_backend: directorio de estado propio y secretos en fichero.
_STATE = Path(tempfile.mkdtemp(prefix="app-backend-tests-"))
os.environ["APP_BACKEND_DIR"] = str(_STATE)
os.environ["APP_BACKEND_SECRETS"] = "file"
os.environ["YOUTUBE_MCP_CONFIG_DIR"] = str(_STATE)
os.environ.setdefault("EMBED_CACHE_DIR", str(Path(tempfile.gettempdir()) / "fastembed_cache"))

import httpx2
import pytest
from anthropic import AsyncAnthropic

import app_backend  # noqa: F401  (carga .env/.env.local al importarse)

os.environ.pop("ANTHROPIC_API_KEY", None)  # los tests no deben ver una clave real


def _sse(events: list[dict]) -> bytes:
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def sse_message(blocks: list[dict], stop_reason: str) -> bytes:
    """Cuerpo SSE de un mensaje del asistente con los bloques dados.

    blocks: {"type": "text", "text": ...} o {"type": "tool_use", "id", "name", "input"}.
    """
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "model": "claude-opus-5-5",
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 1},
            },
        }
    ]
    for i, b in enumerate(blocks):
        if b["type"] == "text":
            events.append(
                {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}
            )
            events.append(
                {
                    "type": "content_block_delta",
                    "index": i,
                    "delta": {"type": "text_delta", "text": b["text"]},
                }
            )
        else:
            events.append(
                {
                    "type": "content_block_start",
                    "index": i,
                    "content_block": {"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}},
                }
            )
            events.append(
                {
                    "type": "content_block_delta",
                    "index": i,
                    "delta": {"type": "input_json_delta", "partial_json": json.dumps(b["input"])},
                }
            )
        events.append({"type": "content_block_stop", "index": i})
    events.append(
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
            "usage": {"output_tokens": 5},
        }
    )
    events.append({"type": "message_stop"})
    return _sse(events)


class FakeAnthropic:
    """Devuelve las respuestas SSE preparadas, en orden, y guarda cada peticion."""

    def __init__(self, responses: list[bytes]):
        self.responses = list(responses)
        self.requests: list[dict] = []
        self.headers: list[dict] = []

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.path.endswith("/v1/models"):  # validación de la clave: GET sin cuerpo
            self.headers.append(dict(request.headers))
            if request.headers.get("x-api-key", "").endswith("mala"):
                return httpx2.Response(401, json={"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
            modelo = {"id": "claude-opus-5-5", "type": "model", "display_name": "Claude Opus 5.5", "created_at": "2026-01-01T00:00:00Z"}
            return httpx2.Response(200, json={"data": [modelo], "has_more": False, "first_id": modelo["id"], "last_id": modelo["id"]})
        self.requests.append(json.loads(request.content))
        self.headers.append(dict(request.headers))
        if not self.responses:
            return httpx2.Response(500, json={"error": "sin respuestas preparadas"})
        return httpx2.Response(
            200, content=self.responses.pop(0), headers={"content-type": "text/event-stream"}
        )

    def factory(self, api_key: str) -> AsyncAnthropic:
        return AsyncAnthropic(
            api_key=api_key,
            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(self.handler)),
            max_retries=0,
        )


@pytest.fixture
def fake_anthropic():
    return FakeAnthropic
