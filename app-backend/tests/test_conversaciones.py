"""Conversaciones guardadas en disco (SEO-100): sobreviven a reiniciar el sidecar y se pueden borrar."""

import asyncio
import json

import pytest

from app_backend.agent import Agent, ConversacionOcupada
from app_backend.approvals import Approvals
from app_backend.conversaciones import Almacen, compactar, titulo_de
from app_backend.jobs import Jobs
from tests.conftest import sse_message
from tests.test_agent import SPECS, _drain


def _agent(fake, tmp_path, almacen):
    return Agent(SPECS, Approvals(), Jobs(tmp_path / "jobs.sqlite", {}), client_factory=fake.factory, almacen=almacen)


async def test_sobrevive_a_reiniciar_el_sidecar_y_el_agente_sigue_la_conversacion(fake_anthropic, tmp_path):
    fake = fake_anthropic([
        sse_message([{"type": "tool_use", "id": "t1", "name": "fake_read", "input": {"q": "seo"}}], "tool_use"),
        sse_message([{"type": "text", "text": "Listo."}], "end_turn"),
        sse_message([{"type": "text", "text": "Sigo aquí."}], "end_turn"),
    ])
    almacen = Almacen(tmp_path / "conversaciones")
    agent = _agent(fake, tmp_path, almacen)
    conv = agent.conversation(None, perfil="smooth")
    events: asyncio.Queue = asyncio.Queue()
    await agent.run_turn(conv, "Analiza   mi canal de cocina por favor ahora mismo", events, api_key="k", model="m")
    await _drain(events)

    # Otro proceso (la app reabierta): lo lee del disco.
    otro = _agent(fake, tmp_path, Almacen(tmp_path / "conversaciones"))
    assert otro.listar() == [{"id": conv.id, "titulo": "Analiza mi canal de cocina por", "perfil": "smooth", "creada": conv.creada, "actualizada": conv.actualizada}]
    detalle = otro.detalle(conv.id)
    assert "messages" not in detalle
    assert [t["texto"] for t in detalle["turnos"]] == ["Analiza   mi canal de cocina por favor ahora mismo"]
    assert [e["type"] for e in detalle["turnos"][0]["eventos"]] == ["tool_use", "tool_result", "text", "done"]

    seguida = otro.conversation(conv.id)
    await otro.run_turn(seguida, "¿sigues?", events, api_key="k", model="m")
    await _drain(events)
    # El modelo recibe el historial entero (con el tool_use y su resultado) y la pregunta nueva.
    assert [m["role"] for m in fake.requests[2]["messages"]] == ["user", "assistant", "user", "assistant", "user"]
    assert fake.requests[2]["messages"][-1]["content"] == "¿sigues?"
    assert len(Almacen(tmp_path / "conversaciones").cargar(conv.id)["turnos"]) == 2


async def test_una_respuesta_cortada_queda_guardada_y_no_rompe_el_turno_siguiente(fake_anthropic, tmp_path):
    fake = fake_anthropic([
        sse_message([{"type": "tool_use", "id": "t1", "name": "fake_update", "input": {"video_id": "v1"}}], "tool_use"),
        sse_message([{"type": "text", "text": "De nuevo."}], "end_turn"),
    ])
    almacen = Almacen(tmp_path / "conversaciones")
    agent = _agent(fake, tmp_path, almacen)
    conv = agent.conversation(None)
    events: asyncio.Queue = asyncio.Queue()
    turno = asyncio.create_task(agent.run_turn(conv, "actualiza el vídeo", events, api_key="k", model="m"))
    while (await events.get())["type"] != "approval_required":
        pass
    turno.cancel()  # la app se cierra con la propuesta pendiente
    with pytest.raises(asyncio.CancelledError):
        await turno

    guardada = almacen.cargar(conv.id)
    assert [e["type"] for e in guardada["turnos"][0]["eventos"]] == ["tool_use", "approval_required"]

    reabierta = _agent(fake, tmp_path, Almacen(tmp_path / "conversaciones")).conversation(conv.id)
    otro = _agent(fake, tmp_path, almacen)
    await otro.run_turn(reabierta, "hola otra vez", events, api_key="k", model="m")
    evs = await _drain(events)
    assert evs[-1]["type"] == "done"
    # Sin el tool_use huérfano ni dos mensajes del usuario seguidos.
    assert [m["role"] for m in fake.requests[1]["messages"]] == ["user"]
    assert fake.requests[1]["messages"][0]["content"] == "hola otra vez"


