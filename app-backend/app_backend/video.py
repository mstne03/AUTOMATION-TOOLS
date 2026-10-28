"""Cliente del motor de vídeo (`video-mcp-server`, Node) como proceso hijo MCP por stdio (D1).

El backend no importa el motor: lo lanza como hijo y le habla por la entrada/salida estándar
(sin puertos). Las rutas REST llaman a `MotorVideo.llamar`; el modelo no ve estas tools (D2).

Ciclo de vida:
- Arranque perezoso en la primera llamada. Un `asyncio.Lock` protege solo el arranque, así
  que varias llamadas simultáneas con el motor parado lanzan un único proceso.
- Una tarea propietaria por proceso mantiene el `AsyncExitStack` con `stdio_client` y la
  `ClientSession`: los cancel scopes de anyio deben entrar y salir en la misma tarea, y una
  petición HTTP no puede ser dueña de un proceso que sobrevive a la petición.
- Si el hijo muere o una llamada vence su timeout, la sesión se descarta (se cierra stdin y,
  pasado el margen del SDK, se mata el árbol con su Job Object) y la siguiente llamada relanza.
- En Windows el SDK mete al hijo en un Job Object propio (KILL_ON_JOB_CLOSE), anidado en el
  del sidecar: muere con la app aunque el backend no llegue a llamar a `cerrar()`.
- El hijo hereda solo el entorno mínimo de `get_default_environment()` más `entorno_motor()`:
  ningún secreto del backend llega al motor salvo la clave de ElevenLabs, y solo si existe.
- `stderr` del hijo → logger `app_backend.video`, con la clave de ElevenLabs ocultada.
"""

import asyncio
import contextvars
import json
import logging
import os
import threading
from collections.abc import Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path

import anyio
import mcp.client.stdio as _stdio
from mcp import ClientSession, MCPError, StdioServerParameters, stdio_client
from mcp_types import CONNECTION_CLOSED, ImageContent, TextContent

from app_backend import config

log = logging.getLogger("app_backend.video")

MENSAJE_DETENIDO = "El motor de vídeo se ha detenido; se relanzará en la siguiente acción."
TIMEOUT_ARRANQUE = 60.0  # spawn + initialize; Node con node_modules en frío tarda unos segundos
TIMEOUT_CIERRE = 15.0  # el SDK acota su apagado a ~5 s (stdin cerrado, espera, kill del árbol)
OCULTO = "***"


class MotorError(Exception):
    """Error legible para la UI. Nunca lleva la clave de ElevenLabs."""


class MotorNoDisponible(MotorError):
    """El motor no arranca o ha muerto."""


@dataclass(frozen=True)
class RespuestaMotor:
    texto: str
    datos: dict | list | None
    imagen: tuple[str, str] | None  # (mime, base64)


# --------------------------------------------------------------- pid del hijo
# `stdio_client` no expone el proceso que lanza. Envolvemos su función de spawn para anotar el
# proceso solo cuando la llamada viene de nuestra tarea propietaria (ContextVar); el resto de
# usos de `stdio_client` no cambian. Si una versión futura del SDK renombra la función, `pid`
# queda en None y `test_arranque_perezoso` lo detecta.
_proceso_lanzado: contextvars.ContextVar[list | None] = contextvars.ContextVar(
    "app_backend_video_proceso", default=None
)
_spawn_original = getattr(_stdio, "_create_platform_compatible_process", None)

if _spawn_original is not None:

    async def _spawn_anotado(*args, **kwargs):
        proceso = await _spawn_original(*args, **kwargs)
        caja = _proceso_lanzado.get()
        if caja is not None:
            caja.append(proceso)
        return proceso

    _stdio._create_platform_compatible_process = _spawn_anotado
else:  # pragma: no cover - depende de la versión del SDK
    log.warning("mcp.client.stdio sin _create_platform_compatible_process: MotorVideo.pid será None.")


def _ocultar(texto: str, clave: str | None) -> str:
    return texto.replace(clave, OCULTO) if clave else texto


def _lector_stderr(fd: int, clave: str | None) -> None:
    """Hilo: vuelca el stderr del hijo al log, línea a línea, con la clave ocultada."""
    try:
        with open(fd, "rb") as f:
            for linea in f:
                texto = linea.decode("utf-8", "replace").rstrip()
                if texto:
                    log.info("motor: %s", _ocultar(texto, clave))
    except (OSError, ValueError):
        pass


class _Sesion:
    """Un proceso del motor con su sesión MCP, propiedad de una sola tarea asyncio."""

    def __init__(self) -> None:
        self.listo: asyncio.Future[ClientSession] = asyncio.get_running_loop().create_future()
        self.parar = asyncio.Event()
        self.proceso = None
        self.tarea: asyncio.Task | None = None
        self.clave: str | None = None

    def viva(self) -> bool:
        if self.tarea is None or self.tarea.done() or self.parar.is_set():
            return False
        if self.listo.done() and self.listo.exception() is not None:
            return False
        return self.proceso is None or self.proceso.returncode is None


