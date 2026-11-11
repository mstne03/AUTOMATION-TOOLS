"""Servidor MCP de prueba por stdio que hace de motor de vídeo en los tests de `MotorVideo`.

Al arrancar crea VIDEO_STATE_DIR (si viene) y deja allí un log, como hace el motor real.
"""

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

import anyio
from mcp.server.mcpserver import MCPServer
from mcp_types import CallToolResult, TextContent

mcp = MCPServer("motor-falso")


@mcp.tool()
def eco(texto: str) -> str:
    return texto


@mcp.tool()
async def dormir(segundos: float) -> str:
    await anyio.sleep(segundos)
    return "despierto"


@mcp.tool()
def morir() -> str:
    os._exit(1)


@mcp.tool()
def pid() -> int:
    return os.getpid()


@mcp.tool()
def entorno(nombre: str) -> str:
    return os.environ.get(nombre, "<ausente>")


@mcp.tool()
def escribir_stderr(texto: str) -> str:
    print(texto, file=sys.stderr, flush=True)
    return "escrito"


@mcp.tool()
def datos_entorno(nombre: str) -> list[TextContent]:
    """Como el motor real: un texto legible y, en el último bloque, el JSON de `datos`."""
    valor = os.environ.get(nombre, "<ausente>")
    return [
        TextContent(type="text", text=f"{nombre} leída"),
        TextContent(type="text", text=json.dumps({"nombre": nombre, "valor": valor, "eco": f"x{valor}x"})),
    ]


@mcp.tool()
def fallar(texto: str) -> str:
    raise ValueError(texto)


# ------------------------------------------------------------------------------------------
# Tools de guiones y proyectos (T4 del plan de vídeo, todavía sin hacer en el motor real).
# SIMULADOR: sus validaciones de esquema (`_validar_guion`, claves del proyecto) NO son la frontera; la
# cobertura real de esquema está en `test_video_rest.py::test_real_*`, contra `video-mcp-server/dist`.
# Simulan la interfaz del plan: `datos` en el último bloque de texto y, en los errores tipados,
# `isError` con un bloque JSON `{ codigo, problemas }`. `problemas` solo lleva ruta y código.
# ------------------------------------------------------------------------------------------

_GUIONES: dict[str, Any] = {}
_PROYECTOS: dict[str, dict] = {}
CLAVES_GUION = {"version", "titulo", "gancho", "escenas", "opciones"}


def _ok(texto: str, datos: Any) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=texto), TextContent(type="text", text=json.dumps(datos))]
    )


def _error(codigo: str, texto: str, problemas: list[dict] | None = None) -> CallToolResult:
    cuerpo = {"codigo": codigo, "problemas": problemas or []}
    return CallToolResult(
        is_error=True,
        content=[TextContent(type="text", text=texto), TextContent(type="text", text=json.dumps(cuerpo))],
    )


def _validar_guion(guion: Any) -> CallToolResult | None:
    if not isinstance(guion, dict):
        return _error("esquema", "El documento no cumple el esquema (1 problema).", [{"ruta": "", "codigo": "invalid_type"}])
    problemas = [{"ruta": "?", "codigo": "unrecognized_keys"} for k in guion if k not in CLAVES_GUION]
    if isinstance(guion.get("escenas"), list) and len(guion["escenas"]) > 90:
        problemas.append({"ruta": "escenas", "codigo": "too_big"})
    if problemas:
        return _error("esquema", f"El documento no cumple el esquema ({len(problemas)} problemas).", problemas)
    return None


@mcp.tool()
def video_guion_esquema() -> CallToolResult:
    return _ok("Esquema", {"texto": "ESQUEMA-FALSO"})


@mcp.tool()
async def video_guion_guardar(guion: Any, id: str | None = None) -> CallToolResult:
    if isinstance(guion, dict) and guion.get("titulo") == "COLGAR":
        await anyio.sleep(60)
    if (malo := _validar_guion(guion)) is not None:
        return malo
    gid = id or "g-" + hashlib.sha256(str(len(_GUIONES)).encode()).hexdigest()[:16]
    _GUIONES[gid] = guion
    return _ok("Guion guardado", {"id": gid, "avisos": []})


@mcp.tool()
def video_guion_listar() -> CallToolResult:
    return _ok("Guiones", {"guiones": [{"id": g, "titulo": v.get("titulo", "")} for g, v in _GUIONES.items()]})  # forma del motor real


