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
    return _ok("Guiones", [{"id": g, "titulo": v.get("titulo", "")} for g, v in _GUIONES.items()])


@mcp.tool()
def video_guion_leer(id: str) -> CallToolResult:
    if id == "g-ffffffffffffffff":  # error sin tipar y con una ruta dentro, como uno inesperado de Node
        raise ValueError("EACCES: permission denied, open 'C:\\Users\\marc\\AppData\\x\\guiones\\g.json'")
    if id == "g-eeeeeeeeeeeeeeee":  # error tipado cuyo mensaje se cuela una ruta
        return _error("no_encontrado", "No existe /home/marc/seo-studio/guiones/g.json")
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
    return _ok("Proyectos", [{"id": k, "titulo": v["titulo"], "estado": "sin_voz"} for k, v in _PROYECTOS.items()])


@mcp.tool()
def video_proyecto_leer(id: str) -> CallToolResult:
    if id not in _PROYECTOS:
        return _error("no_encontrado", "No existe ese proyecto.")
    return _ok("Proyecto", {**_PROYECTOS[id], "avisos": []})


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


def _preparar_estado() -> None:
    estado = os.environ.get("VIDEO_STATE_DIR")
    if estado:
        Path(estado).mkdir(parents=True, exist_ok=True)
        (Path(estado) / "motor-falso.log").write_text("arrancado\n", encoding="utf-8")


if __name__ == "__main__":
    _preparar_estado()
    mcp.run()
