"""Analytics: rango con latencia, engagedViews, filtros en minusculas y errores visibles."""

from datetime import date, timedelta
from unittest.mock import MagicMock, patch

import pytest
from googleapiclient.errors import HttpError
from httplib2 import Response

from youtube_mcp.tools import analytics

ULTIMO = date.today() - timedelta(days=analytics.DATA_LAG_DAYS)


def _http_error(status: int, message: str) -> HttpError:
    content = f'{{"error": {{"code": {status}, "message": "{message}"}}}}'.encode()
    return HttpError(Response({"status": status}), content)


@pytest.fixture
def api():
    """Servicio de Analytics falso; devuelve el mock de `reports().query`."""
    with patch.object(analytics, "auth") as mock_auth:
        service = MagicMock()
        mock_auth.build_youtube_analytics_service.return_value = service
        query = service.reports.return_value.query
        query.return_value.execute.return_value = {"columnHeaders": [], "rows": []}
        yield query


def _params(query) -> dict:
    return query.call_args.kwargs


class TestDateRange:
    def test_por_defecto_termina_en_el_ultimo_dia_procesado(self, api):
        result = analytics.youtube_analytics_overview()
        assert _params(api)["endDate"] == ULTIMO.isoformat()
        assert _params(api)["startDate"] == (ULTIMO - timedelta(days=28)).isoformat()
        assert "note" not in result

    def test_avisa_si_el_rango_pide_dias_sin_procesar(self, api):
        result = analytics.youtube_analytics_overview(end_date=date.today().isoformat())
        assert "48-72h" in result["note"]
        assert ULTIMO.isoformat() in result["note"]

    def test_solo_start_date_respeta_el_start_y_completa_el_end(self, api):
        analytics.youtube_analytics_daily(start_date="2026-01-01")
        assert _params(api)["startDate"] == "2026-01-01"
        assert _params(api)["endDate"] == ULTIMO.isoformat()

    def test_solo_end_date_calcula_el_start_desde_el(self, api):
        analytics.youtube_analytics_daily(end_date="2026-03-31")
        assert _params(api)["startDate"] == "2026-03-03"

    def test_day_of_week_usa_90_dias(self, api):
        analytics.youtube_analytics_day_of_week()
        assert _params(api)["startDate"] == (ULTIMO - timedelta(days=90)).isoformat()


class TestMetricasYFiltros:
    @pytest.mark.parametrize("tool", [
        "youtube_analytics_overview",
        "youtube_analytics_top_videos",
        "youtube_analytics_top_shorts",
        "youtube_analytics_daily",
        "youtube_analytics_day_of_week",
    ])
    def test_piden_engaged_views(self, api, tool):
        getattr(analytics, tool)()
        assert "engagedViews" in _params(api)["metrics"].split(",")

    def test_video_detail_pide_engaged_views(self, api):
        analytics.youtube_analytics_video_detail("abc")
        assert "engagedViews" in _params(api)["metrics"].split(",")

    # La API real rechaza con 400 las mayusculas de la documentacion (2026-10-27).
    @pytest.mark.parametrize("tool, valor", [
        ("youtube_analytics_top_videos", "video_on_demand"),
        ("youtube_analytics_top_shorts", "shorts"),
    ])
    def test_creator_content_type_en_minusculas(self, api, tool, valor):
        getattr(analytics, tool)()
        assert _params(api)["filters"] == f"creatorContentType=={valor}"

    def test_breakdown_filtra_en_minusculas(self, api):
        analytics.youtube_analytics_content_type_breakdown()
        filtros = [c.kwargs["filters"] for c in api.call_args_list]
        assert filtros == [
            "creatorContentType==shorts",
            "creatorContentType==video_on_demand",
            "creatorContentType==live_stream",
        ]


class TestErroresVisibles:
    def test_error_de_api_vuelve_como_dato(self, api):
        api.return_value.execute.side_effect = _http_error(400, "Invalid value (x)")
        result = analytics.youtube_analytics_overview()
        assert result["status"] == 400
        assert "Invalid value (x)" in result["error"]

    def test_breakdown_muestra_la_causa_por_tipo(self, api):
        api.return_value.execute.side_effect = _http_error(400, "Invalid value (shorts)")
        result = analytics.youtube_analytics_content_type_breakdown()
        assert "Invalid value (shorts)" in result["breakdown"]["shorts"]["error"]

    def test_day_of_week_propaga_el_error(self, api):
        api.return_value.execute.side_effect = _http_error(500, "Backend Error")
        result = analytics.youtube_analytics_day_of_week()
        assert result["status"] == 500
        assert "results" not in result

    def test_revenue_vacio_se_explica(self, api):
        result = analytics.youtube_analytics_revenue()
        assert result["results"] == []
        assert "Partner Program" in result["note"]

    def test_revenue_403_se_explica(self, api):
        api.return_value.execute.side_effect = _http_error(403, "Forbidden")
        result = analytics.youtube_analytics_revenue_by_video()
        assert result["status"] == 403
        assert "Partner Program" in result["error"]