class MotorVideo:
    def __init__(
        self,
        comando: list[str],
        cwd: Path,
        env: Callable[[], dict[str, str]],
        timeout_llamada: float = 120.0,
    ) -> None:
        if not comando:
            raise ValueError("comando vacío")
        self._comando = [str(c) for c in comando]
        self._cwd = Path(cwd)
        self._env = env
        self._timeout = timeout_llamada
        self._lock = asyncio.Lock()
        self._sesion: _Sesion | None = None

    @property
    def pid(self) -> int | None:
        s = self._sesion
        if s is None or s.proceso is None or not s.viva():
            return None
        return s.proceso.pid

    # ----------------------------------------------------------- llamadas

    async def llamar(self, tool: str, args: dict | None = None, timeout: float | None = None) -> RespuestaMotor:
        s, sesion = await self._sesion_lista()
        r = await self._esperar(s, sesion.call_tool(tool, args or {}), timeout)
        return self._respuesta(r, s.clave)

    async def herramientas(self) -> list[str]:
        """Nombres de las tools que expone el motor (diagnóstico); mismos errores que `llamar`."""
        s, sesion = await self._sesion_lista()
        r = await self._esperar(s, sesion.list_tools(), None)
        return [t.name for t in r.tools]

    async def _esperar(self, s: _Sesion, peticion, timeout: float | None):
        """Espera una petición MCP de la sesión `s` y traduce sus fallos a MotorError."""
        limite = self._timeout if timeout is None else timeout
        try:
            return await asyncio.wait_for(peticion, limite)
        except TimeoutError:
            # Una llamada colgada puede dejar la sesión a medias: se reinicia el proceso entero.
            await self._descartar(s)
            raise MotorError(f"El motor de vídeo no respondió en {limite:g} s.") from None
        except MCPError as e:
            if e.error.code == CONNECTION_CLOSED or not s.viva():
                await self._descartar(s)
                raise MotorNoDisponible(MENSAJE_DETENIDO) from None
            raise MotorError(_ocultar(e.error.message, s.clave)) from None
        except (anyio.ClosedResourceError, anyio.BrokenResourceError, anyio.EndOfStream, EOFError, ConnectionError):
            await self._descartar(s)
            raise MotorNoDisponible(MENSAJE_DETENIDO) from None

    @staticmethod
    def _respuesta(r, clave: str | None) -> RespuestaMotor:
        textos = [c.text for c in r.content if isinstance(c, TextContent)]
        texto = _ocultar(textos[0], clave) if textos else ""
        if r.is_error:
            raise MotorError(texto or "El motor de vídeo devolvió un error sin detalle.")
        datos = None
        if len(textos) > 1:
            try:
                # La clave se oculta también en los datos: el JSON va tal cual a la respuesta HTTP.
                valor = json.loads(_ocultar(textos[-1], clave))
            except ValueError:
                valor = None
            if isinstance(valor, dict | list):
                datos = valor
        imagen = next(((c.mime_type, c.data) for c in r.content if isinstance(c, ImageContent)), None)
        return RespuestaMotor(texto=texto, datos=datos, imagen=imagen)

    # ------------------------------------------------------ ciclo de vida

    async def _sesion_lista(self) -> tuple[_Sesion, ClientSession]:
        s = self._sesion
        if s is None or not s.viva() or not s.listo.done():
            async with self._lock:
                s = self._sesion
                if s is None or not s.viva():
                    if s is not None:
                        await self._descartar(s)
                    s = self._lanzar()
                    self._sesion = s
                # Escudo: si la petición que arranca se cancela, el arranque sigue en la tarea
                # propietaria y queda registrado para la siguiente llamada o para cerrar().
                try:
                    await asyncio.shield(s.listo)
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001 - cualquier fallo de arranque
                    await self._descartar(s)
                    raise MotorNoDisponible(
                        f"No se pudo arrancar el motor de vídeo: {_ocultar(_describir(e), s.clave)}"
                    ) from None
        return s, s.listo.result()

    def _lanzar(self) -> _Sesion:
        s = _Sesion()
        env = self._env()
        s.clave = env.get("ELEVENLABS_API_KEY") or None
        params = StdioServerParameters(
            command=self._comando[0], args=self._comando[1:], env=env, cwd=self._cwd
        )
        s.tarea = asyncio.create_task(self._propietaria(s, params), name="motor-video")
        return s

    async def _propietaria(self, s: _Sesion, params: StdioServerParameters) -> None:
        """Dueña del proceso: entra y sale de stdio_client y ClientSession en esta misma tarea."""
        try:
            async with AsyncExitStack() as pila:
                leer_fd, escribir_fd = os.pipe()
                threading.Thread(
                    target=_lector_stderr, args=(leer_fd, s.clave), name="motor-video-stderr", daemon=True
                ).start()
                # Solo envuelve el descriptor de la tubería (no bloquea); se cierra tras el spawn.
                errlog = open(escribir_fd, "w", encoding="utf-8")  # noqa: SIM115, ASYNC230
                caja: list = []
                token = _proceso_lanzado.set(caja)
                try:
                    lectura, escritura = await pila.enter_async_context(stdio_client(params, errlog=errlog))
                finally:
                    _proceso_lanzado.reset(token)
                    # El hijo tiene su copia del extremo de escritura; cerrar la nuestra deja que
                    # el hilo lector vea EOF cuando el hijo (y sus descendientes) terminen.
                    errlog.close()
                s.proceso = caja[0] if caja else None
                sesion = await pila.enter_async_context(ClientSession(lectura, escritura))
                with anyio.fail_after(TIMEOUT_ARRANQUE):
                    await sesion.initialize()
                log.info("Motor de vídeo arrancado (pid %s).", s.proceso.pid if s.proceso else "?")
                s.listo.set_result(sesion)
                await s.parar.wait()
        except BaseException as e:
            if not s.listo.done():
                s.listo.set_exception(e if isinstance(e, Exception) else MotorNoDisponible(MENSAJE_DETENIDO))
            elif not s.parar.is_set():
                log.warning("El motor de vídeo terminó: %s", _ocultar(_describir(e), s.clave))
            if not isinstance(e, Exception):
                raise
        finally:
            s.parar.set()
            if not s.listo.done():
                s.listo.set_exception(MotorNoDisponible(MENSAJE_DETENIDO))

    async def _descartar(self, s: _Sesion) -> None:
        """Para el proceso de `s` y espera a que la tarea propietaria lo haya cerrado."""
        if self._sesion is s:
            self._sesion = None
        s.parar.set()
        if s.tarea is None:
            return
        try:
            await asyncio.wait_for(asyncio.shield(s.tarea), TIMEOUT_CIERRE)
        except TimeoutError:
            log.warning("El motor de vídeo no terminó en %s s al cerrarlo.", TIMEOUT_CIERRE)
        except Exception as e:  # noqa: BLE001 - la tarea ya registró su fallo
            log.debug("Cierre del motor de vídeo: %s", _describir(e))

    async def cerrar(self) -> None:
        """Termina el proceso (y su árbol). Idempotente; sin efecto si nunca arrancó."""
        async with self._lock:
            s = self._sesion
            if s is not None:
                await self._descartar(s)


