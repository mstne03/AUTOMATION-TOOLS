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

from app_backend import config, video
from app_backend.main import create_app
from app_backend.video import (
    MENSAJE_NO_INSTALADO,
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
MOTOR_QUE_SALE = Path(__file__).with_name("motor_que_sale.py")
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


async def test_motor_muerto_cierra_la_sesion_sin_otra_llamada(tmp_path, monkeypatch, caplog):
    """El Job Object se cierra al morir el motor, sin esperar a la siguiente llamada; y se avisa una sola vez."""
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    salir = tmp_path / "salir"
    m = MotorVideo(
        [sys.executable, str(MOTOR_QUE_SALE), str(salir)], MOTOR_QUE_SALE.parent, lambda: entorno_motor(StoreFalso())
    )
    try:
        antes = (await m.llamar("pid")).texto
        s = m._sesion
        assert s is not None and s.tarea is not None
        with caplog.at_level(logging.WARNING, logger="app_backend.video"):
            salir.write_text("x")
            # Ninguna llamada más: la propia tarea tiene que darse cuenta y cerrar la sesión.
            await asyncio.wait_for(asyncio.shield(s.tarea), 2)
        assert s.tarea.done() and s.parar.is_set()
        avisos = [r for r in caplog.records if "terminó" in r.getMessage()]
        assert len(avisos) == 1, [r.getMessage() for r in caplog.records]
        # La siguiente llamada relanza un motor nuevo (el falso vuelve a esperar el fichero: se quita antes).
        salir.unlink()
        assert (await m.llamar("pid")).texto != antes
    finally:
        await m.cerrar()


async def test_cierre_normal_no_registra_aviso(motor, caplog):
    await motor.llamar("pid")
    with caplog.at_level(logging.WARNING, logger="app_backend.video"):
        await motor.cerrar()
    assert [r.getMessage() for r in caplog.records if "terminó" in r.getMessage()] == []


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


def _bundle(d: Path, *, node=True, ffmpeg=True) -> Path:
    """Esqueleto de `video-engine/` con ficheros vacíos (solo cuenta que existan). Sin navegador: el
    CfT no va en el instalador (SEO-108; lo cubre tests/test_navegador.py)."""
    piezas = []
    if node:
        piezas.append("node/node.exe")
    if ffmpeg:
        piezas += ["ffmpeg/ffmpeg.exe", "ffmpeg/ffprobe.exe"]
    d.mkdir(parents=True, exist_ok=True)
    for p in piezas:
        (d / p).parent.mkdir(parents=True, exist_ok=True)
        (d / p).write_bytes(b"")
    return d


def test_entorno_congelado_siempre_con_las_piezas_del_bundle(tmp_path, monkeypatch):
    d = _bundle(tmp_path / "video-engine")
    monkeypatch.setattr(config, "FROZEN", True)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", d)
    # Congelado sin CfT descargado no arranca (lo cubre test_navegador.py): aquí, uno «instalado».
    monkeypatch.setattr(config, "NAVEGADOR_DIR", tmp_path / "navegador")
    (tmp_path / "navegador" / config.NAVEGADOR_VERSION).mkdir(parents=True)
    monkeypatch.setattr(video.navegador, "verificar", lambda carpeta: carpeta)
    env = entorno_motor(StoreFalso())
    assert env["FFMPEG_DIR"] == str(d / "ffmpeg")


def test_entorno_congelado_sin_motor_es_modulo_no_instalado(tmp_path, monkeypatch):
    d = tmp_path / "video-engine"
    d.mkdir()
    (d / ".vacio").write_text("marcador", encoding="utf-8")  # lo que deja el release sin VIDEO_ENGINE
    monkeypatch.setattr(config, "FROZEN", True)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", d)
    with pytest.raises(MotorNoDisponible, match="no está instalado"):
        entorno_motor(StoreFalso())


@pytest.mark.parametrize(("falta", "texto"), [({"ffmpeg": False}, "ffmpeg")])
def test_entorno_congelado_sin_una_pieza_pide_reinstalar(tmp_path, monkeypatch, falta, texto):
    d = _bundle(tmp_path / "video-engine", **falta)
    monkeypatch.setattr(config, "FROZEN", True)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", d)
    with pytest.raises(MotorNoDisponible, match=f"{texto}.*reinstala SEO Studio"):
        entorno_motor(StoreFalso())


async def test_ruta_capacidades_503_si_el_modulo_no_esta_instalado(tmp_path, fake_anthropic, monkeypatch):
    d = tmp_path / "video-engine"
    d.mkdir()
    monkeypatch.setattr(config, "FROZEN", True)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", d)
    app = create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
    )
    transporte = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=transporte, base_url="http://test") as c:
        r = await c.get("/video/capacidades", headers=AUTH)
    assert r.status_code == 503
    assert r.json()["detail"] == {"mensaje": MENSAJE_NO_INSTALADO, "codigo": "no_disponible"}


