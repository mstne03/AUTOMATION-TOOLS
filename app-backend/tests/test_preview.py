"""Preview por capacidad (T10): origen propio, clave atada a (id, carpeta, creado), reserva de puertos.

La `_composicion/` real la genera T3 (todavía no está): los tests crean una de prueba y el motor
falso (`motor_falso.py`, `video_montar_preview`) solo dice cuál es la carpeta `r<n>`. La parte del
render real (WebGL del túnel sin «cross-origin data», `piezas-w24`) se valida en local.
Los tests de `SO_EXCLUSIVEADDRUSE` solo corren en Windows (job `backend-windows` de la CI).
"""

import asyncio
import hashlib
import inspect
import json
import logging
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app_backend import config, preview
from app_backend.main import create_app
from app_backend.preview import Claves, Reserva
from tests.test_video import AUTH, TOKEN

MOTOR_FALSO = Path(__file__).with_name("motor_falso.py")
RAIZ_REPO = Path(__file__).resolve().parents[2]
PUERTO = 47810
ORIGEN = f"http://127.0.0.1:{PUERTO}"
META = f'<meta http-equiv="Content-Security-Policy" content="{config.CSP_META_COMPOSICION}" />'
HTML = f'<!doctype html><html><head><meta charset="utf-8">{META}<title>x</title></head><body>ok</body></html>'
RUNTIME = b"/* runtime de prueba */ window.__player = {};"
CENTINELA = "CENTINELA-PROYECTO-JSON"
CAB = ("content-security-policy", "x-content-type-options", "cache-control", "referrer-policy")


def _libres(n: int) -> tuple[int, ...]:
    socks = [socket.socket() for _ in range(n)]
    try:
        for s in socks:
            s.bind(("127.0.0.1", 0))
        return tuple(s.getsockname()[1] for s in socks)
    finally:
        for s in socks:
            s.close()


# ------------------------------------------------------------------ fixtures


@pytest.fixture
async def api(tmp_path, fake_anthropic, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.setenv("APP_BACKEND_VIDEO_CMD", json.dumps([sys.executable, str(MOTOR_FALSO)]))
    raiz = tmp_path / "proyectos"
    raiz.mkdir()
    monkeypatch.setattr(config, "VIDEO_ROOT", raiz, raising=False)
    motor = tmp_path / "motor"  # runtime de prueba con el hash fijado en la config
    runtime = motor / "node_modules" / "hyperframes" / "dist" / "hyperframe.runtime.iife.js"
    runtime.parent.mkdir(parents=True)
    runtime.write_bytes(RUNTIME)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", motor)
    monkeypatch.setattr(config, "RUNTIME_SHA256", hashlib.sha256(RUNTIME).hexdigest())
    app = create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
        reserva_preview=Reserva(sockets=[], puertos=(PUERTO,), ajenos=()),
    )
    async with app.router.lifespan_context(app):
        transporte = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transporte, base_url="http://test", headers=AUTH) as c:
            c.app = app
            c.raiz = raiz
            c.runtime = runtime
            yield c


@pytest.fixture
async def previa(api):
    """Cliente contra la app de la preview (puerto 47810), con las claves y el runtime de `api`."""
    prev = preview.crear_app(api.app.state.claves, PUERTO, api.app.state.runtime)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=prev), base_url=ORIGEN) as c:
        yield c


