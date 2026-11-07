"""Preview del editor de vídeo por capacidad (T10; spec I2, I8, R0-5, R0-7).

El iframe del editor no puede mandar `Authorization`, así que la composición se sirve desde un
**origen propio** (un puerto de `config.PUERTOS_PREVIEW`, distinto del de la API) bajo una URL de
capacidad: `/p/<clave>/<ruta>`. La clave son 32 bytes aleatorios, solo en memoria, atada a
`(id, carpeta, creado)` del proyecto y a su `_composicion/r<n>/`: nunca sirve `recursos/`, `voz/`
ni el proyecto. La API y la preview no responden en el puerto de la otra (`despachar`).

Nada de lo que pasa por aquí se registra: ni la ruta ni la clave (`access_log=False` y ningún registro informativo).
"""

import asyncio
import hashlib
import logging
import re
import secrets
import socket
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from starlette.applications import Starlette
from starlette.datastructures import MutableHeaders

from app_backend import config
from app_backend.navegador import comprobar_ancestros, es_enlace

log = logging.getLogger("app_backend.preview")

MENSAJE_SIN_PUERTO = (
    "No hay preview: los puertos 47810 a 47813 están ocupados por otro programa. "
    "Ciérralo y vuelve a abrir el editor."
)
MENSAJE_RUNTIME = "La preview no está disponible: el motor de reproducción no es el esperado. Reinstala la aplicación."
MENSAJE_COMPOSICION = "La composición no se puede mostrar: vuelve a generarla."

# Mismo formato que `video_rest.PROYECTO` (aquí no se importa: video_rest importa este módulo).
_ID = re.compile(r"video[0-9]{3}", re.ASCII)
_CARPETA = re.compile(r"r[0-9]{1,9}", re.ASCII)

# Lista blanca de extensiones y su Content-Type (lo que una composición de HyperFrames pide).
TIPOS = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}
_RESERVADO_WINDOWS = re.compile(r"(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?", re.IGNORECASE)
_CARACTERES_MALOS = re.compile(r'[\x00-\x1f\\:*?"<>|]')
_RESERVADO_PROPIO = "__preview"
_INYECCION = '<script src="__preview/runtime.js"></script><script src="__preview/control.js"></script>'
_META_CSP = re.compile(r"<meta\b[^>]*http-equiv\s*=\s*[\"']?Content-Security-Policy[^>]*>", re.IGNORECASE)

# Corre dentro del iframe (derivado del spike D6, sin las órdenes de medición). Hacia dentro:
# `seek { id, t }`, `play`, `pause`. Hacia fuera: `listo { duracion }`, `seek-hecho { id, t }`,
# `tiempo { t, reproduciendo }` (≤ 30 por segundo) y `error { id }`, sin texto. Valida la forma de
# cada mensaje: origen = la ventana padre, objeto, tipo de una lista cerrada, `t` finito y acotado.
CONTROL_JS = r"""(() => {
  "use strict";
  const padre = window.parent;
  const responder = (m) => padre.postMessage(m, "*"); // origen opaco: no hay otro destino posible
  const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
  const idValido = (v) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v));
  const dosFrames = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  const MIN_MS = 1000 / 30;
  let ultimoEnvio = 0;
  let bucleActivo = false;

  function enviarTiempo(forzar) {
    const p = window.__player;
    if (!p) return;
    const ahora = performance.now();
    if (!forzar && ahora - ultimoEnvio < MIN_MS) return;
    ultimoEnvio = ahora;
    responder({ tipo: "tiempo", t: p.getTime(), reproduciendo: p.isPlaying() });
  }

  function bucle() {
    enviarTiempo(false);
    const p = window.__player;
    if (p && p.isPlaying()) requestAnimationFrame(bucle);
    else { bucleActivo = false; enviarTiempo(true); }
  }

  function arrancarBucle() {
    if (bucleActivo) return;
    bucleActivo = true;
    requestAnimationFrame(bucle);
  }

  addEventListener("message", async (e) => {
    if (e.source !== padre) return;
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.tipo !== "string") return;
    const id = idValido(d.id) ? d.id : undefined;
    const p = window.__player;
    if (!p) return responder({ tipo: "error", id });
    try {
      switch (d.tipo) {
        case "seek": {
          const t = num(d.t, 0, p.getDuration() || 0);
          if (t === null) return;
          p.seek(t);
          await dosFrames();
          responder({ tipo: "seek-hecho", id, t });
          return enviarTiempo(true);
        }
        case "play": p.play(); return arrancarBucle();
        case "pause": p.pause(); return enviarTiempo(true);
      }
    } catch (_) { responder({ tipo: "error", id }); }
  });
  const aviso = () => responder({ tipo: "listo", duracion: window.__player ? window.__player.getDuration() : null });
  window.__playerReady ? aviso() : addEventListener("load", () => setTimeout(aviso, 500));
})();
"""


