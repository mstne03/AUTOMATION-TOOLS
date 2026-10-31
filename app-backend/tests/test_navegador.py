"""Chrome for Testing en el primer uso (SEO-108): extracción, verificación, instalación y descarga.

Ningún test toca la red: zips fabricados aquí, `httpx.MockTransport` o un servidor en 127.0.0.1.
"""

import ast
import asyncio
import contextlib
import hashlib
import http.server
import io
import ipaddress
import json
import os
import shutil
import ssl
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

import httpx
import pytest

from app_backend import config, kb_update, navegador, registry, video
from app_backend.main import create_app
from app_backend.navegador import NavegadorError, es_enlace, extraer, nombre_valido

TOKEN = "token-de-prueba"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

solo_windows = pytest.mark.skipif(sys.platform != "win32", reason="junctions: solo Windows")

EXE = "chrome-headless-shell-win64/chrome-headless-shell.exe"
CONTENIDO = {
    EXE: b"MZ exe falso del navegador",
    "chrome-headless-shell-win64/libEGL.dll": b"dll egl",
    "chrome-headless-shell-win64/vulkan-1.dll": b"dll vulkan",
    "chrome-headless-shell-win64/locales/es.pak": b"pak es",
}


def _sha(datos: bytes) -> str:
    return hashlib.sha256(datos).hexdigest()


def _zip(ruta: Path, entradas: dict[str, bytes], *, enlace: str | None = None, metodo=zipfile.ZIP_DEFLATED) -> Path:
    with zipfile.ZipFile(ruta, "w", metodo) as z:
        for nombre, datos in entradas.items():
            z.writestr(zipfile.ZipInfo(nombre), datos, compress_type=metodo)
        if enlace:
            info = zipfile.ZipInfo(enlace)
            info.create_system = 3
            info.external_attr = 0o120777 << 16
            z.writestr(info, b"../../fuera")
    return ruta


def _anclar(monkeypatch, datos_zip: bytes, contenido: dict[str, bytes]) -> None:
    """Fija las constantes del navegador a las de un zip de prueba (hash, tamaño y manifiesto)."""
    monkeypatch.setattr(config, "NAVEGADOR_SHA256", _sha(datos_zip))
    monkeypatch.setattr(config, "NAVEGADOR_TAMANO", len(datos_zip))
    monkeypatch.setattr(config, "NAVEGADOR_MAX_DESCARGA", len(datos_zip) * 11 // 10)
    manifiesto = navegador.serializar_manifiesto({n: _sha(b) for n, b in contenido.items()})
    monkeypatch.setattr(config, "NAVEGADOR_MANIFIESTO_SHA256", _sha(manifiesto))


@pytest.fixture
def cft_falso(tmp_path, monkeypatch):
    estado = tmp_path / "estado"
    monkeypatch.setattr(config, "STATE_DIR", estado)
    monkeypatch.setattr(config, "NAVEGADOR_DIR", estado / "video" / "navegador")
    ruta = _zip(tmp_path / "cft.zip", CONTENIDO)
    datos = ruta.read_bytes()
    _anclar(monkeypatch, datos, CONTENIDO)
    return ruta, datos


def _junction(enlace: Path, destino: Path) -> None:
    r = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(enlace), str(destino)], check=False, capture_output=True, text=True, errors="replace"
    )
    if r.returncode != 0 or not enlace.is_junction():
        pytest.fail(f"mklink /J falló: {r.stdout} {r.stderr}")


def _version() -> Path:
    return config.NAVEGADOR_DIR / config.NAVEGADOR_VERSION


def _restos() -> list[str]:
    base = config.NAVEGADOR_DIR
    return sorted(p.name for p in base.iterdir() if p.name != ".bloqueo") if base.exists() else []


def _instalar_en(carpeta: Path, contenido: dict[str, bytes] = CONTENIDO) -> None:
    """Extrae `contenido` con su manifiesto en `carpeta` (sin pasar por instalar_desde_zip)."""
    carpeta.mkdir(parents=True)
    zp = _zip(carpeta.parent / f"{carpeta.name}.zip", contenido)
    with zipfile.ZipFile(zp) as zf:
        ficheros = extraer(zf, carpeta)
    (carpeta / config.NAVEGADOR_MANIFIESTO).write_bytes(navegador.serializar_manifiesto(ficheros))


# ------------------------------------------------------------------ Tarea 1: nombres y extracción


def test_constantes_fijadas():
    assert config.NAVEGADOR_VERSION == "156.0.8078.73"
    assert config.NAVEGADOR_URL == (
        "https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.73/win64/chrome-headless-shell-win64.zip"
    )
    assert config.NAVEGADOR_SHA256 == "e6d26810df71efd0a3dfd0f7246d75d279ebdf8a8ec153d1ac44069657298628"
    assert config.NAVEGADOR_TAMANO == 125_506_562
    assert config.NAVEGADOR_MAX_DESCARGA <= config.NAVEGADOR_TAMANO * 11 // 10
    assert config.NAVEGADOR_MAX_FICHEROS == 320 and config.NAVEGADOR_MAX_EXTRAIDO == 324_423_696
    assert config.NAVEGADOR_DIR == config.STATE_DIR / "video" / "navegador"
    assert len(config.NAVEGADOR_MANIFIESTO_SHA256) == 64


def test_config_del_navegador_no_lee_el_entorno():
    """Ruling 6: nada del navegador se puede cambiar por entorno en el binario congelado."""
    arbol = ast.parse(Path(config.__file__).read_text(encoding="utf-8"))
    for nodo in arbol.body:
        if isinstance(nodo, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id.startswith("NAVEGADOR_") for t in nodo.targets
        ):
            assert "environ" not in ast.unparse(nodo.value), ast.unparse(nodo)


@pytest.mark.parametrize(
    "nombre",
    [
        EXE,
        "chrome-headless-shell-win64/locales/es-419.pak",
        "chrome-headless-shell-win64/hyphen-data/hyph-en-us.hyb",
        "chrome-headless-shell-win64/resources/accessibility/reading_mode_gdocs_helper/content.js",
    ],
)
def test_nombre_valido_acepta_los_del_cft(nombre):
    assert nombre_valido(nombre)


@pytest.mark.parametrize(
    "nombre",
    [
        "../x.dll",
        "chrome-headless-shell-win64/../../x.dll",
        "..\\..\\x.dll",
        "chrome-headless-shell-win64\\..\\x.dll",
        "/x.dll",
        "C:/x.dll",
        "C:x.dll",
        "chrome-headless-shell-win64/a.dll:Zone.Identifier",
        "chrome-headless-shell-win64/CON",
        "chrome-headless-shell-win64/nul.txt",
        "chrome-headless-shell-win64/x.",
        "chrome-headless-shell-win64/x ",
        "otra/x.dll",
        "chrome-headless-shell-win64//x.dll",
        "chrome-headless-shell-win64/\x01.dll",
        "chrome-headless-shell-win64",
        "chrome-headless-shell-win64/" + "a/" * 8 + "x",
    ],
)
def test_nombre_valido_rechaza(nombre):
    assert not nombre_valido(nombre)


def test_el_modulo_usa_zipfile_por_el_modulo():
    """Los tests espían `navegador.zipfile.ZipFile`: un `from zipfile import` los dejaría ciegos."""
    fuente = Path(navegador.__file__).read_text(encoding="utf-8")
    assert "from zipfile import" not in fuente and "import zipfile" in fuente