async def _proyecto(api) -> str:
    r = await api.post("/video/guiones", json={"guion": {"version": 1, "titulo": "P", "gancho": "g", "escenas": [], "opciones": {}}})
    r = await api.post("/video/proyectos", json={"guion_id": r.json()["id"], "perfil_id": "defecto"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


CREADO = "2026-11-07T10:00:00.000Z"  # el que devuelve el motor falso por defecto


def _fijar_creado(api, pid: str, creado: str) -> None:
    """Simula un `proyecto.json` con otro `creado` (id reutilizado) en el disco y en el motor falso."""
    (api.raiz / pid / "proyecto.json").write_text(json.dumps({"creado": creado, "centinela": CENTINELA}), encoding="utf-8")
    (api.raiz / pid / "creado.txt").write_text(creado, encoding="utf-8")


def _componer(api, pid: str, carpeta: str = "r1") -> Path:
    """Crea una `_composicion/<carpeta>/` de prueba (la real la genera T3)."""
    comp = api.raiz / pid / "_composicion"
    r = comp / carpeta
    (r / "assets").mkdir(parents=True)
    (r / "index.html").write_text(HTML, encoding="utf-8")
    (r / "assets" / "a.js").write_text("export const a = 1;", encoding="utf-8")
    (r / "assets" / "foto.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    (r / "datos.json").write_text("{}", encoding="utf-8")
    (comp / "fuera.js").write_text("// hermano de r1", encoding="utf-8")
    (comp / "montar.json").write_text(json.dumps({"carpeta": carpeta}), encoding="utf-8")
    _fijar_creado(api, pid, CREADO)
    (api.raiz / pid / "voz").mkdir()
    (api.raiz / pid / "voz" / "f.mp3").write_bytes(b"voz")
    (api.raiz / pid / "recursos").mkdir()
    (api.raiz / pid / "recursos" / "x.png").write_bytes(b"recurso")
    return r


async def _abrir(api, pid: str | None = None, **cuerpo) -> tuple[str, str]:
    """Crea (si hace falta) proyecto y composición, abre la preview y devuelve `(id, clave)`."""
    pid = pid or await _proyecto(api)
    if not (api.raiz / pid / "_composicion").exists():
        _componer(api, pid)
    r = await api.post(f"/video/proyectos/{pid}/preview", json=cuerpo)
    assert r.status_code == 200, r.text
    m = re.fullmatch(rf"http://127\.0\.0\.1:{PUERTO}/p/([A-Za-z0-9_-]{{43}})/index\.html", r.json()["url"])
    assert m, r.json()
    return pid, m.group(1)


def _cabeceras_ok(r: httpx.Response) -> None:
    for h in CAB:
        assert h in r.headers, h
    csp = r.headers["content-security-policy"]
    assert csp.startswith("sandbox allow-scripts; default-src 'none'; ")
    assert f"script-src {ORIGEN} 'unsafe-inline'" in csp and f"connect-src {ORIGEN}" in csp
    assert "frame-ancestors http://tauri.localhost https://tauri.localhost" in csp
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["referrer-policy"] == "no-referrer"


# ------------------------------------------------------------------- Claves


def test_claves_abrir_y_buscar():
    c = Claves()
    k = c.abrir("video001", "r1", "2026-11-07T10:00:00Z")
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", k)  # token_urlsafe(32)
    e = c.buscar(k)
    assert (e.id, e.carpeta, e.creado) == ("video001", "r1", "2026-11-07T10:00:00Z")
    assert c.buscar(k + "x") is None and c.buscar("") is None and c.buscar("clávé") is None


def test_claves_una_por_proyecto_y_misma_terna_misma_clave():
    c = Claves()
    k1 = c.abrir("video001", "r1", "t")
    assert c.abrir("video001", "r1", "t") == k1
    k2 = c.abrir("video001", "r2", "t")  # otra carpeta: otra clave y la anterior deja de valer
    assert k2 != k1 and c.buscar(k1) is None and c.buscar(k2).carpeta == "r2"


def test_id_reutilizado_no_hereda_la_clave():
    """R0-5: `siguienteId` reutiliza `video001` tras borrarlo; su `creado` es otro."""
    c = Claves()
    vieja = c.abrir("video001", "r1", "2026-11-07T10:00:00Z")
    nueva = c.abrir("video001", "r1", "2026-11-08T09:00:00Z")
    assert nueva != vieja and c.buscar(vieja) is None
    assert c.buscar(nueva).creado == "2026-11-08T09:00:00Z"


def test_rotar_invalida_la_anterior_y_se_ata_a_la_terna():
    c = Claves()
    k = c.abrir("video001", "r1", "t")
    n = c.rotar("video001", "r1", "t")
    assert n != k and c.buscar(k) is None and c.buscar(n).id == "video001"
    m = c.rotar("video001", "r2", "u")
    e = c.buscar(m)
    assert (e.carpeta, e.creado) == ("r2", "u") and c.buscar(n) is None
    assert c.rotar("video009", "r1", "t")  # rotar sin clave previa también abre


def test_cerrar_invalida():
    c = Claves()
    k = c.abrir("video001", "r1", "t")
    c.cerrar("video001")
    c.cerrar("video001")  # idempotente
    assert c.buscar(k) is None


def test_buscar_recorre_todas_con_compare_digest(monkeypatch):
    c = Claves()
    claves = [c.abrir(f"video00{i}", "r1", "t") for i in range(1, 5)]
    llamadas = []
    real = preview.secrets.compare_digest
    monkeypatch.setattr(preview.secrets, "compare_digest", lambda a, b: llamadas.append(1) or real(a, b))
    assert c.buscar(claves[0]).id == "video001"  # la primera: aun así recorre las cuatro
    assert len(llamadas) == 4
    llamadas.clear()
    assert c.buscar("x" * 43) is None and len(llamadas) == 4


def test_reiniciar_invalida():
    k = Claves().abrir("video001", "r1", "t")
    assert Claves().buscar(k) is None  # un backend nuevo parte sin claves


# ------------------------------------------------ puertos fijos y reserva (R0-7)


def test_puertos_preview_fijos():
    assert config.PUERTOS_PREVIEW == (47810, 47811, 47812, 47813)


TAURI = RAIZ_REPO / "app-ui" / "src-tauri"
LOOPBACK = "http://127.0.0.1:"


def _directivas(clave: str) -> dict[str, list[str]]:
    conf = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    csp = conf["app"]["security"][clave]
    partes = [d.split() for d in (x.strip() for x in csp.split(";")) if d]
    nombres = [d[0].lower() for d in partes]
    # Chromium aplica la PRIMERA directiva repetida: un duplicado podría esconder un comodín.
    assert len(nombres) == len(set(nombres)), f"{clave}: directivas repetidas: {nombres}"
    return {d[0]: d[1:] for d in partes}


@pytest.mark.parametrize("clave", ["csp", "devCsp"])
def test_frame_src_sin_comodin(clave):
    fuentes = _directivas(clave).get("frame-src")
    assert fuentes, f"{clave} sin frame-src"
    for f in fuentes:
        assert re.fullmatch(r"http://127\.0\.0\.1:\d{5}", f), f"{clave}: frame-src no exacto: {f}"


@pytest.mark.parametrize("clave", ["csp", "devCsp"])
def test_puertos_coinciden_con_frame_src(clave):
    fuentes = _directivas(clave)["frame-src"]
    assert len(fuentes) == len(set(fuentes))
    assert tuple(sorted(int(f.rsplit(":", 1)[1]) for f in fuentes)) == config.PUERTOS_PREVIEW


@pytest.mark.parametrize("clave", ["csp", "devCsp"])
def test_connect_src_y_frame_src_solo_loopback(clave):
    d = _directivas(clave)
    permitido_connect = {"ipc:", "http://ipc.localhost", "http://localhost:1420", "ws://localhost:1420"}
    for f in d["connect-src"]:
        assert f in permitido_connect or f.startswith(LOOPBACK), f"{clave}: connect-src admite {f}"
    assert "*" not in d["connect-src"] and "http:" not in d["connect-src"]
    assert not any(f.startswith(("*", "http:", "https:", "data:", "blob:")) and not f.startswith(LOOPBACK) for f in d["frame-src"])
    # default-src no abre nada más que el propio origen (y el servidor de Vite en desarrollo).
    assert set(d["default-src"]) <= {"'self'", "http://localhost:1420"}


def test_capacidades_sin_cambios():
    ficheros = sorted(p.name for p in (TAURI / "capabilities").glob("*"))
    assert ficheros == ["default.json"]
    cap = json.loads((TAURI / "capabilities" / "default.json").read_text(encoding="utf-8"))
    assert cap["permissions"] == ["core:default"]


def test_webrtc_sin_fuga_ip_local():
    conf = json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))
    args = conf["app"]["windows"][0]["additionalBrowserArgs"].split()
    assert "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection" in args  # valores por defecto de Tauri
    assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in args


def test_reserva_cuatro_puertos():
    puertos = _libres(4)
    r = preview.reservar_puertos(puertos)
    try:
        assert r.puertos == puertos and r.ajenos == () and r.servicio == puertos[0]
        assert len(r.sockets) == 4
        for s, p in zip(r.sockets, puertos, strict=True):
            assert s.getsockname() == ("127.0.0.1", p)
            with socket.create_connection(("127.0.0.1", p), timeout=2):  # escuchan de verdad
                pass
    finally:
        r.cerrar()


def test_reserva_por_defecto_usa_la_lista_fija():
    assert inspect.signature(preview.reservar_puertos).parameters["puertos"].default == config.PUERTOS_PREVIEW


def test_segundo_bind_falla():
    puertos = _libres(4)
    r = preview.reservar_puertos(puertos)
    try:
        for p in puertos:
            intruso = socket.socket()
            try:
                intruso.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # el intruso intenta robarlo
                with pytest.raises(OSError):
                    intruso.bind(("127.0.0.1", p))
            finally:
                intruso.close()
    finally:
        r.cerrar()


def test_la_reserva_nunca_usa_la_opcion_de_reutilizacion():
    assert "SO_REUSEADDR" not in inspect.getsource(preview)
    puertos = _libres(1)
    r = preview.reservar_puertos(puertos)
    try:
        assert r.sockets[0].getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR) == 0
    finally:
        r.cerrar()