# ---------------------------------------------------------------- claves (R0-5)


class Entrada(NamedTuple):
    id: str
    carpeta: str
    creado: str


class Claves:
    """Una clave por proyecto, solo en memoria, atada a `(id, carpeta, creado)`.

    `siguienteId` reutiliza `video001` tras borrarlo: su `creado` es otro, así que `abrir` nunca le
    entrega la clave del proyecto anterior.
    """

    def __init__(self) -> None:
        self._por_id: dict[str, tuple[str, Entrada]] = {}

    def abrir(self, id: str, carpeta: str, creado: str) -> str:
        """Clave vigente si coincide la terna; si no, una nueva (la anterior deja de valer)."""
        entrada = Entrada(id, carpeta, creado)
        actual = self._por_id.get(id)
        if actual is not None and actual[1] == entrada:
            return actual[0]
        return self.rotar(id, carpeta, creado)

    def rotar(self, id: str, carpeta: str, creado: str) -> str:
        clave = secrets.token_urlsafe(32)
        self._por_id[id] = (clave, Entrada(id, carpeta, creado))
        return clave

    def cerrar(self, id: str) -> None:
        self._por_id.pop(id, None)

    def buscar(self, clave: str) -> Entrada | None:
        """Compara con todas (sin cortar en la primera) para no filtrar cuál acertó por el tiempo."""
        try:
            candidata = clave.encode("ascii")
        except (UnicodeError, AttributeError):
            return None
        if not candidata:
            return None
        encontrada = None
        for k, entrada in self._por_id.values():
            if secrets.compare_digest(candidata, k.encode("ascii")):
                encontrada = entrada
        return encontrada


# ------------------------------------------------------------ runtime (R0-10)


def ruta_runtime() -> Path:
    base = config.VIDEO_ENGINE_DIR / "app" if config.FROZEN else config.VIDEO_ENGINE_DIR
    return base.joinpath(*config.RUNTIME_PREVIEW_REL)


class Runtime:
    """Lee el runtime una vez, comprueba su SHA-256 y lo sirve desde memoria (sin TOCTOU)."""

    def __init__(self) -> None:
        self._datos: bytes | None = None

    def obtener(self) -> bytes | None:
        if self._datos is None:
            try:
                datos = ruta_runtime().read_bytes()
            except OSError as e:
                log.warning("Runtime de la preview ilegible: %s", e)
                return None
            if hashlib.sha256(datos).hexdigest() != config.RUNTIME_SHA256:
                log.warning("El runtime de la preview no coincide con el hash fijado; no se sirve.")
                return None
            self._datos = datos
        return self._datos


# ------------------------------------------------------------------ cabeceras


def cabecera_csp(puerto: int) -> str:
    o = f"http://127.0.0.1:{puerto}"
    ancestros = "http://tauri.localhost https://tauri.localhost"
    if not config.FROZEN:  # el WebView de `tauri dev` sirve la UI desde Vite
        ancestros += " http://localhost:1420"
    return (
        "sandbox allow-scripts; default-src 'none'; "
        f"script-src {o} 'unsafe-inline'; style-src {o} 'unsafe-inline'; img-src {o} data: blob:; "
        f"font-src {o} data:; media-src {o} blob:; connect-src {o}; worker-src 'none'; "
        f"base-uri 'none'; form-action 'none'; frame-ancestors {ancestros}"
    )


class CabecerasPreview:
    """Cabeceras de seguridad en **toda** respuesta HTTP, incluidos 404, 405 y 421. ASGI puro."""

    def __init__(self, app, puerto: int) -> None:
        self.app = app
        self.puerto = puerto

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def enviar(mensaje):
            if mensaje["type"] == "http.response.start":
                h = MutableHeaders(scope=mensaje)
                h["Content-Security-Policy"] = cabecera_csp(self.puerto)
                h["X-Content-Type-Options"] = "nosniff"
                h["Cache-Control"] = "no-store"
                h["Referrer-Policy"] = "no-referrer"
            await send(mensaje)

        await self.app(scope, receive, enviar)


