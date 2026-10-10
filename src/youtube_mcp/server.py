"""YouTube MCP Server — FastMCP entry point."""

import os
import sys

from mcp.server.fastmcp import FastMCP

from youtube_mcp.auth import YouTubeAuth
from youtube_mcp.utils.quota import QuotaTracker

mcp = FastMCP(
    "YouTube MCP Server",
    instructions="Comprehensive MCP server for YouTube Data API, Analytics API, and Reporting API",
)

# Shared state
auth = YouTubeAuth(
    client_secret_path=os.environ.get("YOUTUBE_MCP_CLIENT_SECRET"),
    config_dir=os.environ.get("YOUTUBE_MCP_CONFIG_DIR"),
    api_key=os.environ.get("YOUTUBE_API_KEY"),
)
quota = QuotaTracker()


# --- Auth tools ---


@mcp.tool()
def youtube_auth() -> dict:
    """Initiate OAuth 2.0 authentication flow.

    Opens a browser window for Google OAuth consent. Required before using
    any tools that access private channel data or analytics.
    """
    try:
        auth.authenticate()
        return {"status": "authenticated", "detail": auth.status()}
    except Exception as e:
        return {"status": "error", "detail": str(e)}


@mcp.tool()
def youtube_auth_status() -> dict:
    """Check current authentication status and quota usage."""
    return {
        "auth": auth.status(),
        "quota": quota.status(),
    }


# --- Register tool modules ---
# Import tool modules so their @mcp.tool() decorators run

from youtube_mcp.tools import channel  # noqa: E402, F401
from youtube_mcp.tools import search  # noqa: E402, F401
from youtube_mcp.tools import transcripts  # noqa: E402, F401
from youtube_mcp.tools import local_transcribe  # noqa: E402, F401
from youtube_mcp.tools import analytics  # noqa: E402, F401
from youtube_mcp.tools import publishing  # noqa: E402, F401
from youtube_mcp.tools import playlists  # noqa: E402, F401
from youtube_mcp.tools import comments  # noqa: E402, F401
from youtube_mcp.tools import reporting  # noqa: E402, F401


def _aislar_stdin_windows() -> None:
    """Evita un bloqueo en Windows al cargar DLLs mientras se lee stdin.

    El bucle stdio de MCP deja una lectura sincrona pendiente en la tuberia de stdin.
    Cada DLL que se carga despues (numpy, ctranslate2, cuBLAS...) consulta los handles
    estandar al iniciar su runtime de C y se queda esperando a que esa lectura acabe,
    asi que transcribe_local se colgaba hasta el timeout. MCP sigue leyendo de un
    duplicado de la tuberia y el stdin "oficial" del proceso pasa a ser NUL.
    """
    if os.name != "nt" or sys.stdin is None:
        return
    import ctypes
    import msvcrt

    try:
        fd = os.dup(sys.stdin.fileno())
        sys.stdin = open(fd, "r", encoding="utf-8", closefd=True)
        nul = os.open(os.devnull, os.O_RDONLY)
        os.dup2(nul, 0)
        os.close(nul)
        ctypes.windll.kernel32.SetStdHandle(-10, msvcrt.get_osfhandle(0))  # STD_INPUT_HANDLE
    except OSError:
        pass  # sin consola/tuberia real (p. ej. tests): no hace falta


def main():
    _aislar_stdin_windows()
    mcp.run()


if __name__ == "__main__":
    main()