@pytest.mark.skipif(sys.platform != "win32", reason="SO_EXCLUSIVEADDRUSE solo existe en Windows")
def test_reserva_exclusiva_en_windows():
    puertos = _libres(4)
    r = preview.reservar_puertos(puertos)
    try:
        for s in r.sockets:
            assert s.getsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE) == 1
    finally:
        r.cerrar()


@pytest.mark.skipif(sys.platform != "win32", reason="SO_EXCLUSIVEADDRUSE solo existe en Windows")
def test_segundo_bind_exclusivo_y_con_reuseaddr_fallan_en_windows():
    (p,) = _libres(1)
    r = preview.reservar_puertos((p,))
    try:
        for opcion in (None, socket.SO_REUSEADDR, socket.SO_EXCLUSIVEADDRUSE):
            intruso = socket.socket()
            try:
                if opcion is not None:
                    intruso.setsockopt(socket.SOL_SOCKET, opcion, 1)
                with pytest.raises(OSError):
                    intruso.bind(("127.0.0.1", p))
            finally:
                intruso.close()
    finally:
        r.cerrar()


def test_puerto_ajeno_se_marca_y_la_preview_sirve_en_el_que_haya():
    puertos = _libres(4)
    ajeno = socket.socket()
    ajeno.bind(("127.0.0.1", puertos[0]))
    ajeno.listen(1)
    r = preview.reservar_puertos(puertos)
    try:
        assert r.ajenos == (puertos[0],) and r.puertos == puertos[1:] and r.servicio == puertos[1]
        assert len(r.sockets) == 3
    finally:
        r.cerrar()
        ajeno.close()


def test_sin_ningun_puerto_no_hay_servicio():
    puertos = _libres(2)
    ajenos = [socket.socket() for _ in puertos]
    for s, p in zip(ajenos, puertos, strict=True):
        s.bind(("127.0.0.1", p))
        s.listen(1)
    r = preview.reservar_puertos(puertos)
    try:
        assert r.servicio is None and r.sockets == [] and r.ajenos == puertos
    finally:
        r.cerrar()
        for s in ajenos:
            s.close()


def test_api_fuera_de_lista():
    """Si el SO diera a la API un puerto de la lista, se vuelve a vincular."""
    prohibidos = (47810, 47811)
    entregados: list[int] = []
    puertos = iter([47811, 47810, 0])

    def crear() -> socket.socket:
        s = socket.socket()
        s.bind(("127.0.0.1", next(puertos) or 0))
        entregados.append(s.getsockname()[1])
        return s

    try:
        s = preview.vincular_api(prohibidos, crear)
    except OSError:
        pytest.skip("puerto de la lista ocupado en esta máquina")
    try:
        assert s.getsockname()[1] not in prohibidos and len(entregados) == 3
    finally:
        s.close()


def test_api_fuera_de_lista_se_rinde_si_no_hay_otro():
    class Siempre:
        def getsockname(self):
            return ("127.0.0.1", 47810)

        def close(self):
            pass

    with pytest.raises(RuntimeError):
        preview.vincular_api((47810,), lambda: Siempre(), intentos=3)


def test_servidor_sin_log_de_acceso():
    cfg = preview.config_servidor(FastAPI())
    assert cfg.access_log is False and cfg.log_level == "info"


# ------------------------------------------------------------ despachar (ASGI)


async def _cliente(app, puerto: int):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=f"http://127.0.0.1:{puerto}")


async def test_api_no_responde_en_puerto_preview_y_al_reves():
    api = FastAPI()

    @api.get("/ping")
    def ping():
        return {"api": True}

    claves = Claves()
    clave = claves.abrir("video001", "r1", "t")
    disp = preview.despachar(api, {PUERTO: preview.crear_app(claves, PUERTO, preview.Runtime())})
    async with await _cliente(disp, 50000) as c:  # puerto de la API
        assert (await c.get("/ping")).json() == {"api": True}
        r = await c.get(f"/p/{clave}/index.html")
        assert r.status_code == 404 and r.json() == {"detail": "Not Found"}  # la ruta de la preview no existe aquí
    async with await _cliente(disp, PUERTO) as c:  # puerto de la preview
        r = await c.get("/ping")
        assert r.status_code == 404 and "allow-scripts" in r.headers["content-security-policy"]
        assert "api" not in r.text


