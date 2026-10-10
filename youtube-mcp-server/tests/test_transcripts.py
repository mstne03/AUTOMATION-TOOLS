"""Tests for transcript tools, including the two bugs fixed.

Bug 1 (publishing): youtube_update_video raised KeyError: 'status'.
Bug 2 (here): youtube_get_transcript could not read videos of your own channel
that are private or scheduled, because it only used the scraping route.
"""

from unittest.mock import MagicMock, patch

import pytest
from googleapiclient.errors import HttpError

SRT = """1
00:00:00,000 --> 00:00:02,400
You ever been to Spain?

2
00:00:02,400 --> 00:00:04,560
<i>No.</i>

3
00:01:05,120 --> 00:01:08,000
Third line here
split over two rows
"""


class TestParseSrt:
    def test_parsea_tiempos_y_texto(self):
        from youtube_mcp.tools.transcripts import _parse_srt

        segs = _parse_srt(SRT)
        assert len(segs) == 3
        assert segs[0] == {
            "text": "You ever been to Spain?",
            "start": 0.0,
            "duration": 2.4,
        }

    def test_quita_etiquetas_html(self):
        from youtube_mcp.tools.transcripts import _parse_srt

        assert _parse_srt(SRT)[1]["text"] == "No."

    def test_maneja_horas_y_lineas_partidas(self):
        from youtube_mcp.tools.transcripts import _parse_srt

        seg = _parse_srt(SRT)[2]
        assert seg["start"] == 65.12
        assert seg["text"] == "Third line here split over two rows"

    def test_srt_vacio(self):
        from youtube_mcp.tools.transcripts import _parse_srt

        assert _parse_srt("") == []


class TestElegirPista:
    def _pista(self, lang, kind, ident="x"):
        return {"id": ident, "snippet": {"language": lang, "trackKind": kind}}

    def test_prefiere_manual_en_el_idioma_pedido(self):
        from youtube_mcp.tools.transcripts import _elegir_pista

        items = [
            self._pista("es", "ASR", "asr-es"),
            self._pista("es", "standard", "man-es"),
            self._pista("en", "standard", "man-en"),
        ]
        assert _elegir_pista(items, "es")["id"] == "man-es"

    def test_cae_a_automatica_del_idioma_pedido(self):
        from youtube_mcp.tools.transcripts import _elegir_pista

        items = [self._pista("en", "standard", "man-en"), self._pista("es", "ASR", "asr-es")]
        assert _elegir_pista(items, "es")["id"] == "asr-es"

    def test_ultimo_recurso_cualquiera(self):
        from youtube_mcp.tools.transcripts import _elegir_pista

        items = [self._pista("de", "standard", "man-de")]
        assert _elegir_pista(items, "es")["id"] == "man-de"


def _http_error(status, reason):
    resp = MagicMock()
    resp.status = status
    err = HttpError(resp, b"{}")
    err.error_details = [{"reason": reason}]
    return err


class TestMensajesDeError:
    def test_falta_de_scope_se_explica(self):
        from youtube_mcp.tools.transcripts import FORCE_SSL, _http_message

        msg = _http_message(_http_error(403, "insufficientPermissions"))
        assert FORCE_SSL in msg
        assert "re-authorise" in msg

    def test_404_claro(self):
        from youtube_mcp.tools.transcripts import _http_message

        assert "does not exist" in _http_message(_http_error(404, "notFound"))


class TestViaOficial:
    @patch("youtube_mcp.tools.transcripts.auth")
    @patch("youtube_mcp.tools.transcripts.quota")
    def test_sin_pistas_dice_que_aun_no_estan(self, mock_quota, mock_auth):
        from youtube_mcp.tools.transcripts import _get_transcript_official

        mock_yt = MagicMock()
        mock_auth.build_youtube_service.return_value = mock_yt
        mock_yt.captions().list().execute.return_value = {"items": []}

        r = _get_transcript_official("vid", "es")
        assert "error" in r
        assert "few minutes" in r["error"], "deberia explicar que aun se estan generando"

    @patch("youtube_mcp.tools.transcripts.auth")
    @patch("youtube_mcp.tools.transcripts.quota")
    def test_descarga_y_convierte_a_segmentos(self, mock_quota, mock_auth):
        from youtube_mcp.tools.transcripts import _get_transcript_official

        mock_yt = MagicMock()
        mock_auth.build_youtube_service.return_value = mock_yt
        mock_yt.captions().list().execute.return_value = {
            "items": [{"id": "c1", "snippet": {"language": "es", "trackKind": "ASR"}}]
        }
        mock_yt.captions().download().execute.return_value = SRT.encode("utf-8")

        r = _get_transcript_official("vid", "es")
        assert "error" not in r
        assert r["source"] == "official_api"
        assert r["language"] == "es"
        assert r["is_generated"] is True
        assert len(r["segments"]) == 3
        assert r["full_text"].startswith("You ever been to Spain?")


