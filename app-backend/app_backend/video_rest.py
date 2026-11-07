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
import threading
import time
from collections import defaultdict
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi import Path as RutaPath
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)
from starlette.datastructures import MutableHeaders
from starlette.responses import JSONResponse
from youtube_mcp.utils import progress

from app_backend import config, preview, video
from app_backend.jobs import ErrorPublico
from app_backend.navegador import _borrar, comprobar_ancestros, es_enlace

log = logging.getLogger("app_backend.video")

# Patrones de ruta. `RECURSO` es el formato de T1 (`RECURSO_ID_RE`) y `BANDEJA` el de T13 (pendiente):
# los usan T7/T11, que añaden sus rutas; se declaran aquí para que haya una sola fuente.
PROYECTO = r"^video[0-9]{3}$"  # solo ASCII: `\d` aceptaría dígitos Unicode
GUION = r"^g-[0-9a-f]{16}$"
PERFIL = r"^(defecto|p-[0-9a-f]{16})$"
RECURSO = r"^r-[0-9a-f]{16}$"
BANDEJA = r"^[0-9a-f]{32}$"  # formato de T13: `<estado>/video/bandeja/<32hex>.bin` (simulado hasta que llegue T13)
FRASE = r"^[A-Za-z0-9_-]{1,40}$"  # ids de frase (el motor los acota a 40 caracteres)
VOZ_ID = r"^[A-Za-z0-9]{10,40}$"  # `VOICE_ID_RE` del motor
ID_URL = r"^[A-Za-z0-9_-]{1,64}$"  # ids de servidor de las rutas anteriores al módulo de vídeo

LIMITE_CUERPO = 1024 * 1024  # 1 MiB
DEADLINE_RENDER = 6 * 3600.0  # sobre el peor caso de 180 s de vídeo (T11); los tests lo acortan
SONDEO_RENDER = 1.0  # segundos entre sondeos de `video_estado_render`
TIMEOUT_VOCES = 20.0  # `video_voces` va a ElevenLabs: corto y propio, para que un catálogo lento no ate al motor
TOOL_BARRIDO = "video_barrer_procesos"  # TODO(T6): nombre que el backend espera del motor para el barrido (R0-6)
MAX_FRASES = 540  # 90 escenas × 6 frases
PROFUNDIDAD_MAXIMA = 16
CSP = "sandbox; default-src 'none'"
_RUTA_PROBLEMA = re.compile(r"[A-Za-z0-9_]{1,40}(\.[A-Za-z0-9_]{1,40}){0,8}", re.ASCII)
_CODIGO_PROBLEMA = re.compile(r"[a-z_]{1,40}", re.ASCII)

IdProyecto = Annotated[str, RutaPath(pattern=PROYECTO)]
IdGuion = Annotated[str, RutaPath(pattern=GUION)]
IdPerfil = Annotated[str, RutaPath(pattern=PERFIL)]
IdRecurso = Annotated[str, RutaPath(pattern=RECURSO)]
IdFrase = Annotated[str, StringConstraints(pattern=FRASE)]


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
        r = JSONResponse(
            {"detail": {"mensaje": "El cuerpo supera el máximo de 1 MiB.", "codigo": "demasiado_grande"}}, status_code=413
        )
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


class CosteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    frases: list[IdFrase] | None = Field(default=None, max_length=MAX_FRASES)


class VozIn(BaseModel):
    """Confirmación de la voz. El plan lo da el motor en `/voz/coste` y el backend nunca lo recalcula."""

    model_config = ConfigDict(extra="forbid")
    plan_confirmado: str = Field(min_length=1, max_length=100)
    caracteres_confirmados: int = Field(strict=True, ge=0, le=10**6)
    frases: list[IdFrase] | None = Field(default=None, max_length=MAX_FRASES)
    reintentar_facturadas: Any = None  # solo el `true` literal cuenta; cualquier otro valor es false


class QuitarSilenciosIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    frase_id: str = Field(pattern=FRASE)


class MuestraIn(BaseModel):
    """Muestra de una voz: la que se prueba (`voiceId`, al elegir en el catálogo) o la de un perfil (`perfil_id`)."""

    model_config = ConfigDict(extra="forbid")
    voiceId: str | None = Field(default=None, pattern=VOZ_ID)
    perfil_id: str | None = Field(default=None, pattern=PERFIL)
    plan_confirmado: str = Field(min_length=1, max_length=100)
    caracteres_confirmados: int = Field(strict=True, ge=0, le=10**6)
    reintentar_facturada: Any = None

    @model_validator(mode="after")
    def _una_sola_voz(self):
        if (self.voiceId is None) == (self.perfil_id is None):
            raise ValueError("indica voiceId o perfil_id, uno solo")
        return self


class PerfilPutIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    perfil: dict


class DuplicarIn(BaseModel):
    """El id nuevo lo genera siempre el motor (R0-3): el cuerpo no puede pedir uno."""

    model_config = ConfigDict(extra="forbid")
    nombre: str | None = Field(default=None, max_length=240)


class RecursoIn(BaseModel):
    """La UI nunca envía rutas: solo el id de la bandeja (T13) y la clase."""

    model_config = ConfigDict(extra="forbid")
    bandeja_id: str = Field(pattern=BANDEJA)
    clase: Literal["foto", "clip"]


class RenderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    modo: Literal["auto", "rapido", "compatible"] = "auto"


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
# nombre de usuario, p. ej. `C:\\Users\\Marc Serra\\…`). El detalle va solo al log. TODO error de este módulo
# lleva `detail: {mensaje, codigo}`: la UI decide por `codigo`, nunca por el texto.
MENSAJE_503 = "El motor de vídeo no está disponible. Reinicia la aplicación o reinstálala."
MENSAJE_TIMEOUT = "El motor de vídeo tardó demasiado y se ha reiniciado; vuelve a intentarlo."
MENSAJE_502 = "El motor de vídeo no pudo completar la acción."
MENSAJE_SIN_FFMPEG = "Falta ffmpeg en la instalación de SEO Studio: reinstala la aplicación."
MENSAJE_RENDER_FALLIDO = "El render no se pudo completar. Vuelve a intentarlo; si se repite, reinicia la aplicación."
MENSAJE_RENDER_TIMEOUT = "El render tardó demasiado y se ha dado por fallido; vuelve a intentarlo."
MENSAJE_RENDER_CERRADO = "La aplicación se cerró durante el render."
MENSAJE_FALLO_VOZ = "La generación de la voz se detuvo en una frase; lo ya generado se conserva."
MENSAJE_TIMEOUT_OCUPADO = "El motor de vídeo está ocupado con otra tarea y no respondió a tiempo; vuelve a intentarlo cuando termine."
MENSAJE_SIN_RECURSOS = "La gestión de recursos de vídeo todavía no está disponible en esta versión."
MENSAJES_503_FIJOS = {video.MENSAJE_DETENIDO, video.MENSAJE_NO_INSTALADO}
# código del motor -> (HTTP, mensaje fijo, código público). La voz (contrato-voz.md) y los recursos añaden los suyos.
MENSAJES_POR_CODIGO = {
    "esquema": (422, "El documento no cumple el esquema.", "esquema"),
    "conflicto": (409, "El proyecto ha cambiado desde otra fuente; recárgalo.", "conflicto"),
    "coste_cambiado": (409, "El coste ha cambiado; revísalo y confirma de nuevo.", "coste_cambiado"),
    "plan_cambiado": (409, "El coste ha cambiado; revísalo y confirma de nuevo.", "coste_cambiado"),
    "reintento_facturado": (409, "Hay frases ya cobradas que no se pudieron usar; reintentarlas se cobra otra vez.", "reintento_facturado"),
    "sin_clave": (409, "Falta la clave de ElevenLabs: añádela en Ajustes.", "sin_clave"),
    "sin_voz": (409, "Falta elegir la voz: hazlo en el perfil.", "sin_voz"),
    "voz_pendiente": (409, "Faltan voces por generar.", "voz_pendiente"),
    "fallo_facturado": (502, "ElevenLabs cobró la muestra, pero no se pudo usar; reintentarla se cobra otra vez.", "fallo_facturado"),
    "en_uso": (409, "El recurso está en uso en una escena; quítalo de ahí antes de borrarlo.", "recurso_en_uso"),
    "demasiado_grande": (413, "El archivo supera el tamaño máximo admitido.", "demasiado_grande"),
    "no_encontrado": (404, "No encontrado.", "no_encontrado"),
}


