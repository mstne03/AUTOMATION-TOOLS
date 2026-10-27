"""Tests de youtube_retention_moments: curva de retención cruzada con la transcripción.

Todo con dobles: ni red ni cuota. Las piezas puras (_curva, _caidas, _picos, _cita,
_intro) se prueban por separado; la tool entera, con youtube_get_video,
youtube_analytics_retention y youtube_get_transcript sustituidas.
"""

from unittest.mock import patch

import pytest


def _filas(watch: list[float], relative: float = 0.5) -> list[dict]:
    """Filas de Analytics: una por punto, ratio 0.01, 0.02, ... en orden."""
    return [
        {
            "elapsedVideoTimeRatio": round((i + 1) / len(watch), 4),
            "audienceWatchRatio": w,
            "relativeRetentionPerformance": relative,
        }
        for i, w in enumerate(watch)
    ]


class TestCurva:
    def test_convierte_ratio_a_segundos(self):
        from youtube_mcp.tools.retention import _curva

        curva = _curva(_filas([1.0, 0.8, 0.6, 0.5]), duracion_s=100)
        assert [p["t"] for p in curva] == [25.0, 50.0, 75.0, 100.0]
        assert curva[1] == {"t": 50.0, "ratio": 0.5, "watch": 0.8, "relative": 0.5}

    def test_ordena_por_ratio(self):
        from youtube_mcp.tools.retention import _curva

        filas = list(reversed(_filas([1.0, 0.8, 0.6, 0.5])))
        assert [p["watch"] for p in _curva(filas, duracion_s=100)] == [1.0, 0.8, 0.6, 0.5]


class TestIntro:
    def test_punto_mas_cercano_a_la_ventana(self):
        from youtube_mcp.tools.retention import _curva, _intro

        # 100 s, 10 puntos: t = 10, 20, 30, ... -> el de 30 s es el tercero
        curva = _curva(_filas([0.95, 0.9, 0.7, 0.6, 0.5, 0.5, 0.4, 0.4, 0.3, 0.3]), duracion_s=100)
        assert _intro(curva, 30) == 0.7

    def test_short_ventana_de_3_s(self):
        from youtube_mcp.tools.retention import _curva, _intro

        # 30 s, 10 puntos: t = 3, 6, ... -> el primero
        curva = _curva(_filas([0.8, 0.7, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6]), duracion_s=30)
        assert _intro(curva, 3) == 0.8

    def test_curva_vacia(self):
        from youtube_mcp.tools.retention import _intro

        assert _intro([], 30) is None


class TestCaidas:
    def test_detecta_bajada_por_encima_del_umbral(self):
        from youtube_mcp.tools.retention import _caidas, _curva

        watch = [1.0] * 10 + [0.85] + [0.85] * 89  # bajada de 15 pp en el punto 11
        caidas = _caidas(_curva(_filas(watch), duracion_s=100))
        assert len(caidas) == 1
        c = caidas[0]
        assert (c["t_start"], c["t_end"]) == (10.0, 11.0)
        assert (c["from"], c["to"], c["delta"]) == (1.0, 0.85, -0.15)

    def test_ignora_bajadas_pequenas(self):
        from youtube_mcp.tools.retention import _caidas, _curva

        watch = [1.0 - i * 0.005 for i in range(100)]  # descenso gradual, 0,5 pp por punto
        assert _caidas(_curva(_filas(watch), duracion_s=100)) == []

    def test_fusiona_bajadas_contiguas(self):
        from youtube_mcp.tools.retention import _caidas, _curva

        watch = [1.0] * 20 + [0.9, 0.8, 0.7] + [0.7] * 77
        caidas = _caidas(_curva(_filas(watch), duracion_s=100))
        assert len(caidas) == 1
        assert (caidas[0]["t_start"], caidas[0]["t_end"]) == (20.0, 23.0)
        assert caidas[0]["delta"] == -0.3

    def test_excluye_el_ultimo_5_por_ciento(self):
        from youtube_mcp.tools.retention import _caidas, _curva

        watch = [0.6] * 97 + [0.3, 0.1, 0.05]  # el cierre se desploma: no es un problema
        assert _caidas(_curva(_filas(watch), duracion_s=100)) == []

    def test_las_mayores_en_orden_temporal(self):
        from youtube_mcp.tools.retention import _caidas, _curva

        watch = [1.0] * 100
        # siete bajadas separadas de tamaños distintos
        for punto, delta in [
            (10, 0.03),
            (20, 0.10),
            (30, 0.04),
            (40, 0.08),
            (50, 0.05),
            (60, 0.06),
            (70, 0.07),
        ]:
            for i in range(punto, 100):
                watch[i] -= delta
        watch = [round(w, 4) for w in watch]
        caidas = _caidas(_curva(_filas(watch), duracion_s=100), n=5)
        assert [c["t_start"] for c in caidas] == [20.0, 40.0, 50.0, 60.0, 70.0]


