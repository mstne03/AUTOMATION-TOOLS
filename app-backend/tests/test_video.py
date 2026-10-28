"""`MotorVideo`: cliente MCP por stdio del motor de vídeo (motor falso en Python salvo el último test)."""

import asyncio
import ctypes
import logging
import shutil
import sys
from pathlib import Path

import anyio
import httpx
import pytest

from app_backend import config
from app_backend.main import create_app
from app_backend.video import (
    MotorError,
    MotorNoDisponible,
    MotorVideo,
    RespuestaMotor,
    comando_motor,
    entorno_motor,
)

TOKEN = "token-de-prueba"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
MOTOR_FALSO = Path(__file__).with_name("motor_falso.py")
CLAVE = "xi-clave-secreta-de-prueba"

_DIST_REAL = Path(__file__).resolve().parents[2] / "video-mcp-server" / "dist" / "index.js"
MOTOR_REAL_COMPILADO = _DIST_REAL.exists() and shutil.which("node") is not None


class StoreFalso:
    def __init__(self, datos: dict | None = None):
        self.datos = dict(datos or {})

    def get(self, clave):
        return self.datos.get(clave)


def psutil_pid_vivo(pid: int) -> bool:
    """¿Sigue vivo el proceso? En Windows os.kill(pid, 0) no sirve: OpenProcess + GetExitCodeProcess."""
    if sys.platform != "win32":
        import os

        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    kernel32 = ctypes.windll.kernel32
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return False
    try:
        codigo = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(h, ctypes.byref(codigo)):
            return False
        return codigo.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(h)


def _motor_falso(store: StoreFalso, cwd: Path | None = None, script: Path = MOTOR_FALSO) -> MotorVideo:
    return MotorVideo([sys.executable, str(script)], cwd or script.parent, lambda: entorno_motor(store))


