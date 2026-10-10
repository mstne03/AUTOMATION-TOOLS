"""Regresion del bug: youtube_update_video devolvia KeyError: 'status'.

Cuando no se pasaba privacy_status, la llamada pedia part="snippet", YouTube no
devolvia el bloque status, y leer response["status"] reventaba DESPUES de que la
actualizacion ya se hubiera aplicado. De ahi el sintoma: error en la herramienta
pero cambio hecho en YouTube.
"""

from unittest.mock import MagicMock, patch

ACTUAL = {
    "items": [
        {
            "id": "vid123",
            "snippet": {
                "title": "Titulo viejo",
                "description": "Desc vieja",
                "tags": ["a"],
                "categoryId": "22",
            },
            "status": {"privacyStatus": "private", "publishAt": "2026-10-01T10:00:00Z"},
        }
    ]
}


def _mock_youtube(respuesta_update):
    mock_yt = MagicMock()
    mock_yt.videos().list().execute.return_value = ACTUAL
    mock_yt.videos().update().execute.return_value = respuesta_update
    return mock_yt


class TestUpdateVideoSinStatus:
    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_solo_etiquetas_no_revienta(self, mock_quota, mock_auth):
        """El caso que fallaba: cambiar solo tags, sin tocar privacy_status."""
        from youtube_mcp.tools.publishing import youtube_update_video

        # Respuesta sin bloque "status", como devolvia YouTube con part="snippet".
        mock_auth.build_youtube_service.return_value = _mock_youtube(
            {"id": "vid123", "snippet": {"title": "Titulo viejo", "tags": ["nueva"]}}
        )

        r = youtube_update_video(video_id="vid123", tags=["nueva"])

        assert r["updated"] is True
        assert "error" not in r
        assert r["tags"] == ["nueva"]
        assert r["updated_fields"] == ["tags"]
        # Cae al valor que ya conociamos por videos.list.
        assert r["privacy"] == "private"

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_solo_titulo_no_revienta(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_update_video

        mock_auth.build_youtube_service.return_value = _mock_youtube(
            {"id": "vid123", "snippet": {"title": "Titulo nuevo"}}
        )

        r = youtube_update_video(video_id="vid123", title="Titulo nuevo")
        assert r["title"] == "Titulo nuevo"
        assert r["updated_fields"] == ["title"]

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_pide_siempre_snippet_y_status(self, mock_quota, mock_auth):
        """La causa raiz: pedir solo 'snippet' hacia que faltara el bloque status."""
        from youtube_mcp.tools.publishing import youtube_update_video

        mock_yt = _mock_youtube({"id": "vid123", "snippet": {"title": "t"}})
        mock_auth.build_youtube_service.return_value = mock_yt

        youtube_update_video(video_id="vid123", description="nueva desc")

        partes = [
            c.kwargs.get("part")
            for c in mock_yt.videos().update.call_args_list
            if c.kwargs.get("part")
        ]
        assert partes, "no se llamo a videos().update con part"
        assert all(p == "snippet,status" for p in partes)

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_con_privacy_status_sigue_funcionando(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_update_video

        mock_auth.build_youtube_service.return_value = _mock_youtube(
            {
                "id": "vid123",
                "snippet": {"title": "t"},
                "status": {"privacyStatus": "public"},
            }
        )

        r = youtube_update_video(video_id="vid123", privacy_status="public")
        assert r["privacy"] == "public"
        assert "privacy_status" in r["updated_fields"]

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_sin_cambios_avisa(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_update_video

        mock_auth.build_youtube_service.return_value = _mock_youtube({})
        r = youtube_update_video(video_id="vid123")
        assert r["updated"] is False
        assert "Nothing to update" in r["error"]

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_video_inexistente(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_update_video

        mock_yt = MagicMock()
        mock_yt.videos().list().execute.return_value = {"items": []}
        mock_auth.build_youtube_service.return_value = mock_yt

        r = youtube_update_video(video_id="nope", title="x")
        assert "not found" in r["error"].lower()


class TestPlaylistDefensivo:
    @patch("youtube_mcp.tools.playlists.auth")
    @patch("youtube_mcp.tools.playlists.quota")
    def test_crear_playlist_sin_status_en_la_respuesta(self, mock_quota, mock_auth):
        from youtube_mcp.tools.playlists import youtube_create_playlist

        mock_yt = MagicMock()
        mock_yt.playlists().insert().execute.return_value = {
            "id": "pl1",
            "snippet": {"title": "Mi lista"},
        }
        mock_auth.build_youtube_service.return_value = mock_yt

        r = youtube_create_playlist(title="Mi lista")
        assert r["id"] == "pl1"
        assert r["privacy"] == "private"  # cae al valor pedido
