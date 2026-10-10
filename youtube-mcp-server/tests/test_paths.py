"""Tests for the allowed-folders list shared by every file-reading tool."""

import os

import pytest

from youtube_mcp.utils import paths


@pytest.fixture
def carpetas(tmp_path, monkeypatch):
    smooth = tmp_path / "Smooth"
    candisito = tmp_path / "Candisito"
    otros = tmp_path / "Otros"
    for c in (smooth, candisito, otros):
        c.mkdir()
    (smooth / "video137.mp4").write_bytes(b"x")
    (candisito / "tiktok128.mp4").write_bytes(b"x")
    (otros / "thumb.png").write_bytes(b"x")
    monkeypatch.setenv(
        paths.ENV_VAR,
        os.pathsep.join([f"{smooth}=en", f'"{candisito}=ES"', str(otros)]),
    )
    return smooth, candisito, otros


def test_sin_configurar_deniega_todo(monkeypatch, tmp_path):
    monkeypatch.delenv(paths.ENV_VAR, raising=False)
    f = tmp_path / "a.mp4"
    f.write_bytes(b"x")
    with pytest.raises(paths.AccessDeniedError, match="No allowed folders configured"):
        paths.resolve_allowed(str(f))


def test_parsea_idiomas(carpetas):
    smooth, candisito, otros = carpetas
    assert paths.allowed_dirs() == {
        smooth.resolve(): "en",
        candisito.resolve(): "es",
        otros.resolve(): None,
    }


def test_nombre_corto_se_busca_en_las_carpetas(carpetas):
    smooth, candisito, _ = carpetas
    assert paths.resolve_allowed("video137") == ((smooth / "video137.mp4").resolve(), "en")
    assert paths.resolve_allowed("tiktok128.mp4") == (
        (candisito / "tiktok128.mp4").resolve(),
        "es",
    )


def test_ruta_absoluta_permitida(carpetas):
    _, _, otros = carpetas
    ruta, idioma = paths.resolve_allowed(str(otros / "thumb.png"))
    assert ruta == (otros / "thumb.png").resolve()
    assert idioma is None


def test_ruta_fuera(carpetas, tmp_path):
    fuera = tmp_path / "fuera.mp4"
    fuera.write_bytes(b"x")
    with pytest.raises(paths.AccessDeniedError, match="outside the allowed folders"):
        paths.resolve_allowed(str(fuera))


def test_no_se_escapa_con_puntos(carpetas, tmp_path):
    smooth, _, _ = carpetas
    (tmp_path / "secreto.mp4").write_bytes(b"x")
    with pytest.raises(paths.AccessDeniedError, match="outside the allowed folders"):
        paths.resolve_allowed(str(smooth / ".." / "secreto.mp4"))


def test_ruta_relativa_con_carpeta_rechazada(carpetas):
    with pytest.raises(paths.AccessDeniedError, match="relative path"):
        paths.resolve_allowed("sub/video137.mp4")


def test_nombre_no_encontrado(carpetas):
    with pytest.raises(paths.AccessDeniedError, match="File not found"):
        paths.resolve_allowed("clip5")


def test_absoluta_inexistente_dentro(carpetas):
    smooth, _, _ = carpetas
    with pytest.raises(paths.AccessDeniedError, match="File not found"):
        paths.resolve_allowed(str(smooth / "nada.mp4"))
