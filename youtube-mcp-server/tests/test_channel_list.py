"""youtube_list_videos: playlist_item_id y paginacion."""

from unittest.mock import MagicMock, patch


@patch("youtube_mcp.tools.channel.auth")
@patch("youtube_mcp.tools.channel.quota")
def test_list_videos_exposes_playlist_item_id_and_next_page(mock_quota, mock_auth):
    from youtube_mcp.tools.channel import youtube_list_videos

    yt = MagicMock()
    mock_auth.build_youtube_service.return_value = yt
    yt.playlistItems().list().execute.return_value = {
        "items": [
            {"id": "pli_a", "contentDetails": {"videoId": "vidA"}},
            {"id": "pli_b", "contentDetails": {"videoId": "vidB"}},
        ],
        "nextPageToken": "PAGE2",
        "pageInfo": {"totalResults": 40},
    }
    yt.videos().list().execute.return_value = {
        "items": [{"id": "vidB", "snippet": {}}, {"id": "vidA", "snippet": {}}]
    }

    result = youtube_list_videos(playlist_id="PL1", page_token="PAGE1")

    assert {v["id"]: v["playlist_item_id"] for v in result["videos"]} == {
        "vidA": "pli_a",
        "vidB": "pli_b",
    }
    assert result["next_page_token"] == "PAGE2"
    assert result["total"] == 40
    assert yt.playlistItems().list.call_args.kwargs["pageToken"] == "PAGE1"