class TestPicos:
    def test_detecta_subidas(self):
        from youtube_mcp.tools.retention import _curva, _picos

        watch = [0.5] * 40 + [0.56] + [0.5] * 59  # se vuelve a ver el punto 41
        picos = _picos(_curva(_filas(watch), duracion_s=100))
        assert len(picos) == 1
        assert (picos[0]["t_start"], picos[0]["t_end"], picos[0]["delta"]) == (40.0, 41.0, 0.06)


class TestCita:
    SEGMENTOS = [
        {"text": "Hola a todos", "start": 0.0, "duration": 4.0},
        {"text": "hoy vamos a ver", "start": 4.0, "duration": 6.0},
        {"text": "antes un mensaje del patrocinador", "start": 10.0, "duration": 10.0},
        {"text": "volvemos", "start": 30.0, "duration": 5.0},
    ]

    def test_toma_los_segmentos_que_solapan_la_ventana_con_margen(self):
        from youtube_mcp.tools.retention import _cita

        # ventana [15-5, 18] = [10, 18]: solo el patrocinador (el anterior acaba en 10)
        assert _cita(self.SEGMENTOS, 15.0, 18.0) == "antes un mensaje del patrocinador"

    def test_une_varios_segmentos(self):
        from youtube_mcp.tools.retention import _cita

        assert (
            _cita(self.SEGMENTOS, 10.0, 12.0) == "hoy vamos a ver antes un mensaje del patrocinador"
        )

    def test_recorta(self):
        from youtube_mcp.tools.retention import _cita

        segs = [{"text": "palabra " * 100, "start": 0.0, "duration": 10.0}]
        cita = _cita(segs, 0.0, 5.0, max_chars=50)
        assert len(cita) <= 50
        assert cita.endswith("…")

    def test_sin_segmentos(self):
        from youtube_mcp.tools.retention import _cita

        assert _cita([], 0.0, 10.0) is None
        assert _cita(self.SEGMENTOS, 50.0, 60.0) is None


VIDEO = {
    "id": "abcdefghijk",
    "title": "Mi video",
    "published_at": "2026-09-01T10:00:00Z",
    "duration_seconds": 100,
}
TRANSCRIPCION = {
    "source": "official_api",
    "segments": [
        {"text": "gancho", "start": 0.0, "duration": 5.0},
        {"text": "aqui se van", "start": 5.0, "duration": 10.0},
        {"text": "resto", "start": 15.0, "duration": 85.0},
    ],
}


@pytest.fixture
def dobles():
    watch = [1.0] * 10 + [0.8] * 90  # caída de 20 pp en 10 s -> 11 s
    with (
        patch(
            "youtube_mcp.tools.retention.youtube_get_video", return_value=dict(VIDEO)
        ) as get_video,
        patch(
            "youtube_mcp.tools.retention.youtube_analytics_retention",
            return_value={"results": _filas(watch)},
        ) as retention,
        patch(
            "youtube_mcp.tools.retention.youtube_get_transcript", return_value=dict(TRANSCRIPCION)
        ) as transcript,
    ):
        yield get_video, retention, transcript


