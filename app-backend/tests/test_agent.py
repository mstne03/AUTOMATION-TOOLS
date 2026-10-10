"""Bucle del agente contra un Anthropic falso (SSE real por httpx.MockTransport)."""

import asyncio
import json

from app_backend.agent import REJECTED_TEXT, Agent, Conversation
from app_backend.approvals import Approvals
from app_backend.jobs import Jobs
from app_backend.registry import ToolSpec
from tests.conftest import sse_message

LLAMADAS: list[dict] = []


def _write_tool(video_id: str, title: str = "x") -> dict:
    LLAMADAS.append({"video_id": video_id, "title": title})
    return {"id": video_id, "title": title}


def _read_tool(q: str) -> str:
    return f"resultado para {q}"


SPECS = [
    ToolSpec(
        name="fake_update", description="Actualiza", fn=_write_tool, risk="write",
        quota={"bucket": "general", "cost": 50}, job_kind=None,
        input_schema={
            "type": "object",
            "properties": {
                "video_id": {"type": "string"},
                "title": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            },
            "required": ["video_id", "title"],
            "additionalProperties": False,
        },
    ),
    ToolSpec(
        name="fake_read", description="Lee", fn=_read_tool, risk="read", quota=None, job_kind=None,
        input_schema={
            "type": "object", "properties": {"q": {"type": "string"}},
            "required": ["q"], "additionalProperties": False,
        },
    ),
]


async def _drain(events: asyncio.Queue) -> list[dict]:
    out = []
    while True:
        ev = await events.get()
        out.append(ev)
        if ev["type"] in ("done", "error"):
            return out


def _agent(fake, tmp_path):
    jobs = Jobs(tmp_path / "jobs.sqlite", {})
    return Agent(SPECS, Approvals(), jobs, client_factory=fake.factory), jobs


async def test_read_tool_runs_without_approval(fake_anthropic, tmp_path):
    fake = fake_anthropic([
        sse_message([{"type": "tool_use", "id": "t1", "name": "fake_read", "input": {"q": "seo"}}], "tool_use"),
        sse_message([{"type": "text", "text": "Listo."}], "end_turn"),
    ])
    agent, jobs = _agent(fake, tmp_path)
    conv = Conversation()
    events: asyncio.Queue = asyncio.Queue()
    await agent.run_turn(conv, "hola", events, api_key="k", model="claude-opus-5-5")
    evs = await _drain(events)
    tipos = [e["type"] for e in evs]
    assert tipos == ["tool_use", "tool_result", "text", "done"]
    assert evs[1]["content"] == "resultado para seo" and evs[1]["is_error"] is False
    assert evs[-1]["stop_reason"] == "end_turn"
    # historial: user, assistant(tool_use), user(tool_result), assistant(text)
    assert [m["role"] for m in conv.messages] == ["user", "assistant", "user", "assistant"]

    req = fake.requests[0]
    assert req["model"] == "claude-opus-5-5"
    assert req["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert req["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in fake.headers[0]["anthropic-beta"]
    assert all(t["strict"] is True for t in req["tools"])
    assert [t["name"] for t in req["tools"]] == ["fake_read", "fake_update"]  # orden estable (cache)
    await jobs.stop()


async def test_write_tool_waits_for_approval_then_runs(fake_anthropic, tmp_path):
    LLAMADAS.clear()
    fake = fake_anthropic([
        sse_message(
            [{"type": "tool_use", "id": "t1", "name": "fake_update",
              "input": {"video_id": "v1", "title": None}}],
            "tool_use",
        ),
        sse_message([{"type": "text", "text": "Hecho."}], "end_turn"),
    ])
    agent, jobs = _agent(fake, tmp_path)
    events: asyncio.Queue = asyncio.Queue()
    turno = asyncio.create_task(
        agent.run_turn(Conversation(), "actualiza", events, api_key="k", model="claude-opus-5-5")
    )
    ev = await events.get()
    assert ev["type"] == "tool_use"
    ev = await events.get()
    assert ev["type"] == "approval_required"
    ap = ev["approval"]
    assert ap["tool"] == "fake_update" and ap["args"] == {"video_id": "v1"}
    assert ap["quota"] == {"bucket": "general", "cost": 50} and ap["risk"] == "write"
    assert LLAMADAS == []  # nada ejecutado todavia

    agent.approvals.resolve(ap["id"], "approve")
    await turno
    evs = await _drain(events)
    assert [e["type"] for e in evs] == ["approval_resolved", "tool_result", "text", "done"]
    assert LLAMADAS == [{"video_id": "v1", "title": "x"}]  # null descartado -> default
    assert json.loads(evs[1]["content"]) == {"id": "v1", "title": "x"}
    await jobs.stop()


async def test_rejected_write_tool_is_not_executed(fake_anthropic, tmp_path):
    LLAMADAS.clear()
    fake = fake_anthropic([
        sse_message(
            [{"type": "tool_use", "id": "t1", "name": "fake_update", "input": {"video_id": "v2", "title": "t"}}],
            "tool_use",
        ),
        sse_message([{"type": "text", "text": "Vale, no lo hago."}], "end_turn"),
    ])
    agent, jobs = _agent(fake, tmp_path)
    events: asyncio.Queue = asyncio.Queue()
    turno = asyncio.create_task(
        agent.run_turn(Conversation(), "actualiza", events, api_key="k", model="claude-opus-5-5")
    )
    await events.get()  # tool_use
    ap = (await events.get())["approval"]
    agent.approvals.resolve(ap["id"], "reject")
    await turno
    evs = await _drain(events)
    assert LLAMADAS == []
    assert evs[1]["type"] == "tool_result" and evs[1]["content"] == REJECTED_TEXT
    # el modelo recibe el rechazo como resultado normal, no como error
    assert fake.requests[1]["messages"][2]["content"][0]["content"] == REJECTED_TEXT
    assert fake.requests[1]["messages"][2]["content"][0].get("is_error") is not True
    await jobs.stop()


async def test_api_error_becomes_error_event(fake_anthropic, tmp_path):
    fake = fake_anthropic([])  # sin respuestas: el transporte devuelve 500
    agent, jobs = _agent(fake, tmp_path)
    events: asyncio.Queue = asyncio.Queue()
    await agent.run_turn(Conversation(), "hola", events, api_key="k", model="claude-opus-5-5")
    evs = await _drain(events)
    assert evs[-1]["type"] == "error" and "InternalServerError" in evs[-1]["message"]
    await jobs.stop()
