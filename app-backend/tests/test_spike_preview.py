"""Spike D6: la ruta de la preview no deja salir de la carpeta de la composición."""

import httpx
import pytest
from fastapi import FastAPI

from app_backend.spike_preview import crear_router, resolver

CLAVE = "clave-de-prueba"


@pytest.fixture
def carpeta(tmp_path):
    comp = tmp_path / "_composicion"
    (comp / "assets").mkdir(parents=True)
    (comp / "index.html").write_text("<html><head></head><body>ok</body></html>", encoding="utf-8")
    (comp / "assets" / "a.txt").write_text("dentro", encoding="utf-8")
    (tmp_path / "secreto.txt").write_text("fuera", encoding="utf-8")  # hermano de _composicion
    return comp


@pytest.fixture
async def cliente(carpeta):
    app = FastAPI()
    app.include_router(crear_router(carpeta, None, CLAVE))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


def test_resolver_rechaza_lo_que_sale(carpeta, tmp_path):
    for ruta in ["../secreto.txt", "assets/../../secreto.txt", "/secreto.txt", str(tmp_path / "secreto.txt"), "C:/Windows/win.ini", r"..\secreto.txt", r"assets\..\..\secreto.txt", "D:s.txt", "x" + chr(0) + "y"]:
        assert resolver(carpeta, ruta) is None, ruta


def test_resolver_acepta_lo_de_dentro(carpeta):
    assert resolver(carpeta, "assets/a.txt") == (carpeta / "assets" / "a.txt").resolve()


async def test_http_traversal_y_absolutas_son_404(cliente, tmp_path):
    for ruta in ["%2e%2e/secreto.txt", "assets/%2e%2e/%2e%2e/secreto.txt", "..%2fsecreto.txt", f"{tmp_path.as_posix()}/secreto.txt", "%2fsecreto.txt"]:
        r = await cliente.get(f"/spike/preview/{CLAVE}/{ruta}")
        assert r.status_code == 404, ruta
        assert "fuera" not in r.text


async def test_http_clave_mala_404_y_buena_sirve_con_inyeccion(cliente):
    assert (await cliente.get("/spike/preview/otra/index.html")).status_code == 404
    r = await cliente.get(f"/spike/preview/{CLAVE}/")
    assert r.status_code == 200 and "__spike/control.js" in r.text
    assert (await cliente.get(f"/spike/preview/{CLAVE}/assets/a.txt")).text == "dentro"


async def test_no_se_monta_sin_la_variable(monkeypatch, tmp_path):
    from app_backend.main import create_app

    monkeypatch.delenv("APP_BACKEND_SPIKES", raising=False)
    app = create_app("t", jobs_path=tmp_path / "j.sqlite", kb_auto_update=False, conversaciones_dir=tmp_path / "c")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        assert (await c.get("/spike/preview-info", headers={"Authorization": "Bearer t"})).status_code == 404
        assert (await c.get("/spike/preview/x/index.html")).status_code == 404


async def test_congelado_no_se_monta_aunque_este_la_variable(monkeypatch, tmp_path, carpeta):
    from app_backend import config
    from app_backend.main import create_app

    monkeypatch.setattr(config, "FROZEN", True)
    monkeypatch.setenv("APP_BACKEND_SPIKES", "1")
    monkeypatch.setenv("APP_BACKEND_SPIKE_COMPOSICION", str(carpeta))
    app = create_app("t", jobs_path=tmp_path / "j.sqlite", kb_auto_update=False, conversaciones_dir=tmp_path / "c")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        assert (await c.get("/spike/preview-info", headers={"Authorization": "Bearer t"})).status_code == 404


async def test_clave_no_ascii_es_404_no_500(cliente):
    r = await cliente.get("/spike/preview/cl%C3%A1ve/index.html")
    assert r.status_code == 404


async def test_inyeccion_en_head_con_atributos_y_sin_head(tmp_path):
    comp = tmp_path / "c"
    comp.mkdir()
    (comp / "index.html").write_text('<!DOCTYPE html><HTML><HEAD lang="x"><title>t</title></HEAD></HTML>', encoding="utf-8")
    app = FastAPI()
    app.include_router(crear_router(comp, None, CLAVE))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        h = (await c.get(f"/spike/preview/{CLAVE}/")).text
        assert h.index("<script") > h.index('<HEAD lang="x">') and h.startswith("<!DOCTYPE html>")
        (comp / "index.html").write_text("<!doctype html><body>x</body>", encoding="utf-8")
        h = (await c.get(f"/spike/preview/{CLAVE}/")).text
        assert h.startswith("<!doctype html><script")
