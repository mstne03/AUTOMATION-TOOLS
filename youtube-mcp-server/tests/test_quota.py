"""Tests for quota tracking: buckets, persistence and Pacific-time reset."""

import json
from datetime import date
from unittest.mock import patch

import pytest

from youtube_mcp.utils.quota import QuotaExhaustedError, QuotaTracker


def test_initial_state():
    tracker = QuotaTracker(daily_limit=10_000)
    assert tracker.used == 0
    assert tracker.remaining == 10_000


def test_consume_list():
    tracker = QuotaTracker()
    tracker.consume("list")
    assert tracker.used == 1


def test_consume_multiple():
    tracker = QuotaTracker()
    tracker.consume("list")
    tracker.consume("update")
    tracker.consume("list", count=3)
    assert tracker.used == 54  # 1 + 50 + 3


def test_exhaust_quota():
    tracker = QuotaTracker(daily_limit=50)
    tracker.consume("list", count=50)
    with pytest.raises(QuotaExhaustedError) as exc_info:
        tracker.consume("list")
    assert exc_info.value.used == 50
    assert exc_info.value.limit == 50
    assert exc_info.value.bucket == "general"


def test_search_and_upload_have_their_own_buckets():
    """search.list y videos.insert no tocan las 10.000 unidades generales."""
    tracker = QuotaTracker()
    tracker.consume("search")
    tracker.consume("video_insert")
    assert tracker.used == 0
    buckets = tracker.status()["buckets"]
    assert buckets["search"] == {"used": 1, "limit": 100}
    assert buckets["video_insert"] == {"used": 1, "limit": 100}


def test_search_bucket_exhausts_at_100_calls():
    tracker = QuotaTracker()
    tracker.consume("search", count=100)
    with pytest.raises(QuotaExhaustedError, match="'search': 100/100 calls"):
        tracker.consume("search")
    assert tracker.remaining == 10_000  # el cubo general sigue intacto


def test_caption_costs_match_google_table():
    tracker = QuotaTracker()
    tracker.consume("caption_list")
    tracker.consume("caption_insert")
    assert tracker.used == 450


def test_status():
    tracker = QuotaTracker(daily_limit=10_000)
    tracker.consume("update")
    status = tracker.status()
    assert status["used"] == 50
    assert status["remaining"] == 9_950
    assert status["limit"] == 10_000
    assert status["date"] == str(tracker._date)


def test_resets_on_new_day():
    tracker = QuotaTracker(daily_limit=10_000)
    tracker.consume("update")
    tracker.consume("search")
    assert tracker.used == 50

    with patch("youtube_mcp.utils.quota._hoy", return_value=date(2099, 1, 1)):
        assert tracker.used == 0
        assert tracker.remaining == 10_000
        assert tracker.status()["buckets"]["search"]["used"] == 0


def test_unknown_operation_defaults_to_1():
    tracker = QuotaTracker()
    tracker.consume("some_unknown_op")
    assert tracker.used == 1


class TestPersistence:
    def test_survives_restart(self, tmp_path):
        ruta = tmp_path / "quota.json"
        QuotaTracker(state_path=ruta).consume("search")
        QuotaTracker(state_path=ruta).consume("update")

        nuevo = QuotaTracker(state_path=ruta)
        assert nuevo.used == 50
        assert nuevo.status()["buckets"]["search"]["used"] == 1

    def test_ignores_state_from_another_day(self, tmp_path):
        ruta = tmp_path / "quota.json"
        ruta.write_text(json.dumps({"date": "2000-01-01", "used": {"general": 9_999}}))
        assert QuotaTracker(state_path=ruta).used == 0

    def test_corrupt_file_starts_from_zero(self, tmp_path):
        ruta = tmp_path / "quota.json"
        ruta.write_text("{not json")
        tracker = QuotaTracker(state_path=ruta)
        assert tracker.used == 0
        tracker.consume("list")
        assert json.loads(ruta.read_text())["used"]["general"] == 1

    def test_no_state_path_means_memory_only(self, tmp_path):
        QuotaTracker().consume("list")
        assert not list(tmp_path.iterdir())
