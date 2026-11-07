"""Frontera REST de guiones y proyectos de vídeo (T9).

Contra `motor_falso.py` ampliado con las tools de T4 (el motor real aún no las tiene). Los
tests contra el motor real se saltan solo mientras `dist/` no las exponga.
"""

import json
import re
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.routing import APIRoute

from app_backend import config, registry
from app_backend.main import create_app
from tests.test_video import AUTH, MOTOR_REAL_COMPILADO, TOKEN

MOTOR_FALSO = Path(__file__).with_name("motor_falso.py")
DIST = Path(__file__).resolve().parents[2] / "video-mcp-server" / "dist"
MOTOR_REAL_CON_T4 = (
    MOTOR_REAL_COMPILADO
    and any("video_guion_esquema" in f.read_text(encoding="utf-8", errors="ignore") for f in DIST.glob("*.js"))
)
CSP = "sandbox; default-src 'none'"
GUION = {"version": 1, "titulo": "Prueba", "gancho": "Gancho", "escenas": [], "opciones": {}}
CENTINELA = "CENTINELA-SECRETO-123"


@pytest.fixture
async def api(tmp_path, fake_anthropic, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.setenv("APP_BACKEND_VIDEO_CMD", json.dumps([sys.executable, str(MOTOR_FALSO)]))
    raiz = tmp_path / "proyectos"
    raiz.mkdir()
    monkeypatch.setattr(config, "VIDEO_ROOT", raiz, raising=False)
    app = create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
    )
    async with app.router.lifespan_context(app):
        transporte = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transporte, base_url="http://test", headers=AUTH) as c:
            c.app = app
            c.raiz = raiz
            yield c


