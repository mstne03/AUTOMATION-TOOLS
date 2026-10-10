"""Local transcription with faster-whisper, before the video is uploaded.

YouTube's automatic captions can take hours to appear, so `youtube_get_transcript`
is no use for a video that is not up yet. This tool reads the file straight from
disk and returns the same shape `youtube_get_transcript` does, so the rest of the
flow (title, description, tags) does not change.

Only these folders may be read:

- ``C:\\Ferguson`` -> Smooth, English. Files are named ``videoNNN.mp4``.
- ``C:\\Adobe``    -> Candisito, Spanish. Files are ``tiktokNNN.mp4`` / ``youtubeNN.mp4``.
- ``C:\\Kanye``    -> language autodetected. Files are ``kanyeNNN.mp4``.

The Whisper model is loaded lazily on the first call and kept in memory.
"""

import os
import re
import threading
import time
from pathlib import Path

from youtube_mcp.server import mcp

WHISPER_MODEL = os.environ.get("YOUTUBE_MCP_WHISPER_MODEL", "small")

# Carpeta permitida -> idioma por defecto del canal.
_CARPETAS = {
    Path(r"C:\Ferguson"): "en",  # Smooth
    Path(r"C:\Adobe"): "es",  # Candisito
    Path(r"C:\Kanye"): None,  # sin idioma fijo: autodetecta
}

# Nombre corto -> carpeta. Se acepta con o sin la extension .mp4.
_NOMBRES = [
    (re.compile(r"^video\d+$", re.IGNORECASE), Path(r"C:\Ferguson")),
    (re.compile(r"^(tiktok|youtube)\d+$", re.IGNORECASE), Path(r"C:\Adobe")),
    (re.compile(r"^kanye\d+$", re.IGNORECASE), Path(r"C:\Kanye")),
]

_EXTENSIONES = {
    ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi",
    ".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus",
}

_SAMPLE_RATE = 16000  # faster_whisper.decode_audio devuelve audio a 16 kHz

_modelo = None
_modelo_info: dict = {}
_lock = threading.Lock()


class _ErrorLocal(Exception):
    """Error con un mensaje ya legible para el modelo."""


@mcp.tool()
def transcribe_local(file: str, language: str | None = None) -> dict:
    """Transcribe a local video file with Whisper, BEFORE uploading it to YouTube.

    Use this instead of youtube_get_transcript when the video is not on YouTube yet
    (or was just uploaded and the automatic captions are not ready). With the
    transcript you can write the final title, description and tags first, and then
    call youtube_upload_video once with everything set, including publish_at for a
    scheduled release. No provisional title, no second edit.

    Returns the same shape as youtube_get_transcript (video_id is null, source is
    "local_whisper"), plus file and duration_total in seconds.

    Args:
        file: Absolute path, or just the video name:
            "videoNNN" -> C:\\Ferguson\\videoNNN.mp4 (Smooth channel, English);
            "tiktokNNN" or "youtubeNN" -> C:\\Adobe\\<name>.mp4 (Candisito channel,
            Spanish); "kanyeNNN" -> C:\\Kanye\\<name>.mp4 (language autodetected).
            Only files inside C:\\Ferguson, C:\\Adobe and C:\\Kanye can be read.
        language: Language code ("en", "es", ...). Leave empty to use the folder's
            default (Ferguson = en, Adobe = es, Kanye = autodetect).
    """
    try:
        ruta, idioma_defecto = _resolver_ruta(file)
        idioma = (language or "").strip().lower() or idioma_defecto
        audio = _decodificar(ruta)
        return _transcribir(ruta, audio, idioma)
    except _ErrorLocal as e:
        return {"video_id": None, "file": file, "error": str(e), "source": "local_whisper"}


# ------------------------------------------------------------------- rutas


def _resolver_ruta(file: str) -> tuple[Path, str | None]:
    """Nombre corto o ruta absoluta -> (ruta real, idioma por defecto)."""
    texto = (file or "").strip().strip('"').strip("'")
    if not texto:
        raise _ErrorLocal("No file given. Pass a video name like 'video137' or a full path.")

    candidata = Path(texto)
    if not candidata.is_absolute():
        nombre = candidata.stem if candidata.suffix.lower() == ".mp4" else candidata.name
        carpeta = next((c for patron, c in _NOMBRES if patron.match(nombre)), None)
        if carpeta is None or candidata.parent != Path("."):
            raise _ErrorLocal(
                f"'{file}' is not a known video name. Use 'videoNNN' (C:\\Ferguson), "
                "'tiktokNNN' or 'youtubeNN' (C:\\Adobe), 'kanyeNNN' (C:\\Kanye), "
                "or a full path inside one of "
                "those folders."
            )
        candidata = carpeta / f"{nombre}.mp4"

    # resolve() sigue enlaces y '..', asi no se puede escapar de las carpetas.
    ruta = candidata.resolve()
    carpeta = _carpeta_permitida(ruta)
    if carpeta is None:
        raise _ErrorLocal(
            f"Access denied: '{ruta}' is outside the allowed folders. "
            "Only files inside C:\\Ferguson, C:\\Adobe and C:\\Kanye can be transcribed."
        )
    if not ruta.is_file():
        raise _ErrorLocal(f"File not found: {ruta}")
    if ruta.suffix.lower() not in _EXTENSIONES:
        raise _ErrorLocal(
            f"Unsupported format '{ruta.suffix or '(no extension)'}'. "
            f"Supported: {', '.join(sorted(_EXTENSIONES))}."
        )
    # None => autodetectar (carpeta permitida sin idioma asignado).
    return ruta, _CARPETAS.get(carpeta)


