"""Frontera REST del guion y los proyectos de vídeo (T9).

Es la primera ruta por la que la salida del modelo (guion pegado, KB, transcripciones) llega a la
composición: aquí no se valida el esquema (lo hace el motor, `.strict()`), pero sí todo lo que
acota el JSON antes de reenviarlo: tope de cuerpo, profundidad, claves del sobre, ids con patrón,
errores sin valores ni rutas. El modelo no tiene tools `video_*` (D2): solo la UI llega aquí.
"""

import asyncio
import json
import logging
import os
import re
import secrets
from collections import defaultdict
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request
from fastapi import Path as RutaPath
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.datastructures import MutableHeaders
from starlette.responses import JSONResponse

from app_backend import config, preview, video
from app_backend.navegador import _borrar, comprobar_ancestros, es_enlace

log = logging.getLogger("app_backend.video")

# Patrones de ruta. `RECURSO` es el formato de T1 (`RECURSO_ID_RE`) y `BANDEJA` el de T13 (pendiente):
# los usan T7/T11, que añaden sus rutas; se declaran aquí para que haya una sola fuente.
PROYECTO = r"^video[0-9]{3}$"  # solo ASCII: `\d` aceptaría dígitos Unicode
GUION = r"^g-[0-9a-f]{16}$"
PERFIL = r"^(defecto|p-[0-9a-f]{16})$"
RECURSO = r"^r-[0-9a-f]{16}$"
BANDEJA = r"^b-[0-9a-f]{16}$"  # SIMULADO hasta T13
ID_URL = r"^[A-Za-z0-9_-]{1,64}$"  # ids de servidor de las rutas anteriores al módulo de vídeo

LIMITE_CUERPO = 1024 * 1024  # 1 MiB
PROFUNDIDAD_MAXIMA = 16
CSP = "sandbox; default-src 'none'"
_RUTA_PROBLEMA = re.compile(r"[A-Za-z0-9_]{1,40}(\.[A-Za-z0-9_]{1,40}){0,8}", re.ASCII)
_CODIGO_PROBLEMA = re.compile(r"[a-z_]{1,40}", re.ASCII)

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


class PreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    webgpu: bool = Field(default=False, strict=True)


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


def _rechazar_no_finito(constante: str) -> None:
    raise ValueError("no finito")


def _tiene_sustituto_suelto(v: object) -> bool:
    """True si alguna cadena (valor o clave) lleva un sustituto UTF-16 suelto (U+D800–U+DFFF)."""
    pila = [v]
    while pila:
        x = pila.pop()
        if isinstance(x, str):
            if any("\ud800" <= c <= "\udfff" for c in x):
                return True
        elif isinstance(x, dict):
            pila.extend(x.keys())
            pila.extend(x.values())
        elif isinstance(x, list):
            pila.extend(x)
    return False


async def leer_cuerpo[M: BaseModel](request: Request, modelo: type[M]) -> M:
    """JSON acotado (profundidad, forma del sobre) y validado sin devolver nunca el valor recibido."""
    crudo = await request.body()
    try:
        v = json.loads(crudo, parse_constant=_rechazar_no_finito)
    except (ValueError, RecursionError):
        raise _422("El cuerpo no es JSON válido.", "json") from None
    if _profundidad_excedida(v):
        raise _422(f"El JSON se anida a más de {PROFUNDIDAD_MAXIMA} niveles.", "profundidad")
    if _tiene_sustituto_suelto(v):
        # R1 T1→T9 (N1): `\ud800` es JSON válido, pero no se puede codificar en UTF-8 y tumbaba la
        # sesión MCP del motor (503) antes de validarse.
        raise _422("El texto tiene caracteres Unicode no válidos.", "unicode")
    try:
        return modelo.model_validate(v)
    except ValidationError as e:
        problemas = [{"ruta": _ruta_segura(i["loc"]), "codigo": i["type"]} for i in e.errors()[:50]]
        raise _422("El cuerpo no tiene la forma esperada.", "cuerpo", problemas) from None


async def leer_cuerpo_opcional[M: BaseModel](request: Request, modelo: type[M]) -> M:
    """Como `leer_cuerpo`, pero un cuerpo vacío vale lo mismo que `{}`."""
    if not (await request.body()).strip():
        return modelo()
    return await leer_cuerpo(request, modelo)


def _numero_seguro(v: Any, maximo: float) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) and 0 <= v <= maximo else None


# -------------------------------------------------------------------- errores


