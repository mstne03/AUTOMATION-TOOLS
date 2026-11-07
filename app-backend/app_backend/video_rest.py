"""Frontera REST del guion y los proyectos de vídeo (T9).

Es la primera ruta por la que la salida del modelo (guion pegado, KB, transcripciones) llega a la
composición: aquí no se valida el esquema (lo hace el motor, `.strict()`), pero sí todo lo que
acota el JSON antes de reenviarlo: tope de cuerpo, profundidad, claves del sobre, ids con patrón,
errores sin valores ni rutas. El modelo no tiene tools `video_*` (D2): solo la UI llega aquí.
"""

import asyncio
import json
import logging
import re
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request
from fastapi import Path as RutaPath
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.datastructures import MutableHeaders
from starlette.responses import JSONResponse

from app_backend import config, video
from app_backend.navegador import _borrar, es_enlace

log = logging.getLogger("app_backend.video")

# Patrones de ruta. `RECURSO` es el formato de T1 (`RECURSO_ID_RE`) y `BANDEJA` el de T13 (pendiente):
# los usan T7/T11, que añaden sus rutas; se declaran aquí para que haya una sola fuente.
PROYECTO = r"^video\d{3}$"
GUION = r"^g-[0-9a-f]{16}$"
PERFIL = r"^(defecto|p-[0-9a-f]{16})$"
RECURSO = r"^r-[0-9a-f]{16}$"
BANDEJA = r"^b-[0-9a-f]{16}$"  # SIMULADO hasta T13
ID_URL = r"^[A-Za-z0-9_-]{1,64}$"  # ids de servidor de las rutas anteriores al módulo de vídeo

LIMITE_CUERPO = 1024 * 1024  # 1 MiB
PROFUNDIDAD_MAXIMA = 16
CSP = "sandbox; default-src 'none'"
_RUTA_EN_TEXTO = re.compile(r"(?:[A-Za-z]:[\\/]|\\\\|/(?:home|Users|tmp|var|etc|usr|opt|root|mnt)\b)[^\s'\"]*")

IdProyecto = Annotated[str, RutaPath(pattern=PROYECTO)]
IdGuion = Annotated[str, RutaPath(pattern=GUION)]


# ------------------------------------------------------------ middleware ASGI


class _Excedido(Exception):
    pass


class LimiteCuerpo:
    """Tope de cuerpo para `/video/`, contando el flujo real y no solo `Content-Length`.

    ASGI puro: `BaseHTTPMiddleware` interfiere con el SSE del chat.
    """

    def __init__(self, app, limite: int = LIMITE_CUERPO) -> None:
        self.app = app
        self.limite = limite

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/video/"):
            await self.app(scope, receive, send)
            return
        declarado = dict(scope["headers"]).get(b"content-length", b"")
        if declarado.isdigit() and int(declarado) > self.limite:
            await self._rechazar(scope, receive, send)
            return
        leido = 0
        empezada = False

        async def recibir():
            nonlocal leido
            mensaje = await receive()
            if mensaje["type"] == "http.request":
                leido += len(mensaje.get("body", b""))
                if leido > self.limite:
                    raise _Excedido
            return mensaje

        async def enviar(mensaje):
            nonlocal empezada
            if mensaje["type"] == "http.response.start":
                empezada = True
            await send(mensaje)

        try:
            await self.app(scope, recibir, enviar)
        except _Excedido:
            if empezada:
                raise
            await self._rechazar(scope, receive, send)

    async def _rechazar(self, scope, receive, send) -> None:
        r = JSONResponse({"detail": "El cuerpo supera el máximo de 1 MiB."}, status_code=413)
        await r(scope, receive, send)


