"""Momentos de retención: la curva de Analytics cruzada con la transcripción.

La alineación (fracción de la duración -> segundos -> frase que sonaba) y la detección
de caídas es aritmética: se hace aquí, de forma determinista y testeable, y al modelo
le llega una lista corta de momentos con su frase (SPEC-guiones.md, D1).
"""

from datetime import date

from youtube_mcp.server import mcp
from youtube_mcp.tools.analytics import youtube_analytics_retention
from youtube_mcp.tools.channel import youtube_get_video
from youtube_mcp.tools.transcripts import youtube_get_transcript

# Ventana del gancho por formato: YouTube mide la "Introducción" a los 30 s; en Shorts
# se decide en el primer deslizamiento (SPEC-guiones.md, D5).
INTRO_WINDOW_S = {"long": 30, "short": 3}

DROP_THRESHOLD = -0.02  # bajada mínima entre dos puntos para contar como caída
SPIKE_THRESHOLD = 0.01  # subida mínima para contar como pico (se vuelve a ver)
TAIL_RATIO = 0.95  # el último 5 % es el cierre: ahí siempre se va la gente
QUOTE_MARGIN_S = 5.0  # la frase que provoca la caída suele empezar un poco antes
QUOTE_MAX_CHARS = 300

NO_DATA = (
    "YouTube aún no tiene datos de retención de este vídeo: tardan 1–2 días en aparecer "
    "tras publicar y hace falta un mínimo de visualizaciones. Tampoco hay datos si el "
    "vídeo no es de tu canal."
)


def _curva(filas: list[dict], duracion_s: float) -> list[dict]:
    """Filas de Analytics -> [{t, ratio, watch, relative}] ordenadas, con t en segundos."""
    filas = sorted(filas, key=lambda f: f["elapsedVideoTimeRatio"])
    return [
        {
            "t": round(f["elapsedVideoTimeRatio"] * duracion_s, 1),
            "ratio": f["elapsedVideoTimeRatio"],
            "watch": f["audienceWatchRatio"],
            "relative": f.get("relativeRetentionPerformance"),
        }
        for f in filas
    ]


def _intro(curva: list[dict], ventana_s: float) -> float | None:
    """Retención en el punto más cercano al final de la ventana del gancho."""
    if not curva:
        return None
    return min(curva, key=lambda p: abs(p["t"] - ventana_s))["watch"]


def _tramos(curva: list[dict], cumple) -> list[dict]:
    """Fusiona pasos consecutivos que cumplen la condición en tramos.

    Cada tramo: {t_start, t_end, from, to, delta}. Se ignora el cierre (TAIL_RATIO).
    """
    tramos: list[dict] = []
    actual = None
    for a, b in zip(curva, curva[1:]):
        if b["ratio"] > TAIL_RATIO or not cumple(b["watch"] - a["watch"]):
            actual = None
            continue
        if actual is None:
            actual = {"t_start": a["t"], "from": a["watch"]}
            tramos.append(actual)
        actual.update(t_end=b["t"], to=b["watch"], delta=round(b["watch"] - actual["from"], 4))
    return tramos


def _mayores(tramos: list[dict], n: int) -> list[dict]:
    """Los n tramos de mayor |delta|, devueltos en orden temporal."""
    elegidos = sorted(tramos, key=lambda t: abs(t["delta"]), reverse=True)[:n]
    return sorted(elegidos, key=lambda t: t["t_start"])


def _caidas(curva: list[dict], n: int = 5) -> list[dict]:
    return _mayores(_tramos(curva, lambda d: d <= DROP_THRESHOLD), n)


def _picos(curva: list[dict], n: int = 3) -> list[dict]:
    return _mayores(_tramos(curva, lambda d: d >= SPIKE_THRESHOLD), n)


def _cita(
    segmentos: list[dict], t0: float, t1: float, max_chars: int = QUOTE_MAX_CHARS
) -> str | None:
    """Texto de los segmentos que solapan [t0 - margen, t1], recortado a max_chars."""
    desde = t0 - QUOTE_MARGIN_S
    textos = [
        s["text"]
        for s in segmentos
        if s["start"] < t1 and s["start"] + s.get("duration", 0) > desde
    ]
    if not textos:
        return None
    texto = " ".join(textos)
    return texto if len(texto) <= max_chars else texto[: max_chars - 1].rstrip() + "…"


@mcp.tool()
def youtube_retention_moments(
    video_id: str,
    format: str = "long",
    language: str = "es",
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    """Find where viewers drop off (and rewatch) in one of your videos, with what was being said.

    Crosses the audience retention curve with the transcript: returns the intro
    retention, the biggest drops and spikes with their timestamps and the quote
    spoken at that moment. Use it to diagnose a video's hook and pacing before
    rewriting a script. Costs about 100 quota units (official transcript).

    Args:
        video_id: YouTube video ID (must be on your channel)
        format: "long" (hook window 30 s) or "short" (hook window 3 s)
        language: Preferred transcript language code
        start_date: Start date (YYYY-MM-DD). Defaults to the publish date.
        end_date: End date (YYYY-MM-DD). Defaults to today.
    """
    if format not in INTRO_WINDOW_S:
        return {"error": f"format must be 'long' or 'short', not {format!r}"}

    video = youtube_get_video(video_id)
    if "error" in video:
        return video
    duracion = video.get("duration_seconds")
    if not duracion:
        return {"error": f"Could not read the duration of video {video_id}."}

    try:
        retencion = youtube_analytics_retention(
            video_id,
            start_date=start_date or (video.get("published_at") or "")[:10] or None,
            end_date=end_date or date.today().isoformat(),
        )
    except Exception as e:  # noqa: BLE001 - al modelo le llega un error legible, no un traceback
        return {"error": f"YouTube Analytics: {type(e).__name__}: {e}"}
    filas = retencion.get("results") or []
    if not filas:
        return {"error": NO_DATA}

    curva = _curva(filas, duracion)
    transcripcion = youtube_get_transcript(video_id, language)
    segmentos = transcripcion.get("segments") or []

    def con_cita(tramos: list[dict]) -> list[dict]:
        return [{**t, "quote": _cita(segmentos, t["t_start"], t["t_end"])} for t in tramos]

    ventana = INTRO_WINDOW_S[format]
    return {
        "video_id": video_id,
        "title": video.get("title"),
        "duration_s": duracion,
        "format": format,
        "intro_window_s": ventana,
        "intro_retention": _intro(curva, ventana),
        "curve": curva,
        "drops": con_cita(_caidas(curva)),
        "spikes": con_cita(_picos(curva)),
        "transcript_source": transcripcion.get("source"),
        "transcript_error": transcripcion.get("error"),
    }