async def test_puertos_de_reserva_responden_404_con_su_csp():
    puertos = (47810, 47811)
    disp = preview.despachar(FastAPI(), {47810: preview.crear_app(Claves(), 47810, preview.Runtime()), 47811: preview.app_reserva(47811)})
    async with await _cliente(disp, puertos[1]) as c:
        for ruta in ("/", "/p/abc/index.html", "/ping"):
            r = await c.get(ruta)
            assert r.status_code == 404
            assert "connect-src http://127.0.0.1:47811" in r.headers["content-security-policy"]
            assert r.headers["x-content-type-options"] == "nosniff"


async def test_despachar_reenvia_lifespan_a_la_api():
    vistos = []

    async def api(scope, receive, send):
        vistos.append(scope["type"])
        if scope["type"] == "lifespan":
            await receive()
            await send({"type": "lifespan.startup.complete"})

    disp = preview.despachar(api, {})
    mensajes = iter([{"type": "lifespan.startup"}])
    enviados = []

    async def recibir():
        return next(mensajes)

    async def enviar(m):
        enviados.append(m["type"])

    await disp({"type": "lifespan"}, recibir, enviar)
    assert vistos == ["lifespan"] and enviados == ["lifespan.startup.complete"]


# ------------------------------------------------------- POST …/preview (REST)


async def test_post_preview_devuelve_url_con_clave(api, previa):
    pid, clave = await _abrir(api)
    r = await previa.get(f"/p/{clave}/index.html")
    assert r.status_code == 200 and "ok" in r.text
    assert api.app.state.claves.buscar(clave).id == pid


async def test_post_preview_exige_bearer_y_forma_de_id(api):
    sin = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test")
    async with sin:
        assert (await sin.post("/video/proyectos/video001/preview", json={})).status_code == 401
        assert (await sin.delete("/video/proyectos/video001/preview")).status_code == 401
    assert (await api.post("/video/proyectos/..%5Cx/preview", json={})).status_code == 404
    assert (await api.post("/video/proyectos/video777/preview", json={})).status_code == 404


async def test_post_preview_cuerpo_con_ruta_422(api):
    pid = await _proyecto(api)
    _componer(api, pid)
    assert (await api.post(f"/video/proyectos/{pid}/preview", json={"ruta": "C:\\x"})).status_code == 422
    assert (await api.post(f"/video/proyectos/{pid}/preview", json={"webgpu": "si"})).status_code == 422


async def test_post_preview_sin_cuerpo_vale(api):
    pid = await _proyecto(api)
    _componer(api, pid)
    assert (await api.post(f"/video/proyectos/{pid}/preview")).status_code == 200


async def test_post_preview_rota_la_clave(api, previa):
    pid, k1 = await _abrir(api)
    _, k2 = await _abrir(api, pid)
    assert k1 != k2
    assert (await previa.get(f"/p/{k1}/index.html")).status_code == 404
    assert (await previa.get(f"/p/{k2}/index.html")).status_code == 200


async def test_cerrar_el_editor_invalida(api, previa):
    pid, clave = await _abrir(api)
    assert (await api.delete(f"/video/proyectos/{pid}/preview")).json() == {}
    assert (await previa.get(f"/p/{clave}/index.html")).status_code == 404  # clave_cerrada_404


async def test_borrar_el_proyecto_invalida_la_clave(api, previa):
    pid, clave = await _abrir(api)
    assert (await api.delete(f"/video/proyectos/{pid}")).status_code == 200
    r = await previa.get(f"/p/{clave}/index.html")
    assert r.status_code == 404
    _cabeceras_ok(r)


async def test_id_reutilizado_en_rest_no_hereda(api, previa):
    pid, vieja = await _abrir(api)
    _fijar_creado(api, pid, "2030-01-01T00:00:00.000Z")  # otro `creado`
    _, nueva = await _abrir(api, pid)
    assert nueva != vieja and api.app.state.claves.buscar(vieja) is None
    assert api.app.state.claves.buscar(nueva).creado == "2030-01-01T00:00:00.000Z"


async def test_carpeta_del_motor_con_forma_mala_es_502(api):
    pid = await _proyecto(api)
    _componer(api, pid)
    (api.raiz / pid / "_composicion" / "montar.json").write_text('{"carpeta": "../x"}', encoding="utf-8")
    r = await api.post(f"/video/proyectos/{pid}/preview", json={})
    assert r.status_code == 502 and ".." not in r.text and str(api.raiz) not in r.text


async def test_sin_puerto_libre_503_legible(api):
    api.app.state.reserva_preview = Reserva(sockets=[], puertos=(), ajenos=(47810, 47811, 47812, 47813))
    pid = await _proyecto(api)
    _componer(api, pid)
    r = await api.post(f"/video/proyectos/{pid}/preview", json={})
    assert r.status_code == 503 and r.json()["detail"] == {"mensaje": preview.MENSAJE_SIN_PUERTO, "codigo": "no_disponible"}
    assert "ocupados" in preview.MENSAJE_SIN_PUERTO


async def test_puerto_ajeno_avisa(api, caplog):
    api.app.state.reserva_preview = Reserva(sockets=[], puertos=(PUERTO,), ajenos=(47811, 47812))
    pid = await _proyecto(api)
    _componer(api, pid)
    with caplog.at_level(logging.WARNING):
        r = await api.post(f"/video/proyectos/{pid}/preview", json={})
    assert r.status_code == 200
    assert {"codigo": "puertos_preview_ajenos", "puertos": [47811, 47812]} in r.json()["avisos"]
    assert "puertos_preview_ajenos" in caplog.text and "47811" in caplog.text
    # sin ajenos, el aviso no sale
    api.app.state.reserva_preview = Reserva(sockets=[], puertos=(PUERTO,), ajenos=())
    r = await api.post(f"/video/proyectos/{pid}/preview", json={})
    assert all(a["codigo"] != "puertos_preview_ajenos" for a in r.json()["avisos"])


async def test_respuesta_de_preview_no_lleva_rutas(api):
    pid = await _proyecto(api)
    _componer(api, pid)
    cuerpo = (await api.post(f"/video/proyectos/{pid}/preview", json={})).text
    assert str(api.raiz) not in cuerpo and "_composicion" not in cuerpo
    assert set(json.loads(cuerpo)) <= {"url", "avisos", "duracion"}