def _error(estado: int, mensaje: str, codigo: str, problemas: list | None = None) -> HTTPException:
    detalle: dict[str, Any] = {"mensaje": mensaje, "codigo": codigo}
    if problemas is not None:
        detalle["problemas"] = problemas
    return HTTPException(estado, detalle)


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
    """Traduce un error del motor a `{mensaje, codigo}` fijos por clase o por `codigo`; el detalle, al log."""
    if isinstance(e, video.MotorNoDisponible):
        log.warning("Motor de vídeo no disponible: %s", e)
        return _error(503, str(e) if str(e) in MENSAJES_503_FIJOS else MENSAJE_503, "no_disponible")
    if isinstance(e, video.MotorOcupado):
        log.warning("Motor de vídeo: timeout sin reinicio (trabajo en curso): %s", e)
        return _error(503, MENSAJE_TIMEOUT_OCUPADO, "no_disponible")
    if isinstance(e, video.MotorTimeout):
        log.warning("Motor de vídeo: timeout: %s", e)
        return _error(503, MENSAJE_TIMEOUT, "no_disponible")
    if e.codigo in MENSAJES_POR_CODIGO:
        estado, mensaje, codigo = MENSAJES_POR_CODIGO[e.codigo]
        if estado == 422:
            return _error(422, mensaje, codigo, _problemas_seguros(e.problemas))
        return _error(estado, mensaje, codigo)
    if e.codigo is None and "ffmpeg" in str(e).lower():
        log.warning("Motor de vídeo: falta ffmpeg: %s", e)
        return _error(503, MENSAJE_SIN_FFMPEG, "no_disponible")
    log.warning("Motor de vídeo: error sin tipar: %s", e)
    return _error(502, MENSAJE_502, "error_motor")


async def _llamar(estado, tool: str, args: dict | None = None, timeout: float | None = None, protegida: bool = False) -> Any:
    try:
        r = await video.motor_de(estado, tool).llamar(tool, args, timeout, protegida)
    except video.MotorError as e:
        raise _http(e) from None
    return r.datos


# ------------------------------------------------- cerrojos de actividad y saneado

_AVISO_CODIGO = re.compile(r"[a-z_]{1,40}", re.ASCII)
_TEXTO_CORTO = re.compile(r"[A-Za-z0-9_.-]{1,60}", re.ASCII)
_BASE64 = re.compile(r"[A-Za-z0-9+/=]*", re.ASCII)
_EXT_RECURSO = {"jpg", "png", "webp", "mp4", "wav", "m4a"}
_CLASES_RECURSO = {"foto", "clip", "musica"}


class Ocupado(Exception):
    """El proyecto ya tiene una actividad (`render` o `voz`) en curso."""

    def __init__(self, tipo: str) -> None:
        super().__init__(tipo)
        self.tipo = tipo


class Cerrojos:
    """`dict[id, "render" | "voz"]` en memoria. Está en el backend porque hay dos procesos de motor.

    Se toma antes de llamar al motor y se suelta siempre en un `finally` (la voz) o al acabar el job (el render).
    """

    def __init__(self) -> None:
        self._m: dict[str, str] = {}
        self._l = threading.Lock()  # el runner del render suelta desde un hilo

    def alguno(self) -> bool:
        """¿Algún proyecto tiene una voz o un render en curso?"""
        with self._l:
            return bool(self._m)

    def tomar(self, id: str, tipo: str) -> None:
        with self._l:
            actual = self._m.get(id)
            if actual is not None:
                raise Ocupado(actual)
            self._m[id] = tipo

    def soltar(self, id: str, tipo: str) -> None:
        with self._l:
            if self._m.get(id) == tipo:
                del self._m[id]

    def de(self, id: str) -> str | None:
        with self._l:
            return self._m.get(id)


def _ocupado(e: Ocupado) -> HTTPException:
    if e.tipo == "render":
        return _error(409, "Hay un render en curso en este proyecto; espera a que termine.", "render_en_curso")
    return _error(409, "Se está generando la voz de este proyecto; espera a que termine.", "voz_en_curso")


async def _tomar(estado, id: str, tipo: str) -> None:
    """Toma el cerrojo de actividad bajo el cerrojo del proyecto (el mismo que usan PUT y DELETE)."""
    async with cerrojo_de(id):
        try:
            estado.cerrojos.tomar(id, tipo)
        except Ocupado as e:
            raise _ocupado(e) from None


def timeout_voz(frases: int) -> float:
    """Timeout de `video_voz_generar`: `60 + 200 × frases` s, para no matar el motor a media ejecución."""
    return 60.0 + 200.0 * max(1, frases)


def _entero(v: Any, maximo: int = 10**9) -> int:
    return int(v) if isinstance(v, int | float) and not isinstance(v, bool) and 0 <= v <= maximo else 0


