"""YouTube MCP Server — MCPServer (mcp 2.x) entry point."""

import os
import sys

from mcp.server.mcpserver import MCPServer

from youtube_mcp.auth import AuthError, YouTubeAuth
from youtube_mcp.secrets import KeyringSecretStore
from youtube_mcp.utils.quota import QuotaTracker

mcp = MCPServer(
    "YouTube MCP Server",
    instructions="Comprehensive MCP server for YouTube Data API, Analytics API, and Reporting API",
)

# Shared state. YOUTUBE_MCP_SECRETS=keyring guarda tokens y client_secret en el
# Credential Manager (DPAPI) en vez de JSON en claro; el producto lo activa siempre.
auth = YouTubeAuth(
    client_secret_path=os.environ.get("YOUTUBE_MCP_CLIENT_SECRET"),
    config_dir=os.environ.get("YOUTUBE_MCP_CONFIG_DIR"),
    store=KeyringSecretStore() if os.environ.get("YOUTUBE_MCP_SECRETS") == "keyring" else None,
)
quota = QuotaTracker(state_path=auth.config_dir / "quota.json")


# --- Auth tools ---


@mcp.tool()
def youtube_auth(profile: str | None = None, reauthorize: bool = False) -> dict:
    """Authenticate with Google, or switch the active channel profile.

    This is the ONLY tool allowed to open the browser consent flow. Every other
    tool reuses the saved token and fails with a clear error if it is missing or
    cannot be refreshed.

    Args:
        profile: Channel profile to activate ("default", "smooth", ...). One token
            per profile; see youtube_auth_status for the profiles already saved.
        reauthorize: Ignore the saved token and run the consent flow again
            (needed after a scope change or if Google revoked the token).
    """
    try:
        if profile:
            auth.use_profile(profile)
        auth.authenticate(interactive=True, force_consent=reauthorize)
        return {"status": "authenticated", "detail": auth.status()}
    except AuthError as e:
        return {"status": "error", "detail": str(e)}


@mcp.tool()
def youtube_auth_status() -> dict:
    """Check current authentication status, active profile and quota usage."""
    return {
        "auth": auth.status(),
        "quota": quota.status(),
    }


# --- Register tool modules ---
# Import tool modules so their @mcp.tool() decorators run

from youtube_mcp.tools import (  # noqa: E402
    analytics,  # noqa: F401
    channel,  # noqa: F401
    comments,  # noqa: F401
    local_transcribe,  # noqa: F401
    playlists,  # noqa: F401
    publishing,  # noqa: F401
    reporting,  # noqa: F401
    search,  # noqa: F401
    transcripts,  # noqa: F401
)


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
