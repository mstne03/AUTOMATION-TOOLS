"""Tests for publishing tools with mocked YouTube API."""

from unittest.mock import MagicMock, patch

import pytest
from googleapiclient.errors import HttpError

from youtube_mcp.utils import paths


@pytest.fixture
def video(tmp_path, monkeypatch):
    """Una carpeta permitida con un video y una miniatura dentro."""
    carpeta = tmp_path / "Videos"
    carpeta.mkdir()
    (carpeta / "video.mp4").write_bytes(b"x" * 10)
    (carpeta / "thumb.jpg").write_bytes(b"x" * 10)
    monkeypatch.setenv(paths.ENV_VAR, str(carpeta))
    return carpeta


def _http_error(status: int) -> HttpError:
    return HttpError(MagicMock(status=status, reason="boom"), b"")


class TestUploadVideo:
    @patch("youtube_mcp.tools.publishing.MediaFileUpload")
    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_upload_success(self, mock_quota, mock_auth, mock_media, video):
        from youtube_mcp.tools.publishing import youtube_upload_video

        mock_yt = MagicMock()
        mock_auth.build_youtube_service.return_value = mock_yt
        mock_yt.videos().insert().next_chunk.return_value = (
            None,
            {
                "id": "new123",
                "snippet": {"title": "My Video"},
                "status": {"privacyStatus": "private"},
            },
        )

        result = youtube_upload_video(file_path="video.mp4", title="My Video", description="A test")
        assert result["id"] == "new123"
        assert result["url"] == "https://www.youtube.com/watch?v=new123"
        assert result["quota_bucket"] == "video_insert"
        assert result["file"] == str((video / "video.mp4").resolve())
        mock_quota.consume.assert_called_once_with("video_insert")
        assert mock_media.call_args.kwargs["resumable"] is True

    @patch("youtube_mcp.tools.publishing.quota")
    def test_upload_file_outside_allowed_dirs(self, mock_quota, video, tmp_path):
        from youtube_mcp.tools.publishing import youtube_upload_video

        fuera = tmp_path / "fuera.mp4"
        fuera.write_bytes(b"x")
        result = youtube_upload_video(file_path=str(fuera), title="Test")
        assert "outside the allowed folders" in result["error"]
        mock_quota.consume.assert_not_called()

    @patch("youtube_mcp.tools.publishing.quota")
    def test_upload_file_not_found(self, mock_quota, video):
        from youtube_mcp.tools.publishing import youtube_upload_video

        result = youtube_upload_video(file_path="nope.mp4", title="Test")
        assert "File not found" in result["error"]
        mock_quota.consume.assert_not_called()

    @pytest.mark.parametrize(
        "publish_at, privacy, fragmento",
        [
            ("2026-10-15T18:00:00Z", "public", "requires privacy_status='private'"),
            ("mañana", "private", "not ISO 8601"),
            ("2026-10-15T18:00:00", "private", "needs a timezone"),
        ],
    )
    @patch("youtube_mcp.tools.publishing.quota")
    def test_publish_at_is_validated_not_dropped(
        self, mock_quota, video, publish_at, privacy, fragmento
    ):
        from youtube_mcp.tools.publishing import youtube_upload_video

        result = youtube_upload_video(
            "video.mp4", "T", privacy_status=privacy, publish_at=publish_at
        )
        assert fragmento in result["error"]
        mock_quota.consume.assert_not_called()

    @patch("youtube_mcp.tools.publishing.quota")
    def test_tags_total_limit(self, mock_quota, video):
        from youtube_mcp.tools.publishing import youtube_upload_video

        result = youtube_upload_video("video.mp4", "T", tags=["a" * 300, "b" * 300])
        assert "500-character" in result["error"]

    @patch("youtube_mcp.tools.publishing.time.sleep")
    @patch("youtube_mcp.tools.publishing.MediaFileUpload")
    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_retries_chunks_on_5xx(self, mock_quota, mock_auth, mock_media, mock_sleep, video):
        from youtube_mcp.tools.publishing import youtube_upload_video

        mock_yt = MagicMock()
        mock_auth.build_youtube_service.return_value = mock_yt
        mock_yt.videos().insert().next_chunk.side_effect = [
            _http_error(503),
            (MagicMock(), None),  # trozo subido, aun no ha terminado
            ConnectionResetError(),
            (None, {"id": "ok1", "snippet": {}, "status": {}}),
        ]

        result = youtube_upload_video("video.mp4", "T")
        assert result["id"] == "ok1"
        assert mock_sleep.call_count == 2

    @patch("youtube_mcp.tools.publishing.time.sleep")
    @patch("youtube_mcp.tools.publishing.MediaFileUpload")
    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_4xx_is_not_retried(self, mock_quota, mock_auth, mock_media, mock_sleep, video):
        from youtube_mcp.tools.publishing import youtube_upload_video

        mock_yt = MagicMock()
        mock_auth.build_youtube_service.return_value = mock_yt
        mock_yt.videos().insert().next_chunk.side_effect = _http_error(403)

        with pytest.raises(HttpError):
            youtube_upload_video("video.mp4", "T")
        mock_sleep.assert_not_called()