def _describir(e: BaseException) -> str:
    """Mensaje corto de una excepción, desenvolviendo los ExceptionGroup de anyio."""
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    if isinstance(e, TimeoutError):
        return f"no respondió en {TIMEOUT_ARRANQUE:g} s"
    if isinstance(e, MCPError):
        return e.error.message
    return str(e) or type(e).__name__


# ------------------------------------------------------- comando y entorno


def comando_motor() -> tuple[list[str], Path]:
    """(argv, cwd) del motor. Congelado: el Node y el motor del bundle, siempre."""
    d = config.VIDEO_ENGINE_DIR
    if config.FROZEN:
        return [str(d / "node" / "node.exe"), str(d / "app" / "dist" / "index.js")], d / "app"
    propio = os.environ.get("APP_BACKEND_VIDEO_CMD")
    if propio:
        argv = json.loads(propio)
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            raise ValueError("APP_BACKEND_VIDEO_CMD debe ser una lista JSON de cadenas.")
        return argv, config.STATE_DIR
    return ["node", str(d / "dist" / "index.js")], d


def _navegador_bundle(d: Path) -> Path | None:
    carpeta = d / "browser"
    if not carpeta.is_dir():
        return None
    for nombre in ("chrome-headless-shell.exe", "chrome.exe"):
        encontrados = sorted(carpeta.rglob(nombre))
        if encontrados:
            return encontrados[0]
    return None


def entorno_motor(store) -> dict[str, str]:
    """Entorno propio del hijo; se recalcula en cada arranque (la clave puede haber cambiado)."""
    estado = config.STATE_DIR / "video"
    env = {
        "VIDEO_ENGINE_EMBEDDED": "1",
        "VIDEO_ROOT": str(estado / "proyectos"),
        "VIDEO_STATE_DIR": str(estado / "estado"),
        "HYPERFRAMES_NO_TELEMETRY": "1",
        "DO_NOT_TRACK": "1",
    }
    d = config.VIDEO_ENGINE_DIR
    if (d / "ffmpeg" / "ffmpeg.exe").exists():
        env["FFMPEG_DIR"] = str(d / "ffmpeg")
    navegador = _navegador_bundle(d)
    if navegador is not None:
        env["HYPERFRAMES_BROWSER_PATH"] = str(navegador)
    clave = config.elevenlabs_api_key(store)
    if clave:  # nunca una variable vacía: el motor la trataría como clave mala
        env["ELEVENLABS_API_KEY"] = clave
    return env

