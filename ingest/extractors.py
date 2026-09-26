"""Extraccion de texto segun el tipo de fuente."""

from dataclasses import dataclass, field
from pathlib import Path


class ExtractionError(Exception):
    """La fuente no se pudo procesar. El motivo es legible para el usuario."""


@dataclass
class Extracted:
    text: str = ""
    title: str | None = None
    author: str | None = None
    lang: str | None = None
    published_at: str | None = None
    # Solo para youtube: [{text, start, duration}, ...]
    segments: list[dict] = field(default_factory=list)


def extract(source_type: str, location: str) -> Extracted:
    if source_type == "web":
        return _web(location)
    if source_type == "youtube":
        return _youtube(location)
    if source_type == "pdf":
        return _pdf(location)
    if source_type == "local":
        return _local(location)
    raise ExtractionError(f"Tipo de fuente desconocido: {source_type}")


def _web(url: str) -> Extracted:
    import trafilatura

    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        raise ExtractionError(f"No se pudo descargar {url}")

    text = trafilatura.extract(downloaded, include_comments=False, include_tables=True)
    if not text or not text.strip():
        raise ExtractionError(f"trafilatura no extrajo texto de {url}")

    meta = trafilatura.extract_metadata(downloaded)
    return Extracted(
        text=text,
        title=getattr(meta, "title", None),
        author=getattr(meta, "author", None),
        lang=getattr(meta, "language", None),
        published_at=getattr(meta, "date", None),
    )


def _youtube(url: str) -> Extracted:
    """Transcripcion via youtube-transcript-api 1.x. Espanol primero, luego ingles."""
    from youtube_transcript_api import (
        NoTranscriptFound,
        YouTubeTranscriptApi,
        YouTubeTranscriptApiException,
    )

    video_id = youtube_video_id(url)
    if not video_id:
        raise ExtractionError(f"No pude sacar el ID de video de {url}")

    ytt = YouTubeTranscriptApi()
    try:
        listing = ytt.list(video_id)
        transcript = None
        for lang in ("es", "en"):
            try:
                transcript = listing.find_transcript([lang])
                break
            except NoTranscriptFound:
                continue
        if transcript is None:
            raise ExtractionError(
                f"{url}: no hay transcripcion en espanol ni ingles. Fuente saltada."
            )
        fetched = transcript.fetch()
    except YouTubeTranscriptApiException as e:
        raise ExtractionError(f"{url}: sin transcripcion usable ({type(e).__name__})") from e

    segments = fetched.to_raw_data()
    if not segments:
        raise ExtractionError(f"{url}: la transcripcion vino vacia. Fuente saltada.")

    return Extracted(
        text=" ".join(s["text"] for s in segments),
        lang=transcript.language_code,
        segments=segments,
    )


def _pdf(location: str) -> Extracted:
    from pypdf import PdfReader

    path = Path(location)
    if not path.exists():
        raise ExtractionError(f"No existe el PDF {location}")

    reader = PdfReader(str(path))
    pages = [(p.extract_text() or "").strip() for p in reader.pages]
    text = "\n\n".join(p for p in pages if p)
    if not text.strip():
        raise ExtractionError(f"{location}: PDF sin texto extraible (seguramente escaneado).")

    info = reader.metadata or {}
    return Extracted(
        text=text,
        title=(info.get("/Title") or path.stem) or None,
        author=info.get("/Author") or None,
    )


def _local(location: str) -> Extracted:
    path = Path(location)
    if not path.exists():
        raise ExtractionError(f"No existe el archivo {location}")
    if path.suffix.lower() not in {".md", ".txt"}:
        raise ExtractionError(f"{location}: solo se admiten .md y .txt en type: local")

    text = path.read_text(encoding="utf-8")
    if not text.strip():
        raise ExtractionError(f"{location}: archivo vacio.")

    title = path.stem
    for line in text.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            break

    return Extracted(text=text, title=title)


def youtube_video_id(url: str) -> str | None:
    """Acepta URL completa, shorts, youtu.be o el ID pelado."""
    import re
    from urllib.parse import parse_qs, urlparse

    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return url

    parsed = urlparse(url)
    if parsed.hostname in {"youtu.be"}:
        return parsed.path.lstrip("/").split("/")[0] or None
    if parsed.hostname and "youtube.com" in parsed.hostname:
        if parsed.path.startswith(("/shorts/", "/embed/", "/live/")):
            return parsed.path.split("/")[2]
        v = parse_qs(parsed.query).get("v")
        if v:
            return v[0]
    return None
