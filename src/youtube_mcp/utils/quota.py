"""Contabilidad de cuota de la YouTube Data API v3, en cliente.

Google reparte la cuota en tres cubos independientes por proyecto y dia
(https://developers.google.com/youtube/v3/determine_quota_cost):

- ``general``: 10.000 unidades/dia para todos los metodos salvo los dos de abajo.
- ``search``: ``search.list`` tiene su propio cubo de 100 llamadas/dia.
- ``video_insert``: ``videos.insert`` tiene su propio cubo de 100 llamadas/dia.

El contador se persiste en ``quota.json`` para sobrevivir a reinicios del
servidor, y el dia cambia a medianoche del Pacifico, que es cuando Google reinicia.
Se descuenta ANTES de llamar a la API: una llamada rechazada por cuota no llega
a salir. Si la llamada falla por otro motivo el descuento se mantiene, porque
Google tambien la cobra.
"""

import json
import os
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo

    _PACIFICO = ZoneInfo("America/Los_Angeles")
except Exception:  # noqa: BLE001  (sin base de datos de zonas horarias)
    # ponytail: sin tzdata usamos PST fijo; el error maximo es 1 h en horario de verano.
    _PACIFICO = timezone(timedelta(hours=-8))

BUCKET_LIMITS = {
    "general": 10_000,
    "search": 100,
    "video_insert": 100,
}

# operacion -> (cubo, coste). Valores de la tabla oficial.
QUOTA_COSTS: dict[str, tuple[str, int]] = {
    "list": ("general", 1),
    "insert": ("general", 50),
    "update": ("general", 50),
    "delete": ("general", 50),
    "thumbnail_set": ("general", 50),
    "caption_list": ("general", 50),
    # captions.download no figura en la tabla oficial; se asume el coste de las
    # otras operaciones de captions que no son escritura (list/delete = 50).
    "caption_download": ("general", 50),
    "caption_insert": ("general", 400),
    "caption_update": ("general", 450),
    "search": ("search", 1),
    "video_insert": ("video_insert", 1),
}


class QuotaExhaustedError(Exception):
    def __init__(self, used: int, limit: int, bucket: str = "general"):
        self.used = used
        self.limit = limit
        self.bucket = bucket
        unidad = "units" if bucket == "general" else "calls"
        super().__init__(
            f"YouTube API quota exhausted for '{bucket}': {used}/{limit} {unidad} used today. "
            f"Resets at midnight Pacific Time."
        )


def _hoy() -> date:
    return datetime.now(_PACIFICO).date()


class QuotaTracker:
    def __init__(
        self,
        daily_limit: int = BUCKET_LIMITS["general"],
        state_path: str | Path | None = None,
        limits: dict[str, int] | None = None,
    ):
        self.limits = {**BUCKET_LIMITS, **(limits or {}), "general": daily_limit}
        self.state_path = Path(state_path) if state_path else None
        self._lock = threading.Lock()
        self._used: dict[str, int] = {b: 0 for b in self.limits}
        self._date = _hoy()
        self._load()

    # ------------------------------------------------------------ persistencia

    def _load(self) -> None:
        if not self.state_path or not self.state_path.exists():
            return
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return  # fichero corrupto: se empieza de cero, que es lo seguro para el usuario
        if data.get("date") != str(self._date):
            return
        for bucket, n in data.get("used", {}).items():
            if bucket in self._used and isinstance(n, int):
                self._used[bucket] = n

    def _save(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"date": str(self._date), "used": self._used}), encoding="utf-8"
        )
        os.replace(tmp, self.state_path)

    # ------------------------------------------------------------------ logica

    def _reset_if_new_day(self) -> None:
        hoy = _hoy()
        if hoy != self._date:
            self._used = {b: 0 for b in self.limits}
            self._date = hoy

    def consume(self, operation: str, count: int = 1) -> None:
        """Descuenta `count` operaciones. Lanza QuotaExhaustedError si no caben."""
        bucket, coste = QUOTA_COSTS.get(operation, ("general", 1))
        with self._lock:
            self._reset_if_new_day()
            total = coste * count
            if self._used[bucket] + total > self.limits[bucket]:
                raise QuotaExhaustedError(self._used[bucket], self.limits[bucket], bucket)
            self._used[bucket] += total
            self._save()

    @property
    def daily_limit(self) -> int:
        return self.limits["general"]

    @property
    def used(self) -> int:
        with self._lock:
            self._reset_if_new_day()
            return self._used["general"]

    @property
    def remaining(self) -> int:
        return self.daily_limit - self.used

    def status(self) -> dict:
        with self._lock:
            self._reset_if_new_day()
            return {
                "used": self._used["general"],
                "remaining": self.limits["general"] - self._used["general"],
                "limit": self.limits["general"],
                "date": str(self._date),
                "buckets": {
                    b: {"used": self._used[b], "limit": self.limits[b]} for b in self.limits
                },
            }
