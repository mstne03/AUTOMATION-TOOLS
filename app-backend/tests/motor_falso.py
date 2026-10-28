"""Servidor MCP de prueba por stdio que hace de motor de vídeo en los tests de `MotorVideo`.

Al arrancar crea VIDEO_STATE_DIR (si viene) y deja allí un log, como hace el motor real.
"""

import json
import os
import sys
from pathlib import Path

import anyio
from mcp.server.mcpserver import MCPServer
from mcp_types import TextContent

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


def _preparar_estado() -> None:
    estado = os.environ.get("VIDEO_STATE_DIR")
    if estado:
        Path(estado).mkdir(parents=True, exist_ok=True)
        (Path(estado) / "motor-falso.log").write_text("arrancado\n", encoding="utf-8")


if __name__ == "__main__":
    _preparar_estado()
    mcp.run()