async def test_cambiar_o_borrar_la_clave_reinicia_el_motor(tmp_path, fake_anthropic, monkeypatch):
    """El motor lee la clave de su entorno al arrancar: al cambiarla se para y relanza con la nueva."""
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("APP_BACKEND_VIDEO_CMD", raising=False)
    app = create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
    )
    transporte = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=transporte, base_url="http://test") as c:
        from app_backend.main import yt_auth

        await app.state.motor.cerrar()
        app.state.motor = _motor_falso(yt_auth.store)
        motor = app.state.motor
        try:
            await c.put("/settings", json={"elevenlabs_api_key": "xi-vieja"}, headers=AUTH)
            # La respuesta sale ocultada con la clave de esa sesión: prueba que el hijo la tiene.
            assert (await motor.llamar("entorno", {"nombre": "ELEVENLABS_API_KEY"})).texto == "***"
            assert motor._sesion.clave == "xi-vieja"
            pid = motor.pid
            await c.put("/settings", json={"elevenlabs_api_key": "xi-nueva"}, headers=AUTH)
            assert motor.pid is None and not psutil_pid_vivo(pid)
            assert (await motor.llamar("entorno", {"nombre": "ELEVENLABS_API_KEY"})).texto == "***"
            assert motor._sesion.clave == "xi-nueva"
            await c.put("/settings", json={"elevenlabs_api_key": ""}, headers=AUTH)
            assert motor.pid is None
            assert (await motor.llamar("entorno", {"nombre": "ELEVENLABS_API_KEY"})).texto == "<ausente>"
            assert motor._sesion.clave is None
            # Un PUT sin la clave no toca el motor.
            pid = motor.pid
            await c.put("/settings", json={}, headers=AUTH)
            assert motor.pid == pid
        finally:
            await motor.cerrar()


# ---------------------------------------------------------------- canal aparte para el render


def _app_con_motores(tmp_path, fake_anthropic):
    return create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
    )


async def test_lifespan_crea_dos_motores_perezosos_y_cierra_los_dos(tmp_path, fake_anthropic, monkeypatch):
    app = _app_con_motores(tmp_path, fake_anthropic)
    cerrados = []
    async with app.router.lifespan_context(app):
        motores = (app.state.motor, app.state.motor_render)
        assert isinstance(motores[1], MotorVideo) and motores[0] is not motores[1]
        assert [m.pid for m in motores] == [None, None]
        for nombre, m in zip(("motor", "render"), motores, strict=True):
            original = m.cerrar

            async def cerrar(nombre=nombre, original=original):
                cerrados.append(nombre)
                await original()

            monkeypatch.setattr(m, "cerrar", cerrar)
    assert sorted(cerrados) == ["motor", "render"]


