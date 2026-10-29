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
- APP_BACKEND_VIDEO_CMD: lista JSON con el comando del motor de vídeo (tests y desarrollo);
  el binario congelado la ignora y lanza siempre el motor del bundle (ver `video.py`).

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


# Motor de vídeo (video-mcp-server, Node): en el instalador va junto al ejecutable, en
# `video-engine/` (node/node.exe, app/dist/index.js, ffmpeg/); en desarrollo es la carpeta del
# paquete en el repo. El navegador del render NO va en el instalador: ver NAVEGADOR_*.
VIDEO_ENGINE_DIR = (
    Path(sys.executable).parent / "video-engine"
    if FROZEN
    else Path(__file__).resolve().parent.parent.parent / "video-mcp-server"
)

# Navegador del render: chrome-headless-shell de Chrome for Testing, descargado por el backend en
# el primer uso, a petición del usuario (SEO-108, spec D10, I4, I14). Versión, URL, hashes y topes
# fijados aquí: ninguno lee el entorno (Ruling 6). Subir de versión = cambiar estas constantes
# repitiendo la comparación de `video-mcp-server/spikes/INFORME-chromium.md`.
NAVEGADOR_VERSION = "156.0.8078.73"
NAVEGADOR_URL = (
    "https://storage.googleapis.com/chrome-for-testing-public/"
    f"{NAVEGADOR_VERSION}/win64/chrome-headless-shell-win64.zip"
)
NAVEGADOR_SHA256 = "e6d26810df71efd0a3dfd0f7246d75d279ebdf8a8ec153d1ac44069657298628"
# Medido sobre el zip verificado: 125 506 562 bytes, 288 ficheros, 294 930 633 bytes extraído.
# Topes = esperado + 10 %.
NAVEGADOR_TAMANO = 125_506_562
NAVEGADOR_MAX_DESCARGA = 138_057_218
NAVEGADOR_MAX_EXTRAIDO = 324_423_696
NAVEGADOR_MAX_FICHEROS = 320
# SHA-256 de la serialización canónica del manifiesto de esa versión
# (`navegador.serializar_manifiesto`), calculado una vez con el zip de arriba: un manifiesto
# regenerado a mano tras añadir una .dll no casa con él.
NAVEGADOR_MANIFIESTO_SHA256 = "51085c8fa3f8c022a832617bab007a5099bb9c1b519c88893c73a28276011ccb"
NAVEGADOR_DIR = STATE_DIR / "video" / "navegador"  # fuera de video/proyectos y de la preview
NAVEGADOR_EXE = "chrome-headless-shell-win64/chrome-headless-shell.exe"
NAVEGADOR_MANIFIESTO = "MANIFIESTO-SHA256.json"

ELEVENLABS_KEY = "elevenlabs_api_key"  # clave en el almacen de secretos


def elevenlabs_api_key(store) -> str | None:
    """Clave de ElevenLabs: el almacen manda; ELEVENLABS_API_KEY es el respaldo de desarrollo."""
    return store.get(ELEVENLABS_KEY) or os.environ.get("ELEVENLABS_API_KEY") or None


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
