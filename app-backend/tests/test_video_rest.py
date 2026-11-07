"""Frontera REST de guiones y proyectos de vídeo (T9).

La mayoría usa `motor_falso.py`: sus negativas de esquema son del SIMULADOR y no cuentan como
cobertura de la frontera. La puerta real es `test_real_*`: contra `video-mcp-server/dist` (el motor
con `.strict()` de T1/T4), que se ejecuta siempre que `dist/` exista (si falta, se salta, salvo
con `VIDEO_ENGINE_R1=1`, donde falla).
"""

import asyncio
import json
import os
import re
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.routing import APIRoute

from app_backend import config, registry, video, video_rest
from app_backend.main import create_app
from tests.conftest import sse_message
from tests.test_video import AUTH, MOTOR_REAL_COMPILADO, TOKEN

MOTOR_FALSO = Path(__file__).with_name("motor_falso.py")
DIST = Path(__file__).resolve().parents[2] / "video-mcp-server" / "dist"
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
    cuerpo = {"revision": 0, "proyecto": {"id": pid}}
    assert (await api.put(f"/video/proyectos/{pid}", json=cuerpo)).status_code == 200
    assert (await api.put(f"/video/proyectos/{pid}", json=cuerpo)).status_code == 409


async def test_id_del_cuerpo_distinto_al_de_la_ruta_422(api):
    pid = await _proyecto(api)
    r = await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {"id": "video999"}})
    assert r.status_code == 422


async def test_id_ausente_o_revision_distinta_422(api):
    pid = await _proyecto(api)
    r = await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {}})
    assert r.status_code == 422 and r.json()["detail"]["codigo"] == "id_distinto"
    r = await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {"id": pid, "revision": 5}})
    assert r.status_code == 422 and r.json()["detail"]["codigo"] == "revision_distinta"


async def test_nan_e_infinity_422(api):
    r = await api.post("/video/guiones", content='{"guion": {"version": NaN}}', headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and r.json()["detail"]["codigo"] == "json"


async def test_proyecto_manipulado_422(api):
    pid = await _proyecto(api)
    r = await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {"id": pid, "manipulado": True}})
    assert r.status_code == 422 and r.json()["detail"]["codigo"] == "esquema"


async def test_put_proyecto_inexistente_404(api):
    assert (await api.put("/video/proyectos/video777", json={"revision": 0, "proyecto": {"id": "video777"}})).status_code == 404


@pytest.mark.parametrize("pid", ["video1", "video0001", "..%5Cx", "..%2F..%2Fx", "CON", "video001%00", "video١٢٣"])
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


# ------------------------------------------------- errores con rutas con espacios (M1)

RUTAS_CON_ESPACIOS = ["C:\\Users\\Marc Serra\\AppData\\Local\\x", "C:\\Program Files\\SEO Studio\\video-engine\\node.exe", "Marc Serra", "Program Files"]


def _sin_rutas(texto: str) -> None:
    for trozo in ("Marc Serra", "Program Files", "SEO Studio", "C:\\", "AppData", "marc"):
        assert trozo not in texto, f"{trozo!r} en {texto!r}"


async def _api_con_motor(tmp_path, fake_anthropic, monkeypatch, cmd):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.setenv("APP_BACKEND_VIDEO_CMD", json.dumps(cmd))
    raiz = tmp_path / "proyectos"
    raiz.mkdir(exist_ok=True)
    monkeypatch.setattr(config, "VIDEO_ROOT", raiz, raising=False)
    return create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
    )


async def test_503_sin_rutas_con_espacios(tmp_path, fake_anthropic, monkeypatch):
    """El motor no arranca y el error del sistema lleva la ruta del ejecutable (con espacios)."""
    exe = "C:\\Program Files\\SEO Studio\\video-engine\\node\\Marc Serra\\node.exe"
    app = await _api_con_motor(tmp_path, fake_anthropic, monkeypatch, [exe, "index.js"])
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=AUTH) as c,
    ):
            r = await c.get("/video/guiones/esquema")
            assert r.status_code == 503
            _sin_rutas(r.text)
            assert r.json()["detail"] == video_rest.MENSAJE_503