def test_extraer_genera_manifiesto(tmp_path):
    zp = _zip(tmp_path / "a.zip", CONTENIDO)
    destino = tmp_path / "d"
    destino.mkdir()
    with zipfile.ZipFile(zp) as zf:
        ficheros = extraer(zf, destino)
    assert ficheros == {n: _sha(b) for n, b in CONTENIDO.items()}
    for n, b in CONTENIDO.items():
        assert (destino / n).read_bytes() == b


@pytest.mark.parametrize("malo", ["..\\..\\x.dll", "chrome-headless-shell-win64/../../x.dll", "../x.dll"])
def test_extraer_rechaza_traversal_sin_escribir_fuera(tmp_path, malo):
    trabajo = tmp_path / "t"
    trabajo.mkdir()
    zp = _zip(trabajo / "a.zip", {"chrome-headless-shell-win64/ok.dll": b"ok", malo: b"malo"})
    destino = trabajo / "uno" / "dos" / "d"
    destino.mkdir(parents=True)
    with zipfile.ZipFile(zp) as zf, pytest.raises(NavegadorError, match="no permitida"):
        extraer(zf, destino)
    assert list(destino.iterdir()) == []
    assert list(tmp_path.rglob("x.dll")) == []


def test_extraer_rechaza_enlace_simbolico(tmp_path):
    zp = _zip(tmp_path / "a.zip", {EXE: b"x"}, enlace="chrome-headless-shell-win64/enlace.dll")
    destino = tmp_path / "d"
    destino.mkdir()
    with zipfile.ZipFile(zp) as zf, pytest.raises(NavegadorError, match="no permitida"):
        extraer(zf, destino)
    assert list(destino.iterdir()) == []


def test_extraer_rechaza_duplicados_por_mayusculas(tmp_path):
    zp = _zip(tmp_path / "a.zip", {"chrome-headless-shell-win64/A.dll": b"1", "chrome-headless-shell-win64/a.dll": b"2"})
    destino = tmp_path / "d"
    destino.mkdir()
    with zipfile.ZipFile(zp) as zf, pytest.raises(NavegadorError, match="no permitida"):
        extraer(zf, destino)
    assert list(destino.iterdir()) == []


def test_extraer_rechaza_metodo_raro(tmp_path):
    zp = _zip(tmp_path / "a.zip", {EXE: b"x"}, metodo=zipfile.ZIP_LZMA)
    destino = tmp_path / "d"
    destino.mkdir()
    with zipfile.ZipFile(zp) as zf, pytest.raises(NavegadorError):
        extraer(zf, destino)
    assert list(destino.iterdir()) == []


def test_extraer_tope_de_ficheros(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "NAVEGADOR_MAX_FICHEROS", 2)
    zp = _zip(tmp_path / "a.zip", dict(list(CONTENIDO.items())[:3]))
    destino = tmp_path / "d"
    destino.mkdir()
    with zipfile.ZipFile(zp) as zf, pytest.raises(NavegadorError):
        extraer(zf, destino)
    assert list(destino.iterdir()) == []


def test_extraer_tope_de_tamano(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "NAVEGADOR_MAX_EXTRAIDO", 10)
    zp = _zip(tmp_path / "a.zip", {EXE: b"x" * 11})
    destino = tmp_path / "d"
    destino.mkdir()
    with zipfile.ZipFile(zp) as zf, pytest.raises(NavegadorError):
        extraer(zf, destino)


def test_extraer_cuenta_los_bytes_reales(tmp_path, monkeypatch):
    """Las cabeceras suman 8 (bajo el tope de 10) y los flujos entregan 6 + 6: cuentan los bytes
    reales leídos, no los de la cabecera. `zipfile` ya corta en `file_size`, así que el flujo se
    sustituye por uno que miente (otra implementación, un fallo) para ejercitar el contador."""
    monkeypatch.setattr(config, "NAVEGADOR_MAX_EXTRAIDO", 10)
    zp = _zip(tmp_path / "a.zip", {EXE: b"x" * 4, "chrome-headless-shell-win64/b.dll": b"y" * 4})
    destino = tmp_path / "d"
    destino.mkdir()
    with zipfile.ZipFile(zp) as zf:
        zf.open = lambda info, *a, **k: io.BytesIO(b"z" * 6)
        with pytest.raises(NavegadorError) as e:
            extraer(zf, destino)
    assert str(e.value) == navegador.MENSAJE_TOPES


def test_extraer_exige_destino_vacio(tmp_path):
    zp = _zip(tmp_path / "a.zip", CONTENIDO)
    destino = tmp_path / "d"
    destino.mkdir()
    (destino / "algo").write_text("x")
    with zipfile.ZipFile(zp) as zf, pytest.raises(NavegadorError):
        extraer(zf, destino)


def test_mensaje_de_entrada_trunca_nombres_largos(tmp_path):
    nombre = "chrome-headless-shell-win64/" + "a" * 500 + ":ads"
    zp = _zip(tmp_path / "a.zip", {nombre: b"x"})
    destino = tmp_path / "d"
    destino.mkdir()
    with zipfile.ZipFile(zp) as zf, pytest.raises(NavegadorError) as e:
        extraer(zf, destino)
    assert len(str(e.value)) < 300


# ------------------------------------------------------------------ Tarea 2: verificación


def test_verificar_ok_devuelve_exe(cft_falso, tmp_path):
    _instalar_en(tmp_path / "v")
    assert navegador.verificar(tmp_path / "v") == tmp_path / "v" / EXE


def test_verificar_detecta_dll_extra(cft_falso, tmp_path):
    _instalar_en(tmp_path / "v")
    (tmp_path / "v" / "chrome-headless-shell-win64" / "evil.dll").write_bytes(b"mal")
    with pytest.raises(NavegadorError, match="evil.dll"):
        navegador.verificar(tmp_path / "v")


def test_verificar_rechaza_manifiesto_regenerado(cft_falso, tmp_path):
    """Una .dll añadida con un manifiesto coherente regenerado: el hash anclado del manifiesto lo para."""
    _instalar_en(tmp_path / "v")
    (tmp_path / "v" / "chrome-headless-shell-win64" / "evil.dll").write_bytes(b"mal")
    ficheros = {n: _sha(b) for n, b in CONTENIDO.items()} | {"chrome-headless-shell-win64/evil.dll": _sha(b"mal")}
    (tmp_path / "v" / config.NAVEGADOR_MANIFIESTO).write_bytes(navegador.serializar_manifiesto(ficheros))
    with pytest.raises(NavegadorError, match="manifiesto"):
        navegador.verificar(tmp_path / "v")


def test_verificar_detecta_byte_cambiado(cft_falso, tmp_path):
    _instalar_en(tmp_path / "v")
    exe = tmp_path / "v" / EXE
    datos = bytearray(exe.read_bytes())
    datos[0] ^= 0xFF
    exe.write_bytes(bytes(datos))
    with pytest.raises(NavegadorError, match="chrome-headless-shell.exe"):
        navegador.verificar(tmp_path / "v")


def test_verificar_detecta_fichero_que_falta(cft_falso, tmp_path):
    _instalar_en(tmp_path / "v")
    (tmp_path / "v" / "chrome-headless-shell-win64" / "libEGL.dll").unlink()
    with pytest.raises(NavegadorError, match="libEGL.dll"):
        navegador.verificar(tmp_path / "v")


