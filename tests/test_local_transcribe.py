"""Tests for transcribe_local path rules and output shape (no real model)."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pytest

from youtube_mcp.tools import local_transcribe as lt


@pytest.fixture
def carpetas(tmp_path):
    """Sustituye C:\\Ferguson, C:\\Adobe y C:\\Kanye por carpetas temporales."""
    ferguson = tmp_path / "Ferguson"
    adobe = tmp_path / "Adobe"
    kanye = tmp_path / "Kanye"
    for c in (ferguson, adobe, kanye):
        c.mkdir()
    for f in (
        ferguson / "video137.mp4",
        adobe / "tiktok128.mp4",
        adobe / "youtube12.mp4",
        kanye / "kanye1.mp4",
    ):
        f.write_bytes(b"x")
    (ferguson / "notas.txt").write_text("x")
    with patch.object(lt, "_CARPETAS", {ferguson: "en", adobe: "es", kanye: None}), patch.object(
        lt,
        "_NOMBRES",
        [(lt._NOMBRES[0][0], ferguson), (lt._NOMBRES[1][0], adobe), (lt._NOMBRES[2][0], kanye)],
    ):
        yield ferguson, adobe


class TestResolverRuta:
    def test_nombre_video_va_a_ferguson_en_ingles(self, carpetas):
        ferguson, _ = carpetas
        ruta, idioma = lt._resolver_ruta("video137")
        assert ruta == (ferguson / "video137.mp4").resolve()
        assert idioma == "en"

    @pytest.mark.parametrize("nombre", ["tiktok128", "youtube12", "tiktok128.mp4"])
    def test_nombres_adobe_en_espanol(self, carpetas, nombre):
        _, adobe = carpetas
        ruta, idioma = lt._resolver_ruta(nombre)
        assert ruta.parent == adobe.resolve()
        assert idioma == "es"

    def test_nombre_kanye_autodetecta(self, carpetas, tmp_path):
        ruta, idioma = lt._resolver_ruta("kanye1")
        assert ruta == (tmp_path / "Kanye" / "kanye1.mp4").resolve()
        assert idioma is None

    def test_ruta_absoluta_permitida(self, carpetas):
        ferguson, _ = carpetas
        ruta, idioma = lt._resolver_ruta(str(ferguson / "video137.mp4"))
        assert idioma == "en"

    def test_ruta_fuera_de_carpetas(self, carpetas, tmp_path):
        fuera = tmp_path / "otro.mp4"
        fuera.write_bytes(b"x")
        with pytest.raises(lt._ErrorLocal, match="outside the allowed folders"):
            lt._resolver_ruta(str(fuera))

    def test_no_se_escapa_con_puntos(self, carpetas, tmp_path):
        ferguson, _ = carpetas
        (tmp_path / "secreto.mp4").write_bytes(b"x")
        with pytest.raises(lt._ErrorLocal, match="outside the allowed folders"):
            lt._resolver_ruta(str(ferguson / ".." / "secreto.mp4"))

    def test_nombre_desconocido(self, carpetas):
        with pytest.raises(lt._ErrorLocal, match="not a known video name"):
            lt._resolver_ruta("clip5")

    def test_no_encontrado(self, carpetas):
        with pytest.raises(lt._ErrorLocal, match="File not found"):
            lt._resolver_ruta("video999")

    def test_formato_no_soportado(self, carpetas):
        ferguson, _ = carpetas
        with pytest.raises(lt._ErrorLocal, match="Unsupported format"):
            lt._resolver_ruta(str(ferguson / "notas.txt"))


class TestTranscribeLocal:
    def test_formato_igual_que_youtube_get_transcript(self, carpetas):
        segs = [
            SimpleNamespace(text=" Vamos a detener el tren.", start=0.0, end=2.0049),
            SimpleNamespace(text=" ", start=2.0, end=2.1),
            SimpleNamespace(text=" ¡Venga!", start=2.123456, end=3.5),
        ]
        info = SimpleNamespace(language="es", language_probability=1.0)
        modelo = SimpleNamespace(transcribe=lambda audio, **kw: (iter(segs), info))
        audio = np.zeros(lt._SAMPLE_RATE * 3, dtype=np.float32)

        with patch.object(lt, "_decodificar", return_value=audio), patch.object(
            lt, "_cargar_modelo", return_value=modelo
        ):
            r = lt.transcribe_local("tiktok128")

        assert r["video_id"] is None
        assert r["source"] == "local_whisper"
        assert r["language"] == "es"
        assert r["requested_language"] == "es"
        assert r["duration_total"] == 3.0
        assert r["full_text"] == "Vamos a detener el tren. ¡Venga!"
        assert r["segments"] == [
            {"text": "Vamos a detener el tren.", "start": 0.0, "duration": 2.0},
            {"text": "¡Venga!", "start": 2.12, "duration": 1.38},
        ]

    def test_idioma_explicito_gana(self, carpetas):
        visto = {}

        def transcribe(audio, **kw):
            visto.update(kw)
            return iter([]), SimpleNamespace(language="en", language_probability=1.0)

        with patch.object(lt, "_decodificar", return_value=np.zeros(16000)), patch.object(
            lt, "_cargar_modelo", return_value=SimpleNamespace(transcribe=transcribe)
        ):
            lt.transcribe_local("tiktok128", language="EN")
        assert visto["language"] == "en"
        assert visto["vad_filter"] is True

    def test_error_legible_sin_traza(self):
        r = lt.transcribe_local(str(Path("C:/Windows/win.ini")))
        assert "error" in r and "Traceback" not in r["error"]
        assert r["source"] == "local_whisper"
