"""Directorio de estado, ajustes persistidos y puente de entorno hacia `youtube_mcp`.

`youtube_mcp.server` construye `auth` y `quota` leyendo variables de entorno en el
momento de importarse, y `youtube_mcp.utils.paths` lee la lista blanca de carpetas
en cada llamada. Este modulo traduce los ajustes del producto a esas variables, y
NO debe importar `youtube_mcp.server`.

Variables propias:
- APP_BACKEND_DIR: directorio de estado (ajustes, cuota, jobs). Por defecto
  %LOCALAPPDATA%\\seo-studio.
- APP_BACKEND_SECRETS: "keyring" (por defecto, Credential Manager) o "file"
  (JSON en claro en el directorio de estado; solo para tests y desarrollo).
- APP_BACKEND_TOKEN: token de la cabecera Authorization. Si falta se genera uno.
- ANTHROPIC_API_KEY: respaldo para desarrollo; en el producto la clave va al almacen
  de secretos via PUT /settings y esta variable no se usa.
"""

import json
import os
from pathlib import Path

from dotenv import load_dotenv

# .env y .env.local junto a pyproject.toml, solo para desarrollo (ver .env.example).
# Ninguno se commitea; .env.local pisa a .env.
_RAIZ = Path(__file__).resolve().parent.parent
load_dotenv(_RAIZ / ".env")
load_dotenv(_RAIZ / ".env.local", override=True)

STATE_DIR = Path(
    os.environ.get("APP_BACKEND_DIR")
    or Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "seo-studio"
)
SETTINGS_PATH = STATE_DIR / "settings.json"

MODELS = ("claude-opus-5-5", "claude-sonnet-5-5")
DEFAULTS = {"model": MODELS[0], "allowed_dirs": [], "profile": "default"}

ANTHROPIC_KEY = "anthropic_api_key"  # clave en el almacen de secretos


def anthropic_api_key(store) -> str | None:
    """Clave de Anthropic: el almacen de secretos manda; ANTHROPIC_API_KEY es el respaldo."""
    return store.get(ANTHROPIC_KEY) or os.environ.get("ANTHROPIC_API_KEY") or None


def load_settings() -> dict:
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return {**DEFAULTS, **{k: v for k, v in data.items() if k in DEFAULTS}}


def save_settings(settings: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, SETTINGS_PATH)


def allowed_dirs_env(allowed_dirs: list[dict]) -> str:
    """[{"path": "C:/Videos", "language": "es"}, ...] -> formato YOUTUBE_MCP_ALLOWED_DIRS."""
    partes = []
    for d in allowed_dirs:
        ruta = str(d["path"]).strip()
        if not ruta:
            continue
        idioma = (d.get("language") or "").strip()
        partes.append(f"{ruta}={idioma}" if idioma else ruta)
    return os.pathsep.join(partes)


def apply_env(settings: dict) -> None:
    """Fija las variables que leen `youtube_mcp.server` y `youtube_mcp.utils.paths`."""
    os.environ.setdefault("YOUTUBE_MCP_CONFIG_DIR", str(STATE_DIR))
    modo = os.environ.get("APP_BACKEND_SECRETS", "keyring")
    os.environ["YOUTUBE_MCP_SECRETS"] = "keyring" if modo == "keyring" else "file"
    os.environ["YOUTUBE_MCP_PROFILE"] = settings["profile"]
    os.environ["YOUTUBE_MCP_ALLOWED_DIRS"] = allowed_dirs_env(settings["allowed_dirs"])


apply_env(load_settings())