# Mensajes fijos: a la UI nunca llega texto libre del motor ni de una excepción (llevan rutas con el
# nombre de usuario, p. ej. `C:\\Users\\Marc Serra\\…`). El detalle va solo al log.
MENSAJE_503 = "El motor de vídeo no está disponible. Reinicia la aplicación o reinstálala."
MENSAJE_TIMEOUT = "El motor de vídeo tardó demasiado y se ha reiniciado; vuelve a intentarlo."
MENSAJE_502 = "El motor de vídeo no pudo completar la acción."
MENSAJES_503_FIJOS = {video.MENSAJE_DETENIDO, video.MENSAJE_NO_INSTALADO}
MENSAJES_POR_CODIGO = {
    "esquema": (422, "El documento no cumple el esquema."),
    "conflicto": (409, "El proyecto ha cambiado desde otra fuente; recárgalo."),
    "coste_cambiado": (409, "El coste ha cambiado; revísalo y confirma de nuevo."),
    "no_encontrado": (404, "No encontrado."),
}


def _problemas_seguros(problemas: list) -> list[dict]:
    """Solo `{ruta, codigo}` y solo si tienen forma de ruta de esquema y de código: nunca valores."""
    salida = []
    for p in problemas[:50]:
        if not isinstance(p, dict):
            continue
        ruta, codigo = str(p.get("ruta", "")), str(p.get("codigo", ""))
        salida.append(
            {
                "ruta": ruta if ruta == "" or _RUTA_PROBLEMA.fullmatch(ruta) else "?",
                "codigo": codigo if _CODIGO_PROBLEMA.fullmatch(codigo) else "desconocido",
            }
        )
    return salida


def _http(e: video.MotorError) -> HTTPException:
    """Traduce un error del motor a un mensaje fijo por clase o por `codigo`; el detalle, al log."""
    if isinstance(e, video.MotorNoDisponible):
        log.warning("Motor de vídeo no disponible: %s", e)
        return HTTPException(503, str(e) if str(e) in MENSAJES_503_FIJOS else MENSAJE_503)
    if isinstance(e, video.MotorTimeout):
        log.warning("Motor de vídeo: timeout: %s", e)
        return HTTPException(503, MENSAJE_TIMEOUT)
    if e.codigo in MENSAJES_POR_CODIGO:
        estado, mensaje = MENSAJES_POR_CODIGO[e.codigo]
        if estado == 422:
            return HTTPException(
                422, {"mensaje": mensaje, "codigo": "esquema", "problemas": _problemas_seguros(e.problemas)}
            )
        return HTTPException(estado, mensaje)
    log.warning("Motor de vídeo: error sin tipar: %s", e)
    return HTTPException(502, MENSAJE_502)


async def _llamar(estado, tool: str, args: dict | None = None) -> Any:
    try:
        r = await video.motor_de(estado, tool).llamar(tool, args)
    except video.MotorError as e:
        raise _http(e) from None
    return r.datos


# --------------------------------------------------------------------- borrado


class ProyectoEsEnlace(Exception):
    """La carpeta del proyecto es un enlace o una junction: no se toca."""


class ProyectoEnUso(Exception):
    """La carpeta del proyecto no se puede renombrar: algo la tiene abierta."""


_cerrojos: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def cerrojo_de(id: str) -> asyncio.Lock:
    """Un cerrojo por proyecto, compartido por PUT y DELETE (los ids tienen patrón: acotado a 1000)."""
    return _cerrojos[id]