class CabeceraCSP:
    """`Content-Security-Policy: sandbox; default-src 'none'` en toda respuesta de la API.

    Si alguien abre una respuesta en el navegador (o la API sirviera HTML por error), no ejecuta
    nada. ASGI puro: solo toca `http.response.start`, así que el SSE del chat no cambia.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def enviar(mensaje):
            if mensaje["type"] == "http.response.start":
                MutableHeaders(scope=mensaje)["Content-Security-Policy"] = CSP
            await send(mensaje)

        await self.app(scope, receive, enviar)


# ------------------------------------------------------------------- cuerpos


class GuionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    guion: dict


class ProyectoNuevoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    guion_id: str = Field(pattern=GUION)
    perfil_id: str = Field(pattern=PERFIL)


class ProyectoPutIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(strict=True, ge=0, le=10**9)
    proyecto: dict


def _422(mensaje: str, codigo: str = "esquema", problemas: list | None = None) -> HTTPException:
    return HTTPException(422, {"mensaje": mensaje, "codigo": codigo, "problemas": problemas or []})


def _profundidad_excedida(v: Any) -> bool:
    pila = [(v, 1)]
    while pila:
        x, n = pila.pop()
        if isinstance(x, dict | list):
            if n > PROFUNDIDAD_MAXIMA:
                return True
            pila.extend((h, n + 1) for h in (x.values() if isinstance(x, dict) else x))
    return False


def _ruta_segura(loc: tuple) -> str:
    # El nombre de una clave desconocida es del atacante: solo viaja si parece un identificador.
    return ".".join(str(p) if re.fullmatch(r"[A-Za-z0-9_]{1,40}", str(p)) else "?" for p in loc)


async def leer_cuerpo[M: BaseModel](request: Request, modelo: type[M]) -> M:
    """JSON acotado (profundidad, forma del sobre) y validado sin devolver nunca el valor recibido."""
    crudo = await request.body()
    try:
        v = json.loads(crudo)
    except (ValueError, RecursionError):
        raise _422("El cuerpo no es JSON válido.", "json") from None
    if _profundidad_excedida(v):
        raise _422(f"El JSON se anida a más de {PROFUNDIDAD_MAXIMA} niveles.", "profundidad")
    try:
        return modelo.model_validate(v)
    except ValidationError as e:
        problemas = [{"ruta": _ruta_segura(i["loc"]), "codigo": i["type"]} for i in e.errors()[:50]]
        raise _422("El cuerpo no tiene la forma esperada.", "cuerpo", problemas) from None


# -------------------------------------------------------------------- errores


def _sin_rutas(texto: str) -> str:
    return _RUTA_EN_TEXTO.sub("…", texto)[:300]


def _http(e: video.MotorError) -> HTTPException:
    """Traduce un error del motor. Los mensajes sin tipar (de Node, con rutas) no salen del sidecar."""
    if isinstance(e, video.MotorNoDisponible | video.MotorTimeout):
        return HTTPException(503, _sin_rutas(str(e)))
    mensaje = _sin_rutas(str(e))
    match e.codigo:
        case "esquema":
            return HTTPException(422, {"mensaje": mensaje, "codigo": "esquema", "problemas": e.problemas})
        case "conflicto" | "coste_cambiado":
            return HTTPException(409, mensaje)
        case "no_encontrado":
            return HTTPException(404, mensaje)
    log.warning("Motor de vídeo: error sin tipar: %s", e)
    return HTTPException(502, "El motor de vídeo no pudo completar la acción.")


async def _llamar(estado, tool: str, args: dict | None = None) -> Any:
    try:
        r = await video.motor_de(estado, tool).llamar(tool, args)
    except video.MotorError as e:
        raise _http(e) from None
    return r.datos


# --------------------------------------------------------------------- borrado


def borrar_proyecto(id: str) -> bool:
    """Borra `<VIDEO_ROOT>/<id>`. Devuelve False si no existe; `PermissionError` si es un enlace.

    Solo hijas directas de `VIDEO_ROOT`. Nunca sigue enlaces: los de dentro se desenlazan
    (`navegador._borrar`) y una carpeta que ya es un punto de reanálisis se rechaza sin tocarla.
    """
    if not re.fullmatch(PROYECTO, id):
        return False
    raiz = config.VIDEO_ROOT
    carpeta = raiz / id
    if carpeta.parent != raiz:
        return False
    if es_enlace(carpeta):
        raise PermissionError("La carpeta del proyecto es un enlace.")
    if not carpeta.is_dir():
        return False
    _borrar(carpeta)
    return True


# ---------------------------------------------------------------------- router


def crear_router(estado, protegido: list) -> APIRouter:
    """Rutas de guiones y proyectos. `estado` es `app.state` (el motor se crea en el lifespan)."""
    r = APIRouter(prefix="/video", dependencies=protegido)

    @r.get("/guiones/esquema")
    async def esquema():
        datos = await _llamar(estado, "video_guion_esquema")
        if not isinstance(datos, dict) or not isinstance(datos.get("texto"), str):
            raise HTTPException(502, "El motor de vídeo devolvió una respuesta inesperada.")
        return {"texto": datos["texto"]}

    @r.get("/guiones")
    async def listar_guiones():
        return await _llamar(estado, "video_guion_listar")

    @r.post("/guiones", status_code=201)
    async def crear_guion(request: Request):
        cuerpo = await leer_cuerpo(request, GuionIn)
        return await _llamar(estado, "video_guion_guardar", {"guion": cuerpo.guion})

    @r.get("/guiones/{gid}")
    async def leer_guion(gid: IdGuion):
        return await _llamar(estado, "video_guion_leer", {"id": gid})

    @r.delete("/guiones/{gid}")
    async def borrar_guion(gid: IdGuion):
        await _llamar(estado, "video_guion_borrar", {"id": gid})
        return {}

    @r.get("/proyectos")
    async def listar_proyectos():
        return await _llamar(estado, "video_proyecto_listar")

    @r.post("/proyectos", status_code=201)
    async def crear_proyecto(request: Request):
        cuerpo = await leer_cuerpo(request, ProyectoNuevoIn)
        datos = await _llamar(
            estado, "video_proyecto_crear", {"guionId": cuerpo.guion_id, "perfilId": cuerpo.perfil_id}
        )
        return datos

    @r.get("/proyectos/{id}")
    async def leer_proyecto(id: IdProyecto):
        return await _llamar(estado, "video_proyecto_leer", {"id": id})

    @r.put("/proyectos/{id}")
    async def guardar_proyecto(id: IdProyecto, request: Request):
        cuerpo = await leer_cuerpo(request, ProyectoPutIn)
        if "id" in cuerpo.proyecto and cuerpo.proyecto["id"] != id:
            raise _422("El id del proyecto no coincide con el de la ruta.", "id_distinto")
        return await _llamar(
            estado, "video_proyecto_guardar", {"id": id, "revision": cuerpo.revision, "proyecto": cuerpo.proyecto}
        )

    @r.delete("/proyectos/{id}")
    async def borrar_proyecto_ruta(id: IdProyecto):
        try:
            existia = await asyncio.to_thread(borrar_proyecto, id)
        except PermissionError:
            raise HTTPException(409, "La carpeta del proyecto es un enlace y no se borra.") from None
        except OSError as e:
            log.warning("No se pudo borrar %s: %s", id, e)
            raise HTTPException(409, "No se pudo borrar el proyecto: puede estar en uso.") from None
        if not existia:
            raise HTTPException(404, "Proyecto no encontrado.")
        return {}

    return r