def app_reserva(puerto: int):
    """App de un puerto reservado que no sirve: todo es 404 con la CSP."""
    return CabecerasPreview(Starlette(), puerto)


# ----------------------------------------------------------- reescritura del html


class ComposicionInvalida(Exception):
    pass


def reescribir_html(html: str, puerto: int) -> str:
    """Cambia `'self'` por el origen exacto en el `<meta>` de la CSP e inyecta runtime y control tras él.

    El `<meta>` tiene que aparecer **una sola vez** y con la política que emite el motor.
    """
    metas = list(_META_CSP.finditer(html))
    if len(metas) != 1:
        raise ComposicionInvalida
    m = metas[0]
    etiqueta = m.group(0)
    if etiqueta.count(config.CSP_META_COMPOSICION) != 1 or f'content="{config.CSP_META_COMPOSICION}"' not in etiqueta:
        raise ComposicionInvalida
    nueva = config.CSP_META_COMPOSICION.replace("'self'", f"http://127.0.0.1:{puerto}")
    return html[: m.start()] + etiqueta.replace(config.CSP_META_COMPOSICION, nueva, 1) + _INYECCION + html[m.end() :]


# -------------------------------------------------------------------- la ruta


def _segmento_valido(s: str) -> bool:
    if not s or s in (".", "..") or len(s) > 128:
        return False
    if _CARACTERES_MALOS.search(s) or s != s.rstrip(". ") or "~" in s:
        return False
    return not _RESERVADO_WINDOWS.fullmatch(s)


def _resolver(entrada: Entrada, segmentos: list[str]) -> Path | None:
    """Fichero de `segmentos` dentro de `_composicion/<carpeta>/` del proyecto, o None. Nunca sigue enlaces."""
    if not _ID.fullmatch(entrada.id) or not _CARPETA.fullmatch(entrada.carpeta):
        return None
    try:
        comprobar_ancestros()
        proyecto = config.VIDEO_ROOT / entrada.id
        base = proyecto / "_composicion" / entrada.carpeta
        actual = base
        for p in (config.VIDEO_ROOT, proyecto, proyecto / "_composicion", base):
            if es_enlace(p):
                return None
        for s in segmentos:
            actual = actual / s
            if es_enlace(actual):
                return None
        if not actual.is_file() or not actual.resolve().is_relative_to(base.resolve()):
            return None
    except (OSError, ValueError):
        return None
    return actual


def crear_app(claves: Claves, puerto: int, runtime: Runtime | None = None):
    """App aparte, una sola ruta `GET|HEAD /p/{clave}/{ruta:path}`: sin documentos ni bearer."""
    runtime = runtime or Runtime()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    host = f"127.0.0.1:{puerto}"

    @app.api_route("/p/{clave}/{ruta:path}", methods=["GET", "HEAD"])
    async def servir(clave: str, ruta: str, request: Request):
        if request.headers.get("host") != host:  # contra DNS rebinding
            return Response("Host no válido.", status_code=421, media_type="text/plain")
        entrada = claves.buscar(clave)
        if entrada is None:
            return Response(status_code=404)
        # CORS del túnel y de las subcomposiciones: el iframe opaco manda `Origin: null`. Nunca `*`.
        cors = {"Access-Control-Allow-Origin": "null", "Vary": "Origin"} if request.headers.get("origin") == "null" else {}
        segmentos = ruta.split("/") if ruta else ["index.html"]
        if segmentos[0] == _RESERVADO_PROPIO:
            if segmentos == [_RESERVADO_PROPIO, "control.js"]:
                return Response(CONTROL_JS, media_type="text/javascript", headers=cors)
            if segmentos == [_RESERVADO_PROPIO, "runtime.js"]:
                datos = runtime.obtener()
                if datos is None:
                    return Response(MENSAJE_RUNTIME, status_code=503, media_type="text/plain")
                return Response(datos, media_type="text/javascript", headers=cors)
            return Response(status_code=404)
        if not all(_segmento_valido(s) for s in segmentos):
            return Response(status_code=404)
        tipo = TIPOS.get(Path(segmentos[-1]).suffix.lower())
        if tipo is None:
            return Response(status_code=404)
        fichero = await asyncio.to_thread(_resolver, entrada, segmentos)
        if fichero is None:
            return Response(status_code=404)
        if segmentos == ["index.html"]:
            try:
                html = reescribir_html(await asyncio.to_thread(fichero.read_text, "utf-8"), puerto)
            except (ComposicionInvalida, UnicodeError, OSError):
                return Response(MENSAJE_COMPOSICION, status_code=503, media_type="text/plain")
            return HTMLResponse(html, headers=cors)
        return FileResponse(fichero, media_type=tipo, headers=cors)  # atiende Range (audio y vídeo)

    return CabecerasPreview(app, puerto)


