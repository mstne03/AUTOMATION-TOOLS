"""Voz, recursos, perfiles y render por REST (T11).

Todo contra `motor_falso.py` (ElevenLabs y el render, simulados; nunca red real), salvo los `test_real_*`,
que usan `video-mcp-server/dist` con los mensajes y códigos reales del motor. Lo que lanzaría un render real
(Chrome, ffmpeg, el CfT en Windows) va con `skip` razonado.
"""

import asyncio
import json
import os
import re
import shutil
import sys
from pathlib import Path

import pytest

from app_backend import config, jobs as jobs_mod, video, video_rest
from app_backend.jobs import Jobs
from tests.test_video_rest import (  # noqa: F401  (fixtures y ayudas compartidas)
    CENTINELA,
    DIST,
    GUION,
    _guion,
    _guion_real,
    _motor_real_o_saltar,
    _proyecto,
    api,
    real,
)

SRC_MOTOR = Path(__file__).resolve().parents[2] / "video-mcp-server" / "src"
BANDEJA = "a" * 32
PLAN = None


def _rutas_planas_t11(rutas):
    return [r for r in rutas if hasattr(r, "path")]


@pytest.fixture(autouse=True)
def _sondeo_rapido(monkeypatch):
    monkeypatch.setattr(video_rest, "SONDEO_RENDER", 0.02, raising=False)


async def _config(api, **valores):
    await api.app.state.motor.llamar("falso_configurar", {"valores": valores})


async def _llamadas(api) -> list[dict]:
    return (await api.app.state.motor.llamar("falso_llamadas")).datos


async def _alta(api, id: str) -> str:
    await api.app.state.motor.llamar("falso_proyecto", {"id": id})
    return id


async def _coste(api, pid):
    r = await api.post(f"/video/proyectos/{pid}/voz/coste", json={})
    assert r.status_code == 200, r.text
    return r.json()


def _cuerpo_voz(coste: dict, **extra) -> dict:
    return {"plan_confirmado": coste["plan"], "caracteres_confirmados": coste["caracteres"], **extra}


def _sin_rutas_t11(texto: str) -> None:
    for trozo in ("Marc Serra", "Program Files", "C:\\", "AppData", "Users", "mp4"):
        assert trozo not in texto, f"{trozo!r} en {texto!r}"


# ================================================================== literales del simulador


def test_literales_del_simulador_son_los_del_motor():
    """Los mensajes de error del simulador salen de `voz.ts` / `proceso.ts`: si el motor los cambia, esto avisa."""
    from tests import motor_falso as mf

    voz = (SRC_MOTOR / "voz.ts").read_text(encoding="utf-8")
    proceso = (SRC_MOTOR / "proceso.ts").read_text(encoding="utf-8")
    for literal in (mf.MSG_SIN_CLAVE, mf.MSG_SIN_VOZ, mf.MSG_PLAN, mf.MSG_CONFLICTO_VOZ, mf.MSG_COSTE.split("{n}")[0]):
        assert literal in voz, literal
    assert mf.MSG_SIN_FFMPEG in proceso
    for codigo in ("sin_configurar", "coste_cambiado", "reintento_facturado", "conflicto", "fallo_facturado", "voz_pendiente"):
        assert f'"{codigo}"' in voz, codigo


# ================================================================== voz: coste


async def test_coste_sale_del_motor_y_cruza_el_nombre_de_la_voz(api):
    pid = await _proyecto(api)
    await _config(api, fallidas=True)
    c = await _coste(api, pid)
    assert c["pendientes"] == ["f0", "f1"] and c["caracteres"] == 120 and c["caracteresRefacturados"] == 60
    assert c["fallidasFacturadas"] == ["f1"]  # aplanado a ids (contrato)
    assert c["voz"] == {"id": "21m00Tcm4TlvDq8ikWAM", "nombre": "Lucía"}
    assert c["plan"].startswith("plan-")  # opaco: tal cual lo dio el motor


async def test_coste_sin_voces_usa_el_id(api):
    pid = await _proyecto(api)
    await _config(api, clave=False)  # /video/voces falla, el coste no necesita la clave
    assert (await _coste(api, pid))["voz"] == {"id": "21m00Tcm4TlvDq8ikWAM", "nombre": "21m00Tcm4TlvDq8ikWAM"}


async def test_coste_con_ambito_y_cuerpo_estricto(api):
    pid = await _proyecto(api)
    assert (await api.post(f"/video/proyectos/{pid}/voz/coste", json={"frases": ["f0"]})).status_code == 200
    assert (await api.post(f"/video/proyectos/{pid}/voz/coste", json={"frases": ["../x"]})).status_code == 422
    assert (await api.post(f"/video/proyectos/{pid}/voz/coste", json={"ruta": "C:\\x"})).status_code == 422
    assert (await api.post("/video/proyectos/video777/voz/coste", json={})).status_code == 404


# ================================================================== voz: generar (contrato de T19)