class TestUpdateVideo:
    def _yt(self, mock_auth, privacy="public"):
        mock_yt = MagicMock()
        mock_auth.build_youtube_service.return_value = mock_yt
        mock_yt.videos().list().execute.return_value = {
            "items": [{
                "id": "vid1",
                "snippet": {
                    "title": "Old Title",
                    "description": "Desc",
                    "tags": ["tag1"],
                    "categoryId": "22",
                },
                "status": {"privacyStatus": privacy},
            }]
        }
        mock_yt.videos().update().execute.return_value = {
            "id": "vid1",
            "snippet": {"title": "New Title"},
            "status": {"privacyStatus": privacy},
        }
        return mock_yt

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_update_title(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_update_video

        self._yt(mock_auth)
        result = youtube_update_video(video_id="vid1", title="New Title")
        assert result["title"] == "New Title"
        assert result["updated"] is True

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_update_not_found(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_update_video

        mock_yt = MagicMock()
        mock_auth.build_youtube_service.return_value = mock_yt
        mock_yt.videos().list().execute.return_value = {"items": []}

        result = youtube_update_video(video_id="nope", title="X")
        assert "error" in result

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_reschedule_private_video(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_update_video

        mock_yt = self._yt(mock_auth, privacy="private")
        result = youtube_update_video("vid1", publish_at="2026-10-15T18:00:00Z")
        body = mock_yt.videos().update.call_args.kwargs["body"]
        assert body["status"] == {"privacyStatus": "private", "publishAt": "2026-10-15T18:00:00Z"}
        assert result["updated_fields"] == ["publish_at"]
        assert result["publish_at"] == "2026-10-15T18:00:00Z"

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_publish_at_on_public_video_is_rejected(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_update_video

        mock_yt = self._yt(mock_auth, privacy="public")
        result = youtube_update_video("vid1", publish_at="2026-10-15T18:00:00Z")
        assert "requires privacy_status='private'" in result["error"]
        mock_yt.videos().update().execute.assert_not_called()


class TestSetThumbnail:
    @patch("youtube_mcp.tools.publishing.MediaFileUpload")
    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_set_thumbnail(self, mock_quota, mock_auth, mock_media, video):
        from youtube_mcp.tools.publishing import youtube_set_thumbnail

        mock_yt = MagicMock()
        mock_auth.build_youtube_service.return_value = mock_yt
        mock_yt.thumbnails().set().execute.return_value = {
            "items": [{"default": {"url": "https://i.ytimg.com/thumb.jpg"}}]
        }

        result = youtube_set_thumbnail("vid1", "thumb.jpg")
        assert result["updated"] is True
        mock_quota.consume.assert_called_once_with("thumbnail_set")

    @patch("youtube_mcp.tools.publishing.quota")
    def test_thumbnail_too_big(self, mock_quota, video):
        from youtube_mcp.tools.publishing import youtube_set_thumbnail

        (video / "big.png").write_bytes(b"x" * (2 * 1024 * 1024 + 1))
        result = youtube_set_thumbnail("vid1", "big.png")
        assert "limit is 2 MB" in result["error"]
        mock_quota.consume.assert_not_called()


class TestDeleteVideo:
    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_delete_requires_confirm(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_delete_video

        result = youtube_delete_video("vid1")
        assert result["deleted"] is False
        assert "confirm=True" in result["error"]
        mock_quota.consume.assert_not_called()
        mock_auth.build_youtube_service.assert_not_called()

    @patch("youtube_mcp.tools.publishing.auth")
    @patch("youtube_mcp.tools.publishing.quota")
    def test_delete_confirmed(self, mock_quota, mock_auth):
        from youtube_mcp.tools.publishing import youtube_delete_video

        mock_yt = MagicMock()
        mock_auth.build_youtube_service.return_value = mock_yt

        result = youtube_delete_video("vid1", confirm=True)
        assert result["deleted"] is True
        mock_quota.consume.assert_called_once_with("delete")