def test_verificar_rechaza_manifiesto_con_rutas_raras(cft_falso, tmp_path, monkeypatch):
    _instalar_en(tmp_path / "v")
    (tmp_path / "centinela.txt").write_bytes(b"c")
    ficheros = {n: _sha(b) for n, b in CONTENIDO.items()} | {"../../centinela.txt": _sha(b"c")}
    datos = navegador.serializar_manifiesto(ficheros)
    (tmp_path / "v" / config.NAVEGADOR_MANIFIESTO).write_bytes(datos)
    monkeypatch.setattr(config, "NAVEGADOR_MANIFIESTO_SHA256", _sha(datos))  # aunque el ancla casara
    with pytest.raises(NavegadorError, match="no permitida"):
        navegador.verificar(tmp_path / "v")


def test_verificar_rechaza_version_distinta(cft_falso, tmp_path, monkeypatch):
    _instalar_en(tmp_path / "v")
    obj = json.loads((tmp_path / "v" / config.NAVEGADOR_MANIFIESTO).read_bytes())
    obj["version"] = "1.0.0.0"
    datos = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    (tmp_path / "v" / config.NAVEGADOR_MANIFIESTO).write_bytes(datos)
    monkeypatch.setattr(config, "NAVEGADOR_MANIFIESTO_SHA256", _sha(datos))
    with pytest.raises(NavegadorError, match="versión"):
        navegador.verificar(tmp_path / "v")


def test_verificar_rechaza_hardlinks(cft_falso, tmp_path):
    """os.link funciona sin privilegios (también en NTFS): un hardlink fuera ve (y cambia) el exe (I6)."""
    _instalar_en(tmp_path / "v")
    try:
        os.link(tmp_path / "v" / EXE, tmp_path / "otro-nombre")
    except OSError as e:
        pytest.skip(f"sin hardlinks en este sistema de ficheros: {e}")
    with pytest.raises(NavegadorError, match="enlace"):
        navegador.verificar(tmp_path / "v")


@solo_windows
def _instalado_con_log(cft_falso) -> Path:
    ruta, _ = cft_falso
    navegador.instalar_desde_zip(ruta)
    return _version() / config.NAVEGADOR_LOG


def test_debug_log_de_chrome_no_pide_redescargar(cft_falso):
    log = _instalado_con_log(cft_falso)
    log.write_bytes(b"[ERROR] x")
    assert navegador.verificar(_version()).is_file()
    assert video.entorno_motor(_Store())["HYPERFRAMES_BROWSER_PATH"]


@pytest.mark.skipif(sys.platform != "win32", reason="NTFS no distingue mayúsculas")
def test_debug_log_en_mayusculas_se_tolera_igual_que_en_el_motor(cft_falso):
    log = _instalado_con_log(cft_falso)
    log.with_name("debug.LOG").write_bytes(b"x")
    assert navegador.verificar(_version()).is_file()


def test_debug_log_que_es_carpeta_con_dll_se_rechaza(cft_falso):
    log = _instalado_con_log(cft_falso)
    log.mkdir()
    (log / "x.dll").write_bytes(b"x")
    with pytest.raises(NavegadorError, match=r"sobra .*debug\.log/x\.dll"):
        navegador.verificar(_version())


def test_debug_log_en_otra_ruta_se_rechaza(cft_falso):
    _instalado_con_log(cft_falso)
    (_version() / "debug.log").write_bytes(b"x")
    with pytest.raises(NavegadorError, match=r"sobra .*debug\.log"):
        navegador.verificar(_version())


def test_otro_nombre_junto_al_exe_se_rechaza(cft_falso):
    log = _instalado_con_log(cft_falso)
    log.with_name("debug.log.dll").write_bytes(b"x")
    with pytest.raises(NavegadorError, match="sobra"):
        navegador.verificar(_version())


@pytest.mark.skipif(sys.platform != "win32", reason="enlaces de Windows")
def test_debug_log_enlace_se_rechaza(cft_falso, tmp_path):
    log = _instalado_con_log(cft_falso)
    destino = tmp_path / "destino"
    destino.mkdir()
    _junction(log, destino)
    with pytest.raises(NavegadorError, match="es un enlace"):
        navegador.verificar(_version())


def test_debug_log_con_otro_enlace_duro_se_rechaza(cft_falso, tmp_path):
    log = _instalado_con_log(cft_falso)
    log.write_bytes(b"x")
    os.link(log, tmp_path / "fuera.log")
    with pytest.raises(NavegadorError, match="otro enlace duro"):
        navegador.verificar(_version())


def test_manifiesto_que_lista_el_log_es_corrupto(cft_falso, tmp_path, monkeypatch):
    _instalado_con_log(cft_falso)
    manifiesto = _version() / config.NAVEGADOR_MANIFIESTO
    obj = json.loads(manifiesto.read_bytes())
    obj["ficheros"][config.NAVEGADOR_LOG] = "0" * 64
    datos = json.dumps(obj).encode()
    manifiesto.write_bytes(datos)
    monkeypatch.setattr(config, "NAVEGADOR_MANIFIESTO_SHA256", _sha(datos))
    with pytest.raises(NavegadorError, match="lista el log de Chrome"):
        navegador.verificar(_version())


def test_motor_y_backend_toleran_la_misma_ruta():
    fuente = (Path(__file__).parents[2] / "video-mcp-server" / "src" / "proceso.ts").read_text(encoding="utf-8")
    assert f'const LOG_CHROME = "{config.NAVEGADOR_LOG}";' in fuente


def test_verificar_rechaza_junction_dentro(cft_falso, tmp_path):
    _instalar_en(tmp_path / "v")
    (tmp_path / "centinela").mkdir()
    _junction(tmp_path / "v" / "chrome-headless-shell-win64" / "locales" / "x", tmp_path / "centinela")
    with pytest.raises(NavegadorError, match="enlace"):
        navegador.verificar(tmp_path / "v")


def test_instalado_ignora_extraccion_a_medias(cft_falso):
    _instalar_en(config.NAVEGADOR_DIR / ".extraccion-abc")
    assert navegador.instalado() is None
    _version().mkdir()
    (_version() / "chrome-headless-shell-win64").mkdir()
    (_version() / EXE).write_bytes(b"x")
    assert navegador.instalado() is None  # sin manifiesto


# ------------------------------------------------------------------ Tarea 3: instalación atómica


def test_instalar_publica_en_ruta_fija(cft_falso):
    ruta, _ = cft_falso
    fases = []
    exe = navegador.instalar_desde_zip(ruta, fases.append)
    assert exe == config.NAVEGADOR_DIR / "156.0.8078.73" / config.NAVEGADOR_EXE
    obj = json.loads((_version() / "MANIFIESTO-SHA256.json").read_bytes())
    assert set(obj) == {"version", "ficheros"} and obj["version"] == "156.0.8078.73"
    assert len(obj["ficheros"]) == 4
    assert _restos() == ["156.0.8078.73"]
    assert fases == ["verificando", "extrayendo"]
    assert navegador.instalado() == (exe, _version() / "MANIFIESTO-SHA256.json")