@mcp.tool()
def video_guion_leer(id: str) -> CallToolResult:
    if id == "g-ffffffffffffffff":  # error sin tipar y con una ruta dentro, como uno inesperado de Node
        raise ValueError("EACCES: permission denied, open 'C:\\Users\\marc\\AppData\\x\\guiones\\g.json'")
    if id == "g-eeeeeeeeeeeeeeee":  # error tipado cuyo mensaje se cuela una ruta
        return _error("no_encontrado", "No existe /home/marc/seo-studio/guiones/g.json")
    if id == "g-dddddddddddddddd":  # tipado con rutas con espacios en el mensaje
        return _error("conflicto", "Fallo en C:\\Program Files\\SEO Studio\\x y en C:\\Users\\Marc Serra\\y")
    if id == "g-cccccccccccccccc":
        return _error("no_encontrado", "No existe C:\\Users\\Marc Serra\\AppData\\Local\\seo-studio\\g.json")
    if id == "g-bbbbbbbbbbbbbbbb":
        return _error("coste_cambiado", "Coste en C:\\Program Files\\SEO Studio")
    if id == "g-aaaaaaaaaaaaaaaa":  # problemas hostiles: valores, rutas y HTML donde van ruta y codigo
        return _error(
            "esquema",
            "No cumple C:\\Users\\Marc Serra\\x",
            [
                {"ruta": "escenas.0.texto", "codigo": "too_big"},
                {"ruta": "escenas.0.<img src=x>", "codigo": "C:\\Users\\Marc Serra"},
                {"ruta": "C:\\Program Files\\SEO Studio", "codigo": "valor con espacios"},
            ],
        )
    if id not in _GUIONES:
        return _error("no_encontrado", "No existe ese guion.")
    return _ok("Guion", _GUIONES[id])


@mcp.tool()
def video_guion_borrar(id: str) -> CallToolResult:
    if id not in _GUIONES:
        return _error("no_encontrado", "No existe ese guion.")
    del _GUIONES[id]
    return _ok("Guion borrado", {})


@mcp.tool()
def video_proyecto_crear(guionId: str, perfilId: str) -> CallToolResult:
    if guionId not in _GUIONES:
        return _error("no_encontrado", "No existe ese guion.")
    if perfilId != "defecto":
        return _error("no_encontrado", "No existe ese perfil.")
    raiz = Path(os.environ["VIDEO_ROOT"])
    n = 1
    while (raiz / f"video{n:03d}").exists():
        n += 1
    pid = f"video{n:03d}"
    (raiz / pid).mkdir(parents=True)
    (raiz / pid / "proyecto.json").write_text("{}", encoding="utf-8")
    _PROYECTOS[pid] = {"id": pid, "revision": 0, "titulo": _GUIONES[guionId].get("titulo", ""), "perfilId": perfilId}
    return _ok("Proyecto creado", {"id": pid})


@mcp.tool()
def video_proyecto_listar() -> CallToolResult:
    return _ok("Proyectos", {"proyectos": [{"id": k, "titulo": v["titulo"], "estado": "sin_voz"} for k, v in _PROYECTOS.items()]})  # forma del motor real


@mcp.tool()
def video_proyecto_leer(id: str) -> CallToolResult:
    if id not in _PROYECTOS:
        return _error("no_encontrado", "No existe ese proyecto.")
    creado = Path(os.environ["VIDEO_ROOT"]) / id / "creado.txt"  # un test lo cambia para simular un id reutilizado
    marca = creado.read_text(encoding="utf-8").strip() if creado.is_file() else "2026-11-07T10:00:00.000Z"
    return _ok("Proyecto", {"proyecto": {**_PROYECTOS[id], "creado": marca}, "avisos": []})  # forma del motor real


@mcp.tool()
def video_montar_preview(id: str, webgpu: bool = False) -> CallToolResult:
    """SIMULADOR (T10): la `_composicion/` real la genera T3; el test la crea y fija aquí `carpeta`."""
    if id not in _PROYECTOS:
        return _error("no_encontrado", "No existe ese proyecto.")
    ajustes = Path(os.environ["VIDEO_ROOT"]) / id / "_composicion" / "montar.json"
    datos = json.loads(ajustes.read_text(encoding="utf-8")) if ajustes.is_file() else {}
    return _ok(
        "Preview montada",
        {"carpeta": datos.get("carpeta", "r1"), "duracion": 12.5, "avisos": [], "fondo": {"pedido": "x", "usado": "x"}},
    )