# ------------------------------------------------------- reserva de puertos (R0-7)


@dataclass
class Reserva:
    """Sockets de `PUERTOS_PREVIEW` que el backend mantiene vinculados mientras viva."""

    sockets: list = field(default_factory=list)
    puertos: tuple[int, ...] = ()  # los vinculados, en el orden de la lista
    ajenos: tuple[int, ...] = ()  # los que no se pudieron vincular: otro proceso los tiene

    @property
    def servicio(self) -> int | None:
        """Puerto que sirve la preview: el primero vinculado. Los demás responden 404."""
        return self.puertos[0] if self.puertos else None

    def cerrar(self) -> None:
        for s in self.sockets:
            s.close()
        self.sockets = []


def _vincular(puerto: int) -> socket.socket:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Windows: uso exclusivo, así nadie más (ni con la opción de reutilización) puede vincular el
        # puerto mientras vivimos. Nunca la opción de reutilización: permitiría robarlo.
        exclusivo = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if exclusivo is not None:
            s.setsockopt(socket.SOL_SOCKET, exclusivo, 1)
        s.bind(("127.0.0.1", puerto))  # nunca 0.0.0.0
        s.listen(128)
    except OSError:
        s.close()
        raise
    return s


def reservar_puertos(puertos: tuple[int, ...] = config.PUERTOS_PREVIEW) -> Reserva:
    """Vincula todos los puertos que pueda. Los que falla quedan en `ajenos` (aviso `puertos_preview_ajenos`)."""
    sockets, libres, ajenos = [], [], []
    for p in puertos:
        try:
            sockets.append(_vincular(p))
            libres.append(p)
        except OSError as e:
            ajenos.append(p)
            log.warning("puertos_preview_ajenos: el puerto %d de la preview está ocupado por otro programa: %s", p, e)
    return Reserva(sockets, tuple(libres), tuple(ajenos))


def _crear_socket_api() -> socket.socket:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))  # nunca 0.0.0.0: el sidecar es local
    return s


def vincular_api(
    prohibidos: tuple[int, ...] = config.PUERTOS_PREVIEW,
    crear: Callable[[], socket.socket] = _crear_socket_api,
    intentos: int = 16,
) -> socket.socket:
    """Socket de la API (puerto efímero) fuera de `PUERTOS_PREVIEW`: si coincide, se vuelve a vincular."""
    for _ in range(intentos):
        s = crear()
        if s.getsockname()[1] not in prohibidos:
            s.listen(128)
            return s
        s.close()
    raise RuntimeError("No se pudo vincular el puerto de la API fuera de la lista de la preview.")


def apps_preview(claves: Claves, reserva: Reserva, runtime: Runtime | None = None) -> dict[int, object]:
    """Una app por puerto vinculado: el primero sirve y los demás responden 404 con la CSP."""
    apps: dict[int, object] = {}
    for p in reserva.puertos:
        apps[p] = crear_app(claves, p, runtime) if p == reserva.servicio else app_reserva(p)
    return apps


def despachar(api, preview: Mapping[int, object]):
    """ASGI puro: elige la app por el puerto en el que llegó la petición (`scope["server"][1]`)."""

    async def app(scope, receive, send):
        servidor = scope.get("server")
        destino = preview.get(servidor[1]) if scope["type"] in ("http", "websocket") and servidor else None
        await (destino or api)(scope, receive, send)

    return app


def config_servidor(app) -> uvicorn.Config:
    """Sin log de acceso: la ruta lleva la clave."""
    return uvicorn.Config(app, log_level="info", access_log=False)