def test_zip_con_un_byte_cambiado_no_se_abre(cft_falso, tmp_path, monkeypatch):
    ruta, datos = cft_falso
    # El byte invertido va en el directorio central: ZipFile lo abriría sin quejarse de nada.
    cd = datos.rindex(b"PK\x01\x02")
    malo = bytearray(datos)
    malo[cd + 40] ^= 0x01
    ruta.write_bytes(bytes(malo))
    llamadas = []
    monkeypatch.setattr(navegador.zipfile, "ZipFile", lambda *a, **k: llamadas.append(a) or 1 / 0)
    with pytest.raises(NavegadorError) as e:
        navegador.instalar_desde_zip(ruta)
    assert str(e.value) == navegador.MENSAJE_HASH
    assert llamadas == []
    assert navegador.instalado() is None
    assert _restos() == []


def test_zip_con_hash_correcto_y_traversal_rechazado(tmp_path, monkeypatch):
    estado = tmp_path / "estado"
    monkeypatch.setattr(config, "STATE_DIR", estado)
    monkeypatch.setattr(config, "NAVEGADOR_DIR", estado / "video" / "navegador")
    contenido = {**CONTENIDO, "..\\..\\x.dll": b"malo"}
    zp = _zip(tmp_path / "malo.zip", contenido)
    _anclar(monkeypatch, zp.read_bytes(), CONTENIDO)
    with pytest.raises(NavegadorError, match="no permitida"):
        navegador.instalar_desde_zip(zp)
    assert list(tmp_path.rglob("x.dll")) == []
    assert navegador.instalado() is None and _restos() == []


def test_instalar_borra_versiones_anteriores(cft_falso):
    ruta, _ = cft_falso
    (config.NAVEGADOR_DIR / "152.0.7977.30").mkdir(parents=True)
    (config.NAVEGADOR_DIR / "152.0.7977.30" / "f.txt").write_text("x")
    (config.NAVEGADOR_DIR / ".extraccion-x").mkdir()
    navegador.instalar_desde_zip(ruta)
    assert _restos() == ["156.0.8078.73"]


def test_borrar_quita_solo_lectura(tmp_path):
    d = tmp_path / "d"
    (d / "sub").mkdir(parents=True)
    f = d / "sub" / "f.txt"
    f.write_text("x")
    os.chmod(f, 0o444)
    navegador._borrar(d)
    assert not d.exists()


def test_borrar_symlink_solo_quita_el_enlace(tmp_path):
    centinela = tmp_path / "centinela"
    centinela.mkdir()
    (centinela / "dentro.txt").write_text("x")
    d = tmp_path / "d"
    d.mkdir()
    try:
        os.symlink(centinela, d / "enlace", target_is_directory=True)
        os.symlink(centinela / "dentro.txt", d / "enlace-f")
    except OSError as e:
        pytest.skip(f"sin privilegio para symlinks: {e}")
    navegador._borrar(d)
    assert not d.exists() and (centinela / "dentro.txt").exists()


@solo_windows
def test_borrar_version_anterior_no_sigue_junctions(cft_falso, tmp_path):
    ruta, _ = cft_falso
    vieja = config.NAVEGADOR_DIR / "152.0.7977.30"
    vieja.mkdir(parents=True)
    (tmp_path / "centinela").mkdir()
    (tmp_path / "centinela" / "dentro.txt").write_text("x")
    _junction(vieja / "j", tmp_path / "centinela")
    navegador.instalar_desde_zip(ruta)
    assert (tmp_path / "centinela" / "dentro.txt").exists()
    assert _restos() == ["156.0.8078.73"]


@solo_windows
def test_version_anterior_que_es_junction_solo_quita_el_enlace(cft_falso, tmp_path):
    ruta, _ = cft_falso
    config.NAVEGADOR_DIR.mkdir(parents=True)
    (tmp_path / "centinela").mkdir()
    (tmp_path / "centinela" / "dentro.txt").write_text("x")
    _junction(config.NAVEGADOR_DIR / "152.0.7977.30", tmp_path / "centinela")
    navegador.instalar_desde_zip(ruta)
    assert (tmp_path / "centinela" / "dentro.txt").exists()
    assert _restos() == ["156.0.8078.73"]


@solo_windows
def test_version_actual_que_es_junction_no_se_usa(cft_falso, tmp_path):
    ruta, _ = cft_falso
    centinela = tmp_path / "centinela"
    _instalar_en(centinela)  # un CfT «válido» fuera de la ruta fija
    config.NAVEGADOR_DIR.mkdir(parents=True)
    _junction(_version(), centinela)
    assert navegador.instalado() is None
    navegador.instalar_desde_zip(ruta)
    assert not es_enlace(_version())
    assert (centinela / EXE).exists() and (centinela / config.NAVEGADOR_MANIFIESTO).exists()


@solo_windows
@pytest.mark.parametrize("cual", ["navegador", "video", "estado"])
def test_carpeta_navegador_junction_rechazada(cft_falso, tmp_path, cual):
    ruta, _ = cft_falso
    centinela = tmp_path / "centinela"
    centinela.mkdir()
    enlace = {"navegador": config.NAVEGADOR_DIR, "video": config.STATE_DIR / "video", "estado": config.STATE_DIR}[cual]
    enlace.parent.mkdir(parents=True, exist_ok=True)
    _junction(enlace, centinela)
    with pytest.raises(NavegadorError, match="enlace"):
        navegador.instalar_desde_zip(ruta)
    assert list(centinela.iterdir()) == []


def test_reinstalar_sustituye_atomicamente(cft_falso):
    ruta, _ = cft_falso
    exe = navegador.instalar_desde_zip(ruta)
    datos = bytearray(exe.read_bytes())
    datos[0] ^= 0xFF
    exe.write_bytes(bytes(datos))
    with pytest.raises(NavegadorError):
        navegador.verificar(_version())
    navegador.instalar_desde_zip(ruta)
    assert navegador.verificar(_version()) == exe
    assert _restos() == ["156.0.8078.73"]


def test_fallo_al_extraer_no_deja_version(cft_falso, monkeypatch):
    ruta, _ = cft_falso

    def extraer_que_llena_el_disco(zf, destino):
        (destino / "medio").write_bytes(b"x")
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(navegador, "extraer", extraer_que_llena_el_disco)
    with pytest.raises(NavegadorError):
        navegador.instalar_desde_zip(ruta)
    assert navegador.instalado() is None and _restos() == []


def test_publicar_reintenta_si_el_antivirus_bloquea(cft_falso, monkeypatch):
    ruta, _ = cft_falso
    original = os.replace
    fallos = [PermissionError(13, "en uso"), PermissionError(13, "en uso")]

    def replace(src, dst):
        if fallos and ".extraccion-" in str(src):
            raise fallos.pop()
        return original(src, dst)

    monkeypatch.setattr(kb_update.os, "replace", replace)
    monkeypatch.setattr(kb_update.time, "sleep", lambda s: None)
    exe = navegador.instalar_desde_zip(ruta)
    assert fallos == [] and navegador.verificar(_version()) == exe


def test_si_no_verifica_tras_publicar_se_borra(cft_falso, monkeypatch):
    """Tras el renombrado se verifica la carpeta publicada; si falla, se borra y se da el error."""
    ruta, _ = cft_falso
    original = navegador.verificar
    llamadas = []

    def falla_la_segunda(carpeta):
        llamadas.append(carpeta)
        if len(llamadas) == 2:
            raise navegador._corrupto("cambiado tras publicar")
        return original(carpeta)

    monkeypatch.setattr(navegador, "verificar", falla_la_segunda)
    with pytest.raises(NavegadorError, match="cambiado tras publicar"):
        navegador.instalar_desde_zip(ruta)
    assert llamadas[1] == _version()
    assert navegador.instalado() is None and _restos() == []