@mcp.tool()
def video_proyecto_guardar(id: str, revision: int, proyecto: Any) -> CallToolResult:
    if id not in _PROYECTOS:
        return _error("no_encontrado", "No existe ese proyecto.")
    if not isinstance(proyecto, dict) or set(proyecto) - (CLAVES_GUION | {"id", "revision", "perfilId", "recursos"}):
        return _error("esquema", "El proyecto no cumple el esquema (1 problema).", [{"ruta": "?", "codigo": "unrecognized_keys"}])
    if revision != _PROYECTOS[id]["revision"]:
        return _error("conflicto", "El proyecto cambió desde otra fuente.")
    _PROYECTOS[id] = {**_PROYECTOS[id], **{k: v for k, v in proyecto.items() if k in {"titulo"}}, "revision": revision + 1}
    return _ok("Proyecto guardado", {"revision": revision + 1, "avisos": []})


# ------------------------------------------------------------------------------------------
# Voz, voces, perfiles, recursos y render (T11). SIMULADOR: los mensajes de error de la voz son LITERALES del
# motor real (`voz.ts`; `test_video_t11.py::test_literales_del_simulador_son_los_del_motor` lo comprueba contra el
# fuente). Las tools `falso_*` solo existen aquí: configuran o inspeccionan el simulador.
# ------------------------------------------------------------------------------------------

ELEVEN_ID = "21m00Tcm4TlvDq8ikWAM"
MSG_SIN_CLAVE = "Añade tu clave de ElevenLabs en Ajustes de SEO Studio."
MSG_SIN_VOZ = "El perfil no tiene una voz válida. Elige la voz en el perfil."
MSG_COSTE = "El coste ha cambiado: ahora son {n} caracteres. Vuelve a revisarlo antes de confirmar."
MSG_PLAN = "El contenido a generar ha cambiado desde que lo revisaste. Vuelve a revisarlo antes de confirmar."
MSG_CONFLICTO_VOZ = "Ya se está generando la voz de este proyecto."
MSG_SIN_FFMPEG = "Falta ffmpeg en la instalación de SEO Studio; reinstala la aplicación."
MSG_EN_USO = "El recurso está en uso en una escena."

_CFG: dict[str, Any] = {"clave": True, "voz": True, "ffmpeg": True, "fallidas": False, "fallo": False, "dormir": 0.0, "dormir_voces": 0.0}
_LLAMADAS: list[dict] = []
_PERFILES: dict[str, dict] = {"defecto": {"id": "defecto", "nombre": "Defecto", "voz": ELEVEN_ID, "idioma": "es"}}
_RECURSOS: dict[str, dict[str, bool]] = {}


@mcp.tool()
def falso_configurar(valores: dict) -> str:
    _CFG.update(valores)
    return "ok"


@mcp.tool()
def falso_llamadas() -> CallToolResult:
    return _ok("Llamadas", _LLAMADAS)


@mcp.tool()
def falso_proyecto(id: str, titulo: str = "Prueba") -> CallToolResult:
    """Da de alta un proyecto con un id concreto (en este proceso y en disco)."""
    carpeta = Path(os.environ["VIDEO_ROOT"]) / id
    carpeta.mkdir(parents=True, exist_ok=True)
    (carpeta / "proyecto.json").write_text("{}", encoding="utf-8")
    _PROYECTOS[id] = {"id": id, "revision": 0, "titulo": titulo, "perfilId": "defecto"}
    return _ok("Proyecto", {"id": id})


def _plan() -> dict:
    fallidas = [{"fraseId": "f1", "intentos": 1, "caracteresCobrados": 60}] if _CFG["fallidas"] else []
    return {
        "pendientes": ["f0", "f1"],
        "caracteres": 120,
        "voz": {"voiceId": ELEVEN_ID, "modelo": "eleven_multilingual_v2"},
        "plan": "plan-" + hashlib.sha256(b"f0f1" + (b"x" if fallidas else b"")).hexdigest()[:32],
        "fallidasFacturadas": fallidas,
        "caracteresRefacturados": 60 if fallidas else 0,
    }


def _requisitos_voz() -> CallToolResult | None:
    if not _CFG["voz"]:
        return _error("sin_voz", "Error en voz: " + MSG_SIN_VOZ, [{"ruta": "voz", "codigo": "sin_voz"}])
    return None


@mcp.tool()
def video_voz_coste(id: str, frases: list[str] | None = None) -> CallToolResult:
    if id not in _PROYECTOS:
        return _error("no_encontrado", "No existe ese proyecto.")
    if (malo := _requisitos_voz()) is not None:
        return malo
    return _ok("Coste", _plan())


