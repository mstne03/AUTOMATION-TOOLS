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
- KB_UPDATE_URL: base HTTPS desde la que se descargan `manifest.json`,
  `manifest.json.minisig` y el snapshot. Solo para desarrollo se admite http://127.0.0.1.

Variables de `kb-seo` que este modulo fija ANTES de que se importe `kb.config`
(que las lee al importarse): KB_BACKEND=sqlite, KB_SQLITE_PATH y
KB_PRIVATE_SQLITE_PATH dentro del directorio de estado, y EMBED_CACHE_DIR para el
modelo ONNX. Un `.env.local` con KB_BACKEND=postgres sigue valiendo para desarrollo.
"""

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Binario de PyInstaller (sys.frozen): sin .env (un fichero junto al ejecutable no debe
# poder cambiar la configuracion) y con el modelo de embeddings dentro del bundle.
FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    _BUNDLE = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    os.environ.setdefault("EMBED_MODEL_PATH", str(_BUNDLE / "models" / "multilingual-e5-small"))
    # Sin HF_HUB_OFFLINE: fastembed carga el modelo con specific_model_path y no toca la red
    # de todos modos, y faster-whisper necesita huggingface_hub en linea para bajar su modelo
    # en el primer uso (la Fase 4 lo bloqueaba; ver HANDOFF-fase5.md, E1).
else:
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

# Base de conocimiento: snapshot publico firmado + KB privada, ambos dentro del
# directorio de estado (nunca rutas que vengan de fuera).
KB_DIR = STATE_DIR / "kb"
KB_PUBLIC_PATH = KB_DIR / "kb-public.sqlite"
KB_PRIVATE_PATH = KB_DIR / "kb-private.sqlite"
KB_UPDATE_URL = (os.environ.get("KB_UPDATE_URL") or "https://kb.mstne.dev/kb/").rstrip("/") + "/"
# Clave publica minisign del VPS. Se genera alli y la privada nunca sale de alli.
# Generada el 2026-10-11 en el VPS con `kb-sign keygen` (~marc/kb-seo/keys/kb.pub).
KB_MINISIGN_PUBKEY = os.environ.get("KB_MINISIGN_PUBKEY") or "RWQuXbso1VRON6x1Ol6g6zSn7XH35VZZaRZh7yCYtsfhLwH5O8+IdTxe"

os.environ.setdefault("KB_BACKEND", "sqlite")
os.environ.setdefault("KB_SQLITE_PATH", str(KB_PUBLIC_PATH))
os.environ.setdefault("KB_PRIVATE_SQLITE_PATH", str(KB_PRIVATE_PATH))
os.environ.setdefault("EMBED_CACHE_DIR", str(STATE_DIR / "models"))

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
