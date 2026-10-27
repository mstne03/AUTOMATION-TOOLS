"""Panel de canal: lectura, métricas, caché de 10 minutos y errores del endpoint."""

from datetime import date

import httpx
import pytest

from app_backend import canal
from app_backend.canal import CanalCache, CanalError, Fuentes
from app_backend.main import create_app

TOKEN = "token-de-prueba"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
HOY = date(2026, 10, 23)


class Falsas:
    """Fuentes falsas que cuentan las llamadas (cada una gasta cuota real en producción)."""

    def __init__(self, *, analytics_falla=False, estado_falla=False, canal_error=None):
        self.llamadas = {"canal": 0, "videos": 0, "estado": 0, "analytics": 0}
        self.rangos: list[tuple[str, str]] = []
        self.analytics_falla, self.estado_falla, self.canal_error = analytics_falla, estado_falla, canal_error

    def fuentes(self) -> Fuentes:
        def canal_():
            self.llamadas["canal"] += 1
            if self.canal_error:
                return {"error": self.canal_error}
            return {"id": "UC1", "title": "Marc", "handle": "@mserra03", "thumbnail": "https://x/a.jpg",
                    "subscribers": 120, "total_views": 5000, "video_count": 12}

        def videos(n):
            self.llamadas["videos"] += 1
            assert n == 10
            return {"videos": [
                {"id": "v1", "title": "Demo", "published_at": "2026-10-22T10:00:00Z", "views": 7, "is_short": False},
                {"id": "v2", "title": "Short", "published_at": "2026-10-20T10:00:00Z", "views": 90, "is_short": True},
            ]}

        def estado(ids):
            self.llamadas["estado"] += 1
            if self.estado_falla:
                raise RuntimeError("sin permiso")
            return {"v1": {"privacy": "private", "publish_at": None}, "v2": {"privacy": "public", "publish_at": None}}

        def analytics(ini, fin):
            self.llamadas["analytics"] += 1
            self.rangos.append((ini, fin))
            if self.analytics_falla:
                raise RuntimeError("YouTube Analytics API has not been used in project")
            if len(self.rangos) % 2 == 1:  # periodo actual
                return {"views": 300, "estimatedMinutesWatched": 600, "subscribersGained": 20,
                        "subscribersLost": 5, "averageViewPercentage": 41.234}
            return {"views": 200}  # periodo previo

        return Fuentes(canal=canal_, videos=videos, estado=estado, analytics=analytics)


def test_construir_canal_metricas_y_videos():
    f = Falsas()
    datos = canal.construir(f.fuentes(), HOY)
    assert datos["canal"] == {"id": "UC1", "titulo": "Marc", "handle": "@mserra03", "avatar": "https://x/a.jpg",
                              "suscriptores": 120, "visualizaciones_totales": 5000, "videos": 12}
    m = datos["metricas"]
    assert (m["inicio"], m["fin"]) == ("2026-09-25", "2026-10-23")
    assert m["visualizaciones"] == 300 and m["visualizaciones_delta_pct"] == 50.0  # 300 frente a 200
    assert m["horas_vistas"] == 10.0 and m["suscriptores_netos"] == 15 and m["retencion_media"] == 41.2
    # el periodo previo son los 28 días anteriores, contiguos
    assert f.rangos == [("2026-09-25", "2026-10-23"), ("2026-08-28", "2026-09-25")]
    assert [(v["id"], v["estado"], v["es_short"]) for v in datos["videos"]] == [("v1", "private", False), ("v2", "public", True)]
    assert datos["metricas_error"] is None


def test_si_analytics_falla_el_resto_se_devuelve_con_el_motivo():
    datos = canal.construir(Falsas(analytics_falla=True).fuentes(), HOY)
    assert datos["metricas"] is None and "Analytics" in datos["metricas_error"]
    assert datos["canal"]["titulo"] == "Marc" and len(datos["videos"]) == 2


def test_si_falla_el_estado_los_videos_salen_sin_chip():
    datos = canal.construir(Falsas(estado_falla=True).fuentes(), HOY)
    assert [v["estado"] for v in datos["videos"]] == [None, None]


def test_un_error_del_canal_se_propaga():
    with pytest.raises(CanalError, match="Channel not found"):
        canal.construir(Falsas(canal_error="Channel not found").fuentes(), HOY)


def test_cache_10_minutos_por_perfil_y_refresh():
    f = Falsas()
    t = [0.0]
    cache = CanalCache(f.fuentes(), reloj=lambda: t[0])
    assert cache.obtener("default")["cache"] is False
    t[0] = 599
    assert cache.obtener("default")["cache"] is True
    assert f.llamadas["canal"] == 1  # no se gasta cuota en cada visita
    assert cache.obtener("otro")["cache"] is False  # otro perfil, otra caché
    assert cache.obtener("default", refrescar=True)["cache"] is False
    t[0] = 599 + 601
    assert cache.obtener("default")["cache"] is False
    assert f.llamadas["canal"] == 4


@pytest.fixture
async def api(tmp_path, monkeypatch):
    from app_backend.main import yt_auth

    falsas = Falsas()
    app = create_app(TOKEN, jobs_path=tmp_path / "jobs.sqlite", kb_auto_update=False, canal_fuentes=falsas.fuentes())
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            c.falsas, c.yt_auth, c.monkeypatch = falsas, yt_auth, monkeypatch
            yield c


async def test_endpoint_exige_token_y_canal_autorizado(api):
    assert (await api.get("/youtube/channel")).status_code == 401
    r = await api.get("/youtube/channel", headers=AUTH)
    assert r.status_code == 409 and "autoriz" in r.json()["detail"]
    assert api.falsas.llamadas["canal"] == 0  # sin autorizar no se gasta cuota


async def test_endpoint_devuelve_el_panel_y_cachea(api):
    api.monkeypatch.setattr(api.yt_auth, "status", lambda: {"authenticated": True, "profile": "default"})
    r = await api.get("/youtube/channel", headers=AUTH)
    assert r.status_code == 200
    d = r.json()
    assert d["canal"]["titulo"] == "Marc" and d["cache"] is False and d["actualizado"]
    assert (await api.get("/youtube/channel", headers=AUTH)).json()["cache"] is True
    assert (await api.get("/youtube/channel?refresh=true", headers=AUTH)).json()["cache"] is False
    assert api.falsas.llamadas["canal"] == 2


async def test_endpoint_error_del_canal_es_502_legible(api):
    api.falsas.canal_error = "Channel not found"
    api.monkeypatch.setattr(api.yt_auth, "status", lambda: {"authenticated": True, "profile": "default"})
    r = await api.get("/youtube/channel", headers=AUTH)
    assert r.status_code == 502 and "Channel not found" in r.json()["detail"]


def test_fuentes_reales_un_error_de_analytics_como_dato_es_legible():
    """Si Analytics devuelve el error como dato (sin `results`), el panel debe ver ese mensaje y no un
    KeyError('results'): construir() lo pone tal cual en metricas_error."""
    from unittest.mock import patch

    import pytest

    from app_backend.main import _fuentes_reales

    error = {"error": "YouTube Analytics API 403: Forbidden", "status": 403}
    with (
        patch("youtube_mcp.tools.analytics._run_analytics_query", return_value=error),
        pytest.raises(Exception, match="YouTube Analytics API 403: Forbidden"),
    ):
        _fuentes_reales({}).analytics("2026-09-01", "2026-09-28")