@pytest.mark.parametrize("gid", ["g-dddddddddddddddd", "g-cccccccccccccccc", "g-bbbbbbbbbbbbbbbb", "g-aaaaaaaaaaaaaaaa"])
async def test_4xx_y_502_sin_rutas_con_espacios(api, gid):
    r = await api.get(f"/video/guiones/{gid}")
    assert r.status_code in (404, 409, 422, 502)
    _sin_rutas(r.text)
    r = await api.get("/video/guiones/g-ffffffffffffffff")
    assert r.status_code == 502
    _sin_rutas(r.text)


async def test_problemas_filtrados_a_ruta_y_codigo(api):
    r = await api.get("/video/guiones/g-aaaaaaaaaaaaaaaa")  # 422 con problemas hostiles del motor
    assert r.status_code == 422
    assert r.json()["detail"]["problemas"] == [
        {"ruta": "escenas.0.texto", "codigo": "too_big"},
        {"ruta": "?", "codigo": "desconocido"},
        {"ruta": "?", "codigo": "desconocido"},
    ]
    _sin_rutas(r.text)
    assert "<img" not in r.text


async def test_500_sin_detalle_y_con_csp(tmp_path, fake_anthropic, monkeypatch):
    app = await _api_con_motor(tmp_path, fake_anthropic, monkeypatch, [sys.executable, str(MOTOR_FALSO)])

    def roto(*a, **k):
        raise RuntimeError("fallo en C:\\Users\\Marc Serra\\x")

    monkeypatch.setattr(video, "motor_de", roto)
    async with app.router.lifespan_context(app):
        transporte = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transporte, base_url="http://test", headers=AUTH) as c:
            r = await c.get("/video/guiones/esquema")
            assert r.status_code == 500
            assert r.headers["content-security-policy"] == CSP
            _sin_rutas(r.text)


# ------------------------------------------------------- borrado concurrente (M2)


async def test_junction_es_409_enlace_y_en_uso_es_409_distinto(api, tmp_path, monkeypatch):
    fuera = tmp_path / "fuera"
    fuera.mkdir()
    _enlace_a_carpeta(fuera, api.raiz / "video042")
    r = await api.delete("/video/proyectos/video042")
    assert r.status_code == 409 and "enlace" in r.json()["detail"]

    pid = await _proyecto(api)
    original = os.rename

    def en_uso(a, b, *args, **kw):  # WinError 32: algo tiene la carpeta abierta
        if Path(a).name == pid:
            raise PermissionError(32, "en uso")
        return original(a, b, *args, **kw)

    monkeypatch.setattr(video_rest.os, "rename", en_uso)
    r = await api.delete(f"/video/proyectos/{pid}")
    assert r.status_code == 409 and "enlace" not in r.json()["detail"] and "en uso" in r.json()["detail"]
    assert (api.raiz / pid / "proyecto.json").is_file()  # intacto
    assert not any(p.name.startswith(".borrando") for p in api.raiz.iterdir())


async def test_borrado_renombra_a_papelera_antes_de_borrar(api, monkeypatch):
    pid = await _proyecto(api)
    vistos = []
    original = video_rest._borrar

    def espiar(ruta):
        vistos.append(Path(ruta).name)
        assert not (api.raiz / pid).exists()  # el proyecto ya no está en su sitio durante el borrado
        return original(ruta)

    monkeypatch.setattr(video_rest, "_borrar", espiar)
    assert (await api.delete(f"/video/proyectos/{pid}")).status_code == 200
    assert len(vistos) == 1 and vistos[0].startswith(f".borrando-{pid}-")
    assert list(api.raiz.iterdir()) == []