def _avisos_seguros(avisos: Any) -> list[dict]:
    """Solo códigos: un aviso del motor con texto libre (o una ruta) no llega a la UI."""
    salida = []
    for a in (avisos if isinstance(avisos, list) else [])[:50]:
        codigo = a.get("codigo") if isinstance(a, dict) else a
        if isinstance(codigo, str) and _AVISO_CODIGO.fullmatch(codigo):
            salida.append({"codigo": codigo})
    return salida


async def _exigir_tool(estado, tool: str) -> None:
    """501 `no_disponible` si el motor aún no registra `tool` (los recursos llegan con T7): nunca un 502 con texto."""
    try:
        tools = await video.motor_de(estado, tool).herramientas()
    except video.MotorError as e:
        raise _http(e) from None
    if tool not in tools:
        log.warning("El motor no tiene la tool %s todavía.", tool)
        raise _error(501, MENSAJE_SIN_RECURSOS, "no_disponible")


def _inesperada() -> HTTPException:
    return _error(502, "El motor de vídeo devolvió una respuesta inesperada.", "error_motor")


_NOMBRE_PELIGROSO = re.compile(r"[\\/:\x00-\x1f\x7f]|\.\.")


def recurso_seguro(r: Any) -> dict:
    """Los campos del contrato de un recurso del motor, con tope; cualquier otro (una ruta) se descarta."""
    if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not re.fullmatch(RECURSO, r["id"]):
        raise ValueError("recurso sin id válido")
    if r.get("clase") not in _CLASES_RECURSO or r.get("ext") not in _EXT_RECURSO:
        raise ValueError("clase o extensión fuera de la lista")
    nombre = r.get("nombreOriginal")
    return {
        "id": r["id"],
        "clase": r["clase"],
        "ext": r["ext"],
        # Defensa en profundidad: un nombre con separadores, `..` o caracteres de control no llega a la UI.
        "nombreOriginal": nombre[:120] if isinstance(nombre, str) and not _NOMBRE_PELIGROSO.search(nombre) else "",
        "ancho": _entero(r.get("ancho"), 8192),
        "alto": _entero(r.get("alto"), 8192),
        "duracion": _numero_seguro(r.get("duracion"), 3600) or 0,
    }


def _resultado_render(id: str, modo: str, d: dict) -> dict:
    """`{ id, duracion, modo, codificador, avisos, reserva }`: nunca la ruta del MP4 ni texto del motor."""
    cod = d.get("codificador")
    reserva = d.get("reserva")
    return {
        "id": id,
        "duracion": _numero_seguro(d.get("duracion"), 3600),
        "modo": d["modo"] if d.get("modo") in ("auto", "rapido", "compatible") else modo,
        "codificador": cod if isinstance(cod, str) and _TEXTO_CORTO.fullmatch(cod) else None,
        "avisos": _avisos_seguros(d.get("avisos")),
        "reserva": [x for x in (reserva if isinstance(reserva, list) else [])[:10] if isinstance(x, str) and _TEXTO_CORTO.fullmatch(x)],
    }


def _estado_proyecto(estado, id: Any, jobs: list[dict]) -> str:
    """`renderizando` por cerrojo, `listo` si existe el MP4, `error` si el último render falló, `borrador` si no."""
    if not isinstance(id, str) or not re.fullmatch(PROYECTO, id):
        return "borrador"
    if estado.cerrojos.de(id) == "render":
        return "renderizando"
    mp4 = config.VIDEO_ROOT / id / "video.mp4"
    if mp4.is_file() and not es_enlace(mp4):
        return "listo"
    ultimo = next((j for j in jobs if j["kind"] == "video_render" and j["args"].get("id") == id), None)
    return "error" if ultimo is not None and ultimo["status"] == "failed" else "borrador"


async def reiniciar_motor_render(motor) -> bool:
    """Reinicio del motor del render al vencer el deadline (R0-6). `True` si el motor nuevo barrió los procesos huérfanos.

    Los Chrome y ffmpeg del render cuelgan del Job Object del sidecar y no mueren con el motor. Antes de parar se
    registran los PID conocidos (para poder rastrearlos) y, ya con el motor nuevo, se le pide el barrido si tiene la
    tool. El barrido real al arrancar es de T6 (ver `docs/video-fase1/pendientes-T11.md`).
    """
    pids = motor.pids_conocidos()
    log.warning("Render: se reinicia el motor del render; PID conocidos antes de pararlo: %s.", pids)
    await motor.cerrar()
    try:
        if TOOL_BARRIDO not in await motor.herramientas():
            log.warning(
                "TODO(T6): el motor no tiene %s; los procesos hijos %s (Chrome, ffmpeg) pueden quedar huérfanos hasta el "
                "próximo barrido del motor.",
                TOOL_BARRIDO,
                pids,
            )
            return False
        await motor.llamar(TOOL_BARRIDO, {}, 120.0)
    except video.MotorError as e:
        log.warning("No se pudo pedir el barrido al motor del render: %s", e)
        return False
    return True