async def test_generar_reenvia_el_plan_confirmado_tal_cual(api):
    pid = await _proyecto(api)
    c = await _coste(api, pid)
    r = await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c, frases=["f0"], reintentar_facturadas=False))
    assert r.status_code == 200, r.text
    assert r.json() == {"generadas": 2, "caracteresFacturados": 120}  # sin `revision` inventada
    envio = [x for x in await _llamadas(api) if x["tool"] == "video_voz_generar"]
    assert envio == [
        {"tool": "video_voz_generar", "id": pid, "frases": ["f0"], "caracteresConfirmados": 120,
         "planConfirmado": c["plan"], "reintentarFacturadas": False}
    ]


async def test_plan_no_se_fabrica(api, monkeypatch):
    """Sin `plan_confirmado` es un 422 y el backend no llama a `video_voz_coste` para rellenarlo."""
    pid = await _proyecto(api)
    vistas = []
    original = video_rest._llamar

    async def espia(estado, tool, args=None, **kw):
        vistas.append(tool)
        return await original(estado, tool, args, **kw)

    monkeypatch.setattr(video_rest, "_llamar", espia)
    for cuerpo in ({"caracteres_confirmados": 120}, {"caracteres_confirmados": 120, "plan_confirmado": None}, {}):
        r = await api.post(f"/video/proyectos/{pid}/voz", json=cuerpo)
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["codigo"] == "cuerpo"
    assert "video_voz_coste" not in vistas and "video_voz_generar" not in vistas
    assert await _llamadas(api) == []


@pytest.mark.parametrize("valor", ["true", 1, "yes", None, False, [True], {"a": 1}, 0, "True"])
async def test_reintentar_facturadas_solo_con_true_literal(api, valor):
    pid = await _proyecto(api)
    await _config(api, fallidas=True)
    c = await _coste(api, pid)
    r = await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c, reintentar_facturadas=valor))
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "reintento_facturado", r.text
    ultimo = [x for x in await _llamadas(api) if x["tool"] == "video_voz_generar"][-1]
    assert ultimo["reintentarFacturadas"] is False


async def test_reintentar_facturadas_ausente_es_false_y_true_literal_pasa(api):
    pid = await _proyecto(api)
    await _config(api, fallidas=True)
    c = await _coste(api, pid)
    r = await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c))
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "reintento_facturado"
    r = await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c, reintentar_facturadas=True))
    assert r.status_code == 200
    assert [x for x in await _llamadas(api) if x["tool"] == "video_voz_generar"][-1]["reintentarFacturadas"] is True


async def test_coste_cambiado_409(api):
    pid = await _proyecto(api)
    c = await _coste(api, pid)
    r = await api.post(f"/video/proyectos/{pid}/voz", json={**_cuerpo_voz(c), "caracteres_confirmados": 119})
    assert r.status_code == 409 and r.json()["detail"] == {"mensaje": video_rest.MENSAJES_POR_CODIGO["coste_cambiado"][1], "codigo": "coste_cambiado"}
    r = await api.post(f"/video/proyectos/{pid}/voz", json={**_cuerpo_voz(c), "plan_confirmado": "otro"})
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "coste_cambiado"  # `plan_cambiado` del motor, mismo código
    assert "contenido" not in r.text.lower().replace("coste", "")  # el texto del motor no llega


async def test_sin_clave_elevenlabs_409_y_sin_voz_es_otro_codigo(api):
    pid = await _proyecto(api)
    c = await _coste(api, pid)
    await _config(api, clave=False)
    r = await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c))
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "sin_clave"
    assert "Añade tu clave" not in r.text  # mensaje fijo del backend, no el del motor
    await _config(api, clave=True, voz=False)
    r = await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c))
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "sin_voz"
    assert "clave" not in r.json()["detail"]["mensaje"].lower()
    r = await api.post(f"/video/proyectos/{pid}/voz/coste", json={})
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "sin_voz"


async def test_sin_ffmpeg_es_no_disponible_503(api):
    pid = await _proyecto(api)
    c = await _coste(api, pid)
    await _config(api, ffmpeg=False)
    r = await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c))
    assert r.status_code == 503 and r.json()["detail"]["codigo"] == "no_disponible"
    assert "SEO Studio" not in r.json()["detail"]["mensaje"] or "ffmpeg" in r.json()["detail"]["mensaje"]


async def test_fallo_a_medias_sin_texto_libre(api):
    pid = await _proyecto(api)
    await _config(api, fallo=True)
    c = await _coste(api, pid)
    r = await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c))
    assert r.status_code == 200
    f = r.json()["fallo"]
    assert f["fraseId"] == "f1" and f["facturada"] is True and f["codigo"] == "fallo_facturado"
    _sin_rutas_t11(r.text)
    assert set(f) == {"fraseId", "facturada", "codigo", "mensaje"}


