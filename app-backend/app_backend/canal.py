"""Datos del Panel de canal: canal, métricas de 28 días y últimos vídeos.

Llama a las funciones de lectura de youtube_mcp directamente (sin pasar por el agente ni el
modelo) y cachea el resultado 10 minutos por perfil, para no gastar cuota de la Data API en
cada visita a la pantalla. Las métricas salen de la Analytics API (cuota aparte). Si una parte
opcional falla (Analytics sin activar, estado de los vídeos), el resto se devuelve igualmente y
el fallo se informa en `metricas_error` / vídeos sin `estado`.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

TTL_SEGUNDOS = 600
DIAS = 28
ULTIMOS = 10
METRICAS = "views,estimatedMinutesWatched,subscribersGained,subscribersLost,averageViewPercentage"


class CanalError(Exception):
    """El canal no se pudo leer (el detalle se muestra al usuario)."""


@dataclass
class Fuentes:
    """Las lecturas de YouTube que necesita el panel; en los tests se sustituyen por falsas."""

    canal: Callable[[], dict]  # youtube_get_channel(mine=True)
    videos: Callable[[int], dict]  # youtube_list_videos(mine=True, max_results=n)
    estado: Callable[[list[str]], dict[str, dict]]  # id -> {"privacy": ..., "publish_at": ...}
    analytics: Callable[[str, str], dict]  # (inicio, fin) -> fila de métricas


def _delta_pct(actual: float, previo: float) -> float | None:
    return None if not previo else round((actual - previo) / previo * 100, 1)


def _metricas(fuentes: Fuentes, hoy: date) -> dict:
    fin = hoy
    inicio = fin - timedelta(days=DIAS)
    ini_prev = inicio - timedelta(days=DIAS)
    ahora = fuentes.analytics(inicio.isoformat(), fin.isoformat())
    previo = fuentes.analytics(ini_prev.isoformat(), inicio.isoformat())
    vistas = int(ahora.get("views", 0))
    return {
        "inicio": inicio.isoformat(),
        "fin": fin.isoformat(),
        "visualizaciones": vistas,
        "visualizaciones_delta_pct": _delta_pct(vistas, int(previo.get("views", 0))),
        "horas_vistas": round(float(ahora.get("estimatedMinutesWatched", 0)) / 60, 1),
        "suscriptores_netos": int(ahora.get("subscribersGained", 0)) - int(ahora.get("subscribersLost", 0)),
        "retencion_media": round(float(ahora.get("averageViewPercentage", 0)), 1),
    }


def construir(fuentes: Fuentes, hoy: date | None = None) -> dict:
    """Lee todo del canal. Lanza CanalError si no se puede leer el canal en sí."""
    canal = fuentes.canal()
    if "error" in canal:
        raise CanalError(str(canal["error"]))
    listado = fuentes.videos(ULTIMOS)
    if "error" in listado:
        raise CanalError(str(listado["error"]))
    videos = listado.get("videos", [])

    try:
        estados = fuentes.estado([v["id"] for v in videos]) if videos else {}
    except Exception:  # noqa: BLE001 - opcional: sin estado se pinta sin chip
        estados = {}

    metricas, error = None, None
    try:
        metricas = _metricas(fuentes, hoy or date.today())
    except Exception as e:  # noqa: BLE001 - Analytics puede no estar activada en el proyecto del usuario
        error = str(e)

    return {
        "canal": {
            "id": canal.get("id"),
            "titulo": canal.get("title"),
            "handle": canal.get("handle"),
            "avatar": canal.get("thumbnail"),
            "suscriptores": canal.get("subscribers", 0),
            "visualizaciones_totales": canal.get("total_views", 0),
            "videos": canal.get("video_count", 0),
        },
        "metricas": metricas,
        "metricas_error": error,
        "videos": [
            {
                "id": v["id"],
                "titulo": v.get("title"),
                "publicado": v.get("published_at"),
                "visualizaciones": v.get("views", 0),
                "es_short": bool(v.get("is_short")),
                "miniatura": v.get("thumbnail"),
                "estado": estados.get(v["id"], {}).get("privacy"),
                "programado_para": estados.get(v["id"], {}).get("publish_at"),
            }
            for v in videos
        ],
    }


class CanalCache:
    """Caché por perfil con TTL; `ahora` y `reloj` se inyectan para probarla sin esperar."""

    def __init__(self, fuentes: Fuentes, *, ttl: float = TTL_SEGUNDOS, reloj: Callable[[], float] = time.monotonic):
        self.fuentes = fuentes
        self.ttl = ttl
        self.reloj = reloj
        self._datos: dict[str, tuple[float, dict]] = {}

    def obtener(self, perfil: str, refrescar: bool = False) -> dict[str, Any]:
        guardado = self._datos.get(perfil)
        if guardado and not refrescar and self.reloj() - guardado[0] < self.ttl:
            return {**guardado[1], "cache": True}
        datos = construir(self.fuentes) | {"actualizado": datetime.now(UTC).isoformat()}
        self._datos[perfil] = (self.reloj(), datos)
        return {**datos, "cache": False}

    def invalidar(self, perfil: str | None = None) -> None:
        if perfil is None:
            self._datos.clear()
        else:
            self._datos.pop(perfil, None)