def borrar_proyecto(id: str) -> bool:
    """Borra `<VIDEO_ROOT>/<id>`. Devuelve False si no existe.

    Solo hijas directas de `VIDEO_ROOT`. Nunca sigue enlaces: los de dentro se desenlazan
    (`navegador._borrar`) y una carpeta que ya es un punto de reanálisis lanza `ProyectoEsEnlace`
    sin tocarla. Antes de borrar se renombra a una carpeta de papelera: si algo la tiene abierta
    el renombrado falla entero (`ProyectoEnUso`) y el proyecto queda intacto.
    """
    if not re.fullmatch(PROYECTO, id):
        return False
    raiz = config.VIDEO_ROOT
    carpeta = raiz / id
    if carpeta.parent != raiz:
        return False
    try:
        comprobar_ancestros()
    except Exception:  # noqa: BLE001 - un ancestro enlazado se trata como enlace
        raise ProyectoEsEnlace from None
    if es_enlace(carpeta):
        raise ProyectoEsEnlace
    if not carpeta.is_dir():
        return False
    papelera = raiz / f".borrando-{id}-{secrets.token_hex(4)}"
    try:
        os.rename(carpeta, papelera)
    except FileNotFoundError:
        return False
    except OSError as e:
        log.warning("No se pudo renombrar %s para borrarlo: %s", id, e)
        raise ProyectoEnUso from None
    try:
        _borrar(papelera)
    except OSError as e:  # el proyecto ya no existe para el usuario; la papelera se barre luego
        log.warning("Papelera de %s sin vaciar del todo: %s", id, e)
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
        if cuerpo.proyecto.get("id") != id:
            raise _422("El id del proyecto falta o no coincide con el de la ruta.", "id_distinto")
        if "revision" in cuerpo.proyecto and cuerpo.proyecto["revision"] != cuerpo.revision:
            raise _422("La revisión del proyecto no coincide con la del sobre.", "revision_distinta")
        async with cerrojo_de(id):
            return await _llamar(
                estado, "video_proyecto_guardar", {"id": id, "revision": cuerpo.revision, "proyecto": cuerpo.proyecto}
            )

    @r.delete("/proyectos/{id}")
    async def borrar_proyecto_ruta(id: IdProyecto):
        async with cerrojo_de(id):
            try:
                existia = await asyncio.to_thread(borrar_proyecto, id)
            except ProyectoEsEnlace:
                raise HTTPException(409, "La carpeta del proyecto es un enlace y no se borra.") from None
            except ProyectoEnUso:
                raise HTTPException(409, "El proyecto está en uso; ciérralo y vuelve a intentarlo.") from None
            except OSError as e:
                log.warning("No se pudo borrar %s: %s", id, e)
                raise HTTPException(409, "El proyecto está en uso; ciérralo y vuelve a intentarlo.") from None
            estado.claves.cerrar(id)  # la clave de la preview muere con el proyecto
        if not existia:
            raise HTTPException(404, "Proyecto no encontrado.")
        return {}

    @r.post("/proyectos/{id}/preview")
    async def abrir_preview(id: IdProyecto, request: Request):
        """Monta la composición y entrega la URL de capacidad. La UI no arma ningún `src` (I8)."""
        cuerpo = await leer_cuerpo_opcional(request, PreviewIn)
        reserva = estado.reserva_preview
        if reserva is None or reserva.servicio is None:
            raise HTTPException(503, preview.MENSAJE_SIN_PUERTO)
        if estado.runtime.obtener() is None:
            raise HTTPException(503, preview.MENSAJE_RUNTIME)
        async with cerrojo_de(id):
            datos = await _llamar(estado, "video_montar_preview", {"id": id, "webgpu": cuerpo.webgpu})
            carpeta = datos.get("carpeta") if isinstance(datos, dict) else None
            if not isinstance(carpeta, str) or not re.fullmatch(r"r[0-9]{1,9}", carpeta, re.ASCII):
                log.warning("video_montar_preview devolvió una carpeta inesperada")
                raise HTTPException(502, MENSAJE_502)
            leido = await _llamar(estado, "video_proyecto_leer", {"id": id})
            doc = leido.get("proyecto", leido) if isinstance(leido, dict) else None
            creado = doc.get("creado") if isinstance(doc, dict) else None
            if not isinstance(creado, str) or not 1 <= len(creado) <= 64:
                log.warning("video_proyecto_leer no devolvió `creado`")
                raise HTTPException(502, MENSAJE_502)
            clave = estado.claves.rotar(id, carpeta, creado)
        avisos = [
            {"codigo": a["codigo"]}
            for a in (datos.get("avisos") or [])
            if isinstance(a, dict) and isinstance(a.get("codigo"), str) and _CODIGO_PROBLEMA.fullmatch(a["codigo"])
        ]
        if reserva.ajenos:
            log.warning("puertos_preview_ajenos: %s", list(reserva.ajenos))
            avisos.append({"codigo": "puertos_preview_ajenos", "puertos": list(reserva.ajenos)})
        salida: dict[str, Any] = {"url": f"http://127.0.0.1:{reserva.servicio}/p/{clave}/index.html", "avisos": avisos}
        duracion = _numero_seguro(datos.get("duracion"), 3600)
        if duracion is not None:
            salida["duracion"] = duracion
        return salida

    @r.delete("/proyectos/{id}/preview")
    async def cerrar_preview(id: IdProyecto):
        """Cierra el editor: dejan de valer todas las claves del proyecto (con el mismo cerrojo que el POST)."""
        async with cerrojo_de(id):
            estado.claves.cerrar(id)
        return {}

    return r