def _carpeta_permitida(ruta: Path) -> Path | None:
    destino = os.path.normcase(str(ruta))
    for carpeta in _CARPETAS:
        base = os.path.normcase(str(carpeta.resolve()))
        try:
            if os.path.commonpath([destino, base]) == base:
                return carpeta
        except ValueError:  # distinta unidad
            continue
    return None


# ------------------------------------------------------------------- audio


def _decodificar(ruta: Path):
    try:
        from faster_whisper import decode_audio
    except ImportError:
        raise _ErrorLocal(
            "faster-whisper is not installed. Install it with: pip install faster-whisper"
        ) from None
    try:
        audio = decode_audio(str(ruta), sampling_rate=_SAMPLE_RATE)
    except Exception as e:  # noqa: BLE001  (av lanza varias clases distintas)
        raise _ErrorLocal(
            f"Could not read the audio of '{ruta.name}': the format is not supported "
            f"or the file is damaged ({type(e).__name__}: {_una_linea(e)})."
        ) from None
    if len(audio) == 0:
        raise _ErrorLocal(f"'{ruta.name}' has no audio track.")
    return audio


# ------------------------------------------------------------------ modelo


def _cuda_disponible() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001
        return False


def _registrar_dlls_cuda() -> None:
    """ctranslate2 necesita cublas64_12.dll; en Windows viene del wheel nvidia-cublas-cu12."""
    if os.name != "nt":
        return
    try:
        import nvidia.cublas

        bin_dir = Path(next(iter(nvidia.cublas.__path__))) / "bin"
    except Exception:  # noqa: BLE001
        return
    if bin_dir.is_dir():
        os.add_dll_directory(str(bin_dir))
        os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"


def _cargar_modelo(forzar_cpu: bool = False):
    global _modelo, _modelo_info
    with _lock:
        if _modelo is not None and not (forzar_cpu and _modelo_info.get("device") == "cuda"):
            return _modelo
        from faster_whisper import WhisperModel

        if not forzar_cpu and _cuda_disponible():
            _registrar_dlls_cuda()
            opciones = [("cuda", "float16"), ("cpu", "int8")]
        else:
            opciones = [("cpu", "int8")]

        fallos = []
        for device, compute_type in opciones:
            try:
                _modelo = WhisperModel(WHISPER_MODEL, device=device, compute_type=compute_type)
                _modelo_info = {
                    "model": WHISPER_MODEL,
                    "device": device,
                    "compute_type": compute_type,
                }
                if fallos:
                    _modelo_info["notes"] = fallos
                return _modelo
            except Exception as e:  # noqa: BLE001
                fallos.append(f"{device}: {type(e).__name__}: {_una_linea(e)}")

        raise _ErrorLocal(
            f"Could not load the Whisper model '{WHISPER_MODEL}'. "
            "The first call downloads it from Hugging Face, so it needs internet. "
            + " | ".join(fallos)
        )


def _transcribir(ruta: Path, audio, idioma: str | None) -> dict:
    inicio = time.perf_counter()
    modelo = _cargar_modelo()
    try:
        segmentos, info = _ejecutar(modelo, audio, idioma)
    except Exception as e:  # noqa: BLE001
        if _modelo_info.get("device") != "cuda":
            raise _ErrorLocal(f"Transcription failed: {type(e).__name__}: {_una_linea(e)}")
        # La GPU carga bien pero puede fallar al ejecutar (falta cuBLAS, sin VRAM...).
        aviso = f"cuda failed, fell back to cpu: {type(e).__name__}: {_una_linea(e)}"
        modelo = _cargar_modelo(forzar_cpu=True)
        _modelo_info.setdefault("notes", []).append(aviso)
        try:
            segmentos, info = _ejecutar(modelo, audio, idioma)
        except Exception as e2:  # noqa: BLE001
            raise _ErrorLocal(f"Transcription failed: {type(e2).__name__}: {_una_linea(e2)}")

    resultado = {
        "video_id": None,
        "file": str(ruta),
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "is_generated": True,
        "requested_language": idioma,
        "source": "local_whisper",
        "duration_total": round(len(audio) / _SAMPLE_RATE, 2),
        "full_text": " ".join(s["text"] for s in segmentos),
        "segments": segmentos,
        **_modelo_info,
        "elapsed_seconds": round(time.perf_counter() - inicio, 2),
    }
    if not segmentos:
        resultado["notes"] = resultado.get("notes", []) + ["No speech detected in the file."]
    return resultado


def _ejecutar(modelo, audio, idioma: str | None) -> tuple[list[dict], object]:
    # transcribe() devuelve un generador: el trabajo (y los errores de GPU) ocurre al iterar.
    generador, info = modelo.transcribe(audio, language=idioma, vad_filter=True)
    segmentos = []
    for s in generador:
        texto = s.text.strip()
        if texto:
            segmentos.append({
                "text": texto,
                "start": round(s.start, 2),
                "duration": round(s.end - s.start, 2),
            })
    return segmentos, info


def _una_linea(e: Exception) -> str:
    texto = str(e).strip().splitlines()
    return (texto[0] if texto else "")[:300]