@mcp.tool()
async def video_voz_generar(
    id: str,
    caracteresConfirmados: float,
    planConfirmado: str,
    frases: list[str] | None = None,
    reintentarFacturadas: bool | None = None,
) -> CallToolResult:
    _LLAMADAS.append({"tool": "video_voz_generar", "id": id, "frases": frases, "caracteresConfirmados": caracteresConfirmados, "planConfirmado": planConfirmado, "reintentarFacturadas": reintentarFacturadas})
    if id not in _PROYECTOS:
        return _error("no_encontrado", "No existe ese proyecto.")
    if (malo := _requisitos_voz()) is not None:
        return malo
    p = _plan()
    if caracteresConfirmados != p["caracteres"]:
        return _error("coste_cambiado", MSG_COSTE.format(n=p["caracteres"]), [{"ruta": "caracteresConfirmados", "codigo": "coste_cambiado"}])
    if planConfirmado != p["plan"]:
        return _error("coste_cambiado", MSG_PLAN, [{"ruta": "planConfirmado", "codigo": "plan_cambiado"}])
    if p["fallidasFacturadas"] and reintentarFacturadas is not True:
        return _error("reintento_facturado", "1 frase(s) ya se cobraron y no se pudieron usar.", [{"ruta": "f1", "codigo": "reintento_facturado"}])
    if not _CFG["clave"]:
        return _error("sin_clave", MSG_SIN_CLAVE)
    if not _CFG["ffmpeg"]:
        return _error_sin_tipar(MSG_SIN_FFMPEG)
    if _CFG["dormir"]:
        await anyio.sleep(_CFG["dormir"])
    if _CFG["fallo"]:
        return _ok("Parcial", {"generadas": 1, "caracteresFacturados": 60, "fallo": {"fraseId": "f1", "mensaje": "C:\\Users\\Marc Serra\\x: boom", "facturada": True}})
    return _ok("Voz", {"generadas": 2, "caracteresFacturados": 120})


def _error_sin_tipar(texto: str) -> CallToolResult:
    return CallToolResult(is_error=True, content=[TextContent(type="text", text=f"Error en voz: {texto}")])


@mcp.tool()
def video_voz_quitar_silencios(id: str, fraseId: str) -> CallToolResult:
    if id not in _PROYECTOS:
        return _error("no_encontrado", "No existe ese proyecto.")
    _LLAMADAS.append({"tool": "video_voz_quitar_silencios", "id": id, "fraseId": fraseId})
    _PROYECTOS[id]["revision"] += 1  # el motor real guarda el proyecto
    return _ok("Recorte", {"recorte": {"inicio": 0.1, "fin": 2.5}})


@mcp.tool()
async def video_voces() -> CallToolResult:
    if _CFG["dormir_voces"]:
        await anyio.sleep(_CFG["dormir_voces"])
    if not _CFG["clave"]:
        return _error("sin_clave", "Error en video_voces: " + MSG_SIN_CLAVE)
    return _ok("Voces", {"voces": [{"id": ELEVEN_ID, "nombre": "Lucía", "idioma": "es", "planMuestra": "m" * 64}]})


@mcp.tool()
def video_voz_muestra(caracteresConfirmados: float, planConfirmado: str, voiceId: str | None = None, perfilId: str | None = None, reintentarFacturada: bool | None = None) -> CallToolResult:
    _LLAMADAS.append({"tool": "video_voz_muestra", "voiceId": voiceId, "perfilId": perfilId, "caracteresConfirmados": caracteresConfirmados, "planConfirmado": planConfirmado, "reintentarFacturada": reintentarFacturada})
    if not _CFG["clave"]:
        return _error("sin_clave", MSG_SIN_CLAVE)
    if caracteresConfirmados != 60 or planConfirmado != "m" * 64:
        return _error("coste_cambiado", MSG_PLAN, [{"ruta": "planConfirmado", "codigo": "plan_cambiado"}])
    if _CFG["fallidas"] and reintentarFacturada is not True:
        return _error("reintento_facturado", "La muestra de esta voz ya se cobró (60 caracteres).", [{"ruta": "voiceId", "codigo": "reintento_facturado"}])
    return _ok("Muestra", {"audioBase64": "QUJD", "caracteres": 60, "cache": False})


@mcp.tool()
def video_perfiles_listar() -> CallToolResult:
    return _ok("Perfiles", {"perfiles": list(_PERFILES.values())})


