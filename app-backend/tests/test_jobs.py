import pytest
from youtube_mcp.utils import progress

from app_backend.jobs import Jobs


def _lento(pasos: int):
    for i in range(1, pasos + 1):
        progress.report(i / pasos)
    return {"ok": True, "pasos": pasos}


def _falla(**_):
    raise RuntimeError("boom")


def _error_dict(**_):
    return {"error": "fichero fuera de las carpetas permitidas"}


async def test_job_runs_with_progress_and_result(tmp_path):
    jobs = Jobs(tmp_path / "jobs.sqlite", {"lento": _lento})
    jobs.start()
    try:
        job = jobs.enqueue("lento", {"pasos": 4})
        assert job["status"] == "queued" and job["progress"] == 0.0
        final = await jobs.wait(job["id"])
        assert final["status"] == "done"
        assert final["progress"] == 1.0
        assert final["result"] == {"ok": True, "pasos": 4}
        assert jobs.list()[0]["id"] == job["id"]
    finally:
        await jobs.stop()


async def test_job_failure_and_error_dict(tmp_path):
    jobs = Jobs(tmp_path / "jobs.sqlite", {"falla": _falla, "err": _error_dict})
    jobs.start()
    try:
        j1 = await jobs.wait(jobs.enqueue("falla", {})["id"])
        assert j1["status"] == "failed" and "RuntimeError: boom" in j1["error"]
        j2 = await jobs.wait(jobs.enqueue("err", {})["id"])
        assert j2["status"] == "failed" and "carpetas" in j2["error"]
    finally:
        await jobs.stop()


async def test_unknown_kind_and_missing_job(tmp_path):
    jobs = Jobs(tmp_path / "jobs.sqlite", {})
    with pytest.raises(ValueError, match="desconocido"):
        jobs.enqueue("nope", {})
    with pytest.raises(KeyError):
        jobs.get("nope")
    await jobs.stop()


async def test_interrupted_jobs_marked_failed_on_restart(tmp_path):
    path = tmp_path / "jobs.sqlite"
    jobs = Jobs(path, {"lento": _lento})
    job = jobs.enqueue("lento", {"pasos": 1})  # sin start(): se queda en cola
    await jobs.stop()
    jobs2 = Jobs(path, {"lento": _lento})
    assert jobs2.get(job["id"])["status"] == "failed"
    assert "Interrumpido" in jobs2.get(job["id"])["error"]
    await jobs2.stop()