# ------------------------------------------------------- seguridad de la ruta


async def test_cabeceras_en_toda_respuesta(api, previa):
    _, clave = await _abrir(api)
    for r in (
        await previa.get(f"/p/{clave}/index.html"),  # 200 html
        await previa.get(f"/p/{clave}/assets/a.js"),  # 200 fichero
        await previa.get(f"/p/{clave}/nada.js"),  # 404
        await previa.get("/p/mala/index.html"),  # 404 por clave
        await previa.get("/otra-ruta"),  # 404 sin ruta
        await previa.get(f"/p/{clave}/index.html", headers={"Host": "evil.test"}),  # 421
        await previa.post(f"/p/{clave}/index.html"),  # 405
    ):
        _cabeceras_ok(r)


async def test_html_inyecta_tras_el_meta_y_reescribe_self(api, previa):
    _, clave = await _abrir(api)
    html = (await previa.get(f"/p/{clave}/index.html")).text
    scripts = '<script src="__preview/runtime.js"></script><script src="__preview/control.js"></script>'
    m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)" />', html)
    assert m and html[m.end() :].startswith(scripts)  # justo después del <meta> (W1.2 M3)
    assert "'self'" not in m.group(1)
    assert f"script-src {ORIGEN} 'unsafe-inline'" in m.group(1) and f"connect-src {ORIGEN}" in m.group(1)
    assert m.group(1) == config.CSP_META_COMPOSICION.replace("'self'", ORIGEN)
    assert html.count("__preview/runtime.js") == 1


@pytest.mark.parametrize(
    "html",
    [
        "<html><head></head><body></body></html>",  # sin meta
        f"<html><head>{META}{META}</head></html>",  # dos metas
        '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>',  # otra política
    ],
)
async def test_meta_csp_unica(api, previa, html):
    pid, clave = await _abrir(api)
    (api.raiz / pid / "_composicion" / "r1" / "index.html").write_text(html, encoding="utf-8")
    r = await previa.get(f"/p/{clave}/index.html")
    assert r.status_code == 503 and "__preview" not in r.text
    _cabeceras_ok(r)


async def test_sirve_con_content_type_por_extension(api, previa):
    _, clave = await _abrir(api)
    esperado = {"assets/a.js": "text/javascript", "assets/foto.png": "image/png", "datos.json": "application/json"}
    for ruta, tipo in esperado.items():
        r = await previa.get(f"/p/{clave}/{ruta}")
        assert r.status_code == 200 and r.headers["content-type"].split(";")[0] == tipo, ruta
    r = await previa.get(f"/p/{clave}/index.html")
    assert r.headers["content-type"].startswith("text/html")
    assert (await previa.get(f"/p/{clave}/")).status_code == 200  # ruta vacía = index.html
    r = await previa.head(f"/p/{clave}/assets/a.js")
    assert r.status_code == 200 and r.content == b"" and "content-security-policy" in r.headers


async def test_range_en_medios(api, previa):
    _, clave = await _abrir(api)
    r = await previa.get(f"/p/{clave}/assets/foto.png", headers={"Range": "bytes=0-3"})
    assert r.status_code == 206 and r.content == b"\x89PNG"


async def test_clave_mala_404_con_csp(api, previa):
    await _abrir(api)
    for clave in ("x" * 43, "", "clávé", "%00", "A" * 500):
        r = await previa.get(f"/p/{clave}/index.html")
        assert r.status_code == 404, clave
        _cabeceras_ok(r)


async def test_clave_de_otro_proyecto(api, previa):
    p1, k1 = await _abrir(api)
    p2 = await _proyecto(api)
    r2 = _componer(api, p2)
    (r2 / "propio.js").write_text("// solo del proyecto 2", encoding="utf-8")
    assert p1 != p2
    assert (await previa.get(f"/p/{k1}/propio.js")).status_code == 404
    for ruta in (f"..%2f..%2f{p2}%2f_composicion%2fr1%2fpropio.js", f"%2e%2e/%2e%2e/{p2}/_composicion/r1/propio.js"):
        assert (await previa.get(f"/p/{k1}/{ruta}")).status_code == 404


@pytest.mark.parametrize(
    "ruta",
    [
        "..%2fproyecto.json",
        "%2e%2e/proyecto.json",
        "assets/%2e%2e/%2e%2e/proyecto.json",
        "assets%5c..%5c..%5cproyecto.json",
        "..%5cproyecto.json",
        "%2fetc%2fpasswd",
        "C:/x",
        "C%3A/Windows/win.ini",
        "C%3Ax.js",
        "index.html::$DATA",
        "index.html%3a%3a%24DATA",
        "assets/a.js:stream",
        "CON",
        "con.js",
        "NUL.html",
        "assets/AUX.png",
        "assets/COM1.json",
        "lpt9.css",
        "a%00b.js",
        "assets//a.js",
        "assets/%2e/a.js",
        "index.html.",
        "index.html%20",
        "assets/a.js%2e",
        "ASSETS~1/a.js",
        "__preview/otro.js",
        "__preview",
        "__preview/",
        "assets/",
    ],
)
async def test_recorrido_y_codificado(api, previa, ruta):
    _, clave = await _abrir(api)
    r = await previa.get(f"/p/{clave}/{ruta}")
    assert r.status_code == 404, ruta
    assert CENTINELA not in r.text and "recurso" not in r.text
    _cabeceras_ok(r)


async def test_fuera_de_composicion_404(api, previa):
    _, clave = await _abrir(api)
    for ruta in ("proyecto.json", "voz/f.mp3", "recursos/x.png", "fuera.js", "montar.json", "r1/index.html"):
        r = await previa.get(f"/p/{clave}/{ruta}")
        assert r.status_code == 404, ruta
        assert CENTINELA not in r.text
        _cabeceras_ok(r)