@mcp.tool()
def video_perfil_guardar(id: str, perfil: Any) -> CallToolResult:
    _LLAMADAS.append({"tool": "video_perfil_guardar", "id": id, "perfil": perfil})
    if id not in _PERFILES:
        return _error("no_encontrado", "No existe ese perfil.")
    if isinstance(perfil, dict) and perfil.get("id", id) != id:
        return _error("esquema", "El documento no cumple el esquema (1 problema).", [{"ruta": "id", "codigo": "id_distinto"}])
    _PERFILES[id] = {**perfil, "id": id}
    return _ok("Perfil guardado", {"id": id})


@mcp.tool()
def video_perfil_duplicar(id: str, nombre: str | None = None) -> CallToolResult:
    _LLAMADAS.append({"tool": "video_perfil_duplicar", "id": id, "nombre": nombre})
    if id not in _PERFILES:
        return _error("no_encontrado", "No existe ese perfil.")
    nuevo = "p-" + hashlib.sha256(str(len(_PERFILES)).encode()).hexdigest()[:16]
    _PERFILES[nuevo] = {**_PERFILES[id], "id": nuevo, "nombre": nombre or "Copia"}
    return _ok("Perfil duplicado", {"id": nuevo})


@mcp.tool()
def video_recurso_importar(id: str, bandejaId: str, clase: str, nombreOriginal: str | None = None) -> CallToolResult:
    """SIMULADOR (T7/T13): la bandeja real es `<estado>/video/bandeja/<32hex>.bin`. `ee…` = recurso que una escena usa."""
    _LLAMADAS.append({"tool": "video_recurso_importar", "id": id, "bandejaId": bandejaId, "clase": clase, **({"nombreOriginal": nombreOriginal} if nombreOriginal else {})})
    if id not in _PROYECTOS:
        return _error("no_encontrado", "No existe ese proyecto.")
    if bandejaId == "0" * 32:
        return _error("no_encontrado", "No existe esa entrada de la bandeja.")
    rid = "r-" + hashlib.sha256(bandejaId.encode()).hexdigest()[:16]
    _RECURSOS.setdefault(id, {})[rid] = bandejaId.startswith("ee")
    _PROYECTOS[id]["revision"] += 1
    recurso = {"id": rid, "clase": clase, "ext": "jpg" if clase == "foto" else "mp4", "nombreOriginal": "foto.jpg", "ancho": 800, "alto": 600, "duracion": 0}
    return _ok("Recurso importado", {"recurso": recurso, "avisos": [{"codigo": "foto_pequena"}]})


_PISTAS: dict[str, dict] = {}


@mcp.tool()
def video_musica_listar() -> CallToolResult:
    """SIMULADOR (T7): la biblioteca real son `m-<16hex>.m4a` y su `.json` en `<estado>/video/musica`; nunca rutas."""
    return _ok("Pistas", {"pistas": list(_PISTAS.values())})


@mcp.tool()
def video_musica_importar(bandejaId: str, nombreOriginal: str | None = None) -> CallToolResult:
    _LLAMADAS.append({"tool": "video_musica_importar", "bandejaId": bandejaId, **({"nombreOriginal": nombreOriginal} if nombreOriginal else {})})
    if bandejaId == "0" * 32:
        return _error("no_encontrado", "No existe esa entrada de la bandeja.")
    pid = "m-" + hashlib.sha256(bandejaId.encode()).hexdigest()[:16]
    _PISTAS[pid] = {"id": pid, "nombre": nombreOriginal or "pista.m4a", "duracion": 95.5, "ruta": "C:\\Users\\x\\musica.m4a"}
    return _ok("Pista importada", {"pista": _PISTAS[pid]})


@mcp.tool()
def video_recurso_borrar(id: str, recursoId: str) -> CallToolResult:
    if id not in _PROYECTOS or recursoId not in _RECURSOS.get(id, {}):
        return _error("no_encontrado", "No existe ese recurso.")
    if _RECURSOS[id][recursoId]:
        return _error("en_uso", MSG_EN_USO)
    del _RECURSOS[id][recursoId]
    _PROYECTOS[id]["revision"] += 1
    return _ok("Recurso borrado", {})


# --- render (canal propio). Comportamiento por el final del id: 097 no acaba, 098 muere con hijos huérfanos, 099 falla,
# 096 devuelve un job_id con forma inesperada (con el render lanzado) y 095 responde al sondeo con un error tipado.
_JOBS: dict[str, dict] = {}