async def test_cuerpo_de_voz_estricto(api):
    pid = await _proyecto(api)
    c = await _coste(api, pid)
    for extra in ({"ruta": "C:\\x"}, {"id": pid}):
        assert (await api.post(f"/video/proyectos/{pid}/voz", json={**_cuerpo_voz(c), **extra})).status_code == 422
    assert (await api.post(f"/video/proyectos/{pid}/voz", json={**_cuerpo_voz(c), "plan_confirmado": "x" * 101})).status_code == 422
    assert (await api.post(f"/video/proyectos/{pid}/voz", json={**_cuerpo_voz(c), "caracteres_confirmados": "120"})).status_code == 422
    assert (await api.post(f"/video/proyectos/{pid}/voz", json={**_cuerpo_voz(c), "frases": ["f0"] * 541})).status_code == 422


def test_timeout_de_voz():
    assert video_rest.timeout_voz(1) == 260 and video_rest.timeout_voz(10) == 60 + 200 * 10
    assert video_rest.timeout_voz(0) == 260  # al menos una frase


async def test_generar_usa_el_timeout_de_voz(api, monkeypatch):
    pid = await _proyecto(api)
    c = await _coste(api, pid)
    visto = {}
    original = api.app.state.motor.llamar

    async def espia(tool, args=None, timeout=None):
        if tool == "video_voz_generar":
            visto["t"] = timeout
        return await original(tool, args, timeout)

    monkeypatch.setattr(api.app.state.motor, "llamar", espia)
    assert (await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c, frases=["f0", "f1"]))).status_code == 200
    assert visto["t"] == 60 + 200 * 2
    await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c))  # sin ámbito: acotado por los caracteres
    assert visto["t"] == 60 + 200 * 120


# ================================================================== voz: quitar silencios, voces, muestra


async def test_quitar_silencios_no_inventa_revision(api):
    pid = await _proyecto(api)
    antes = (await api.get(f"/video/proyectos/{pid}")).json()["revision"]
    r = await api.post(f"/video/proyectos/{pid}/voz/quitar-silencios", json={"frase_id": "f0"})
    assert r.status_code == 200 and r.json() == {"recorte": {"inicio": 0.1, "fin": 2.5}}
    assert (await api.get(f"/video/proyectos/{pid}")).json()["revision"] == antes + 1  # la UI relee el proyecto
    for extra in ({"plan_confirmado": "x"}, {"caracteres_confirmados": 1}):
        assert (await api.post(f"/video/proyectos/{pid}/voz/quitar-silencios", json={"frase_id": "f0", **extra})).status_code == 422
    assert (await api.post(f"/video/proyectos/{pid}/voz/quitar-silencios", json={"frase_id": "../x"})).status_code == 422


async def test_voces_y_muestra(api):
    r = await api.get("/video/voces")
    assert r.status_code == 200
    v = r.json()["voces"][0]
    assert v == {"id": "21m00Tcm4TlvDq8ikWAM", "nombre": "Lucía", "idioma": "es", "planMuestra": "m" * 64}
    cuerpo = {"voiceId": v["id"], "plan_confirmado": v["planMuestra"], "caracteres_confirmados": 60}
    r = await api.post("/video/voces/muestra", json=cuerpo)
    assert r.status_code == 200 and r.json() == {"audioBase64": "QUJD", "caracteres": 60, "cache": False}
    ultimo = [x for x in await _llamadas(api) if x["tool"] == "video_voz_muestra"][-1]
    assert ultimo["reintentarFacturada"] is False
    r = await api.post("/video/voces/muestra", json={**cuerpo, "plan_confirmado": "otro"})
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "coste_cambiado"
    assert (await api.post("/video/voces/muestra", json={"voiceId": "../x", "plan_confirmado": "x", "caracteres_confirmados": 60})).status_code == 422
    assert (await api.post("/video/voces/muestra", json={"voiceId": v["id"], "caracteres_confirmados": 60})).status_code == 422


async def test_muestra_facturada_pide_reintento_expreso(api):
    await _config(api, fallidas=True)
    cuerpo = {"voiceId": "21m00Tcm4TlvDq8ikWAM", "plan_confirmado": "m" * 64, "caracteres_confirmados": 60}
    r = await api.post("/video/voces/muestra", json=cuerpo)
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "reintento_facturado"
    r = await api.post("/video/voces/muestra", json={**cuerpo, "reintentar_facturada": "true"})
    assert r.status_code == 409
    r = await api.post("/video/voces/muestra", json={**cuerpo, "reintentar_facturada": True})
    assert r.status_code == 200


async def test_voces_sin_clave_409(api):
    await _config(api, clave=False)
    r = await api.get("/video/voces")
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "sin_clave"


# ================================================================== cerrojos


async def test_voz_con_render_409(api):
    pid = await _proyecto(api)
    c = await _coste(api, pid)
    api.app.state.cerrojos.tomar(pid, "render")
    for ruta, cuerpo in ((f"/video/proyectos/{pid}/voz", _cuerpo_voz(c)), (f"/video/proyectos/{pid}/voz/quitar-silencios", {"frase_id": "f0"})):
        r = await api.post(ruta, json=cuerpo)
        assert r.status_code == 409 and r.json()["detail"]["codigo"] == "render_en_curso", r.text
    assert await _llamadas(api) == []  # ni siquiera llegó al motor
    api.app.state.cerrojos.soltar(pid, "render")
    assert (await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c))).status_code == 200