async def test_extension_fuera_de_lista(api, previa):
    pid, clave = await _abrir(api)
    r1 = api.raiz / pid / "_composicion" / "r1"
    for nombre in ("a.exe", "a.py", "datos.sqlite", "sinext", "a.html.bak", "a.js.exe", "a.dll", "a.bat"):
        (r1 / nombre).write_bytes(b"contenido")
        r = await previa.get(f"/p/{clave}/{nombre}")
        assert r.status_code == 404, nombre
        _cabeceras_ok(r)


def _enlace_a_dir(destino: Path, origen: Path) -> None:
    try:
        origen.symlink_to(destino, target_is_directory=True)
    except OSError:
        pytest.skip("sin permiso para crear enlaces simbólicos")


async def test_junction_dentro_rechazada(api, previa, tmp_path):
    pid, clave = await _abrir(api)
    fuera = tmp_path / "fuera"
    fuera.mkdir()
    (fuera / "secreto.json").write_text(CENTINELA, encoding="utf-8")
    r1 = api.raiz / pid / "_composicion" / "r1"
    _enlace_a_dir(fuera, r1 / "enlace")
    r = await previa.get(f"/p/{clave}/enlace/secreto.json")
    assert r.status_code == 404 and CENTINELA not in r.text
    _cabeceras_ok(r)
    try:
        (r1 / "suelto.json").symlink_to(fuera / "secreto.json")
    except OSError:
        pytest.skip("sin permiso para crear enlaces simbólicos")
    assert (await previa.get(f"/p/{clave}/suelto.json")).status_code == 404


async def test_la_propia_carpeta_enlazada_se_rechaza(api, previa, tmp_path):
    pid, clave = await _abrir(api)
    comp = api.raiz / pid / "_composicion"
    real = tmp_path / "otra-r1"
    shutil.copytree(comp / "r1", real)
    shutil.rmtree(comp / "r1")
    _enlace_a_dir(real, comp / "r1")
    assert (await previa.get(f"/p/{clave}/index.html")).status_code == 404


async def test_host_rebinding_421(api, previa):
    _, clave = await _abrir(api)
    for host in ("evil.test", "evil.test:47810", "localhost:47810", "127.0.0.1", "127.0.0.1:47811", "127.0.0.1:47810.evil.test", ""):
        r = await previa.get(f"/p/{clave}/index.html", headers={"Host": host})
        assert r.status_code == 421, host
        _cabeceras_ok(r)
        assert "ok" not in r.text
    assert (await previa.get(f"/p/{clave}/index.html", headers={"Host": f"127.0.0.1:{PUERTO}"})).status_code == 200


async def test_post_405(api, previa):
    _, clave = await _abrir(api)
    for metodo in ("post", "put", "delete", "patch", "options"):
        r = await getattr(previa, metodo)(f"/p/{clave}/index.html")
        assert r.status_code == 405, metodo
        _cabeceras_ok(r)
        assert "access-control-allow-origin" not in r.headers  # y sin OPTIONS de CORS


async def test_sin_estrella_en_cors(api, previa):
    _, clave = await _abrir(api)
    for ruta in ("index.html", "assets/a.js", "assets/foto.png", "nada.js", "__preview/runtime.js"):
        for origen in (None, "null", "http://evil.test", "http://tauri.localhost", ORIGEN):
            h = {"Origin": origen} if origen else {}
            r = await previa.get(f"/p/{clave}/{ruta}", headers=h)
            assert r.headers.get("access-control-allow-origin") != "*"
            assert "access-control-allow-credentials" not in r.headers
    r = await previa.get(f"/p/{clave}/assets/a.js", headers={"Origin": "null"})
    assert r.headers["access-control-allow-origin"] == "null" and r.headers["vary"] == "Origin"


async def test_origen_web_sin_cors(api, previa):
    _, clave = await _abrir(api)
    for origen in ("http://evil.test", "https://tauri.localhost", "http://localhost:1420", "Null", "nul"):
        r = await previa.get(f"/p/{clave}/assets/a.js", headers={"Origin": origen})
        assert r.status_code == 200 and "access-control-allow-origin" not in r.headers, origen
    r = await previa.get(f"/p/{clave}/assets/a.js")  # sin Origin
    assert "access-control-allow-origin" not in r.headers
    r = await previa.get("/p/mala/assets/a.js", headers={"Origin": "null"})  # clave inválida: nada
    assert r.status_code == 404 and "access-control-allow-origin" not in r.headers


# --------------------------------------------------------------- runtime (I4)


async def test_runtime_se_sirve_desde_memoria_verificado(api, previa):
    _, clave = await _abrir(api)
    r = await previa.get(f"/p/{clave}/__preview/runtime.js")
    assert r.status_code == 200 and r.content == RUNTIME and r.headers["content-type"].startswith("text/javascript")
    _cabeceras_ok(r)
    api.runtime.write_bytes(b"alert('otro')")  # tocarlo en disco después ya no cambia lo servido (R0-10)
    assert (await previa.get(f"/p/{clave}/__preview/runtime.js")).content == RUNTIME


async def test_runtime_alterado_503(api, previa):
    api.runtime.write_bytes(b"alert('alterado')")
    pid = await _proyecto(api)
    _componer(api, pid)
    r = await api.post(f"/video/proyectos/{pid}/preview", json={})  # se comprueba al abrir
    assert r.status_code == 503 and "alterado" not in r.text and str(api.runtime) not in r.text
    # y la ruta no sirve otro runtime aunque ya hubiera clave
    clave = api.app.state.claves.abrir(pid, "r1", "t")
    r = await previa.get(f"/p/{clave}/__preview/runtime.js")
    assert r.status_code == 503 and b"alterado" not in r.content
    _cabeceras_ok(r)


async def test_runtime_ausente_503(api, previa):
    api.runtime.unlink()
    pid = await _proyecto(api)
    _componer(api, pid)
    assert (await api.post(f"/video/proyectos/{pid}/preview", json={})).status_code == 503


def test_el_hash_fijado_es_el_del_runtime_del_repo():
    ruta = RAIZ_REPO / "video-mcp-server" / "node_modules" / "hyperframes" / "dist" / "hyperframe.runtime.iife.js"
    if not ruta.is_file():
        pytest.skip("node_modules del motor no instalado")
    assert hashlib.sha256(ruta.read_bytes()).hexdigest() == config.RUNTIME_SHA256


