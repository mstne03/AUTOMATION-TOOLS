"""T6 · R0-6: en Windows el backend no lee `/proc` (existe `C:\\proc` en alguna máquina y Python lo resolvería) y
pide el barrido de procesos al motor con `video_barrer_procesos`."""

import sys
from pathlib import Path

import pytest

from app_backend import video, video_rest


@pytest.fixture
def sin_psutil(monkeypatch):
    monkeypatch.setitem(sys.modules, "psutil", None)  # `import psutil` lanza ImportError


def test_no_lee_proc_en_win32(monkeypatch, sin_psutil):
    leidas: list[str] = []

    class Espia(type(Path())):  # pragma: no cover - solo si algo lee /proc
        def __new__(cls, *args, **kwargs):
            leidas.append(str(args[0]) if args else "")
            return super().__new__(cls, *args, **kwargs)

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(video, "Path", Espia)
    assert video._descendientes(4242) == []
    assert not [r for r in leidas if "proc" in r.lower()], f"se leyó /proc en win32: {leidas}"


def test_en_linux_sigue_el_respaldo_por_proc(monkeypatch, sin_psutil, tmp_path):
    # Fuera de Windows el respaldo por /proc se conserva: con un /proc inexistente, vacío y sin error.
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(video, "Path", lambda *_a: tmp_path / "no-hay-proc")
    assert video._descendientes(1) == []


def test_el_barrido_se_pide_por_la_tool_del_motor():
    assert video_rest.TOOL_BARRIDO == "video_barrer_procesos"
    assert "TODO(T6)" not in Path(video_rest.__file__).read_text(encoding="utf-8")