async def test_render_con_voz_409_y_el_cerrojo_se_suelta(api):
    pid = await _proyecto(api)
    c = await _coste(api, pid)
    await _config(api, dormir=0.6)
    voz = asyncio.create_task(api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c)))
    await asyncio.sleep(0.25)
    r = await api.post(f"/video/proyectos/{pid}/render", json={"modo": "auto"})
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "voz_en_curso", r.text
    assert (await voz).status_code == 200
    assert api.app.state.cerrojos.de(pid) is None
    await _config(api, dormir=0, clave=False)  # y también si falla
    assert (await api.post(f"/video/proyectos/{pid}/voz", json=_cuerpo_voz(c))).status_code == 409
    assert api.app.state.cerrojos.de(pid) is None


# ================================================================== perfiles


async def test_perfiles_listar_duplicar_guardar(api):
    r = await api.get("/video/perfiles")
    assert r.status_code == 200 and [p["id"] for p in r.json()["perfiles"]] == ["defecto"]
    r = await api.post("/video/perfiles/defecto/duplicar", json={"nombre": "Copia"})
    assert r.status_code == 201 and re.fullmatch(r"p-[0-9a-f]{16}", r.json()["id"])
    nuevo = r.json()["id"]
    r = await api.put(f"/video/perfiles/{nuevo}", json={"perfil": {"id": nuevo, "nombre": "Otro"}})
    assert r.status_code == 200 and r.json() == {"id": nuevo}
    r = await api.put(f"/video/perfiles/{nuevo}", json={"perfil": {"nombre": "Sin id"}})
    assert r.status_code == 200  # el id del cuerpo es opcional; si viene, tiene que coincidir
    assert (await api.put("/video/perfiles/p-0123456789abcdef", json={"perfil": {"nombre": "x"}})).status_code == 404


async def test_perfil_id_del_cuerpo_distinto_422_sin_llegar_al_motor(api):
    r = await api.put("/video/perfiles/defecto", json={"perfil": {"id": "p-0123456789abcdef", "nombre": "x"}})
    assert r.status_code == 422 and r.json()["detail"]["codigo"] == "id_distinto"
    assert [x for x in await _llamadas(api) if x["tool"] == "video_perfil_guardar"] == []


async def test_perfil_el_id_nuevo_lo_genera_el_motor(api):
    for cuerpo in ({"id": "p-0123456789abcdef"}, {"nombre": "x", "id": "defecto"}):
        r = await api.post("/video/perfiles/defecto/duplicar", json=cuerpo)
        assert r.status_code == 422
    assert [x for x in await _llamadas(api) if x["tool"] == "video_perfil_duplicar"] == []
    r = await api.post("/video/perfiles/defecto/duplicar", content="")  # cuerpo vacío = sin nombre
    assert r.status_code == 201


@pytest.mark.parametrize("pid", ["p-xyz", "..", "DEFECTO", "p-0123456789abcdef0", "video001"])
async def test_perfil_con_forma_mala_404(api, pid):
    assert (await api.post(f"/video/perfiles/{pid}/duplicar", json={})).status_code == 404
    assert (await api.put(f"/video/perfiles/{pid}", json={"perfil": {}})).status_code == 404


async def test_perfil_ruta_en_cuerpo_422(api):
    assert (await api.put("/video/perfiles/defecto", json={"perfil": {}, "ruta": "C:\\x"})).status_code == 422


# ================================================================== recursos (la bandeja de T13 está simulada)


async def test_importar_recurso_devuelve_recurso_y_avisos(api):
    pid = await _proyecto(api)
    antes = (await api.get(f"/video/proyectos/{pid}")).json()["revision"]
    r = await api.post(f"/video/proyectos/{pid}/recursos", json={"bandeja_id": BANDEJA, "clase": "foto"})
    assert r.status_code == 201, r.text
    cuerpo = r.json()
    assert set(cuerpo) == {"recurso", "avisos"} and cuerpo["avisos"] == [{"codigo": "foto_pequena"}]
    assert re.fullmatch(video_rest.RECURSO, cuerpo["recurso"]["id"])
    assert set(cuerpo["recurso"]) == {"id", "clase", "ext", "nombreOriginal", "ancho", "alto", "duracion"}
    # Supuesto de T18: importar escribe `recursos` en el proyecto y sube su revisión; la UI vuelve a pedirlo.
    assert (await api.get(f"/video/proyectos/{pid}")).json()["revision"] == antes + 1
    envio = [x for x in await _llamadas(api) if x["tool"] == "video_recurso_importar"]
    assert envio == [{"tool": "video_recurso_importar", "id": pid, "bandejaId": BANDEJA, "clase": "foto"}]