async def test_put_y_delete_comparten_cerrojo(api, monkeypatch):
    pid = await _proyecto(api)
    orden = []
    original = video_rest.borrar_proyecto

    async def put_lento(*a, **k):
        orden.append("put-dentro")
        await asyncio.sleep(0.3)
        orden.append("put-fuera")
        return {"revision": 1, "avisos": []}

    def borrar_espia(id):
        orden.append("delete-dentro")
        return original(id)

    monkeypatch.setattr(video_rest, "_llamar", put_lento)
    monkeypatch.setattr(video_rest, "borrar_proyecto", borrar_espia)
    put = asyncio.create_task(api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {"id": pid}}))
    await asyncio.sleep(0.1)
    borrar = asyncio.create_task(api.delete(f"/video/proyectos/{pid}"))
    assert (await put).status_code == 200 and (await borrar).status_code == 200
    assert orden == ["put-dentro", "put-fuera", "delete-dentro"]


# ----------------------------------------------- el modelo no llega a las rutas (T9)


async def test_modelo_no_llega_a_rutas(tmp_path, fake_anthropic, monkeypatch):
    """Un turno que inventa tools `video_*` no toca el motor ni el disco: tool desconocida."""
    fake = fake_anthropic(
        [
            sse_message(
                [
                    {"type": "tool_use", "id": "t1", "name": "video_guion_guardar", "input": {"guion": GUION}},
                    {"type": "tool_use", "id": "t2", "name": "video_proyecto_crear", "input": {"guionId": "g-0123456789abcdef", "perfilId": "defecto"}},
                ],
                "tool_use",
            ),
            sse_message([{"type": "text", "text": "ok"}], "end_turn"),
        ]
    )
    monkeypatch.setenv("APP_BACKEND_VIDEO_CMD", json.dumps([sys.executable, str(MOTOR_FALSO)]))
    monkeypatch.setattr(config, "VIDEO_ROOT", tmp_path / "proyectos", raising=False)
    llamadas = []

    async def espia(self, tool, args=None):
        llamadas.append(tool)
        raise AssertionError("el modelo llegó al motor de vídeo")

    monkeypatch.setattr(video.MotorVideo, "llamar", espia)
    app = create_app(
        TOKEN, client_factory=fake.factory, jobs_path=tmp_path / "jobs.sqlite", kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=AUTH) as c,
    ):
            await c.put("/settings", json={"anthropic_api_key": "sk-ant-prueba"})
            r = await c.post("/chat", json={"message": "crea un vídeo"})
            assert r.status_code == 200
            enviadas = [t["name"] for t in fake.requests[0].get("tools", [])]
            assert not [n for n in enviadas if n.startswith("video_")]
            resultados = [e for e in (json.loads(l[5:]) for l in r.text.splitlines() if l.startswith("data:")) if e["type"] == "tool_result"]
            assert len(resultados) == 2  # cada tool inventada recibe un resultado (error), sin ejecutarse
    assert llamadas == []
    assert not (tmp_path / "proyectos").exists()


# ------------------------------------------------------------ contra el motor real
# PUERTA de la frontera: el esquema `.strict()` es del motor, no del backend. Estos son los únicos
# tests de `proto`, `límites`, `ruta` y `proyecto_manipulado` que cuentan como cobertura real.


def _motor_real_o_saltar():
    if (DIST / "index.js").exists() and MOTOR_REAL_COMPILADO:
        return
    if os.environ.get("VIDEO_ENGINE_R1") == "1":
        pytest.fail("VIDEO_ENGINE_R1=1 y falta video-mcp-server/dist (o node): la puerta no puede saltarse")
    pytest.skip("npm run build en video-mcp-server (sin dist/ no hay motor real)")


