"""Tests for formatting utilities."""

from youtube_mcp.utils.formatting import (
    _is_likely_short,
    format_count,
    format_duration,
    format_video_summary,
)


class TestFormatDuration:
    def test_seconds_only(self):
        assert format_duration("PT30S") == "30s"

    def test_minutes_and_seconds(self):
        assert format_duration("PT5M30S") == "5m 30s"

    def test_hours_minutes_seconds(self):
        assert format_duration("PT1H2M3S") == "1h 2m 3s"

    def test_minutes_only(self):
        assert format_duration("PT10M") == "10m"

    def test_hours_only(self):
        assert format_duration("PT2H") == "2h"

    def test_zero(self):
        assert format_duration("PT0S") == "0s"

    def test_empty(self):
        assert format_duration("") == "unknown"

    def test_none(self):
        assert format_duration(None) == "unknown"


class TestFormatCount:
    def test_small_number(self):
        assert format_count(42) == "42"

    def test_thousands(self):
        assert format_count(1500) == "1.5K"

    def test_millions(self):
        assert format_count(2_300_000) == "2.3M"

    def test_billions(self):
        assert format_count(1_000_000_000) == "1.0B"

    def test_string_input(self):
        assert format_count("12345") == "12.3K"

    def test_zero(self):
        assert format_count(0) == "0"


class TestIsLikelyShort:
    def test_short_video(self):
        assert _is_likely_short("PT30S") is True

    def test_exactly_60s(self):
        assert _is_likely_short("PT60S") is True
        assert _is_likely_short("PT1M") is True

    def test_over_60s(self):
        assert _is_likely_short("PT1M1S") is False
        assert _is_likely_short("PT2M") is False

    def test_long_video(self):
        assert _is_likely_short("PT1H") is False

    def test_empty(self):
        assert _is_likely_short("") is False


class TestFormatVideoSummary:
    def test_full_video(self):
        video = {
            "id": "abc123",
            "snippet": {
                "title": "Test Video",
                "channelTitle": "Test Channel",
                "publishedAt": "2025-01-01T00:00:00Z",
                "description": "A test video",
                "tags": ["test", "video"],
                "thumbnails": {"high": {"url": "https://example.com/thumb.jpg"}},
            },
            "statistics": {
                "viewCount": "1000",
                "likeCount": "50",
                "commentCount": "10",
            },
            "contentDetails": {
                "duration": "PT5M30S",
            },
        }

        result = format_video_summary(video)
        assert result["id"] == "abc123"
        assert result["title"] == "Test Video"
        assert result["views"] == 1000
        assert result["likes"] == 50
        assert result["duration"] == "5m 30s"
        assert result["is_short"] is False

    def test_short_video(self):
        video = {
            "id": "short1",
            "snippet": {
                "title": "My Short",
                "channelTitle": "Ch",
                "publishedAt": "2025-06-01T00:00:00Z",
                "description": "",
                "thumbnails": {},
            },
            "statistics": {"viewCount": "50000", "likeCount": "500", "commentCount": "5"},
            "contentDetails": {"duration": "PT45S"},
        }

        result = format_video_summary(video)
        assert result["is_short"] is True
        assert result["duration"] == "45s"

    def test_missing_fields(self):
        video = {"id": "x", "snippet": {}, "statistics": {}, "contentDetails": {}}
        result = format_video_summary(video)
        assert result["id"] == "x"
        assert result["views"] == 0
        assert result["likes"] == 0
        assert result["title"] is None


class TestIsoDurationSeconds:
    def test_casos(self):
        from youtube_mcp.utils.formatting import iso_duration_seconds

        assert iso_duration_seconds("PT45S") == 45
        assert iso_duration_seconds("PT5M30S") == 330
        assert iso_duration_seconds("PT1H") == 3600
        assert iso_duration_seconds("PT1H2M3S") == 3723
        assert iso_duration_seconds("P1DT1S") == 86401
        assert iso_duration_seconds("P0D") == 0

    def test_vacia_o_invalida(self):
        from youtube_mcp.utils.formatting import iso_duration_seconds

        assert iso_duration_seconds("") is None
        assert iso_duration_seconds("5 minutos") is None

    def test_resumen_incluye_segundos(self):
        from youtube_mcp.utils.formatting import format_video_summary

        video = {"id": "x", "snippet": {}, "statistics": {}, "contentDetails": {"duration": "PT2M"}}
        assert format_video_summary(video)["duration_seconds"] == 120