@pytest.mark.parametrize(
    "cuerpo",
    [
        {"bandeja_id": BANDEJA, "clase": "foto", "ruta": "C:\\x.jpg"},
        {"bandeja_id": BANDEJA, "clase": "foto", "path": "/etc/passwd"},
        {"bandeja_id": "C:\\Users\\x\\foto.jpg", "clase": "foto"},
        {"bandeja_id": "../" + "a" * 29, "clase": "foto"},
        {"bandeja_id": "A" * 32, "clase": "foto"},
        {"bandeja_id": BANDEJA, "clase": "exe"},
        {"bandeja_id": BANDEJA},
        {"clase": "foto"},
    ],
)
async def test_recurso_ruta_o_bandeja_mala_422(api, cuerpo):
    pid = await _proyecto(api)
    r = await api.post(f"/video/proyectos/{pid}/recursos", json=cuerpo)
    assert r.status_code == 422
    assert [x for x in await _llamadas(api) if x["tool"] == "video_recurso_importar"] == []


async def test_recurso_bandeja_inexistente_y_proyecto_inexistente_404(api):
    pid = await _proyecto(api)
    assert (await api.post(f"/video/proyectos/{pid}/recursos", json={"bandeja_id": "0" * 32, "clase": "clip"})).status_code == 404
    assert (await api.post("/video/proyectos/video777/recursos", json={"bandeja_id": BANDEJA, "clase": "clip"})).status_code == 404


async def test_recurso_en_uso_409(api):
    pid = await _proyecto(api)
    r = await api.post(f"/video/proyectos/{pid}/recursos", json={"bandeja_id": "ee" + "0" * 30, "clase": "foto"})
    en_uso = r.json()["recurso"]["id"]
    libre = (await api.post(f"/video/proyectos/{pid}/recursos", json={"bandeja_id": BANDEJA, "clase": "foto"})).json()["recurso"]["id"]
    r = await api.delete(f"/video/proyectos/{pid}/recursos/{en_uso}")
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "recurso_en_uso"
    assert (await api.delete(f"/video/proyectos/{pid}/recursos/{libre}")).json() == {}
    assert (await api.delete(f"/video/proyectos/{pid}/recursos/{libre}")).status_code == 404
    assert (await api.delete(f"/video/proyectos/{pid}/recursos/r-xyz")).status_code == 404


def test_recurso_seguro_descarta_lo_que_no_es_del_contrato():
    sucio = {"id": "r-0123456789abcdef", "clase": "foto", "ext": "jpg", "nombreOriginal": "a" * 500, "ancho": 10, "alto": 5,
             "duracion": 0, "ruta": "C:\\Users\\Marc\\x.jpg", "origen": "/tmp/x"}
    limpio = video_rest.recurso_seguro(sucio)
    assert "ruta" not in limpio and "origen" not in limpio and len(limpio["nombreOriginal"]) <= 120
    with pytest.raises(ValueError):
        video_rest.recurso_seguro({**sucio, "id": "../x"})
    with pytest.raises(ValueError):
        video_rest.recurso_seguro({**sucio, "ext": "exe"})


# ================================================================== borrar proyecto


async def test_borrar_con_render_409(api):
    pid = await _proyecto(api)
    api.app.state.cerrojos.tomar(pid, "render")
    r = await api.delete(f"/video/proyectos/{pid}")
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "render_en_curso"
    assert (api.raiz / pid / "proyecto.json").is_file()
    api.app.state.cerrojos.soltar(pid, "render")
    assert (await api.delete(f"/video/proyectos/{pid}")).status_code == 200


async def test_borrar_con_voz_en_curso_409(api):
    pid = await _proyecto(api)
    api.app.state.cerrojos.tomar(pid, "voz")
    r = await api.delete(f"/video/proyectos/{pid}")
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "voz_en_curso"


async def test_borrar_invalida_clave(api):
    pid = await _proyecto(api)
    clave = api.app.state.claves.rotar(pid, "r1", "2026-11-07T10:00:00.000Z")
    assert api.app.state.claves.buscar(clave) is not None
    assert (await api.delete(f"/video/proyectos/{pid}")).status_code == 200
    assert api.app.state.claves.buscar(clave) is None
    # Con render activo no se borra y la clave sigue valiendo (el proyecto sigue existiendo).
    pid2 = await _proyecto(api)
    clave2 = api.app.state.claves.rotar(pid2, "r1", "2026-11-07T10:00:00.000Z")
    api.app.state.cerrojos.tomar(pid2, "render")
    assert (await api.delete(f"/video/proyectos/{pid2}")).status_code == 409
    assert api.app.state.claves.buscar(clave2) is not None


# ================================================================== errores: todo con {mensaje, codigo}


@pytest.mark.parametrize(
    ("codigo_motor", "estado", "codigo"),
    [("esquema", 422, "esquema"), ("conflicto", 409, "conflicto"), ("no_encontrado", 404, "no_encontrado"),
     ("coste_cambiado", 409, "coste_cambiado"), ("reintento_facturado", 409, "reintento_facturado"),
     ("sin_configurar", 409, "sin_clave"), ("en_uso", 409, "recurso_en_uso"), ("voz_pendiente", 409, "voz_pendiente"),
     ("fallo_facturado", 502, "fallo_facturado")],
)
def test_http_todo_error_lleva_mensaje_y_codigo(codigo_motor, estado, codigo):
    e = video_rest._http(video.MotorError("Error en x: C:\\Users\\Marc Serra\\y", codigo_motor, []))
    assert e.status_code == estado
    assert set(e.detail) >= {"mensaje", "codigo"} and e.detail["codigo"] == codigo
    _sin_rutas_t11(json.dumps(e.detail))