@pytest.fixture
async def real(tmp_path, fake_anthropic, monkeypatch):
    _motor_real_o_saltar()
    app = await _api_con_motor(tmp_path, fake_anthropic, monkeypatch, ["node", str(DIST / "index.js")])
    monkeypatch.setenv("VIDEO_STATE_DIR", str(tmp_path / "estado"))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=AUTH) as c,
    ):
            c.app = app
            c.raiz = tmp_path / "proyectos"
            yield c


def _guion_real(**extra) -> dict:
    return {
        "version": 1,
        "titulo": "Prueba",
        "gancho": "Un gancho claro",
        "escenas": [_escena_real()],
        "opciones": {"fondo": "ninguno", "look": "normal", "subtitulos": "karaoke", "destellos": []},
        **extra,
    }


def _escena_real(frase: str = "Primera frase corta.", texto: str = "Hola", **base) -> dict:
    return {"frases": [frase], "base": {"tipo": "cartel", "texto": texto, **base}}


def _codigos(r) -> set[str]:
    return {p["codigo"] for p in r.json()["detail"]["problemas"]}


async def test_real_esquema_y_tools_de_t4(real):
    assert (await real.get("/video/guiones/esquema")).json()["texto"]
    r = await real.post("/video/guiones", json={"guion": _guion_real()})
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    assert (await real.get(f"/video/guiones/{gid}")).status_code == 200