async def test_dos_canales_son_procesos_distintos_y_matar_uno_no_afecta_al_otro(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    uno, dos = _motor_falso(StoreFalso()), _motor_falso(StoreFalso())
    try:
        assert (uno.pid, dos.pid) == (None, None)
        await uno.llamar("eco", {"texto": "a"})
        await dos.llamar("eco", {"texto": "b"})
        assert uno.pid != dos.pid
        pid = uno.pid
        with pytest.raises(MotorNoDisponible):
            await uno.llamar("morir")
        assert not psutil_pid_vivo(pid)
        assert (await dos.llamar("eco", {"texto": "sigo"})).texto == "sigo"
    finally:
        await uno.cerrar()
        await dos.cerrar()


def test_entorno_del_render_no_lleva_la_clave(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    store = StoreFalso({config.ELEVENLABS_KEY: CLAVE})
    assert entorno_motor(store)["ELEVENLABS_API_KEY"] == CLAVE
    assert "ELEVENLABS_API_KEY" not in entorno_motor(store, con_clave=False)


@pytest.mark.parametrize(
    ("tool", "canal"),
    [
        ("video_renderizar", "motor_render"),
        ("video_estado_render", "motor_render"),
        ("video_estado", "motor"),  # ya no existe en integrado (T11): no es del canal de render
        ("video_capacidades", "motor"),
        ("video_vista_previa", "motor"),
        ("video_generar_voz", "motor"),  # necesita la clave: nunca por el canal sin ella
    ],
)
def test_cada_tool_va_por_su_canal(tool, canal):
    estado = type("Estado", (), {"motor": "motor", "motor_render": "motor_render"})()
    assert video.motor_de(estado, tool) == canal


async def test_cambiar_la_clave_para_motor_y_no_el_render(tmp_path, fake_anthropic, monkeypatch):
    """Cambiar la clave no puede matar un render en curso: el canal de render no la lleva."""
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("APP_BACKEND_VIDEO_CMD", raising=False)
    app = _app_con_motores(tmp_path, fake_anthropic)
    transporte = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app), httpx.AsyncClient(transport=transporte, base_url="http://test") as c:
        from app_backend.main import yt_auth

        app.state.motor = _motor_falso(yt_auth.store)
        app.state.motor_render = _motor_falso(yt_auth.store)
        motor, render = app.state.motor, app.state.motor_render
        try:
            await motor.llamar("eco", {"texto": "a"})
            await render.llamar("eco", {"texto": "b"})
            pid_render = render.pid
            r = await c.put("/settings", json={"elevenlabs_api_key": "xi-otra"}, headers=AUTH)
            assert r.status_code == 200
            assert motor.pid is None
            assert render.pid == pid_render and psutil_pid_vivo(pid_render)
        finally:
            await motor.cerrar()
            await render.cerrar()


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
    assert "motor de vídeo" in r.json()["detail"]["mensaje"] and r.json()["detail"]["codigo"] == "no_disponible"


@pytest.fixture
async def motor_real(monkeypatch):
    monkeypatch.delenv("APP_BACKEND_VIDEO_CMD", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    argv, cwd = comando_motor()
    m = MotorVideo(argv, cwd, lambda: entorno_motor(StoreFalso()))
    yield m
    await m.cerrar()


@pytest.mark.skipif(not MOTOR_REAL_COMPILADO, reason="npm run build en video-mcp-server")
async def test_motor_real_lista_las_11_tools(motor_real):
    caps = await motor_real.llamar("video_capacidades", {"reprobar": False})
    assert caps.datos["hyperframes"] == "0.8.206"
    assert caps.texto
    nombres = await motor_real.herramientas()
    # Integrado (VIDEO_ENGINE_EMBEDDED=1): T4 quita las 5 tools del formato anterior (guion.md, voz suelta, estado,
    # listado por carpeta y música por ruta) y el catálogo (SEO-110), y añade las 9 del almacén de guiones y
    # proyectos. Quedan 15; se compara el conjunto exacto y no la cuenta, para que una tool sustituida no pase.
    # T5 añade las 6 de la voz por frases (única excepción al carril M: solo la expectativa; los canales y la
    # aprobación de estas tools son de T13/T14): 21.
    # T8 añade las 3 del perfil visual (misma excepción, solo la expectativa): 24.
    # T6 añade video_montar_preview y video_barrer_procesos: 26. T7 añade las 4 de recursos y música: 30.
    esperadas = {
        "video_guion_esquema", "video_guion_guardar", "video_guion_listar", "video_guion_leer", "video_guion_borrar",
        "video_proyecto_crear", "video_proyecto_listar", "video_proyecto_leer", "video_proyecto_guardar",
        "video_renderizar", "video_estado_render", "video_fotograma", "video_vista_previa", "video_ayuda",
        "video_capacidades",
        "video_voz_coste", "video_voz_generar", "video_voz_forma", "video_voz_quitar_silencios", "video_voces", "video_voz_muestra",
        "video_perfiles_listar", "video_perfil_guardar", "video_perfil_duplicar",
        "video_montar_preview", "video_barrer_procesos",  # T6: montaje de la preview y barrido de procesos (R0-6)
        "video_recurso_importar", "video_recurso_borrar", "video_musica_listar", "video_musica_importar",  # T7: recursos normalizados y música
    }  # fmt: skip
    assert set(nombres) == esperadas and len(nombres) == 30


async def test_ruta_capacidades_da_tiempo_a_la_prueba_de_gpu(tmp_path, fake_anthropic):
    """La prueba de GPU del motor puede tardar hasta 240 s: la ruta no puede usar los 120 s por defecto."""
    llamadas = []

    class MotorQueAnota:
        async def llamar(self, tool, args=None, timeout=None):
            llamadas.append((tool, args, timeout))
            return RespuestaMotor(texto="ok", datos={"hyperframes": "0.8.206"}, imagen=None)

        async def cerrar(self):
            pass

    app = create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
    )
    transporte = httpx.ASGITransport(app=app)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transporte, base_url="http://test") as c,
    ):
        await app.state.motor.cerrar()
        app.state.motor = MotorQueAnota()
        r = await c.get("/video/capacidades", headers=AUTH)
    assert r.status_code == 200 and r.json() == {"hyperframes": "0.8.206"}
    assert [(t, a) for t, a, _ in llamadas] == [("video_capacidades", {"reprobar": False})]
    # Peor caso del motor: 240 s de render + 30 s de fotograma + 60 s de sondas en paralelo.
    assert llamadas[0][2] == video.TIMEOUT_CAPACIDADES and video.TIMEOUT_CAPACIDADES > 330


def test_canal_de_render_sin_video_estado():
    assert video.TOOLS_CANAL_RENDER == frozenset({"video_renderizar", "video_estado_render"})


def test_entorno_reenvia_tts_de_pruebas_solo_si_no_esta_congelado(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_PRUEBAS_TTS_URL", "http://127.0.0.1:9999")
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
    env = entorno_motor(StoreFalso())
    assert env["VIDEO_PRUEBAS_TTS_URL"] == "http://127.0.0.1:9999"
    assert env["ELEVENLABS_VOICE_ID"] == "21m00Tcm4TlvDq8ikWAM"
    d = _bundle(tmp_path / "video-engine")
    monkeypatch.setattr(config, "FROZEN", True)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", d)
    monkeypatch.setattr(config, "NAVEGADOR_DIR", tmp_path / "navegador")
    (tmp_path / "navegador" / config.NAVEGADOR_VERSION).mkdir(parents=True)
    monkeypatch.setattr(video.navegador, "verificar", lambda carpeta: carpeta)
    env = entorno_motor(StoreFalso())
    assert "VIDEO_PRUEBAS_TTS_URL" not in env and "ELEVENLABS_VOICE_ID" not in env