class TestTool:
    def test_resultado_completo(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments

        r = youtube_retention_moments("abcdefghijk")
        assert r["video_id"] == "abcdefghijk"
        assert r["title"] == "Mi video"
        assert r["duration_s"] == 100
        assert r["format"] == "long"
        assert r["intro_window_s"] == 30
        assert r["intro_retention"] == 0.8
        assert len(r["curve"]) == 100
        assert r["drops"] == [
            {
                "t_start": 10.0,
                "t_end": 11.0,
                "from": 1.0,
                "to": 0.8,
                "delta": -0.2,
                "quote": "aqui se van",
            }
        ]
        assert r["spikes"] == []
        assert r["transcript_source"] == "official_api"
        assert r["transcript_error"] is None

    def test_por_defecto_toda_la_vida_del_video(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments

        _, retention, _ = dobles
        youtube_retention_moments("abcdefghijk")
        kwargs = retention.call_args.kwargs
        assert kwargs["start_date"] == "2026-09-01"
        assert kwargs["end_date"]  # hoy

    def test_short_usa_ventana_de_3_s(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments

        r = youtube_retention_moments("abcdefghijk", format="short")
        assert r["intro_window_s"] == 3
        assert r["intro_retention"] == 1.0

    def test_formato_invalido(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments

        assert "error" in youtube_retention_moments("abcdefghijk", format="reel")

    def test_video_no_encontrado(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments

        get_video, retention, _ = dobles
        get_video.return_value = {"error": "Video not found: abcdefghijk"}
        r = youtube_retention_moments("abcdefghijk")
        assert r == {"error": "Video not found: abcdefghijk"}
        retention.assert_not_called()

    def test_sin_datos_de_retencion(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments

        _, retention, transcript = dobles
        retention.return_value = {"results": []}
        r = youtube_retention_moments("abcdefghijk")
        assert "1–2 días" in r["error"]
        transcript.assert_not_called()  # no se gasta cuota de transcripción para nada

    def test_error_de_analytics(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments

        _, retention, _ = dobles
        retention.side_effect = RuntimeError("403 Forbidden")
        r = youtube_retention_moments("abcdefghijk")
        assert "403 Forbidden" in r["error"]

    def test_sin_transcripcion_no_es_error(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments

        _, _, transcript = dobles
        transcript.return_value = {"error": "The video has no caption tracks yet."}
        r = youtube_retention_moments("abcdefghijk")
        assert "error" not in r
        assert r["transcript_error"] == "The video has no caption tracks yet."
        assert r["drops"][0]["quote"] is None


class TestErroresDeYouTube:
    """Cuota agotada, token revocado o HttpError: siempre {"error"} legible, nunca excepción."""

    def test_cuota_agotada_al_leer_el_video(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments
        from youtube_mcp.utils.quota import QuotaExhaustedError

        get_video, retention, _ = dobles
        get_video.side_effect = QuotaExhaustedError(10000, 10000)
        r = youtube_retention_moments("abcdefghijk")
        assert "quota exhausted" in r["error"]
        retention.assert_not_called()

    def test_token_revocado_al_leer_el_video(self, dobles):
        from youtube_mcp.auth import AuthError
        from youtube_mcp.tools.retention import youtube_retention_moments

        get_video, _, _ = dobles
        get_video.side_effect = AuthError("Vuelve a autorizar el canal.")
        assert youtube_retention_moments("abcdefghijk") == {"error": "Vuelve a autorizar el canal."}

    def test_sin_cuota_para_la_transcripcion_se_conserva_la_curva(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments
        from youtube_mcp.utils.quota import QuotaExhaustedError

        _, _, transcript = dobles
        transcript.side_effect = QuotaExhaustedError(9990, 10000)
        r = youtube_retention_moments("abcdefghijk")
        assert "error" not in r
        assert len(r["curve"]) == 100
        assert "quota exhausted" in r["transcript_error"]
        assert r["drops"][0]["quote"] is None


class TestFechasYVentana:
    def test_las_fechas_por_defecto_van_en_utc(self, dobles):
        from youtube_mcp.tools import retention

        _, analytics, _ = dobles
        with patch.object(retention, "_hoy_utc", return_value=retention.date(2026, 9, 1)):
            retention.youtube_retention_moments("abcdefghijk")
        kwargs = analytics.call_args.kwargs
        assert kwargs["start_date"] <= kwargs["end_date"]

    def test_publicado_despues_de_hoy_utc_no_invierte_el_rango(self, dobles):
        from youtube_mcp.tools import retention

        get_video, analytics, _ = dobles
        get_video.return_value = {**VIDEO, "published_at": "2026-09-02T01:00:00Z"}
        with patch.object(retention, "_hoy_utc", return_value=retention.date(2026, 9, 1)):
            retention.youtube_retention_moments("abcdefghijk")
        kwargs = analytics.call_args.kwargs
        assert kwargs["start_date"] == kwargs["end_date"] == "2026-09-01"

    def test_video_mas_corto_que_la_ventana(self, dobles):
        from youtube_mcp.tools.retention import youtube_retention_moments

        get_video, _, _ = dobles
        get_video.return_value = {**VIDEO, "duration_seconds": 20}
        r = youtube_retention_moments("abcdefghijk")
        assert r["intro_window_s"] == 20