@pytest.fixture
async def motor(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    m = _motor_falso(StoreFalso({config.ELEVENLABS_KEY: CLAVE}))
    yield m
    await m.cerrar()


@pytest.fixture
async def motor_con_store_vacio(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    m = _motor_falso(StoreFalso())
    yield m
    await m.cerrar()


async def test_llamada_devuelve_texto(motor):
    r = await motor.llamar("eco", {"texto": "hola"})
    assert isinstance(r, RespuestaMotor)
    assert r.texto == "hola"
    assert r.datos is None and r.imagen is None


async def test_arranque_perezoso(motor):
    assert motor.pid is None
    await motor.llamar("eco", {"texto": "x"})
    assert motor.pid is not None


async def test_arranque_concurrente_un_solo_proceso(motor):
    pids = await asyncio.gather(*(motor.llamar("pid") for _ in range(5)))
    assert len({p.texto for p in pids}) == 1


async def test_motor_muere_y_se_relanza(motor):
    antes = (await motor.llamar("pid")).texto
    with pytest.raises(MotorNoDisponible, match="se relanzará"):
        await motor.llamar("morir")
    assert (await motor.llamar("pid")).texto != antes
    assert not psutil_pid_vivo(int(antes))


async def test_timeout_de_llamada(motor):
    colgado = int((await motor.llamar("pid")).texto)
    with pytest.raises(MotorError, match="no respondió en 1 s"):
        await motor.llamar("dormir", {"segundos": 5}, timeout=1)
    assert (await motor.llamar("eco", {"texto": "sigue"})).texto == "sigue"
    assert int((await motor.llamar("pid")).texto) != colgado
    assert not psutil_pid_vivo(colgado)


async def test_error_de_tool_es_motor_error_sin_reiniciar(motor):
    await motor.llamar("eco", {"texto": "x"})
    pid = motor.pid
    with pytest.raises(MotorError) as e:
        await motor.llamar("fallar", {"texto": "algo salió mal"})
    assert not isinstance(e.value, MotorNoDisponible)
    assert motor.pid == pid


async def test_env_del_motor_sin_clave(motor_con_store_vacio):
    assert (await motor_con_store_vacio.llamar("entorno", {"nombre": "ELEVENLABS_API_KEY"})).texto == "<ausente>"


async def test_env_del_motor_con_clave_y_sin_secretos_del_padre(motor, monkeypatch):
    monkeypatch.setenv("SECRETO_DEL_PADRE", "no-debe-llegar")
    # La clave llega al hijo, pero nunca vuelve en una respuesta: se oculta al leerla.
    assert (await motor.llamar("entorno", {"nombre": "ELEVENLABS_API_KEY"})).texto == "***"
    assert (await motor.llamar("entorno", {"nombre": "SECRETO_DEL_PADRE"})).texto == "<ausente>"
    assert (await motor.llamar("entorno", {"nombre": "VIDEO_ENGINE_EMBEDDED"})).texto == "1"
    assert (await motor.llamar("entorno", {"nombre": "HYPERFRAMES_NO_TELEMETRY"})).texto == "1"
    assert (await motor.llamar("entorno", {"nombre": "DO_NOT_TRACK"})).texto == "1"


async def test_datos_con_la_clave_oculta(motor):
    r = await motor.llamar("datos_entorno", {"nombre": "ELEVENLABS_API_KEY"})
    assert r.texto == "ELEVENLABS_API_KEY leída"
    assert r.datos == {"nombre": "ELEVENLABS_API_KEY", "valor": "***", "eco": "x***x"}
    r = await motor.llamar("datos_entorno", {"nombre": "VIDEO_ENGINE_EMBEDDED"})
    assert r.datos["valor"] == "1"


async def test_herramientas_lista_las_tools(motor):
    nombres = await motor.herramientas()
    assert {"eco", "pid", "datos_entorno"} <= set(nombres)


async def test_herramientas_con_la_sesion_rota_es_motor_no_disponible(motor, monkeypatch):
    await motor.llamar("eco", {"texto": "x"})
    sesion = motor._sesion.listo.result()

    async def rota():
        raise anyio.ClosedResourceError

    monkeypatch.setattr(sesion, "list_tools", rota)
    with pytest.raises(MotorNoDisponible, match="se relanzará"):
        await motor.herramientas()
    assert motor.pid is None  # sesión descartada; la siguiente acción relanza
    assert (await motor.llamar("eco", {"texto": "sigue"})).texto == "sigue"


async def test_herramientas_colgada_respeta_el_timeout(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    m = MotorVideo([sys.executable, str(MOTOR_FALSO)], MOTOR_FALSO.parent, lambda: entorno_motor(StoreFalso()), 0.5)
    try:
        await m.llamar("eco", {"texto": "x"}, timeout=30)
        colgado = m.pid

        async def colgada():
            await asyncio.sleep(30)

        monkeypatch.setattr(m._sesion.listo.result(), "list_tools", colgada)
        with pytest.raises(MotorError, match="no respondió en 0.5 s") as e:
            await m.herramientas()
        assert not isinstance(e.value, MotorNoDisponible)
        assert m.pid is None and not psutil_pid_vivo(colgado)  # proceso reiniciado
    finally:
        await m.cerrar()


def test_entorno_motor():
    env = entorno_motor(StoreFalso({config.ELEVENLABS_KEY: CLAVE}))
    assert env["VIDEO_ENGINE_EMBEDDED"] == "1"
    assert env["VIDEO_ROOT"] == str(config.STATE_DIR / "video" / "proyectos")
    assert env["VIDEO_STATE_DIR"] == str(config.STATE_DIR / "video" / "estado")
    assert env["ELEVENLABS_API_KEY"] == CLAVE
    assert "ELEVENLABS_API_KEY" not in entorno_motor(StoreFalso({config.ELEVENLABS_KEY: ""}))


def test_comando_motor_desarrollo(monkeypatch):
    monkeypatch.delenv("APP_BACKEND_VIDEO_CMD", raising=False)
    argv, cwd = comando_motor()
    assert argv[0] == "node"
    assert Path(argv[1]) == config.VIDEO_ENGINE_DIR / "dist" / "index.js"
    assert cwd == config.VIDEO_ENGINE_DIR


async def test_stderr_al_log_con_la_clave_oculta(motor, caplog):
    caplog.set_level(logging.INFO, logger="app_backend.video")
    await motor.llamar("escribir_stderr", {"texto": f"traza con {CLAVE} dentro"})
    for _ in range(100):  # el hilo lector va por su cuenta
        if any("traza con" in r.getMessage() for r in caplog.records):
            break
        await asyncio.sleep(0.05)
    mensajes = [r.getMessage() for r in caplog.records if r.name == "app_backend.video"]
    assert any("traza con" in m for m in mensajes)
    assert not any(CLAVE in m for m in mensajes)


async def test_cerrar_mata_el_proceso(motor):
    # En un venv de Windows python.exe es un lanzador que crea el intérprete real como hijo:
    # motor.pid es el lanzador y la tool `pid` el servidor; los dos deben morir (árbol entero).
    servidor = int((await motor.llamar("pid")).texto)
    pid = motor.pid
    await motor.cerrar()
    assert not psutil_pid_vivo(pid)
    assert not psutil_pid_vivo(servidor)
    assert motor.pid is None
    await motor.cerrar()  # dos veces no falla


async def test_cerrar_sin_arrancar():
    m = _motor_falso(StoreFalso())
    await m.cerrar()
    assert m.pid is None


async def test_motor_rutas_con_espacios_y_acentos(tmp_path, monkeypatch):
    usuario = tmp_path / "José Pérez"
    estado = usuario / "seo studio"
    carpeta_motor = usuario / "motor de vídeo"
    carpeta_motor.mkdir(parents=True)
    script = carpeta_motor / "motor falso.py"
    shutil.copy(MOTOR_FALSO, script)
    monkeypatch.setattr(config, "STATE_DIR", estado)
    m = _motor_falso(StoreFalso(), cwd=carpeta_motor, script=script)
    try:
        assert (await m.llamar("eco", {"texto": "ñandú"})).texto == "ñandú"
        assert (await m.llamar("entorno", {"nombre": "VIDEO_STATE_DIR"})).texto == str(estado / "video" / "estado")
        assert (estado / "video" / "estado" / "motor-falso.log").exists()
    finally:
        await m.cerrar()


async def test_arranque_fallido_es_motor_no_disponible(tmp_path):
    m = MotorVideo([str(tmp_path / "no-existe.exe")], tmp_path, dict)
    with pytest.raises(MotorNoDisponible):
        await m.llamar("eco", {"texto": "x"})
    assert m.pid is None
    await m.cerrar()


@pytest.fixture
async def client_con_motor_roto(tmp_path, fake_anthropic, monkeypatch):
    monkeypatch.setenv("APP_BACKEND_VIDEO_CMD", f'["{(tmp_path / "no-existe.exe").as_posix()}"]')
    app = create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
    )
    transporte = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=transporte, base_url="http://test") as c:
        yield c


async def test_ruta_capacidades_503_si_no_arranca(client_con_motor_roto):
    assert (await client_con_motor_roto.get("/video/capacidades")).status_code == 401
    r = await client_con_motor_roto.get("/video/capacidades", headers=AUTH)
    assert r.status_code == 503
    assert "motor de vídeo" in r.json()["detail"]


@pytest.fixture
async def motor_real(monkeypatch):
    monkeypatch.delenv("APP_BACKEND_VIDEO_CMD", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    argv, cwd = comando_motor()
    m = MotorVideo(argv, cwd, lambda: entorno_motor(StoreFalso()))
    yield m
    await m.cerrar()


@pytest.mark.skipif(not MOTOR_REAL_COMPILADO, reason="npm run build en video-mcp-server")
async def test_motor_real_lista_las_12_tools(motor_real):
    caps = await motor_real.llamar("video_capacidades", {"reprobar": False})
    assert caps.datos["hyperframes"] == "0.8.206"
    assert caps.texto
    nombres = await motor_real.herramientas()
    assert len(nombres) == 12 and all(n.startswith("video_") for n in nombres)
