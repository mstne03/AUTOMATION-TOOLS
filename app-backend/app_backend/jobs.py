"""Cola de jobs para las tools largas (subida de video, transcripcion).

Un worker `asyncio` ejecuta los jobs de uno en uno en un hilo; el estado y el
progreso viven en SQLite para sobrevivir a reinicios y poder consultarse por HTTP.
El progreso llega por `youtube_mcp.utils.progress` (ContextVar, se propaga al hilo).

ponytail: un solo worker; las subidas van limitadas por ancho de banda y la
transcripcion por GPU, asi que paralelizar no aporta. Varios workers si hiciera falta.
"""

import asyncio
import json
import secrets
import sqlite3
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from youtube_mcp.utils import progress

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    args TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class Jobs:
    def __init__(self, path: str | Path, runners: dict[str, Callable[..., Any]]):
        self.runners = runners
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(_SCHEMA)
            # Jobs que quedaron a medias en un proceso anterior: no se reanudan solos.
            self._db.execute(
                "UPDATE jobs SET status='failed', error='Interrumpido al cerrar la aplicacion', "
                "updated_at=? WHERE status IN ('queued','running')",
                (_now(),),
            )
            self._db.commit()
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._done: dict[str, asyncio.Event] = {}
        self._worker: asyncio.Task | None = None

    # ------------------------------------------------------------------ ciclo

    def start(self) -> None:
        if self._worker is None:
            self._worker = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None
        self._db.close()

    # ------------------------------------------------------------------ API

    def enqueue(self, kind: str, args: dict) -> dict:
        if kind not in self.runners:
            raise ValueError(f"Tipo de job desconocido: {kind}. Validos: {sorted(self.runners)}")
        job_id = secrets.token_urlsafe(8)
        now = _now()
        self._write(
            "INSERT INTO jobs (id, kind, args, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (job_id, kind, json.dumps(args, ensure_ascii=False), "queued", now, now),
        )
        self._done[job_id] = asyncio.Event()
        self._queue.put_nowait(job_id)
        return self.get(job_id)

    def get(self, job_id: str) -> dict:
        with self._lock:
            row = self._db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(job_id)
        return _to_dict(row)

    def list(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [_to_dict(r) for r in rows]

    async def wait(self, job_id: str) -> dict:
        """Espera a que el job termine (en este proceso) y devuelve su estado final."""
        event = self._done.get(job_id)
        if event is not None:
            await event.wait()
        return self.get(job_id)

    # --------------------------------------------------------------- interno

    def _write(self, sql: str, params: tuple) -> None:
        with self._lock:
            self._db.execute(sql, params)
            self._db.commit()

    def _set_progress(self, job_id: str, fraction: float) -> None:
        self._write(
            "UPDATE jobs SET progress=?, updated_at=? WHERE id=? AND status='running'",
            (round(fraction, 3), _now(), job_id),
        )

    async def _run(self) -> None:
        while True:
            job_id = await self._queue.get()
            job = self.get(job_id)
            self._write(
                "UPDATE jobs SET status='running', updated_at=? WHERE id=?", (_now(), job_id)
            )
            try:
                result = await asyncio.to_thread(self._execute, job)
                if isinstance(result, dict) and "error" in result:
                    self._finish(job_id, "failed", error=str(result["error"]))
                else:
                    self._finish(job_id, "done", result=result)
            except Exception as e:  # noqa: BLE001 - el error se guarda en el job
                self._finish(job_id, "failed", error=f"{type(e).__name__}: {e}")
            finally:
                event = self._done.pop(job_id, None)
                if event is not None:
                    event.set()

    def _execute(self, job: dict) -> Any:
        ultimo = -1.0

        def reportar(fraction: float) -> None:
            nonlocal ultimo
            if fraction - ultimo >= 0.01 or fraction >= 1.0:
                ultimo = fraction
                self._set_progress(job["id"], fraction)

        progress.reporter.set(reportar)  # contexto copiado por to_thread: no contamina a otros
        return self.runners[job["kind"]](**job["args"])

    def _finish(self, job_id: str, status: str, result: Any = None, error: str | None = None) -> None:
        self._write(
            "UPDATE jobs SET status=?, progress=COALESCE(?, progress), result=?, error=?, "
            "updated_at=? WHERE id=?",
            (
                status,
                1.0 if status == "done" else None,
                json.dumps(result, ensure_ascii=False, default=str) if result is not None else None,
                error,
                _now(),
                job_id,
            ),
        )


def _to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["args"] = json.loads(d["args"])
    d["result"] = json.loads(d["result"]) if d["result"] else None
    if d["progress"] is None:
        d["progress"] = 0.0
    return d