def test_sin_espacio_error_legible(cft_falso, monkeypatch):
    ruta, _ = cft_falso
    monkeypatch.setattr(navegador.shutil, "disk_usage", lambda p: shutil._ntuple_diskusage(10, 9, 1))
    with pytest.raises(NavegadorError, match="espacio"):
        navegador.instalar_desde_zip(ruta)
    assert _restos() == []


def test_limpiar_restos(cft_falso):
    ruta, _ = cft_falso
    navegador.instalar_desde_zip(ruta)
    (config.NAVEGADOR_DIR / ".descarga-a.zip").write_bytes(b"x")
    (config.NAVEGADOR_DIR / ".extraccion-b").mkdir()
    (config.NAVEGADOR_DIR / ".viejo-c").mkdir()
    navegador.limpiar_restos()
    assert _restos() == ["156.0.8078.73"]


def test_limpiar_restos_sin_carpeta_no_falla(cft_falso):
    navegador.limpiar_restos()
    assert not config.NAVEGADOR_DIR.exists()


def test_limpiar_restos_respeta_el_candado(cft_falso):
    config.NAVEGADOR_DIR.mkdir(parents=True)
    (config.NAVEGADOR_DIR / ".descarga-a.zip").write_bytes(b"x")
    with navegador._candado():
        navegador.limpiar_restos()
    assert _restos() == [".descarga-a.zip"]


def test_candado_que_no_se_puede_abrir_es_error_legible(cft_falso, monkeypatch):
    config.NAVEGADOR_DIR.mkdir(parents=True)

    def os_open(*a, **k):
        raise PermissionError(13, "Acceso denegado")

    monkeypatch.setattr(navegador.os, "open", os_open)
    with pytest.raises(NavegadorError, match="Acceso denegado"), navegador._candado():
        pass


@solo_windows
def test_borrar_junction_da_error_claro_si_falla(tmp_path, monkeypatch):
    """Una junction se quita con rmdir; si rmdir falla, el error es ese y no uno confuso de unlink."""
    (tmp_path / "centinela").mkdir()
    _junction(tmp_path / "j", tmp_path / "centinela")
    llamadas = []
    monkeypatch.setattr(navegador.os, "unlink", lambda p: llamadas.append(("unlink", p)))
    navegador._borrar(tmp_path / "j")
    assert llamadas == [] and not (tmp_path / "j").exists() and (tmp_path / "centinela").is_dir()


def test_instalar_con_candado_ocupado_error_legible(cft_falso):
    ruta, _ = cft_falso
    config.NAVEGADOR_DIR.mkdir(parents=True)
    with navegador._candado(), pytest.raises(NavegadorError) as e:
        navegador.instalar_desde_zip(ruta)
    assert str(e.value) == navegador.MENSAJE_OCUPADO
    assert navegador.instalado() is None


# ------------------------------------------------------------------ Tarea 4: descarga y Descargador


class _Transporte(httpx.MockTransport):
    """MockTransport que anota cada petición."""

    def __init__(self, handler):
        self.peticiones: list[httpx.Request] = []

        def anotar(request):
            self.peticiones.append(request)
            return handler(request)

        super().__init__(anotar)