class TestDespacho:
    """El orden oficial -> scraping para videos propios."""

    @patch("youtube_mcp.tools.transcripts._get_transcript_scraping")
    @patch("youtube_mcp.tools.transcripts._get_transcript_official")
    @patch("youtube_mcp.tools.transcripts._es_video_propio", return_value=(True, None))
    def test_video_propio_usa_primero_la_oficial(self, mock_propio, mock_of, mock_scr):
        from youtube_mcp.tools.transcripts import youtube_get_transcript

        mock_of.return_value = {"video_id": "v", "full_text": "ok", "source": "official_api"}

        r = youtube_get_transcript("v", "es")
        assert r["source"] == "official_api"
        mock_of.assert_called_once()
        mock_scr.assert_not_called()

    @patch("youtube_mcp.tools.transcripts._get_transcript_scraping")
    @patch("youtube_mcp.tools.transcripts._get_transcript_official")
    @patch("youtube_mcp.tools.transcripts._es_video_propio", return_value=(False, None))
    def test_video_ajeno_no_gasta_cuota_en_la_oficial(self, mock_propio, mock_of, mock_scr):
        from youtube_mcp.tools.transcripts import youtube_get_transcript

        mock_scr.return_value = {"video_id": "v", "full_text": "ok", "source": "scrap"}

        youtube_get_transcript("v", "es")
        mock_of.assert_not_called()
        mock_scr.assert_called_once()

    @patch("youtube_mcp.tools.transcripts._get_transcript_scraping")
    @patch("youtube_mcp.tools.transcripts._get_transcript_official")
    @patch("youtube_mcp.tools.transcripts._es_video_propio", return_value=(True, None))
    def test_si_la_oficial_falla_cae_al_scraping(self, mock_propio, mock_of, mock_scr):
        from youtube_mcp.tools.transcripts import youtube_get_transcript

        mock_of.return_value = {"video_id": "v", "error": "sin scope"}
        mock_scr.return_value = {"video_id": "v", "full_text": "ok", "source": "scrap"}

        r = youtube_get_transcript("v", "es")
        assert r["source"] == "scrap"
        assert "notes" in r, "deberia decir que la via oficial se intento y fallo"

    @patch("youtube_mcp.tools.transcripts._get_transcript_scraping")
    @patch("youtube_mcp.tools.transcripts._get_transcript_official")
    @patch("youtube_mcp.tools.transcripts._es_video_propio", return_value=(True, None))
    def test_si_fallan_las_dos_explica_ambas(self, mock_propio, mock_of, mock_scr):
        from youtube_mcp.tools.transcripts import youtube_get_transcript

        mock_of.return_value = {"video_id": "v", "error": "sin scope"}
        mock_scr.return_value = {"video_id": "v", "error": "no reproducible"}

        r = youtube_get_transcript("v", "es")
        assert "error" in r
        assert len(r["attempts"]) == 2
        assert "sin scope" in r["error"] and "no reproducible" in r["error"]

    @patch("youtube_mcp.tools.transcripts._get_transcript_scraping")
    @patch("youtube_mcp.tools.transcripts._get_transcript_official")
    def test_use_official_api_no_hace_fallback(self, mock_of, mock_scr):
        from youtube_mcp.tools.transcripts import youtube_get_transcript

        mock_of.return_value = {"video_id": "v", "error": "boom"}
        r = youtube_get_transcript("v", "es", use_official_api=True)
        assert r["error"] == "boom"
        mock_scr.assert_not_called()


@pytest.mark.parametrize("kind,esperado", [("ASR", True), ("standard", False)])
@patch("youtube_mcp.tools.transcripts.auth")
@patch("youtube_mcp.tools.transcripts.quota")
def test_is_generated_segun_track_kind(mock_quota, mock_auth, kind, esperado):
    from youtube_mcp.tools.transcripts import _get_transcript_official

    mock_yt = MagicMock()
    mock_auth.build_youtube_service.return_value = mock_yt
    mock_yt.captions().list().execute.return_value = {
        "items": [{"id": "c1", "snippet": {"language": "es", "trackKind": kind}}]
    }
    mock_yt.captions().download().execute.return_value = SRT

    assert _get_transcript_official("vid", "es")["is_generated"] is esperado