def test_http_503_y_502_tambien_con_codigo():
    for exc, estado, codigo in (
        (video.MotorNoDisponible("C:\\Users\\Marc Serra\\node.exe"), 503, "no_disponible"),
        (video.MotorTimeout("tardó"), 503, "no_disponible"),
        (video.MotorError("boom en C:\\Users\\Marc Serra"), 502, "error_motor"),
    ):
        e = video_rest._http(exc)
        assert e.status_code == estado and e.detail["codigo"] == codigo and isinstance(e.detail["mensaje"], str)
        _sin_rutas_t11(json.dumps(e.detail))


def test_http_sin_configurar_distingue_clave_de_voz_con_el_texto_real():
    voz = (SRC_MOTOR / "voz.ts").read_text(encoding="utf-8")
    sin_clave = re.search(r'"sin_configurar", "(Añade tu clave[^"]+)"', voz).group(1)
    sin_voz = re.search(r'"sin_configurar", "(Elige la voz[^"]+)"', voz).group(1)
    assert video_rest._http(video.MotorError("Error en x: " + sin_clave, "sin_configurar")).detail["codigo"] == "sin_clave"
    assert video_rest._http(video.MotorError("Error en x: " + sin_voz, "sin_configurar")).detail["codigo"] == "sin_voz"


async def test_todo_error_de_video_lleva_detail_dict(api):
    """Los 404/409/503 que antes eran texto plano, ahora con código (borrar, preview, motor caído)."""
    assert isinstance((await api.delete("/video/proyectos/video777")).json()["detail"], dict)
    api.app.state.reserva_preview = None
    pid = await _proyecto(api)
    r = await api.post(f"/video/proyectos/{pid}/preview", json={})
    assert r.status_code == 503 and r.json()["detail"]["codigo"] == "no_disponible"


# ================================================================== listado con estado derivado


async def _esperar(api, job_id):
    return await asyncio.wait_for(api.app.state.jobs.wait(job_id), 20)


async def _estado(api, pid) -> str:
    lista = (await api.get("/video/proyectos")).json()
    lista = lista["proyectos"] if isinstance(lista, dict) else lista
    return next(p["estado"] for p in lista if p["id"] == pid)


async def test_estado_borrador_renderizando_listo_y_error(api):
    ok = await _alta(api, "video001")
    colgado = await _alta(api, "video097")
    roto = await _alta(api, "video099")
    assert [await _estado(api, p) for p in (ok, colgado, roto)] == ["borrador"] * 3
    api.app.state.cerrojos.tomar(ok, "render")
    assert await _estado(api, ok) == "renderizando"
    api.app.state.cerrojos.soltar(ok, "render")
    r = await api.post(f"/video/proyectos/{ok}/render", json={"modo": "auto"})
    await _esperar(api, r.json()["id"])
    assert await _estado(api, ok) == "listo"
    r = await api.post(f"/video/proyectos/{roto}/render", json={"modo": "auto"})
    await _esperar(api, r.json()["id"])
    assert await _estado(api, roto) == "error"


# ================================================================== render


