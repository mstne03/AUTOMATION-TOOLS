"""Chrome for Testing en el primer uso (SEO-108): extracción, verificación, instalación y descarga.

Ningún test toca la red: zips fabricados aquí, `httpx.MockTransport` o un servidor en 127.0.0.1.
"""

import ast
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from app_backend import config, kb_update, navegador
from app_backend.navegador import NavegadorError, es_enlace, extraer, nombre_valido

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


def test_extraer_tope_de_tamano_con_cabecera_mentirosa(tmp_path, monkeypatch):
    """La cabecera dice 1 byte y el contenido real son 11: cuentan los bytes reales."""
    monkeypatch.setattr(config, "NAVEGADOR_MAX_EXTRAIDO", 10)
    zp = _zip(tmp_path / "a.zip", {EXE: b"x" * 11})
    destino = tmp_path / "d"
    destino.mkdir()
    with zipfile.ZipFile(zp) as zf:
        zf.infolist()[0].file_size = 1
        with pytest.raises(NavegadorError):
            extraer(zf, destino)


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


def test_instalar_con_candado_ocupado_error_legible(cft_falso):
    ruta, _ = cft_falso
    config.NAVEGADOR_DIR.mkdir(parents=True)
    with navegador._candado(), pytest.raises(NavegadorError) as e:
        navegador.instalar_desde_zip(ruta)
    assert str(e.value) == navegador.MENSAJE_OCUPADO
    assert navegador.instalado() is None