def test_ruta_del_runtime_congelado_y_de_desarrollo(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", tmp_path)
    monkeypatch.setattr(config, "FROZEN", False)
    assert preview.ruta_runtime() == tmp_path / "node_modules" / "hyperframes" / "dist" / "hyperframe.runtime.iife.js"
    monkeypatch.setattr(config, "FROZEN", True)
    assert preview.ruta_runtime() == tmp_path / "app" / "node_modules" / "hyperframes" / "dist" / "hyperframe.runtime.iife.js"


# ------------------------------------------------------------------ CSP / meta


def test_frame_ancestors_produccion(monkeypatch):
    monkeypatch.setattr(config, "FROZEN", True)
    prod = preview.cabecera_csp(PUERTO)
    assert "frame-ancestors http://tauri.localhost https://tauri.localhost" in prod and "localhost:1420" not in prod
    monkeypatch.setattr(config, "FROZEN", False)
    assert "frame-ancestors http://tauri.localhost https://tauri.localhost http://localhost:1420" in preview.cabecera_csp(PUERTO)


def test_csp_de_la_cabecera_completa():
    csp = preview.cabecera_csp(PUERTO)
    o = ORIGEN
    for parte in (
        "sandbox allow-scripts",
        "default-src 'none'",
        f"script-src {o} 'unsafe-inline'",
        f"style-src {o} 'unsafe-inline'",
        f"img-src {o} data: blob:",
        f"font-src {o} data:",
        f"media-src {o} blob:",
        f"connect-src {o}",
        "worker-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ):
        assert parte in csp, parte
    assert "*" not in csp and "'unsafe-eval'" not in csp and "allow-same-origin" not in csp


def test_la_constante_del_meta_es_la_que_emite_el_motor():
    plantilla = RAIZ_REPO / "video-mcp-server" / "plantilla" / "index.html"
    if not plantilla.is_file():
        pytest.skip("plantilla del motor ausente")
    m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)"', plantilla.read_text(encoding="utf-8"))
    assert m and m.group(1) == config.CSP_META_COMPOSICION


# ------------------------------------------------------------------ control.js


def test_control_js_solo_lleva_las_ordenes_de_la_preview():
    js = preview.CONTROL_JS
    for orden in ('"seek"', '"play"', '"pause"'):
        assert orden in js
    for fuera in ("medir", "fps(", "deriva", "estado"):
        assert fuera not in js
    for saliente in ("listo", "seek-hecho", "tiempo", "error"):
        assert f'"{saliente}"' in js
    assert "motivo" not in js and "err.message" not in js  # el error no lleva texto
    assert "e.source" in js and "innerHTML" not in js and "eval(" not in js


def test_control_js_limita_tiempo_a_30_por_segundo():
    assert re.search(r"1000\s*/\s*30|\b33\b", preview.CONTROL_JS)


@pytest.mark.skipif(shutil.which("node") is None, reason="sin node")
def test_control_js_es_javascript_valido(tmp_path):
    f = tmp_path / "control.js"
    f.write_text(preview.CONTROL_JS, encoding="utf-8")
    r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True, timeout=30, check=False)
    assert r.returncode == 0, r.stderr


# ------------------------------------------------------------------------ logs


async def test_clave_no_en_logs(api, previa, caplog, capfd):
    caplog.set_level(logging.DEBUG)
    pid, clave = await _abrir(api)
    for ruta in ("index.html", "assets/a.js", "nada.js", "__preview/runtime.js", "__preview/control.js", "..%2fproyecto.json"):
        await previa.get(f"/p/{clave}/{ruta}")
    await previa.get(f"/p/{clave}/index.html", headers={"Host": "evil.test"})
    await previa.post(f"/p/{clave}/index.html")
    await api.delete(f"/video/proyectos/{pid}/preview")
    await previa.get(f"/p/{clave}/index.html")  # ya cerrada
    salida = capfd.readouterr()
    # El cliente de prueba (httpx) registra sus propias URLs: no es código del backend.
    propios = "\n".join(r.getMessage() for r in caplog.records if not r.name.startswith("httpx"))
    assert clave not in propios and clave not in salida.out and clave not in salida.err


def test_la_preview_no_registra_rutas():
    fuente = inspect.getsource(preview)
    assert "log.info" not in fuente and "access_log=False" in fuente


# ------------------------------------------------------- bucle de eventos propio


async def test_peticiones_concurrentes_no_se_pisan(api, previa):
    _, clave = await _abrir(api)
    rs = await asyncio.gather(*[previa.get(f"/p/{clave}/assets/a.js") for _ in range(20)])
    assert all(r.status_code == 200 and r.text == "export const a = 1;" for r in rs)


# ---------------------------------------------------- Low de la revisión de seguridad de T10


async def test_cerrar_durante_montaje_no_deja_clave(api, previa, monkeypatch):
    """DELETE …/preview espera al cerrojo del POST en vuelo: no queda una clave abierta en paralelo."""
    from collections import defaultdict

    from app_backend import video_rest

    # Los cerrojos son globales y un `Lock` disputado se ata al bucle de este test: uno propio, para no contaminar.
    monkeypatch.setattr(video_rest, "_cerrojos", defaultdict(asyncio.Lock))
    pid = await _proyecto(api)
    _componer(api, pid)
    empezado, soltar = asyncio.Event(), asyncio.Event()
    real = video_rest._llamar

    async def lenta(estado, nombre, args):
        if nombre == "video_montar_preview":
            empezado.set()
            await soltar.wait()
        return await real(estado, nombre, args)

    monkeypatch.setattr(video_rest, "_llamar", lenta)
    abrir = asyncio.create_task(api.post(f"/video/proyectos/{pid}/preview", json={}))
    await empezado.wait()
    cerrar = asyncio.create_task(api.delete(f"/video/proyectos/{pid}/preview"))
    await asyncio.sleep(0.05)  # el DELETE no debe haberse resuelto antes que el POST
    assert not cerrar.done()
    soltar.set()
    r_abrir, r_cerrar = await asyncio.gather(abrir, cerrar)
    assert r_abrir.status_code == 200 and r_cerrar.status_code == 200
    clave = re.search(r"/p/([A-Za-z0-9_-]{43})/", r_abrir.json()["url"]).group(1)
    assert (await previa.get(f"/p/{clave}/index.html")).status_code == 404
    assert api.app.state.claves.buscar(clave) is None