async def test_sin_kb_se_indica_al_modelo_pero_no_se_guarda_en_el_texto(fake_anthropic, tmp_path):
    fake = fake_anthropic([sse_message([{"type": "text", "text": "Vale."}], "end_turn")])
    almacen = Almacen(tmp_path / "conversaciones")
    agent = _agent(fake, tmp_path, almacen)
    conv = agent.conversation(None)
    events: asyncio.Queue = asyncio.Queue()
    await agent.run_turn(conv, "hola", events, api_key="k", model="m", sin_kb=True)
    await _drain(events)
    assert "no uses las herramientas de la base de conocimiento" in fake.requests[0]["messages"][0]["content"]
    assert almacen.cargar(conv.id)["turnos"][0]["texto"] == "hola"
    assert almacen.cargar(conv.id)["titulo"] == "hola"


async def test_borrar_y_conversaciones_que_no_se_guardan(fake_anthropic, tmp_path):
    fake = fake_anthropic([sse_message([{"type": "text", "text": "a"}], "end_turn"), sse_message([{"type": "text", "text": "b"}], "end_turn")])
    almacen = Almacen(tmp_path / "conversaciones")
    agent = _agent(fake, tmp_path, almacen)
    events: asyncio.Queue = asyncio.Queue()
    trabajo = agent.conversation(None, persistir=False)  # Publicar
    await agent.run_turn(trabajo, "borrador", events, api_key="k", model="m")
    await _drain(events)
    assert agent.listar() == [] and almacen.cargar(trabajo.id) is None

    conv = agent.conversation(None)
    await agent.run_turn(conv, "hola", events, api_key="k", model="m")
    await _drain(events)
    async with conv.lock:  # con un turno en curso no se borra
        with pytest.raises(ConversacionOcupada):
            agent.borrar(conv.id)
    assert agent.borrar(conv.id) is True
    assert agent.listar() == [] and agent.detalle(conv.id) is None
    assert agent.borrar(conv.id) is False


def test_ids_que_no_son_de_conversacion_no_tocan_el_disco(tmp_path):
    almacen = Almacen(tmp_path / "conversaciones")
    (tmp_path / "secreto.json").write_text("{}")
    for malo in ("../secreto", "..\\secreto", "a/b", "", "x" * 65):
        assert almacen.cargar(malo) is None
        assert almacen.borrar(malo) is False
    with pytest.raises(ValueError):
        almacen.guardar({"id": "../x"})
    assert (tmp_path / "secreto.json").exists()


def test_un_fichero_roto_se_ignora(tmp_path):
    almacen = Almacen(tmp_path)
    (tmp_path / "rotoroto.json").write_text("{no es json")
    almacen.guardar({"id": "buenobueno", "titulo": "t", "perfil": None, "creada": 1, "actualizada": 1, "turnos": []})
    assert [r["id"] for r in almacen.listar()] == ["buenobueno"]


def test_titulo_y_compactar():
    assert titulo_de("  uno dos  tres ") == "uno dos tres"
    largo = titulo_de("palabraslarguisimas " * 6)
    assert len(largo) == 40 and largo.endswith("…")
    assert compactar([{"type": "text", "delta": "a"}, {"type": "text", "delta": "b"}, {"type": "done"}, {"type": "text", "delta": "c"}]) == [
        {"type": "text", "delta": "ab"}, {"type": "done"}, {"type": "text", "delta": "c"}
    ]
    json.dumps(compactar([]))