async def _guion(c, **extra) -> str:
    r = await c.post("/video/guiones", json={"guion": {**GUION, **extra}})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _proyecto(c) -> str:
    r = await c.post("/video/proyectos", json={"guion_id": await _guion(c), "perfil_id": "defecto"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ------------------------------------------------------------------ guiones


async def test_esquema_del_guion(api):
    r = await api.get("/video/guiones/esquema")
    assert r.status_code == 200 and r.json() == {"texto": "ESQUEMA-FALSO"}


async def test_ciclo_de_guiones(api):
    gid = await _guion(api)
    assert re.fullmatch(r"g-[0-9a-f]{16}", gid)
    assert [g["id"] for g in (await api.get("/video/guiones")).json()] == [gid]
    assert (await api.get(f"/video/guiones/{gid}")).json()["titulo"] == "Prueba"
    assert (await api.delete(f"/video/guiones/{gid}")).json() == {}
    assert (await api.get(f"/video/guiones/{gid}")).status_code == 404
    assert (await api.delete(f"/video/guiones/{gid}")).status_code == 404


@pytest.mark.parametrize("gid", ["g-xyz", "..", "G-0123456789abcdef", "g-0123456789abcdef0", "video001"])
async def test_id_de_guion_con_forma_mala_es_404(api, gid):
    assert (await api.get(f"/video/guiones/{gid}")).status_code == 404
    assert (await api.delete(f"/video/guiones/{gid}")).status_code == 404


async def test_ruta_en_cuerpo_422(api):
    r = await api.post("/video/guiones", json={"guion": GUION, "ruta": "C:\\x"})
    assert r.status_code == 422
    r = await api.post("/video/guiones", json={"guion": {**GUION, "ruta": "C:\\x"}})
    assert r.status_code == 422
    assert r.json()["detail"]["codigo"] == "esquema"
    r = await api.post("/video/proyectos", json={"guion_id": await _guion(api), "perfil_id": "defecto", "ruta": "x"})
    assert r.status_code == 422


async def test_proto_rechazado(api):
    cuerpo = '{"guion": {"__proto__": {"x": 1}, "version": 1}}'
    r = await api.post("/video/guiones", content=cuerpo, headers={"Content-Type": "application/json"})
    assert r.status_code == 422


async def test_limites_en_rest(api):
    r = await api.post("/video/guiones", json={"guion": {**GUION, "escenas": [{}] * 91}})
    assert r.status_code == 422
    assert r.json()["detail"]["problemas"] == [{"ruta": "escenas", "codigo": "too_big"}]


async def test_cuerpo_2mib_413(api):
    grande = {"guion": {**GUION, "titulo": "a" * (2 * 1024 * 1024)}}
    assert (await api.post("/video/guiones", json=grande)).status_code == 413

    async def trozos():  # sin Content-Length: el tope cuenta el flujo real
        yield b'{"guion": {"titulo": "'
        for _ in range(40):
            yield b"a" * 65536
        yield b'"}}'

    r = await api.post("/video/guiones", content=trozos(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413
    assert CSP in r.headers["content-security-policy"]


async def test_cuerpo_justo_bajo_el_tope_pasa(api):
    r = await api.post("/video/guiones", json={"guion": {**GUION, "titulo": "a" * (900 * 1024)}})
    assert r.status_code == 201


@pytest.mark.parametrize("n", [17, 50_000])
async def test_json_anidado_422(api, n):
    cuerpo = '{"guion": ' + '{"a": ' * n + "1" + "}" * n + "}"
    r = await api.post("/video/guiones", content=cuerpo, headers={"Content-Type": "application/json"})
    assert r.status_code == 422


async def test_json_roto_422(api):
    r = await api.post("/video/guiones", content="{no es json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422


async def test_motor_cuelga_503_y_sigue(api):
    api.app.state.motor._timeout = 0.5
    r = await api.post("/video/guiones", json={"guion": {**GUION, "titulo": "COLGAR"}})
    assert r.status_code == 503
    assert (await api.get("/video/guiones/esquema")).status_code == 200


# ------------------------------------------------------ errores sin secretos


async def test_error_sin_centinela(api):
    for cuerpo in (
        {"guion": CENTINELA},
        {"guion": GUION, CENTINELA: CENTINELA},
        {"guion_id": CENTINELA, "perfil_id": CENTINELA},
    ):
        for ruta in ("/video/guiones", "/video/proyectos"):
            r = await api.post(ruta, json=cuerpo)
            assert r.status_code == 422 and CENTINELA not in r.text
    r = await api.post("/video/guiones", json={"guion": {**GUION, CENTINELA: CENTINELA}})
    assert r.status_code == 422 and CENTINELA not in r.text
    pid = await _proyecto(api)
    r = await api.put(f"/video/proyectos/{pid}", json={"revision": CENTINELA, "proyecto": {}})
    assert r.status_code == 422 and CENTINELA not in r.text


async def test_error_sin_ruta(api):
    r = await api.get("/video/guiones/g-ffffffffffffffff")  # error sin tipar de Node con una ruta
    assert r.status_code == 502
    assert "Users" not in r.text and "marc" not in r.text and "C:" not in r.text
    r = await api.get("/video/guiones/g-eeeeeeeeeeeeeeee")  # tipado, con una ruta en el mensaje
    assert r.status_code == 404
    assert "marc" not in r.text and "/home" not in r.text


# ---------------------------------------------------------------- proyectos


async def test_crear_listar_leer_y_guardar_proyecto(api):
    pid = await _proyecto(api)
    assert re.fullmatch(r"video\d{3}", pid)
    assert [p["id"] for p in (await api.get("/video/proyectos")).json()] == [pid]
    leido = (await api.get(f"/video/proyectos/{pid}")).json()
    assert leido["id"] == pid and leido["revision"] == 0
    r = await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {"id": pid, "titulo": "Nuevo"}})
    assert r.status_code == 200 and r.json() == {"revision": 1, "avisos": []}


async def test_crear_proyecto_con_guion_o_perfil_inexistente(api):
    base = {"guion_id": "g-0123456789abcdef", "perfil_id": "defecto"}
    assert (await api.post("/video/proyectos", json=base)).status_code == 404
    gid = await _guion(api)
    assert (await api.post("/video/proyectos", json={"guion_id": gid, "perfil_id": "p-0123456789abcdef"})).status_code == 404
    assert (await api.post("/video/proyectos", json={"guion_id": gid, "perfil_id": "../x"})).status_code == 422
    assert (await api.post("/video/proyectos", json={"guion_id": "g-malo", "perfil_id": "defecto"})).status_code == 422


async def test_revision_antigua_409(api):
    pid = await _proyecto(api)
    assert (await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {}})).status_code == 200
    assert (await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {}})).status_code == 409


async def test_id_del_cuerpo_distinto_al_de_la_ruta_422(api):
    pid = await _proyecto(api)
    r = await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {"id": "video999"}})
    assert r.status_code == 422


async def test_proyecto_manipulado_422(api):
    pid = await _proyecto(api)
    r = await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {"manipulado": True}})
    assert r.status_code == 422 and r.json()["detail"]["codigo"] == "esquema"


async def test_put_proyecto_inexistente_404(api):
    assert (await api.put("/video/proyectos/video777", json={"revision": 0, "proyecto": {}})).status_code == 404


@pytest.mark.parametrize("pid", ["video1", "video0001", "..%5Cx", "..%2F..%2Fx", "CON", "video001%00"])
async def test_id_recorrido_404(api, pid):
    for metodo in ("get", "delete"):
        assert (await getattr(api, metodo)(f"/video/proyectos/{pid}")).status_code == 404
    assert (await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {}})).status_code == 404


# ------------------------------------------------------------------- borrado


async def test_borrar_proyecto(api):
    pid = await _proyecto(api)
    (api.raiz / pid / "voz").mkdir()
    (api.raiz / pid / "voz" / "a.wav").write_bytes(b"x")
    assert (await api.delete(f"/video/proyectos/{pid}")).json() == {}
    assert not (api.raiz / pid).exists()
    assert (await api.delete(f"/video/proyectos/{pid}")).status_code == 404