def test_cerrar_invalida_todas_las_claves_del_proyecto():
    """Requisito de T16: un cierre (también uno atrasado de una sesión vieja) no deja ninguna viva."""
    c = Claves()
    k1 = c.rotar("video001", "r1", "t")
    k2 = c.rotar("video001", "r2", "t")
    otra = c.rotar("video002", "r1", "t")
    c.cerrar("video001")
    assert c.buscar(k1) is None and c.buscar(k2) is None
    assert c.buscar(otra) is not None  # solo las del proyecto cerrado
    c.cerrar("video001")  # idempotente


async def test_cierre_atrasado_no_deja_claves_vivas(api, previa):
    pid, vieja = await _abrir(api)
    _, nueva = await _abrir(api, pid)
    assert (await api.delete(f"/video/proyectos/{pid}/preview")).status_code == 200  # el de la sesión vieja
    for k in (vieja, nueva):
        assert (await previa.get(f"/p/{k}/index.html")).status_code == 404


async def test_proyecto_recreado_con_otro_creado_no_sirve_y_cierra_la_clave(api, previa):
    pid, clave = await _abrir(api)
    assert (await previa.get(f"/p/{clave}/index.html")).status_code == 200
    # el proyecto desaparece y se recrea por fuera de REST: mismo id y carpeta, otro `creado`
    (api.raiz / pid / "proyecto.json").write_text(json.dumps({"creado": "2031-01-01T00:00:00.000Z"}), encoding="utf-8")
    r = await previa.get(f"/p/{clave}/index.html")
    assert r.status_code == 404
    _cabeceras_ok(r)
    assert api.app.state.claves.buscar(clave) is None  # la clave queda invalidada
    # aunque el `creado` volviera a coincidir, la clave ya no vale
    (api.raiz / pid / "proyecto.json").write_text(json.dumps({"creado": CREADO}), encoding="utf-8")
    assert (await previa.get(f"/p/{clave}/index.html")).status_code == 404


@pytest.mark.parametrize("contenido", [None, "no es json", "[]", '{"creado": 5}', "{}"])
async def test_proyecto_json_ilegible_o_sin_creado_404(api, previa, contenido):
    pid, clave = await _abrir(api)
    destino = api.raiz / pid / "proyecto.json"
    destino.unlink() if contenido is None else destino.write_text(contenido, encoding="utf-8")
    assert (await previa.get(f"/p/{clave}/index.html")).status_code == 404


async def test_ancestro_enlazado_es_404_y_no_500(api, previa, monkeypatch):
    from app_backend.navegador import NavegadorError

    _, clave = await _abrir(api)

    def enlazado():
        raise NavegadorError("La carpeta de estado es un enlace: C:\\secreto\\ruta")

    monkeypatch.setattr(preview, "comprobar_ancestros", enlazado)
    r = await previa.get(f"/p/{clave}/index.html")
    assert r.status_code == 404 and "secreto" not in r.text
    _cabeceras_ok(r)


def test_reserva_reintenta_los_puertos_ajenos_y_los_recupera():
    (p,) = _libres(1)
    ajeno = socket.socket()
    ajeno.bind(("127.0.0.1", p))
    esperas: list[float] = []

    def dormir(s: float) -> None:
        esperas.append(s)
        ajeno.close()  # el otro socket (TIME_WAIT, o un listener que cierra) libera el puerto

    r = preview.reservar_puertos((p,), reintentos=3, espera=0.01, dormir=dormir)
    try:
        assert r.puertos == (p,) and r.ajenos == () and len(esperas) == 1
    finally:
        r.cerrar()


def test_reserva_reintento_acotado_si_el_puerto_sigue_ocupado():
    (p,) = _libres(1)
    ajeno = socket.socket()
    ajeno.bind(("127.0.0.1", p))
    esperas: list[float] = []
    try:
        r = preview.reservar_puertos((p,), reintentos=3, espera=0.01, dormir=esperas.append)
        assert r.puertos == () and r.ajenos == (p,)
        assert len(esperas) == 3  # acotado: ni uno más
    finally:
        ajeno.close()


def test_reserva_sin_ajenos_no_espera():
    puertos = _libres(2)
    esperas: list[float] = []
    r = preview.reservar_puertos(puertos, dormir=esperas.append)
    try:
        assert esperas == [] and r.ajenos == ()
    finally:
        r.cerrar()


def test_reserva_el_reintento_total_es_corto():
    firma = inspect.signature(preview.reservar_puertos).parameters
    assert firma["reintentos"].default * firma["espera"].default <= 2.0


@pytest.mark.skipif(sys.platform != "win32", reason="SO_EXCLUSIVEADDRUSE solo existe en Windows")
def test_reabrir_con_conexion_aceptada_en_time_wait_en_windows():
    # TODO(Windows): medir si, tras cerrar la reserva con una conexión aceptada (TIME_WAIT), el
    # `bind` exclusivo vuelve a fallar y durante cuánto (la documentación de Winsock lo sugiere).
    # Esta prueba solo fija lo que sí debe cumplirse: con el reintento acotado, reservar nunca
    # lanza ni se queda esperando más de lo previsto, y los puertos que no vuelven quedan en `ajenos`.
    (p,) = _libres(1)
    primera = preview.reservar_puertos((p,))
    cliente = socket.create_connection(("127.0.0.1", p), timeout=2)
    aceptada, _ = primera.sockets[0].accept()
    aceptada.close()
    cliente.close()
    primera.cerrar()
    segunda = preview.reservar_puertos((p,), reintentos=2, espera=0.1)
    try:
        assert set(segunda.puertos) | set(segunda.ajenos) == {p}
    finally:
        segunda.cerrar()