async def test_real_proto_rechazado(real):
    cuerpo = '{"guion": {"__proto__": {"x": 1}, "version": 1, "titulo": "x", "gancho": "y", "escenas": [], "opciones": {}}}'
    r = await real.post("/video/guiones", content=cuerpo, headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert "__proto__" not in r.text


async def test_real_ruta_en_cuerpo_422(real):
    r = await real.post("/video/guiones", json={"guion": _guion_real(ruta="C:\\Users\\Marc Serra\\x")})
    assert r.status_code == 422 and r.json()["detail"]["codigo"] == "esquema"
    _sin_rutas(r.text)


async def test_real_limites(real):
    r = await real.post("/video/guiones", json={"guion": _guion_real(escenas=[_escena_real()] * 91)})
    assert r.status_code == 422 and "too_big" in _codigos(r)
    r = await real.post("/video/guiones", json={"guion": _guion_real(titulo="a" * 100_000)})
    assert r.status_code == 422


async def _proyecto_real(c) -> str:
    gid = (await c.post("/video/guiones", json={"guion": _guion_real()})).json()["id"]
    r = await c.post("/video/proyectos", json={"guion_id": gid, "perfil_id": "defecto"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_real_proyecto_manipulado_422(real):
    pid = await _proyecto_real(real)
    leido = (await real.get(f"/video/proyectos/{pid}")).json()["proyecto"]
    assert leido["id"] == pid
    r = await real.put(f"/video/proyectos/{pid}", json={"revision": leido["revision"], "proyecto": leido})
    assert r.status_code == 200, r.text  # sin cambios: el motor lo acepta, así que los 422 de abajo son por la manipulación
    leido = (await real.get(f"/video/proyectos/{pid}")).json()["proyecto"]
    for cambio in ({"manipulado": True}, {"recursos": {"r-0123456789abcdef": {"ruta": "C:\\x"}}}, {"id": "video999"}):
        r = await real.put(f"/video/proyectos/{pid}", json={"revision": leido["revision"], "proyecto": {**leido, **cambio}})
        assert r.status_code == 422, (cambio, r.text)
        _sin_rutas(r.text)


async def test_real_url_en_texto_inerte(real):
    """Un texto con URL se rechaza con `url_en_texto` (T1): nunca llega a guardarse ni a la composición."""
    for campo in ("titulo", "gancho"):
        r = await real.post("/video/guiones", json={"guion": _guion_real(**{campo: "mira https://evil.example/x"})})
        assert r.status_code == 422 and "url_en_texto" in _codigos(r), r.text
    for escena in (
        _escena_real(frase="ve a http://evil.example"),
        _escena_real(texto="https://evil.example"),
        _escena_real(subtexto="javascript:alert(1)"),
    ):
        r = await real.post("/video/guiones", json={"guion": _guion_real(escenas=[escena])})
        assert r.status_code == 422 and "url_en_texto" in _codigos(r), r.text
    lista = await real.get("/video/guiones")
    assert lista.json() == {"guiones": []} and "evil.example" not in lista.text


XSS = "<img src=x onerror=alert(1)>"


async def test_real_xss_en_cada_campo_son_datos(real):
    """Guardar y cargar devuelven el texto como datos (JSON), sin tocarlo ni interpretarlo.

    Cada campo de texto del guion y del proyecto; la salida es `application/json` con CSP `sandbox`.
    """
    campos = {
        "titulo": _guion_real(titulo=XSS),
        "gancho": _guion_real(gancho=XSS),
        "frase": _guion_real(escenas=[_escena_real(frase=XSS)]),
        "cartel.texto": _guion_real(escenas=[_escena_real(texto=XSS)]),
        "cartel.subtexto": _guion_real(escenas=[_escena_real(subtexto=XSS)]),
        "etiqueta": _guion_real(opciones={"fondo": "ninguno", "look": "normal", "subtitulos": "karaoke", "destellos": [], "etiqueta": XSS}),
    }
    for campo, guion in campos.items():
        r = await real.post("/video/guiones", json={"guion": guion})
        if r.status_code == 422:  # T1 puede rechazar el texto: entonces nunca se guarda (también inerte)
            assert _codigos(r) & {"texto_inseguro", "url_en_texto"}, (campo, r.text)
            assert "<script" not in r.text
            continue
        assert r.status_code == 201, (campo, r.text)
        leido = await real.get(f"/video/guiones/{r.json()['id']}")
        assert leido.headers["content-type"].startswith("application/json")
        assert leido.headers["content-security-policy"] == CSP
        assert XSS in leido.text.replace("\\u003c", "<") or XSS in json.dumps(leido.json(), ensure_ascii=False)
    pid = await _proyecto_real(real)
    assert (await real.get(f"/video/proyectos/{pid}")).headers["content-type"].startswith("application/json")


@pytest.mark.skip(reason="Pendiente de T3: `_composicion/**` aún no se genera; aquí irá 'ningún <script> ni URL en la composición'")
async def test_real_xss_en_la_composicion():
    ...


# ------------------------------------------------------- R1 T1→T9 (N1, N2)


@pytest.mark.parametrize("texto", ["\\ud800", "a\\udfffb", "\\udc00\\ud800"])
async def test_sustituto_suelto_422_y_el_motor_sigue(api, texto):
    # N1: un sustituto UTF-16 suelto no se puede codificar en UTF-8 y tumbaba la sesión del motor.
    cuerpo = '{"guion": {"titulo": "' + texto + '"}}'
    r = await api.post("/video/guiones", content=cuerpo, headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert "\\ud8" not in r.text.lower() and "\\udc" not in r.text.lower()
    r = await api.post("/video/guiones", json={"guion": GUION})
    assert r.status_code == 201


async def test_sustituto_suelto_en_clave_422(api):
    cuerpo = '{"guion": {"\\ud800": 1}}'
    r = await api.post("/video/guiones", content=cuerpo, headers={"Content-Type": "application/json"})
    assert r.status_code == 422


@pytest.mark.parametrize("clase", ["MotorError", "MotorNoDisponible"])
async def test_capacidades_sin_rutas_en_errores(api, monkeypatch, clase):
    # N2: /video/capacidades reenviaba str(e) con rutas del usuario.
    async def roto(*a, **k):
        raise getattr(video, clase)("fallo en C:\\Users\\Marc Serra\\AppData\\Local\\x")

    monkeypatch.setattr(api.app.state.motor, "llamar", roto)
    r = await api.get("/video/capacidades")
    assert r.status_code in (502, 503)
    _sin_rutas(r.text)