def _bajo(ruta: Path, carpetas: list[Path]) -> bool:
    return any(ruta == c or c in ruta.parents for c in carpetas)


def _barrer() -> None:
    """Simula el barrido al arrancar del motor (R0-6): mata lo que tenga imagen bajo el CfT o sea el ffmpeg del bundle."""
    navegador = os.environ.get("HYPERFRAMES_BROWSER_PATH")
    ffmpeg = os.environ.get("FFMPEG_DIR")
    carpetas = [Path(navegador).parent] if navegador else []
    exactos = [Path(ffmpeg) / n for n in ("ffmpeg.exe", "ffprobe.exe")] if ffmpeg else []
    proc = Path("/proc")
    if not proc.is_dir():
        return
    for d in proc.iterdir():
        if not d.name.isdigit() or int(d.name) == os.getpid():
            continue
        try:
            exe = Path(os.readlink(d / "exe").removesuffix(" (deleted)"))
        except OSError:
            continue
        if _bajo(exe, carpetas) or exe in exactos:
            try:
                os.kill(int(d.name), 9)
            except OSError:
                pass


def _lanzar_huerfanos() -> None:
    import shutil
    import subprocess

    chrome = Path(os.environ["HYPERFRAMES_BROWSER_PATH"])
    chrome.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(shutil.which("sleep") or "/bin/sleep", chrome)
    os.chmod(chrome, 0o755)
    for exe in (chrome, Path(os.environ["FFMPEG_DIR"]) / "ffmpeg.exe"):
        subprocess.Popen([str(exe), "300"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)


@mcp.tool()
def video_renderizar(id: str, modo: str = "auto") -> CallToolResult:
    if id.endswith("98") and os.environ.get("FFMPEG_DIR"):
        _lanzar_huerfanos()
    jid = f"j{len(_JOBS) + 1}"
    if id.endswith("96"):
        _JOBS[jid] = {"id": id, "modo": modo, "polls": 0, "clave": None}
        return _ok("Render lanzado", {"job_id": "../" + jid, "id": id, "estado": "en_cola", "mp4": None, "avisos": []})
    _JOBS[jid] = {"id": id, "modo": modo, "polls": 0, "clave": os.environ.get("ELEVENLABS_API_KEY")}
    return _ok("Render lanzado", {"job_id": jid, "id": id, "estado": "en_cola", "mp4": None, "avisos": []})


@mcp.tool()
def video_estado_render(job_id: str) -> CallToolResult:
    j = _JOBS.get(job_id)
    if j is None:
        return _error_sin_tipar("No existe el job " + job_id)
    j["polls"] += 1
    if j["id"].endswith("95"):
        return _error("conflicto", "El render se descolgó.")
    base = {"job_id": job_id, "id": j["id"], "fase": None, "mp4": None, "duracion": None, "avisos": []}
    if j["id"].endswith("97"):
        return _ok("renderizando", {**base, "estado": "renderizando", "progreso": 10})
    if j["id"].endswith("98"):
        os._exit(1)
    if j["id"].endswith("99"):
        return _ok("error", {**base, "estado": "error", "progreso": 30, "error": "ffmpeg falló en C:\\Users\\Marc Serra\\x", "salida": ["C:\\Users\\Marc Serra\\y"]})
    if j["polls"] < 3:
        return _ok("renderizando", {**base, "estado": "renderizando", "progreso": 50.0 * j["polls"] / 2})
    (Path(os.environ["VIDEO_ROOT"]) / j["id"]).mkdir(parents=True, exist_ok=True)
    (Path(os.environ["VIDEO_ROOT"]) / j["id"] / "video.mp4").write_bytes(b"mp4")
    return _ok(
        "terminado",
        {
            **base,
            "estado": "terminado",
            "progreso": 100,
            "mp4": "C:\\Users\\Marc Serra\\AppData\\video.mp4",
            "duracion": 12.5,
            "modo": j["modo"],
            "codificador": "h264_mf",
            "avisos": ["C:\\Users\\Marc Serra\\x", {"codigo": "fondo_degradado"}],
            "reserva": ["fondo_degradado"],
        },
    )


def _preparar_estado() -> None:
    _barrer()
    estado = os.environ.get("VIDEO_STATE_DIR")
    if estado:
        Path(estado).mkdir(parents=True, exist_ok=True)
        (Path(estado) / "motor-falso.log").write_text("arrancado\n", encoding="utf-8")


if __name__ == "__main__":
    _preparar_estado()
    mcp.run()