def _trozos(datos: bytes, n: int = 3) -> list[bytes]:
    paso = max(1, len(datos) // n + 1)
    return [datos[i : i + paso] for i in range(0, len(datos), paso)]


def _sirve(datos: bytes) -> _Transporte:
    return _Transporte(lambda r: httpx.Response(200, content=iter(_trozos(datos))))


def _espia_zipfile(monkeypatch) -> list:
    llamadas: list = []
    original = zipfile.ZipFile

    def espia(*a, **k):
        llamadas.append(a)
        return original(*a, **k)

    monkeypatch.setattr(navegador.zipfile, "ZipFile", espia)
    return llamadas


def test_descarga_ok_instala_y_reporta_progreso(cft_falso, monkeypatch):
    _, datos = cft_falso
    t = _sirve(datos)
    avances: list[int] = []
    original = navegador.Descargador._avance

    def anotar(self, n):
        avances.append(n)
        original(self, n)

    monkeypatch.setattr(navegador.Descargador, "_avance", anotar)
    d = navegador.Descargador(t)
    assert d.estado() == {
        "version": "156.0.8078.73",
        "tamano": len(datos),
        "estado": "ausente",
        "descargado": 0,
        "error": None,
    }
    assert d.reservar()
    assert d.estado()["estado"] == "descargando"
    d.ejecutar()
    e = d.estado()
    assert e["estado"] == "listo" and e["error"] is None and e["descargado"] == len(datos)
    assert avances == sorted(avances) and len(avances) >= 2 and avances[-1] == len(datos)
    assert [(r.method, str(r.url)) for r in t.peticiones] == [("GET", config.NAVEGADOR_URL)]
    assert navegador.instalado() is not None and _restos() == ["156.0.8078.73"]


def test_sin_redirecciones(cft_falso):
    t = _Transporte(lambda r: httpx.Response(302, headers={"Location": "https://evil.test/x.zip"}))
    d = navegador.Descargador(t)
    d.reservar()
    d.ejecutar()
    assert d.estado()["estado"] == "error" and "respondió 302" in d.estado()["error"]
    assert len(t.peticiones) == 1 and t.peticiones[0].url.host == "storage.googleapis.com"
    assert _restos() == []


def test_descarga_mas_grande_que_el_maximo(cft_falso, monkeypatch):
    llamadas = _espia_zipfile(monkeypatch)
    cuerpo = b"x" * (config.NAVEGADOR_MAX_DESCARGA + 1)
    t = _Transporte(lambda r: httpx.Response(200, content=iter(_trozos(cuerpo, 5))))
    d = navegador.Descargador(t)
    d.reservar()
    d.ejecutar()
    assert d.estado()["error"] == navegador.MENSAJE_GRANDE
    assert _restos() == [] and llamadas == []


def test_content_length_excesivo_no_se_lee(cft_falso):
    def no_leer():
        raise AssertionError("no debía leerse el cuerpo")
        yield b""  # pragma: no cover

    t = _Transporte(
        lambda r: httpx.Response(200, headers={"Content-Length": str(10**12)}, content=no_leer())
    )
    d = navegador.Descargador(t)
    d.reservar()
    d.ejecutar()
    assert d.estado()["error"] == navegador.MENSAJE_GRANDE
    assert _restos() == []


def test_descarga_pide_identity_y_rechaza_content_encoding(cft_falso):
    _, datos = cft_falso
    t = _Transporte(lambda r: httpx.Response(200, headers={"Content-Encoding": "gzip"}, content=iter([datos])))
    d = navegador.Descargador(t)
    d.reservar()
    d.ejecutar()
    assert t.peticiones[0].headers["accept-encoding"] == "identity"
    assert d.estado()["estado"] == "error" and "gzip" in d.estado()["error"]
    assert _restos() == []


def test_descarga_lee_los_bytes_sin_descomprimir(cft_falso, monkeypatch):
    """`iter_raw`: lo que se hashea es lo que llegó por la red, nunca una descompresión de httpx."""
    _, datos = cft_falso
    monkeypatch.setattr(
        httpx.Response, "iter_bytes", lambda self, *a, **k: (_ for _ in ()).throw(AssertionError("iter_bytes"))
    )
    d = navegador.Descargador(_sirve(datos))
    d.reservar()
    d.ejecutar()
    assert d.estado()["estado"] == "listo"


def test_descarga_con_plazo_total_vencido(cft_falso, monkeypatch):
    _, datos = cft_falso
    monkeypatch.setattr(navegador, "PLAZO_DESCARGA", -1.0)
    d = navegador.Descargador(_sirve(datos))
    d.reservar()
    d.ejecutar()
    assert d.estado()["error"] == navegador.MENSAJE_PLAZO
    assert _restos() == []


def test_plazo_total_de_media_hora():
    assert navegador.PLAZO_DESCARGA == 30 * 60


def test_descarga_hash_distinto_no_extrae(cft_falso, monkeypatch):
    _, datos = cft_falso
    malo = bytearray(datos)
    malo[len(malo) // 2] ^= 0x01
    llamadas = _espia_zipfile(monkeypatch)
    d = navegador.Descargador(_sirve(bytes(malo)))
    d.reservar()
    d.ejecutar()
    assert d.estado()["error"] == navegador.MENSAJE_HASH
    assert llamadas == [] and navegador.instalado() is None and _restos() == []


def test_sin_red_error_claro(cft_falso):
    _, datos = cft_falso

    def sin_red(request):
        raise httpx.ConnectError("getaddrinfo failed", request=request)

    d = navegador.Descargador(_Transporte(sin_red))
    d.reservar()
    d.ejecutar()
    assert d.estado()["estado"] == "error" and d.estado()["error"] == navegador.MENSAJE_SIN_RED
    # Reintento: lo decide el usuario con otra petición.
    d._transporte = _sirve(datos)
    assert d.reservar()
    d.ejecutar()
    assert d.estado()["estado"] == "listo" and d.estado()["error"] is None


def test_corte_a_mitad_borra_temporal(cft_falso):
    _, datos = cft_falso

    def cortado():
        yield datos[: len(datos) // 2]
        raise httpx.ReadError("conexión cortada")

    d = navegador.Descargador(_Transporte(lambda r: httpx.Response(200, content=cortado())))
    d.reservar()
    d.ejecutar()
    assert d.estado()["error"] == navegador.MENSAJE_SIN_RED
    assert _restos() == []


def _certificado(carpeta: Path) -> tuple[Path, Path]:
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    clave = ec.generate_private_key(ec.SECP256R1())
    nombre = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
    ahora = datetime.datetime.now(datetime.UTC)
    san = x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))])
    cert = (
        x509.CertificateBuilder()
        .subject_name(nombre)
        .issuer_name(nombre)
        .public_key(clave.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(ahora - datetime.timedelta(minutes=5))
        .not_valid_after(ahora + datetime.timedelta(hours=1))
        .add_extension(san, critical=False)
        .sign(clave, hashes.SHA256())
    )
    crt, key = carpeta / "c.pem", carpeta / "k.pem"
    crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key.write_bytes(
        clave.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return crt, key


def test_tls_no_verificado_falla(cft_falso, tmp_path, monkeypatch):
    # Sin esto, un proxy del sistema podría interceptar 127.0.0.1 y el error no sería el de TLS.
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("no_proxy", "127.0.0.1")
    crt, key = _certificado(tmp_path)
    recibidas: list[str] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            recibidas.append(self.path)
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass

    servidor = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    servidor.socket = ctx.wrap_socket(servidor.socket, server_side=True)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    try:
        puerto = servidor.server_address[1]
        monkeypatch.setattr(config, "NAVEGADOR_URL", f"https://127.0.0.1:{puerto}/x.zip")
        monkeypatch.setattr(navegador, "PREFIJO_URL", f"https://127.0.0.1:{puerto}/")
        d = navegador.Descargador()  # cliente real, verificación TLS por defecto
        d.reservar()
        d.ejecutar()
    finally:
        servidor.shutdown()
        servidor.server_close()
    assert d.estado()["error"] == navegador.MENSAJE_TLS
    assert recibidas == []


def test_solo_https_de_storage(cft_falso, monkeypatch):
    monkeypatch.setattr(config, "NAVEGADOR_URL", "http://127.0.0.1:9/x.zip")
    t = _sirve(b"")
    d = navegador.Descargador(t)
    d.reservar()
    d.ejecutar()
    assert d.estado()["estado"] == "error" and t.peticiones == []


def test_reservar_impide_dos_descargas(cft_falso):
    d = navegador.Descargador(_sirve(b""))
    assert d.reservar() is True
    assert d.reservar() is False


def test_ya_instalado_no_descarga(cft_falso):
    ruta, _ = cft_falso
    navegador.instalar_desde_zip(ruta)

    def no_llamar(request):
        raise AssertionError("no debía tocar la red")

    t = _Transporte(no_llamar)
    d = navegador.Descargador(t)
    assert d.estado()["estado"] == "listo"
    d.reservar()
    d.ejecutar()
    assert d.estado()["estado"] == "listo" and d.estado()["descargado"] == 0 and t.peticiones == []


def test_instalado_pero_corrupto_se_descarga_de_nuevo(cft_falso):
    ruta, datos = cft_falso
    exe = navegador.instalar_desde_zip(ruta)
    exe.write_bytes(b"cambiado")
    d = navegador.Descargador(_sirve(datos))
    d.reservar()
    d.ejecutar()
    assert d.estado()["estado"] == "listo" and navegador.verificar(_version()) == exe


def test_descarga_con_candado_ocupado_error_legible(cft_falso):
    _, datos = cft_falso
    t = _sirve(datos)
    d = navegador.Descargador(t)
    config.NAVEGADOR_DIR.mkdir(parents=True)
    with navegador._candado():
        d.reservar()
        d.ejecutar()
    assert d.estado()["error"] == navegador.MENSAJE_OCUPADO and t.peticiones == []


def test_error_inesperado_es_legible(cft_falso, monkeypatch):
    def roto(cliente, al_avanzar):
        raise ZeroDivisionError

    monkeypatch.setattr(navegador, "descargar", roto)
    d = navegador.Descargador(_sirve(b""))
    d.reservar()
    d.ejecutar()
    assert d.estado()["error"] == "Error inesperado al instalar el navegador: ZeroDivisionError"


# ------------------------------------------------------------------ Tarea 5: rutas REST


@contextlib.asynccontextmanager
async def _app(tmp_path, fake_anthropic, transporte=None):
    app = create_app(
        TOKEN,
        client_factory=fake_anthropic([]).factory,
        jobs_path=tmp_path / "jobs.sqlite",
        kb_auto_update=False,
        conversaciones_dir=tmp_path / "conversaciones",
        navegador_transport=transporte,
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c,
    ):
        yield app, c


async def _hasta_fin(c) -> dict:
    for _ in range(200):
        e = (await c.get("/video/navegador", headers=AUTH)).json()
        if e["estado"] in ("listo", "error"):
            return e
        await asyncio.sleep(0.025)
    raise AssertionError(f"la descarga no terminó: {e}")


async def test_get_navegador_ausente(cft_falso, tmp_path, fake_anthropic):
    _, datos = cft_falso
    async with _app(tmp_path, fake_anthropic) as (_, c):
        r = await c.get("/video/navegador", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {
        "version": "156.0.8078.73",
        "tamano": len(datos),
        "estado": "ausente",
        "descargado": 0,
        "error": None,
    }


async def test_post_descarga_202_y_llega_a_listo(cft_falso, tmp_path, fake_anthropic):
    _, datos = cft_falso
    t = _sirve(datos)
    async with _app(tmp_path, fake_anthropic, t) as (_, c):
        r = await c.post("/video/navegador/descarga", headers=AUTH)
        assert r.status_code == 202 and r.json()["estado"] == "descargando"
        e = await _hasta_fin(c)
    assert e["estado"] == "listo" and e["descargado"] == len(datos)
    assert len(t.peticiones) == 1 and navegador.instalado() is not None


async def test_post_mientras_descarga_409(cft_falso, tmp_path, fake_anthropic):
    _, datos = cft_falso
    soltar = threading.Event()

    def lenta(request):
        soltar.wait(10)
        return httpx.Response(200, content=iter([datos]))

    t = _Transporte(lenta)
    async with _app(tmp_path, fake_anthropic, t) as (_, c):
        assert (await c.post("/video/navegador/descarga", headers=AUTH)).status_code == 202
        r = await c.post("/video/navegador/descarga", headers=AUTH)
        assert r.status_code == 409 and "en curso" in r.json()["detail"]
        soltar.set()
        assert (await _hasta_fin(c))["estado"] == "listo"
    assert len(t.peticiones) == 1


async def test_post_tras_error_reintenta(cft_falso, tmp_path, fake_anthropic):
    _, datos = cft_falso
    intentos = []

    def primero_falla(request):
        intentos.append(1)
        if len(intentos) == 1:
            raise httpx.ConnectError("sin red", request=request)
        return httpx.Response(200, content=iter([datos]))

    async with _app(tmp_path, fake_anthropic, _Transporte(primero_falla)) as (_, c):
        await c.post("/video/navegador/descarga", headers=AUTH)
        e = await _hasta_fin(c)
        assert e["estado"] == "error" and e["error"] == navegador.MENSAJE_SIN_RED
        assert (await c.post("/video/navegador/descarga", headers=AUTH)).status_code == 202
        assert (await _hasta_fin(c))["estado"] == "listo"


async def test_rutas_del_navegador_exigen_token(cft_falso, tmp_path, fake_anthropic):
    t = _sirve(b"")
    async with _app(tmp_path, fake_anthropic, t) as (_, c):
        assert (await c.get("/video/navegador")).status_code == 401
        assert (await c.post("/video/navegador/descarga")).status_code == 401
        malo = {"Authorization": "Bearer otro"}
        assert (await c.post("/video/navegador/descarga", headers=malo)).status_code == 401
    assert t.peticiones == []


async def test_el_modelo_no_puede_descargar_el_navegador(cft_falso, tmp_path, fake_anthropic):
    """D2/I10/I14: ni tool ni tipo de job; la descarga solo la inicia el usuario por REST."""
    for s in registry.build():
        texto = f"{s.name} {s.description}".lower()
        assert not any(p in texto for p in ("navegador", "chrome", "cft")), s.name
    assert "navegador" not in registry.JOB_KINDS.values()
    t = _sirve(b"")
    async with _app(tmp_path, fake_anthropic, t) as (_, c):
        r = await c.post("/jobs", json={"kind": "navegador", "args": {}}, headers=AUTH)
        assert r.status_code == 400
    assert t.peticiones == []


async def test_post_sin_modulo_instalado_503(cft_falso, tmp_path, fake_anthropic, monkeypatch):
    d = tmp_path / "video-engine"
    d.mkdir()
    monkeypatch.setattr(config, "FROZEN", True)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", d)
    t = _sirve(b"")
    async with _app(tmp_path, fake_anthropic, t) as (_, c):
        r = await c.post("/video/navegador/descarga", headers=AUTH)
        assert r.status_code == 503 and r.json()["detail"] == video.MENSAJE_NO_INSTALADO
        assert (await c.get("/video/navegador", headers=AUTH)).json()["estado"] == "ausente"
    assert t.peticiones == []


async def test_arranque_limpia_restos_sin_descargar(cft_falso, tmp_path, fake_anthropic):
    """I14: arrancar el backend no toca la red; solo borra restos de una ejecución anterior."""
    config.NAVEGADOR_DIR.mkdir(parents=True)
    (config.NAVEGADOR_DIR / ".descarga-x.zip").write_bytes(b"x")
    t = _sirve(b"")
    async with _app(tmp_path, fake_anthropic, t) as (_, c):
        assert (await c.get("/video/navegador", headers=AUTH)).json()["estado"] == "ausente"
    assert _restos() == [] and t.peticiones == []


async def test_entorno_del_motor_fuera_del_bucle_de_eventos(cft_falso, tmp_path, fake_anthropic, monkeypatch):
    """M5: `entorno_motor` hashea ~295 MB; mientras, el resto de rutas siguen respondiendo."""
    monkeypatch.setenv("APP_BACKEND_VIDEO_CMD", f'["{(tmp_path / "no-existe.exe").as_posix()}"]')

    def lento(store):
        time.sleep(1)
        return {}

    monkeypatch.setattr(video, "entorno_motor", lento)
    async with _app(tmp_path, fake_anthropic) as (_, c):
        capacidades = asyncio.create_task(c.get("/video/capacidades", headers=AUTH))
        await asyncio.sleep(0.1)
        t0 = time.perf_counter()
        r = await c.get("/video/navegador", headers=AUTH)
        dt = time.perf_counter() - t0
        assert r.status_code == 200 and dt < 0.2, dt
        assert (await capacidades).status_code == 503


# ------------------------------------------------------------------ Tarea 6: entorno del motor


class _Store:
    def get(self, clave):
        return None


def _bundle_con_navegadores(d: Path) -> Path:
    """`video-engine/` de una instalación antigua: Node, ffmpeg y dos Chrome bajo `browser/`."""
    for p in (
        "node/node.exe",
        "ffmpeg/ffmpeg.exe",
        "ffmpeg/ffprobe.exe",
        "browser/x/chrome.exe",
        "browser/chrome-headless-shell-win64/chrome-headless-shell.exe",
    ):
        (d / p).parent.mkdir(parents=True, exist_ok=True)
        (d / p).write_bytes(b"")
    return d


def _rutas_fijas() -> tuple[str, str]:
    return str(_version() / config.NAVEGADOR_EXE), str(_version() / "MANIFIESTO-SHA256.json")


@pytest.mark.parametrize("congelado", [True, False])
def test_entorno_sin_cft(cft_falso, tmp_path, monkeypatch, congelado):
    """Sin CfT el motor arranca igual (ruling C3): recibe la ruta fija, que no existe, y cada CLI falla
    cerrado. Nunca un navegador del bundle, del entorno o de una caché (I11, I13, I14)."""
    d = _bundle_con_navegadores(tmp_path / "video-engine")
    monkeypatch.setattr(config, "FROZEN", congelado)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", d)
    otro = str(d / "browser" / "x" / "chrome.exe")
    for var in ("HYPERFRAMES_BROWSER_PATH", "PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH", "VIDEO_NAVEGADOR_MANIFIESTO"):
        monkeypatch.setenv(var, otro)
    env = video.entorno_motor(_Store())
    exe, manifiesto = _rutas_fijas()
    assert env["HYPERFRAMES_BROWSER_PATH"] == exe and not Path(exe).exists()
    assert env["VIDEO_NAVEGADOR_MANIFIESTO"] == manifiesto
    for valor in env.values():
        assert not any(t in valor.lower() for t in ("browser", ".cache", "program files")), valor


@pytest.mark.parametrize("congelado", [True, False])
def test_entorno_sin_cft_enlace_colgante_sigue_cayendo(cft_falso, tmp_path, monkeypatch, congelado):
    """`lexists`→`verificar` se conserva: una carpeta de versión que es un enlace roto no pasa por «sin CfT»."""
    if sys.platform != "win32":
        pytest.skip("enlaces de Windows")
    d = _bundle_con_navegadores(tmp_path / "video-engine")
    monkeypatch.setattr(config, "FROZEN", congelado)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", d)
    destino = tmp_path / "destino"
    destino.mkdir()
    _version().parent.mkdir(parents=True, exist_ok=True)
    _junction(_version(), destino)
    destino.rmdir()
    with pytest.raises(video.MotorNoDisponible):
        video.entorno_motor(_Store())


def test_entorno_usa_solo_la_ruta_fija(cft_falso, tmp_path, monkeypatch):
    ruta, _ = cft_falso
    d = _bundle_con_navegadores(tmp_path / "video-engine")
    monkeypatch.setattr(config, "FROZEN", True)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", d)
    monkeypatch.setenv("HYPERFRAMES_BROWSER_PATH", str(d / "browser" / "x" / "chrome.exe"))
    navegador.instalar_desde_zip(ruta)
    env = video.entorno_motor(_Store())
    assert (env["HYPERFRAMES_BROWSER_PATH"], env["VIDEO_NAVEGADOR_MANIFIESTO"]) == _rutas_fijas()
    assert Path(env["HYPERFRAMES_BROWSER_PATH"]).is_file()
    assert env["FFMPEG_DIR"] == str(d / "ffmpeg")


def test_entorno_navegador_corrupto_es_motor_no_disponible(cft_falso):
    ruta, _ = cft_falso
    navegador.instalar_desde_zip(ruta)
    (_version() / "chrome-headless-shell-win64" / "evil.dll").write_bytes(b"mal")
    with pytest.raises(video.MotorNoDisponible, match="vuelve a descargarlo"):
        video.entorno_motor(_Store())


def test_entorno_navegador_a_medias_es_motor_no_disponible(cft_falso):
    """Una carpeta de versión sin manifiesto (o que sea un enlace) no se pasa al motor como buena."""
    _version().mkdir(parents=True)
    with pytest.raises(video.MotorNoDisponible, match="vuelve a descargarlo"):
        video.entorno_motor(_Store())


@solo_windows
@pytest.mark.parametrize("cual", ["navegador", "video", "estado"])
@pytest.mark.parametrize("congelado", [True, False])
def test_entorno_con_ancestro_enlazado_es_motor_no_disponible(cft_falso, tmp_path, monkeypatch, cual, congelado):
    """LOW-1: si `<estado>`, `<estado>/video` o la carpeta del navegador es un enlace, no se usa."""
    centinela = tmp_path / "centinela"
    centinela.mkdir()
    monkeypatch.setattr(config, "FROZEN", congelado)
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", _bundle_con_navegadores(tmp_path / "video-engine"))
    enlace = {"navegador": config.NAVEGADOR_DIR, "video": config.STATE_DIR / "video", "estado": config.STATE_DIR}[cual]
    enlace.parent.mkdir(parents=True, exist_ok=True)
    _junction(enlace, centinela)
    with pytest.raises(video.MotorNoDisponible, match="enlace"):
        video.entorno_motor(_Store())


def test_video_ya_no_busca_navegadores():
    """C6: nada de `rglob` ni de `browser/` en video.py."""
    fuente = Path(video.__file__).read_text(encoding="utf-8")
    assert "rglob" not in fuente and "_navegador_bundle" not in fuente and '"browser"' not in fuente


def _referencias_a_navegador(fuente: str) -> set[str]:
    """Nombres de `navegador` que usa un módulo de `app_backend`, resolviendo alias e imports
    relativos: `navegador.X`, `nv.X` (con `as`), `app_backend.navegador.X`, `from .navegador import X`…
    Cualquier enlace al propio módulo añade «<módulo>»."""
    arbol = ast.parse(fuente)
    nombres: set[str] = set()
    alias_modulo: set[str] = set()  # nombres locales ligados al módulo navegador
    via_paquete = False  # `import app_backend.navegador` sin alias: se usa como app_backend.navegador.X

    def paquete(n: ast.ImportFrom) -> str:
        # `from . import x` dentro de app_backend → «app_backend»; `from .navegador import x` → «app_backend.navegador».
        if n.level:
            return "app_backend" + (f".{n.module}" if n.module else "")
        return n.module or ""

    for n in ast.walk(arbol):
        if isinstance(n, ast.ImportFrom):
            origen = paquete(n)
            if origen == "app_backend.navegador":
                nombres |= {a.name for a in n.names}
            elif origen == "app_backend":
                for a in n.names:
                    if a.name == "navegador":
                        nombres.add("<módulo>")
                        alias_modulo.add(a.asname or a.name)
        elif isinstance(n, ast.Import):
            for a in n.names:
                if a.name == "app_backend.navegador":
                    nombres.add("<módulo>")
                    if a.asname:
                        alias_modulo.add(a.asname)
                    else:
                        via_paquete = True
    for n in ast.walk(arbol):
        if not isinstance(n, ast.Attribute):
            continue
        v = n.value
        por_alias = isinstance(v, ast.Name) and v.id in alias_modulo
        por_paquete = (
            via_paquete
            and isinstance(v, ast.Attribute)
            and v.attr == "navegador"
            and isinstance(v.value, ast.Name)
            and v.value.id == "app_backend"
        )
        if por_alias or por_paquete:
            nombres.add(n.attr)
    return nombres


@pytest.mark.parametrize(
    "fuente",
    [
        "from app_backend import navegador\nnavegador.Descargador()",
        "from . import navegador\nnavegador.Descargador()",
        "from .navegador import Descargador",
        "from app_backend.navegador import Descargador as D",
        "from app_backend import navegador as nv\nnv.Descargador()",
        "from . import navegador as nv\nnv.Descargador()",
        "import app_backend.navegador as nv\nnv.Descargador",
        "import app_backend.navegador\napp_backend.navegador.Descargador()",
    ],
)
def test_el_detector_de_usos_ve_alias_e_imports_relativos(fuente):
    assert "Descargador" in _referencias_a_navegador(fuente)


def test_quien_puede_usar_el_navegador():
    """I10: solo main.py descarga; video.py solo consulta; nada más (registry, tools) lo importa."""
    carpeta = Path(navegador.__file__).parent
    usos = {
        p.name: _referencias_a_navegador(p.read_text(encoding="utf-8"))
        for p in carpeta.glob("*.py")
        if p.name != "navegador.py"
    }
    assert usos.pop("main.py") - {"<módulo>"} <= {"Descargador", "limpiar_restos"}
    assert usos.pop("video.py") - {"<módulo>"} <= {"instalado", "verificar", "comprobar_ancestros", "NavegadorError"}
    assert {m: u for m, u in usos.items() if u} == {}
