"""Comprobaciones puras de scripts/smoke_test.py (SEO-109). El vigilante real solo corre en el smoke."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "smoke_test", Path(__file__).resolve().parents[1] / "scripts" / "smoke_test.py"
)
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)

FICHEROS = {"dist/cli.js": b"parcheado\n", "bin/hyperframes.mjs": b"bin\n"}


def _sha(datos: bytes) -> str:
    return hashlib.sha256(datos).hexdigest()


@pytest.fixture
def motor(tmp_path, monkeypatch):
    """Un repo y un bundle correctos, con el mismo JSON."""
    json_hashes = {
        "version": smoke.HYPERFRAMES,
        "ficheros": {"dist/cli.js": _sha(FICHEROS["dist/cli.js"])},
        "sinParche": {"bin/hyperframes.mjs": _sha(FICHEROS["bin/hyperframes.mjs"])},
    }
    backend = tmp_path / "repo" / "app-backend"
    monkeypatch.setattr(smoke, "APP_BACKEND", backend)
    for carpeta in (tmp_path / "repo" / "video-mcp-server", tmp_path / "video-engine" / "app"):
        (carpeta / "patches").mkdir(parents=True)
        (carpeta / "patches" / smoke.HASHES_PARCHE).write_text(json.dumps(json_hashes), "utf-8")
    motor = tmp_path / "video-engine"
    hf = motor / "app" / "node_modules" / "hyperframes"
    for rel, datos in FICHEROS.items():
        (hf / rel).parent.mkdir(parents=True, exist_ok=True)
        (hf / rel).write_bytes(datos)
    (hf / "package.json").write_text(json.dumps({"version": smoke.HYPERFRAMES}), "utf-8")
    return motor


def _hf(motor: Path) -> Path:
    return motor / "app" / "node_modules" / "hyperframes"


def test_bundle_correcto(motor):
    smoke.comprobar_parche_bundle(motor)


@pytest.mark.parametrize("rel", FICHEROS)
def test_un_byte_cambiado_en_ficheros_y_en_sin_parche(motor, rel):
    (_hf(motor) / rel).write_bytes(b"otro\n")
    with pytest.raises(AssertionError, match=rel):
        smoke.comprobar_parche_bundle(motor)


@pytest.mark.parametrize("rel", FICHEROS)
def test_fichero_que_falta(motor, rel):
    (_hf(motor) / rel).unlink()
    with pytest.raises(AssertionError, match=rel):
        smoke.comprobar_parche_bundle(motor)


def test_falta_el_json_del_bundle(motor):
    (motor / "app" / "patches" / smoke.HASHES_PARCHE).unlink()
    with pytest.raises(AssertionError, match="Falta"):
        smoke.comprobar_parche_bundle(motor)


def test_json_del_bundle_distinto_del_repo(motor):
    f = motor / "app" / "patches" / smoke.HASHES_PARCHE
    j = json.loads(f.read_text("utf-8"))
    j["ficheros"]["dist/cli.js"] = _sha(b"otro\n")
    f.write_text(json.dumps(j), "utf-8")
    (_hf(motor) / "dist" / "cli.js").write_bytes(b"otro\n")  # coherente con su JSON: lo único que lo delata es el repo
    with pytest.raises(AssertionError, match="no es el JSON del repo"):
        smoke.comprobar_parche_bundle(motor)


def test_otra_version_en_el_bundle(motor):
    (_hf(motor) / "package.json").write_text('{"version": "0.0.1"}', "utf-8")
    with pytest.raises(AssertionError, match="0.0.1"):
        smoke.comprobar_parche_bundle(motor)


def _browser(pid=1, cmd=None, vida=5000):
    if cmd is None:
        cmd = " ".join(f'"{f}"' if " " in f else f for f in (*smoke.FLAGS_BROWSER, f"{smoke.BYPASS};127.0.0.1:1234"))
    return {"pid": pid, "ppid": 0, "tipo": "browser", "nivel": 8192, "salida": 0, "cmd": cmd, "ruta": "", "vida_ms": vida}


def _renderer(pid=2, ppid=1, nivel=0, salida=0):
    return {"pid": pid, "ppid": ppid, "tipo": "renderer", "nivel": nivel, "salida": salida, "cmd": "", "ruta": "", "vida_ms": 900}


def _render():
    return [_browser(), _renderer()]


def _sonda():
    """Browser de la sonda de GPU: sin excepción de proxy, con un renderer Untrusted."""
    cmd = _browser()["cmd"].replace(";127.0.0.1:1234", "")
    return [_browser(11, cmd), _renderer(12, ppid=11)]


def _con(procesos, **cambios):
    r = copy.deepcopy(procesos)
    r[-1].update(cambios)
    return r


def test_render_correcto():
    assert smoke.fallos_integridad(_render()) == []


def test_sin_renderers_falla_cerrado():
    assert "ningún renderer" in smoke.fallos_integridad([_browser()])[0]
    assert "ningún renderer" in smoke.fallos_integridad([])[0]


@pytest.mark.parametrize("nivel", [8192, 12288, 4096, -2, -3, -4, -9])
def test_renderer_fuera_de_untrusted(nivel):
    fallos = smoke.fallos_integridad([*_render(), _renderer(3, nivel=nivel)])
    assert any("no está en Untrusted" in f for f in fallos), fallos


def test_nivel_desconocido_solo_si_hay_otro_untrusted():
    assert smoke.fallos_integridad([*_render(), _renderer(3, nivel=smoke.SALIO_ANTES)]) == []
    assert any("Ningún renderer medido" in f for f in smoke.fallos_integridad(_con(_render(), nivel=smoke.SALIO_ANTES)))


def test_low_solo_en_la_sonda_y_con_salida_limpia():
    base = [*_render(), *_sonda()]
    assert smoke.fallos_integridad([*base, _renderer(3, ppid=11, nivel=smoke.LOW, salida=0)]) == []
    assert smoke.fallos_integridad([*base, _renderer(3, nivel=smoke.LOW, salida=0)])  # este browser navega
    assert smoke.fallos_integridad([*base, _renderer(3, ppid=11, nivel=smoke.LOW, salida=1)])  # crash
    assert smoke.fallos_integridad([*base, _renderer(3, ppid=11, nivel=smoke.LOW, salida=259)])  # sigue vivo


def test_solo_la_sonda_no_es_un_render_real():
    assert any("no hubo render real" in f for f in smoke.fallos_integridad(_sonda()))


def test_sin_identificar_medium_vivo_es_fallo():
    p = {"pid": 9, "ppid": 1, "tipo": "?", "nivel": 8192, "salida": 0, "cmd": "", "ruta": "", "vida_ms": 2000}
    assert any("sin identificar" in f for f in smoke.fallos_integridad([*_render(), p]))
    assert smoke.fallos_integridad([*_render(), {**p, "vida_ms": 1999}]) == []
    assert smoke.fallos_integridad([*_render(), {**p, "nivel": 0}]) == []


@pytest.mark.parametrize("flag", [*smoke.FLAGS_BROWSER, smoke.BYPASS])
def test_browser_sin_un_flag(flag):
    cmd = _browser()["cmd"].replace(f"{flag};127.0.0.1:1234" if flag == smoke.BYPASS else flag, "")
    assert any("sin los flags de red" in f for f in smoke.fallos_integridad([_browser(1, cmd), _renderer()]))


@pytest.mark.parametrize(
    "lista",
    ["<-loopback>;*", "<-loopback>;localhost", "<-loopback>;127.0.0.1", "<-loopback>;example.test:1", "*"],
)
def test_excepcion_de_proxy_no_valida(lista):
    cmd = _browser()["cmd"].replace("<-loopback>;127.0.0.1:1234", lista)
    assert any("sin los flags de red" in f for f in smoke.fallos_integridad([_browser(1, cmd), _renderer()]))


@pytest.mark.parametrize("flag", ["--no-sandbox", "--single-process", "--in-process-gpu"])
def test_flag_prohibido(flag):
    assert any(flag in f for f in smoke.fallos_integridad([_browser(1, f"{_browser()['cmd']} {flag}"), _renderer()]))


def test_browser_longevo_sin_renderer_untrusted():
    ms = [*_render(), _browser(5, vida=2000)]
    assert any("#5" in f and "sin renderer" in f for f in smoke.fallos_integridad(ms))
    assert smoke.fallos_integridad([*_render(), _browser(5, vida=1999)]) == []


def test_navegador_ajeno():
    ms = _con(_render(), ajeno=True, ruta=r"C:\Program Files\Google\Chrome\chrome.exe")
    assert any("no es el navegador fijado" in f for f in smoke.fallos_integridad(ms))


@pytest.mark.parametrize(
    ("cmd", "tipo"),
    [
        ("chrome.exe --type=renderer --lang=es", "renderer"),
        ("chrome.exe --type=utility --utility-sub-type=x", "utility"),
        ("chrome.exe --headless about:blank", "browser"),
        ("chrome.exe --version", "version"),
    ],
)
def test_tipo_de(cmd, tipo):
    assert smoke.tipo_de(cmd) == tipo