def crear_runner_render(estado, loop: asyncio.AbstractEventLoop):
    """Runner `render_job(id, titulo, modo)` del carril `video`: lanza `video_renderizar` y sondea cada segundo.

    Corre en el hilo del job; llama al motor con `run_coroutine_threadsafe`. Si el motor muere, no responde o supera el
    deadline, el job falla con un mensaje fijo. El cerrojo del proyecto solo se suelta cuando el render ha parado de
    verdad: porque el motor dijo `terminado` o `error`, o porque se paró el motor del render. Si no se pudo parar, el
    cerrojo se queda (el proyecto sigue «renderizando») y se deja en el log.
    """

    def en_el_bucle(coro, espera: float = 600.0):
        return asyncio.run_coroutine_threadsafe(coro, loop).result(espera)

    def llamar(tool: str, args: dict) -> dict:
        d = en_el_bucle(video.motor_de(estado, tool).llamar(tool, args)).datos
        if not isinstance(d, dict):
            raise video.MotorError("respuesta sin datos")
        return d

    def parar_motor() -> bool:
        try:
            en_el_bucle(estado.motor_render.cerrar(), 60.0)
        except Exception as e:  # noqa: BLE001 - se informa abajo: el cerrojo se queda
            log.warning("No se pudo parar el motor del render: %s", e)
            return False
        return True

    def render_job(id: str, titulo: str, modo: str) -> dict:
        lanzado = False  # el motor pudo empezar a renderizar
        parado = False  # y se sabe que ya no corre
        try:
            try:
                en_marcha = en_el_bucle(video.motor_de(estado, "video_renderizar").llamar("video_renderizar", {"id": id, "modo": modo}))
            except video.MotorError:
                raise  # el motor respondió con un error o se reinició: no hay render en marcha
            except BaseException:
                lanzado = True  # sin respuesta que lo descarte (p. ej. se agotó la espera): puede haber empezado
                raise
            lanzado = True
            if not isinstance(en_marcha.datos, dict):
                raise video.MotorError("respuesta sin datos")
            job_id = en_marcha.datos.get("job_id")
            if not isinstance(job_id, str) or not _TEXTO_CORTO.fullmatch(job_id):
                raise video.MotorError("job_id inválido")
            limite = time.monotonic() + DEADLINE_RENDER
            while True:
                if estado.cierre.is_set():
                    raise ErrorPublico(MENSAJE_RENDER_CERRADO)
                if time.monotonic() > limite:
                    log.warning("Render de %s: deadline superado; se reinicia el motor del render.", id)
                    try:
                        en_el_bucle(reiniciar_motor_render(estado.motor_render), 300.0)
                        parado = True
                    except Exception as e:  # noqa: BLE001 - el job falla igual; el `finally` reintenta la parada
                        log.warning("No se pudo reiniciar el motor del render: %s", e)
                    raise ErrorPublico(MENSAJE_RENDER_TIMEOUT)
                d = llamar("video_estado_render", {"job_id": job_id})
                if d.get("estado") == "terminado":
                    parado = True
                    return _resultado_render(id, modo, d)
                if d.get("estado") == "error":
                    parado = True
                    log.warning("Render de %s fallido: %s", id, str(d.get("error"))[:300])
                    raise ErrorPublico(MENSAJE_RENDER_FALLIDO)
                p = _numero_seguro(d.get("progreso"), 100)
                if p is not None:
                    progress.report(p / 100)
                estado.cierre.wait(SONDEO_RENDER)
        except ErrorPublico:
            raise
        except (video.MotorError, TimeoutError, OSError, RuntimeError) as e:
            log.warning("Render de %s: %s", id, e)
            raise ErrorPublico(MENSAJE_RENDER_FALLIDO) from None
        except Exception:
            log.exception("Render de %s: error inesperado", id)
            raise ErrorPublico(MENSAJE_RENDER_FALLIDO) from None
        finally:
            if lanzado and not parado:
                parado = parar_motor()
            if parado or not lanzado:
                estado.cerrojos.soltar(id, "render")
            else:
                log.error("Render de %s: no se pudo parar; el proyecto sigue marcado como renderizando.", id)

    return render_job


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
            raise _inesperada()
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
        datos = await _llamar(estado, "video_proyecto_listar")
        lista = datos.get("proyectos") if isinstance(datos, dict) else datos
        if not isinstance(lista, list):
            raise _inesperada()
        jobs = estado.jobs.list(200) if getattr(estado, "jobs", None) is not None else []
        for p in lista:
            if isinstance(p, dict):
                p["estado"] = await asyncio.to_thread(_estado_proyecto, estado, p.get("id"), jobs)
        return datos

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
            if (activo := estado.cerrojos.de(id)) is not None:  # render o voz en curso: no se borra por debajo
                raise _ocupado(Ocupado(activo))
            try:
                existia = await asyncio.to_thread(borrar_proyecto, id)
            except ProyectoEsEnlace:
                raise _error(409, "La carpeta del proyecto es un enlace y no se borra.", "proyecto_enlace") from None
            except ProyectoEnUso:
                raise _error(409, "El proyecto está en uso; ciérralo y vuelve a intentarlo.", "proyecto_en_uso") from None
            except OSError as e:
                log.warning("No se pudo borrar %s: %s", id, e)
                raise _error(409, "El proyecto está en uso; ciérralo y vuelve a intentarlo.", "proyecto_en_uso") from None
            estado.claves.cerrar(id)  # la clave de la preview muere con el proyecto
        if not existia:
            raise _error(404, "Proyecto no encontrado.", "no_encontrado")
        return {}

    @r.post("/proyectos/{id}/preview")
    async def abrir_preview(id: IdProyecto, request: Request):
        """Monta la composición y entrega la URL de capacidad. La UI no arma ningún `src` (I8)."""
        cuerpo = await leer_cuerpo_opcional(request, PreviewIn)
        reserva = estado.reserva_preview
        if reserva is None or reserva.servicio is None:
            raise _error(503, preview.MENSAJE_SIN_PUERTO, "no_disponible")
        if estado.runtime.obtener() is None:
            raise _error(503, preview.MENSAJE_RUNTIME, "no_disponible")
        async with cerrojo_de(id):
            datos = await _llamar(estado, "video_montar_preview", {"id": id, "webgpu": cuerpo.webgpu})
            carpeta = datos.get("carpeta") if isinstance(datos, dict) else None
            if not isinstance(carpeta, str) or not re.fullmatch(r"r[0-9]{1,9}", carpeta, re.ASCII):
                log.warning("video_montar_preview devolvió una carpeta inesperada")
                raise _error(502, MENSAJE_502, "error_motor")
            leido = await _llamar(estado, "video_proyecto_leer", {"id": id})
            doc = leido.get("proyecto", leido) if isinstance(leido, dict) else None
            creado = doc.get("creado") if isinstance(doc, dict) else None
            if not isinstance(creado, str) or not 1 <= len(creado) <= 64:
                log.warning("video_proyecto_leer no devolvió `creado`")
                raise _error(502, MENSAJE_502, "error_motor")
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

    # ------------------------------------------------------------------ voz
    # Contrato: docs/video-fase1/contrato-voz.md. El coste y el `plan` salen del motor; el backend nunca recalcula
    # el plan tras la confirmación: reenvía lo confirmado y el motor lo compara con su propio cálculo.

    @r.post("/proyectos/{id}/voz/coste")
    async def coste_voz(id: IdProyecto, request: Request):
        cuerpo = await leer_cuerpo_opcional(request, CosteIn)
        args: dict[str, Any] = {"id": id}
        if cuerpo.frases is not None:
            args["frases"] = cuerpo.frases
        d = await _llamar(estado, "video_voz_coste", args)
        voz = d.get("voz") if isinstance(d, dict) else None
        vid = voz.get("voiceId") if isinstance(voz, dict) else None
        if not isinstance(d, dict) or not isinstance(d.get("plan"), str) or len(d["plan"]) > 100 or not (
            isinstance(vid, str) and re.fullmatch(VOZ_ID, vid)
        ):
            raise _inesperada()
        nombre = vid
        try:  # el nombre se cruza con el catálogo; sin catálogo (sin clave, sin red) se queda el id
            catalogo = await _llamar(estado, "video_voces", timeout=TIMEOUT_VOCES)
            for v in catalogo.get("voces", []) if isinstance(catalogo, dict) else []:
                if isinstance(v, dict) and v.get("id") == vid and isinstance(v.get("nombre"), str) and v["nombre"]:
                    nombre = v["nombre"][:80]
        except HTTPException:
            pass

        def ids(xs: list) -> list[str]:
            return [x for x in xs if isinstance(x, str) and re.fullmatch(FRASE, x)][:MAX_FRASES]

        fallidas = [f.get("fraseId") if isinstance(f, dict) else f for f in d.get("fallidasFacturadas") or []]
        return {
            "pendientes": ids(d.get("pendientes") or []),
            "caracteres": _entero(d.get("caracteres")),
            "caracteresRefacturados": _entero(d.get("caracteresRefacturados")),
            "fallidasFacturadas": ids(fallidas),
            "plan": d["plan"],
            "voz": {"id": vid, "nombre": nombre},
        }

    @r.post("/proyectos/{id}/voz")
    async def generar_voz(id: IdProyecto, request: Request):
        cuerpo = await leer_cuerpo(request, VozIn)
        await _tomar(estado, id, "voz")
        try:
            args: dict[str, Any] = {
                "id": id,
                "caracteresConfirmados": cuerpo.caracteres_confirmados,
                "planConfirmado": cuerpo.plan_confirmado,
                "reintentarFacturadas": cuerpo.reintentar_facturadas is True,
            }
            if cuerpo.frases is not None:
                args["frases"] = cuerpo.frases
            # Cada frase tiene al menos un carácter: sin ámbito, el tope de frases lo da lo confirmado.
            n = len(cuerpo.frases) if cuerpo.frases is not None else min(MAX_FRASES, max(1, cuerpo.caracteres_confirmados))
            d = await _llamar(estado, "video_voz_generar", args, timeout=timeout_voz(n), protegida=True)
        finally:
            estado.cerrojos.soltar(id, "voz")
        if not isinstance(d, dict):
            raise _inesperada()
        salida: dict[str, Any] = {"generadas": _entero(d.get("generadas")), "caracteresFacturados": _entero(d.get("caracteresFacturados"))}
        f = d.get("fallo")
        if isinstance(f, dict):
            fid = f.get("fraseId")
            facturada = f.get("facturada") is True
            log.warning("Voz de %s: la generación se cortó en %s (facturada=%s): %s", id, fid, facturada, str(f.get("mensaje"))[:300])
            salida["fallo"] = {
                "fraseId": fid if isinstance(fid, str) and re.fullmatch(FRASE, fid) else "",
                "facturada": facturada,
                "codigo": "fallo_facturado" if facturada else "fallo_voz",
                "mensaje": MENSAJE_FALLO_VOZ,
            }
        return salida

    @r.post("/proyectos/{id}/voz/quitar-silencios")
    async def quitar_silencios(id: IdProyecto, request: Request):
        """El motor guarda el proyecto (sube su revisión) y no la devuelve: la UI vuelve a pedir el proyecto."""
        cuerpo = await leer_cuerpo(request, QuitarSilenciosIn)
        await _tomar(estado, id, "voz")
        try:
            async with cerrojo_de(id):
                d = await _llamar(estado, "video_voz_quitar_silencios", {"id": id, "fraseId": cuerpo.frase_id}, protegida=True)
        finally:
            estado.cerrojos.soltar(id, "voz")
        rec = d.get("recorte") if isinstance(d, dict) else None
        inicio = _numero_seguro(rec.get("inicio"), 3600) if isinstance(rec, dict) else None
        fin = _numero_seguro(rec.get("fin"), 3600) if isinstance(rec, dict) else None
        if inicio is None or fin is None:
            raise _inesperada()
        return {"recorte": {"inicio": inicio, "fin": fin}}

    @r.get("/voces")
    async def listar_voces():
        d = await _llamar(estado, "video_voces", timeout=TIMEOUT_VOCES)
        salida = []
        for v in (d.get("voces") if isinstance(d, dict) else None) or []:
            if isinstance(v, dict) and isinstance(v.get("id"), str) and re.fullmatch(VOZ_ID, v["id"]):
                salida.append(
                    {
                        "id": v["id"],
                        "nombre": str(v.get("nombre") or v["id"])[:80],
                        "idioma": str(v.get("idioma") or "")[:20],
                        "planMuestra": str(v.get("planMuestra") or "")[:100],
                    }
                )
        return {"voces": salida[:500]}

    @r.post("/voces/muestra")
    async def muestra_voz(request: Request):
        cuerpo = await leer_cuerpo(request, MuestraIn)
        args: dict[str, Any] = {
            "caracteresConfirmados": cuerpo.caracteres_confirmados,
            "planConfirmado": cuerpo.plan_confirmado,
            "reintentarFacturada": cuerpo.reintentar_facturada is True,
        }
        if cuerpo.voiceId is not None:
            args["voiceId"] = cuerpo.voiceId
        else:
            args["perfilId"] = cuerpo.perfil_id
        d = await _llamar(estado, "video_voz_muestra", args, protegida=True)
        audio = d.get("audioBase64") if isinstance(d, dict) else None
        if not isinstance(audio, str) or len(audio) > 4_000_000 or not _BASE64.fullmatch(audio):
            raise _inesperada()
        return {"audioBase64": audio, "caracteres": _entero(d.get("caracteres")), "cache": d.get("cache") is True}

    # --------------------------------------------------------------- perfiles

    @r.get("/perfiles")
    async def listar_perfiles():
        d = await _llamar(estado, "video_perfiles_listar")
        if not isinstance(d, dict) or not isinstance(d.get("perfiles"), list):
            raise _inesperada()
        return d

    @r.post("/perfiles/{pid}/duplicar", status_code=201)
    async def duplicar_perfil(pid: IdPerfil, request: Request):
        cuerpo = await leer_cuerpo_opcional(request, DuplicarIn)
        args: dict[str, Any] = {"id": pid}
        if cuerpo.nombre is not None:
            args["nombre"] = cuerpo.nombre
        d = await _llamar(estado, "video_perfil_duplicar", args)
        nuevo = d.get("id") if isinstance(d, dict) else None
        if not isinstance(nuevo, str) or not re.fullmatch(PERFIL, nuevo):
            raise _inesperada()
        return {"id": nuevo}

    @r.put("/perfiles/{pid}")
    async def guardar_perfil(pid: IdPerfil, request: Request):
        cuerpo = await leer_cuerpo(request, PerfilPutIn)
        if cuerpo.perfil.get("id", pid) != pid:
            raise _422("El id del perfil no coincide con el de la ruta.", "id_distinto")
        d = await _llamar(estado, "video_perfil_guardar", {"id": pid, "perfil": cuerpo.perfil})
        if not isinstance(d, dict):
            raise _inesperada()
        return {"id": pid}

    # --------------------------------------------------------------- recursos

    @r.post("/proyectos/{id}/recursos", status_code=201)
    async def importar_recurso(id: IdProyecto, request: Request):
        """Importa lo que hay en la bandeja (T13) como recurso del proyecto: `{ recurso, avisos }`.

        Supuesto (T18): el motor escribe `recursos` en `proyecto.json` y **sube la revisión**; la respuesta no la
        lleva, así que la UI vuelve a pedir `GET /video/proyectos/{id}` antes de seguir editando.
        """
        cuerpo = await leer_cuerpo(request, RecursoIn)
        await _exigir_tool(estado, "video_recurso_importar")
        async with cerrojo_de(id):
            d = await _llamar(estado, "video_recurso_importar", {"id": id, "bandejaId": cuerpo.bandeja_id, "clase": cuerpo.clase})
        try:
            recurso = recurso_seguro(d.get("recurso") if isinstance(d, dict) else None)
        except ValueError:
            log.warning("video_recurso_importar devolvió un recurso inesperado")
            raise _inesperada() from None
        return {"recurso": recurso, "avisos": _avisos_seguros(d.get("avisos"))}

    @r.delete("/proyectos/{id}/recursos/{rid}")
    async def borrar_recurso(id: IdProyecto, rid: IdRecurso):
        await _exigir_tool(estado, "video_recurso_borrar")
        async with cerrojo_de(id):
            await _llamar(estado, "video_recurso_borrar", {"id": id, "recursoId": rid})
        return {}

    # ----------------------------------------------------------------- render

    @r.post("/proyectos/{id}/render", status_code=202)
    async def lanzar_render(id: IdProyecto, request: Request):
        """Encola el render (job interno `video_render`). El cerrojo se suelta al acabar el job."""
        cuerpo = await leer_cuerpo_opcional(request, RenderIn)
        await _tomar(estado, id, "render")
        try:
            leido = await _llamar(estado, "video_proyecto_leer", {"id": id})
            doc = leido.get("proyecto", leido) if isinstance(leido, dict) else {}
            titulo = doc.get("titulo") if isinstance(doc, dict) else None
            titulo = titulo[:120] if isinstance(titulo, str) else id
            return estado.jobs.enqueue("video_render", {"id": id, "titulo": titulo, "modo": cuerpo.modo}, interno=True)
        except BaseException:
            estado.cerrojos.soltar(id, "render")
            raise

    return r