def _enlace_a_carpeta(destino: Path, origen: Path) -> None:
    try:
        origen.symlink_to(destino, target_is_directory=True)
    except OSError:
        pytest.skip("sin permiso para crear enlaces simbólicos")


async def test_junction_interna_centinela_intacta(api, tmp_path):
    fuera = tmp_path / "fuera"
    fuera.mkdir()
    (fuera / "centinela.txt").write_text("intacto", encoding="utf-8")
    pid = await _proyecto(api)
    _enlace_a_carpeta(fuera, api.raiz / pid / "recursos")
    assert (await api.delete(f"/video/proyectos/{pid}")).status_code == 200
    assert not (api.raiz / pid).exists()
    assert (fuera / "centinela.txt").read_text(encoding="utf-8") == "intacto"


async def test_carpeta_reanalisis_rechazada(api, tmp_path):
    fuera = tmp_path / "fuera"
    fuera.mkdir()
    (fuera / "centinela.txt").write_text("intacto", encoding="utf-8")
    _enlace_a_carpeta(fuera, api.raiz / "video042")
    r = await api.delete("/video/proyectos/video042")
    assert r.status_code == 409
    assert (fuera / "centinela.txt").read_text(encoding="utf-8") == "intacto"


# --------------------------------------------------------- frontera de la API


async def test_sin_docs(api):
    for ruta in ("/docs", "/redoc", "/openapi.json"):
        assert (await api.get(ruta)).status_code == 404


async def test_respuesta_con_csp(api):
    for r in (
        await api.get("/video/guiones/esquema"),
        await api.get("/video/guiones/g-0123456789abcdef"),
        await api.get("/video/guiones", headers={"Authorization": "Bearer mal"}),
        await api.get("/settings"),
        await api.get("/no-existe"),
        await api.options("/video/guiones", headers={"Origin": "http://tauri.localhost", "Access-Control-Request-Method": "POST"}),
    ):
        assert r.headers["content-security-policy"] == "sandbox; default-src 'none'"


async def test_cors_de_video_sigue_exacto(api):
    r = await api.get("/video/guiones/esquema", headers={"Origin": "http://tauri.localhost"})
    assert r.headers["access-control-allow-origin"] == "http://tauri.localhost"
    r = await api.get("/video/guiones/esquema", headers={"Origin": "http://malo.example"})
    assert "access-control-allow-origin" not in r.headers



def _rutas_planas(rutas):
    """Las rutas de verdad, entrando en los routers incluidos (FastAPI los anida)."""
    for r in rutas:
        interior = getattr(getattr(r, "original_router", None), "routes", None)
        if interior is not None:
            yield from _rutas_planas(interior)
        else:
            yield r


async def test_todas_las_rutas_exigen_bearer(api):
    sin_bearer = []
    for r in _rutas_planas(api.app.routes):
        if not isinstance(r, APIRoute):
            sin_bearer.append(getattr(r, "path", repr(r)))
            continue
        if not any(getattr(d.dependency, "__name__", "") == "require_token" for d in r.dependencies):
            sin_bearer.append(r.path)
    assert sin_bearer == []  # lista vacía de excepciones
    assert any(r.path.startswith("/video/proyectos") for r in _rutas_planas(api.app.routes))


async def test_todas_las_rutas_con_patron(api):
    sin_patron = []
    for r in _rutas_planas(api.app.routes):
        for campo in getattr(getattr(r, "dependant", None), "path_params", []):
            if not any(getattr(m, "pattern", None) for m in campo.field_info.metadata):
                sin_patron.append(f"{r.path}:{campo.name}")
    assert sin_patron == []


async def test_jobs_rechaza_video_render(api):
    r = await api.post("/jobs", json={"kind": "video_render", "args": {}})
    assert r.status_code == 400


def test_registry_sin_tools_video():
    assert [n for n in registry.by_name(registry.build()) if n.startswith("video_")] == []


# ------------------------------------------------------ contra el motor real


@pytest.mark.skipif(not MOTOR_REAL_CON_T4, reason="el motor compilado aún no tiene las tools de T4")
async def test_esquema_y_xss_contra_motor_real(tmp_path, fake_anthropic, monkeypatch):
    monkeypatch.setenv("APP_BACKEND_VIDEO_CMD", json.dumps(["node", str(DIST / "index.js")]))
    monkeypatch.setattr(config, "VIDEO_ROOT", tmp_path / "proyectos", raising=False)
    app = create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
    )
    async with app.router.lifespan_context(app):
        transporte = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transporte, base_url="http://test", headers=AUTH) as c:
            assert (await c.get("/video/guiones/esquema")).json()["texto"]
            malo = {"version": 1, "titulo": "x", "gancho": "y", "escenas": [], "opciones": {}, "ruta": "C:\\x"}
            r = await c.post("/video/guiones", json={"guion": malo})
            assert r.status_code == 422 and "C:" not in r.text