async def test_render_hasta_resultado_sin_rutas_ni_clave(api, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", CENTINELA)
    pid = await _alta(api, "video001")
    r = await api.post(f"/video/proyectos/{pid}/render", json={"modo": "rapido"})
    assert r.status_code == 202, r.text
    job = r.json()
    assert job["kind"] == "video_render" and job["args"] == {"id": pid, "titulo": "Prueba", "modo": "rapido"}
    assert api.app.state.cerrojos.de(pid) == "render"
    final = await _esperar(api, job["id"])
    assert final["status"] == "done" and final["progress"] == 1.0
    assert final["result"] == {"id": pid, "duracion": 12.5, "modo": "rapido", "codificador": "h264_mf",
                               "avisos": [{"codigo": "fondo_degradado"}], "reserva": ["fondo_degradado"]}
    # resultado_sin_rutas y clave_no_en_jobs
    volcado = json.dumps(api.app.state.jobs.list()) + json.dumps((await api.get("/jobs")).json()) + json.dumps(job)
    _sin_rutas_t11(volcado)
    assert CENTINELA not in volcado
    assert (await api.app.state.motor_render.llamar("entorno", {"nombre": "ELEVENLABS_API_KEY"})).texto == "<ausente>"
    assert api.app.state.cerrojos.de(pid) is None


async def test_render_progreso_viene_del_motor(api):
    pid = await _alta(api, "video001")
    r = await api.post(f"/video/proyectos/{pid}/render", json={})
    vistos = set()
    while (j := api.app.state.jobs.get(r.json()["id"]))["status"] in ("queued", "running"):
        vistos.add(j["progress"])
        await asyncio.sleep(0.01)
    assert any(0 < p < 1 for p in vistos) or j["progress"] == 1.0
    assert j["args"]["modo"] == "auto"


async def test_render_cuerpo_y_proyecto(api):
    pid = await _alta(api, "video001")
    for cuerpo in ({"modo": "turbo"}, {"modo": "auto", "ruta": "C:\\x"}, {"modo": 1}):
        assert (await api.post(f"/video/proyectos/{pid}/render", json=cuerpo)).status_code == 422
    assert (await api.post("/video/proyectos/video777/render", json={"modo": "auto"})).status_code == 404
    assert api.app.state.cerrojos.de(pid) is None and api.app.state.cerrojos.de("video777") is None


async def test_render_dos_veces_409(api):
    pid = await _alta(api, "video097")  # no acaba
    assert (await api.post(f"/video/proyectos/{pid}/render", json={"modo": "auto"})).status_code == 202
    r = await api.post(f"/video/proyectos/{pid}/render", json={"modo": "auto"})
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "render_en_curso"
    api.app.state.cierre.set()  # que el hilo del render salga al cerrar


async def test_put_sigue_permitido_durante_un_render(api):
    pid = await _proyecto(api)
    api.app.state.cerrojos.tomar(pid, "render")
    r = await api.put(f"/video/proyectos/{pid}", json={"revision": 0, "proyecto": {"id": pid, "titulo": "Nuevo"}})
    assert r.status_code == 200


async def test_render_fallido_legible(api):
    pid = await _alta(api, "video099")
    r = await api.post(f"/video/proyectos/{pid}/render", json={"modo": "auto"})
    final = await _esperar(api, r.json()["id"])
    assert final["status"] == "failed" and final["error"] == video_rest.MENSAJE_RENDER_FALLIDO
    _sin_rutas_t11(json.dumps(final))
    assert api.app.state.cerrojos.de(pid) is None


async def test_jobs_rechaza_video_render_por_el_endpoint(api):
    r = await api.post("/jobs", json={"kind": "video_render", "args": {"id": "video001", "titulo": "x", "modo": "auto"}})
    assert r.status_code == 400
    assert api.app.state.jobs.list() == []
    with pytest.raises(ValueError, match="interno"):
        api.app.state.jobs.enqueue("video_render", {})


async def test_render_colgado_falla_y_cola_sigue(api, monkeypatch):
    monkeypatch.setattr(video_rest, "DEADLINE_RENDER", 0.4)
    colgado = await _alta(api, "video097")
    bueno = await _alta(api, "video001")
    api.app.state.jobs.runners["prueba"] = lambda: {"ok": 1}
    r1 = await api.post(f"/video/proyectos/{colgado}/render", json={"modo": "auto"})
    r2 = await api.post(f"/video/proyectos/{bueno}/render", json={"modo": "auto"})
    assert r2.status_code == 202
    # Un trabajo de otro carril (subidas, transcripción) no espera al render colgado.
    otro = api.app.state.jobs.enqueue("prueba", {})
    assert (await _esperar(api, otro["id"]))["status"] == "done"
    assert api.app.state.jobs.get(r1.json()["id"])["status"] in ("queued", "running")
    j1 = await _esperar(api, r1.json()["id"])
    assert j1["status"] == "failed" and j1["error"] == video_rest.MENSAJE_RENDER_TIMEOUT
    j2 = await _esperar(api, r2.json()["id"])  # la cola del carril sigue
    assert j2["status"] == "done"
    assert api.app.state.cerrojos.de(colgado) is None and api.app.state.cerrojos.de(bueno) is None


# ----------------------------------------------------- motor_muere_en_render (R0-6)


def _procesos_con_imagen_bajo(carpetas: list[Path], exactos: list[Path]) -> list[int]:
    salida = []
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            exe = Path(os.readlink(d / "exe").removesuffix(" (deleted)"))
        except OSError:
            continue
        if exe in exactos or any(c in exe.parents for c in carpetas):
            salida.append(int(d.name))
    return salida


@pytest.mark.skipif(not Path("/proc").is_dir(), reason="enumera procesos por /proc (Linux); en Windows lo cubre el test real")
async def test_motor_muere_en_render(api, tmp_path, monkeypatch):
    """El motor muere a media ejecución: job fallido legible, cerrojo suelto y, tras relanzar, ningún proceso con
    imagen bajo el CfT ni el ffmpeg del bundle (el barrido al arrancar lo hace el SIMULADOR; el motor real, en T6)."""
    cft = tmp_path / "navegador" / config.NAVEGADOR_VERSION
    cft.mkdir(parents=True)
    bundle = tmp_path / "video-engine"
    (bundle / "ffmpeg").mkdir(parents=True)
    for n in ("ffmpeg.exe", "ffprobe.exe"):
        shutil.copy(shutil.which("sleep"), bundle / "ffmpeg" / n)
    monkeypatch.setattr(config, "NAVEGADOR_DIR", tmp_path / "navegador")
    monkeypatch.setattr(config, "VIDEO_ENGINE_DIR", bundle)
    monkeypatch.setattr(video.navegador, "verificar", lambda carpeta: carpeta)
    carpetas, exactos = [cft], [bundle / "ffmpeg" / "ffmpeg.exe", bundle / "ffmpeg" / "ffprobe.exe"]

    muere = await _alta(api, "video098")
    sano = await _alta(api, "video001")
    try:
        r = await api.post(f"/video/proyectos/{muere}/render", json={"modo": "auto"})
        j = await _esperar(api, r.json()["id"])
        assert j["status"] == "failed" and j["error"] == video_rest.MENSAJE_RENDER_FALLIDO
        _sin_rutas_t11(json.dumps(j))
        assert api.app.state.cerrojos.de(muere) is None
        huerfanos = _procesos_con_imagen_bajo(carpetas, exactos)
        assert len(huerfanos) == 2, "el test no prueba nada si el motor no dejó procesos"
        # La siguiente acción relanza el motor, que barre al arrancar.
        r = await api.post(f"/video/proyectos/{sano}/render", json={"modo": "auto"})
        assert (await _esperar(api, r.json()["id"]))["status"] == "done"
        for _ in range(50):
            if not _procesos_con_imagen_bajo(carpetas, exactos):
                break
            await asyncio.sleep(0.1)
        assert _procesos_con_imagen_bajo(carpetas, exactos) == []
    finally:
        for pid in _procesos_con_imagen_bajo(carpetas, exactos):
            os.kill(pid, 9)


@pytest.mark.skip(reason="Necesita Windows con el CfT descargado, el ffmpeg del bundle y un render real de HyperFrames (lo valida Marc / T21).")
def test_real_motor_muere_en_render_sin_procesos_huerfanos():
    """Mismo recorrido que `test_motor_muere_en_render` con el motor real: matar `node` en pleno render y comprobar que,
    tras el relanzamiento, no queda ningún proceso con imagen bajo el CfT ni el ffmpeg del bundle (R0-6)."""


@pytest.mark.skip(reason="Un render real necesita Chrome (CfT) y ffmpeg del bundle; no se lanza en la validación local.")
def test_real_render_de_extremo_a_extremo():
    """POST /render con el motor real, hasta `done`, sin rutas en el resultado."""


# ================================================================== motor real: mensajes y códigos reales


async def test_real_sin_clave_en_voces_es_409_sin_clave(real):
    r = await real.get("/video/voces")
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "sin_clave", r.text
    assert "Añade tu clave" not in r.text


async def _proyecto_real(real) -> str:
    gid = (await real.post("/video/guiones", json={"guion": _guion_real()})).json()["id"]
    r = await real.post("/video/proyectos", json={"guion_id": gid, "perfil_id": "defecto"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_real_sin_voz_es_otro_codigo_que_sin_clave(real, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_VOICE_ID", raising=False)
    pid = await _proyecto_real(real)
    r = await real.post(f"/video/proyectos/{pid}/voz/coste", json={})
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "sin_voz", r.text


async def test_real_coste_plan_y_errores_del_motor(real, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
    pid = await _proyecto_real(real)
    r = await real.post(f"/video/proyectos/{pid}/voz/coste", json={})
    assert r.status_code == 200, r.text
    c = r.json()
    assert c["caracteres"] > 0 and isinstance(c["plan"], str) and c["fallidasFacturadas"] == []
    assert c["voz"]["id"] == "21m00Tcm4TlvDq8ikWAM" and c["voz"]["nombre"] == c["voz"]["id"]  # sin clave no hay nombres
    # El coste cambiado y el plan cambiado salen del motor real con el mismo código.
    r = await real.post(f"/video/proyectos/{pid}/voz", json={"plan_confirmado": c["plan"], "caracteres_confirmados": c["caracteres"] + 1})
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "coste_cambiado", r.text
    r = await real.post(f"/video/proyectos/{pid}/voz", json={"plan_confirmado": "otro", "caracteres_confirmados": c["caracteres"]})
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "coste_cambiado", r.text
    # Con plan y coste buenos pero sin clave: sin_clave (y sin gastar nada).
    r = await real.post(f"/video/proyectos/{pid}/voz", json={"plan_confirmado": c["plan"], "caracteres_confirmados": c["caracteres"]})
    assert r.status_code == 409 and r.json()["detail"]["codigo"] == "sin_clave", r.text


async def test_real_perfiles(real):
    r = await real.get("/video/perfiles")
    assert r.status_code == 200 and "defecto" in [p["id"] for p in r.json()["perfiles"]]
    r = await real.post("/video/perfiles/defecto/duplicar", json={"nombre": "Copia"})
    assert r.status_code == 201 and re.fullmatch(r"p-[0-9a-f]{16}", r.json()["id"])
    r = await real.put("/video/perfiles/defecto", json={"perfil": {"id": "p-0123456789abcdef"}})
    assert r.status_code == 422
