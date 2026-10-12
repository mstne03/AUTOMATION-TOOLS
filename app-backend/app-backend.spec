# -*- mode: python ; coding: utf-8 -*-
"""Spec de PyInstaller del sidecar: `uv run pyinstaller app-backend.spec` -> dist/app-backend/.

--onedir (carpeta `_internal` junto al .exe), sin consola. Tauri lo arrastra como
externalBin (ver app-ui/src-tauri/tauri.conf.json y app-ui/README.md).

Antes: `uv run python scripts/fetch_model.py` deja el modelo de embeddings en
models/multilingual-e5-small; aqui se copia al bundle y app_backend.config lo
apunta con EMBED_MODEL_PATH (sin red en el producto).

Hidden imports: lo que se importa por cadena (uvicorn carga loops/protocolos por
nombre, keyring elige backend por entrypoint) o de forma perezosa dentro de una
funcion (faster_whisper, ctranslate2, fastembed, sqlite_vec, playwright NO: es solo
del VPS). Los hooks de pyinstaller-hooks-contrib ya cubren onnxruntime (DLLs),
googleapiclient (discovery docs), psycopg_binary (libpq), av, lxml, tzdata y certifi.
"""

from pathlib import Path

from PyInstaller.utils.hooks import (
    collect_all,
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

RAIZ = Path(SPECPATH)
MODELO = RAIZ / "models" / "multilingual-e5-small"
if not (MODELO / "onnx" / "model.onnx").is_file():
    raise SystemExit(f"Falta el modelo en {MODELO}: ejecuta `uv run python scripts/fetch_model.py`.")

datas = [(str(MODELO), "models/multilingual-e5-small")]
binaries = []
hiddenimports = [
    "keyring.backends.Windows",
    "win32ctypes.pywin32",
    "uvicorn.loops.auto", "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto", "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on",
    "sse_starlette", "httpx2", "anthropic.lib.tools",
    "google_auth_oauthlib", "google_auth_httplib2", "googleapiclient.discovery",
    "pgvector.psycopg",
    "sqlite_vec",
    "faster_whisper", "ctranslate2", "av",
    "youtube_transcript_api", "pypdf",
]

# Paquetes propios: las tools se registran al importar los modulos, asi que van enteros.
for pkg in ("app_backend", "youtube_mcp", "kb", "ingest", "mcp_server"):
    hiddenimports += collect_submodules(pkg)

# fastembed y tokenizers: submodulos cargados por nombre de modelo.
for pkg in ("fastembed", "tokenizers", "huggingface_hub", "ctranslate2", "faster_whisper"):
    hiddenimports += collect_submodules(pkg)

# Extension nativa de sqlite-vec (vec0.dll) y DLLs de ctranslate2.
binaries += collect_dynamic_libs("sqlite_vec")
binaries += collect_dynamic_libs("ctranslate2")
# faster_whisper lleva el VAD (silero) como asset.
datas += collect_data_files("faster_whisper")
# trafilatura y sus dependencias leen ficheros de configuracion/stoplists del paquete.
for pkg in ("trafilatura", "justext", "htmldate", "courlan"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [str(RAIZ / "scripts" / "entry.py")],
    pathex=[str(RAIZ)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "playwright",  # extractor `browser`: solo en el VPS
        "pytest", "_pytest", "ruff",
        "tkinter", "matplotlib", "IPython", "jupyter", "notebook",
        "PyQt5", "PyQt6", "PySide2", "PySide6",
        "torch", "tensorflow", "scipy", "pandas",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name="app-backend",
    debug=False,
    strip=False,
    upx=False,
    console=False,  # sin ventana de consola: Tauri habla con el por stdout/stdin
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="app-backend",
)
