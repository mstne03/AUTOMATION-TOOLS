"""Transcript and caption tools.

Two strategies, and the order between them matters:

- **Official Data API** (`captions.list` + `captions.download`, OAuth). Works on
  videos of the authenticated channel whatever their privacy is: private,
  scheduled or unlisted. Needs the `youtube.force-ssl` scope for the download.
- **youtube-transcript-api** (scraping, no auth). Works on any *publicly
  playable* video, which is why it cannot see your own drafts.

For a video of your own channel we try the official route first and fall back to
scraping. For anyone else's video we go straight to scraping, since the official
captions endpoint only serves videos you own.
"""

import re

from googleapiclient.errors import HttpError

from youtube_mcp.server import auth, mcp, quota

FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl"

_SCOPE_HINT = (
    "The official captions endpoints (both captions.list and captions.download) "
    f"need the '{FORCE_SSL}' OAuth scope, which this token does not have. "
    "Add it to SCOPES in youtube_mcp/auth.py and re-authorise with youtube_auth. "
    "Until then only the scraping route works, and it needs the video to be "
    "publicly playable."
)


@mcp.tool()
def youtube_list_captions(video_id: str) -> dict:
    """List available caption tracks for a video you own.

    Requires OAuth. Only works for videos on the authenticated user's channel.

    Args:
        video_id: YouTube video ID
    """
    quota.consume("list")
    youtube = auth.build_youtube_service()

    response = youtube.captions().list(part="snippet", videoId=video_id).execute()

    tracks = []
    for item in response.get("items", []):
        snippet = item.get("snippet", {})
        tracks.append({
            "id": item["id"],
            "language": snippet.get("language"),
            "name": snippet.get("name"),
            "track_kind": snippet.get("trackKind"),
            "is_auto_synced": snippet.get("isAutoSynced"),
            "is_draft": snippet.get("isDraft"),
            "last_updated": snippet.get("lastUpdated"),
        })

    return {"video_id": video_id, "tracks": tracks}


@mcp.tool()
def youtube_get_transcript(
    video_id: str,
    language: str = "en",
    use_official_api: bool = False,
) -> dict:
    """Get the transcript/captions for a video.

    For a video on your own channel this uses the official API first, so it also
    works on private, unlisted and scheduled videos, and falls back to
    youtube-transcript-api. For someone else's video it goes straight to
    youtube-transcript-api, which needs the video to be publicly playable.

    Args:
        video_id: YouTube video ID
        language: Preferred language code (e.g., "en", "es", "ja")
        use_official_api: Force the official API only, with no scraping fallback
    """
    if use_official_api:
        return _get_transcript_official(video_id, language)

    propio, motivo_propietario = _es_video_propio(video_id)

    intentos: list[str] = []
    if propio:
        oficial = _get_transcript_official(video_id, language)
        if "error" not in oficial:
            return oficial
        intentos.append(f"official API: {oficial['error']}")

    scraped = _get_transcript_scraping(video_id, language)
    if "error" not in scraped:
        if intentos:
            scraped["notes"] = intentos
        return scraped
    intentos.append(f"youtube-transcript-api: {scraped['error']}")

    return {
        "video_id": video_id,
        "error": _mensaje_final(propio, motivo_propietario, intentos),
        "attempts": intentos,
        "source": "none",
    }


def _mensaje_final(propio: bool, motivo_propietario: str | None, intentos: list[str]) -> str:
    detalle = " | ".join(intentos)
    if propio:
        return (
            f"Could not get the transcript for this video of yours. {detalle}"
        )
    if motivo_propietario:
        return (
            f"Could not get the transcript. {detalle}. "
            f"Note: could not confirm whether the video is yours ({motivo_propietario}), "
            "so the official API route was skipped."
        )
    return (
        f"Could not get the transcript. {detalle}. "
        "The video is not on your channel, so only the scraping route is available "
        "and it needs the video to be publicly playable."
    )


# ---------------------------------------------------------------- propiedad

_mi_canal_id: str | None = None


def _mi_canal() -> str | None:
    """ID del canal autenticado. Se cachea: no cambia durante la sesion."""
    global _mi_canal_id
    if _mi_canal_id is None:
        quota.consume("list")
        youtube = auth.build_youtube_service()
        resp = youtube.channels().list(part="id", mine=True).execute()
        items = resp.get("items", [])
        if items:
            _mi_canal_id = items[0].get("id")
    return _mi_canal_id


def _es_video_propio(video_id: str) -> tuple[bool, str | None]:
    """(es_propio, motivo_si_no_se_pudo_determinar)."""
    try:
        quota.consume("list")
        youtube = auth.build_youtube_service()
        resp = youtube.videos().list(part="snippet", id=video_id).execute()
        items = resp.get("items", [])
        if not items:
            # Un video privado ajeno tampoco aparece; no es concluyente.
            return False, "the video was not returned by videos.list"
        canal_video = items[0].get("snippet", {}).get("channelId")
        mio = _mi_canal()
        if not mio:
            return False, "could not resolve the authenticated channel"
        return canal_video == mio, None
    except HttpError as e:
        return False, f"{_http_reason(e) or 'HTTP error'}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


# ------------------------------------------------------------ via oficial


def _get_transcript_official(video_id: str, language: str) -> dict:
    """Official Data API. Works on private/scheduled videos of your own channel.

    Track preference: a human-written track in the requested language, then an
    auto-generated one in that language, then whatever the video has.
    """
    youtube = auth.build_youtube_service()

    try:
        quota.consume("list")
        response = youtube.captions().list(part="snippet", videoId=video_id).execute()
    except HttpError as e:
        return {"video_id": video_id, "error": _http_message(e), "source": "official_api"}

    items = response.get("items", [])
    if not items:
        return {
            "video_id": video_id,
            "error": (
                "The video has no caption tracks yet. If you have just uploaded it, "
                "YouTube usually takes a few minutes to generate the automatic ones. "
                "Try again later."
            ),
            "source": "official_api",
        }

    track = _elegir_pista(items, language)
    snippet = track.get("snippet", {})

    try:
        quota.consume("list")
        raw = youtube.captions().download(id=track["id"], tfmt="srt").execute()
    except HttpError as e:
        return {"video_id": video_id, "error": _http_message(e), "source": "official_api"}

    text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    segments = _parse_srt(text)

    if not segments:
        return {
            "video_id": video_id,
            "error": "The caption track downloaded empty.",
            "source": "official_api",
        }

    track_kind = snippet.get("trackKind")
    return {
        "video_id": video_id,
        "language": snippet.get("language"),
        "language_name": snippet.get("name") or snippet.get("language"),
        "is_generated": track_kind == "ASR",
        "track_kind": track_kind,
        "requested_language": language,
        "matched_requested_language": snippet.get("language") == language,
        "source": "official_api",
        "full_text": " ".join(s["text"] for s in segments),
        "segments": segments,
    }


def _elegir_pista(items: list[dict], language: str) -> dict:
    """Manual en el idioma pedido > automatica en ese idioma > la que haya."""
    def es(item, idioma, kind=None):
        snippet = item.get("snippet", {})
        if snippet.get("language") != idioma:
            return False
        return kind is None or snippet.get("trackKind") == kind

    for kind in ("standard", None, "ASR"):
        for item in items:
            if kind == "standard" and es(item, language, "standard"):
                return item
            if kind == "ASR" and es(item, language, "ASR"):
                return item
            if kind is None and es(item, language) and item.get(
                "snippet", {}
            ).get("trackKind") not in ("standard", "ASR"):
                return item
    return items[0]


def _parse_srt(text: str) -> list[dict]:
    """SRT -> [{text, start, duration}], igual que la via de scraping."""
    segments: list[dict] = []
    for bloque in re.split(r"\r?\n\r?\n+", text.strip()):
        lineas = [ln for ln in bloque.splitlines() if ln.strip()]
        if len(lineas) < 2:
            continue
        tiempos = next((ln for ln in lineas if "-->" in ln), None)
        if not tiempos:
            continue
        inicio_txt, _, fin_txt = tiempos.partition("-->")
        inicio = _srt_a_segundos(inicio_txt)
        fin = _srt_a_segundos(fin_txt)
        if inicio is None or fin is None:
            continue
        cuerpo = " ".join(
            ln.strip() for ln in lineas[lineas.index(tiempos) + 1 :] if ln.strip()
        )
        cuerpo = re.sub(r"<[^>]+>", "", cuerpo).strip()
        if cuerpo:
            segments.append(
                {"text": cuerpo, "start": inicio, "duration": round(fin - inicio, 3)}
            )
    return segments


def _srt_a_segundos(marca: str) -> float | None:
    m = re.search(r"(\d+):(\d{2}):(\d{2})[,.](\d{1,3})", marca.strip())
    if not m:
        return None
    h, mi, s, ms = (int(g) for g in m.groups())
    return h * 3600 + mi * 60 + s + ms / 1000


def _http_reason(e: HttpError) -> str | None:
    try:
        return e.error_details[0].get("reason")  # type: ignore[index]
    except Exception:  # noqa: BLE001
        return None


def _http_message(e: HttpError) -> str:
    """Traduce el error de la API a algo accionable."""
    status = getattr(e.resp, "status", None)
    reason = _http_reason(e) or ""

    if status == 403 and reason in {
        "insufficientPermissions",
        "forbidden",
        "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
    }:
        return _SCOPE_HINT
    if status == 403 and "scope" in str(e).lower():
        return _SCOPE_HINT
    if status == 403:
        return (
            "YouTube refused the captions request (403). The official captions "
            "endpoint only serves videos on your own channel. " + _SCOPE_HINT
        )
    if status == 404:
        return "No caption track with that id, or the video does not exist."
    return f"YouTube API error {status}: {reason or e}"


# ----------------------------------------------------------- via scraping

# Human-readable messages for the youtube-transcript-api 1.x exception classes.
# Looked up by name so the module keeps importing on versions that drop or rename one.
_SCRAPING_ERRORS = {
    "TranscriptsDisabled": "The uploader has disabled subtitles for this video.",
    "NoTranscriptFound": "This video has no transcript in any available language.",
    "VideoUnavailable": "The video does not exist or is not publicly available.",
    "VideoUnplayable": (
        "YouTube refuses to play this video, so the scraping route cannot read it. "
        "This is what happens with private, unlisted or scheduled videos."
    ),
    "AgeRestricted": "The video is age restricted, so its transcript cannot be fetched anonymously.",
    "InvalidVideoId": "That is not a valid video ID. Pass the ID, not the full URL.",
    "RequestBlocked": "YouTube is blocking these requests. Try again later or use a proxy.",
    "IpBlocked": "YouTube has blocked this IP address. Try again later or use a proxy.",
    "PoTokenRequired": "YouTube is asking for a PO token for this video, which is not supported.",
    "YouTubeRequestFailed": "The request to YouTube failed.",
    "YouTubeDataUnparsable": "YouTube returned data this library could not parse.",
}


def _scraping_error_message(exc) -> str:
    """Map a youtube-transcript-api exception to a short, actionable message."""
    for cls in type(exc).__mro__:
        if cls.__name__ in _SCRAPING_ERRORS:
            return _SCRAPING_ERRORS[cls.__name__]
    return str(exc) or type(exc).__name__


def _get_transcript_scraping(video_id: str, language: str) -> dict:
    """Get transcript using youtube-transcript-api (publicly playable videos).

    Targets the 1.x instance API. Language preference, in order: a human-written
    transcript in the requested language, an auto-generated one in that language,
    then whatever the video happens to have.
    """
    try:
        from youtube_transcript_api import (
            NoTranscriptFound,
            YouTubeTranscriptApi,
            YouTubeTranscriptApiException,
        )
    except ImportError:
        return {
            "error": "youtube-transcript-api is not installed. "
            "Install it with: pip install 'youtube-transcript-api>=1.0'",
        }

    ytt_api = YouTubeTranscriptApi()

    try:
        transcript_list = ytt_api.list(video_id)

        transcript = None
        try:
            transcript = transcript_list.find_manually_created_transcript([language])
        except NoTranscriptFound:
            try:
                transcript = transcript_list.find_generated_transcript([language])
            except NoTranscriptFound:
                transcript = next(iter(transcript_list), None)

        if transcript is None:
            raise NoTranscriptFound(video_id, [language], transcript_list)

        fetched = transcript.fetch()
    except YouTubeTranscriptApiException as e:
        return {
            "video_id": video_id,
            "error": _scraping_error_message(e),
            "source": "youtube-transcript-api",
        }
    except Exception as e:  # network errors and anything else the library lets through
        return {
            "video_id": video_id,
            "error": f"{type(e).__name__}: {e}",
            "source": "youtube-transcript-api",
        }

    # fetch() returns a FetchedTranscript, not a list of dicts.
    segments = fetched.to_raw_data()

    return {
        "video_id": video_id,
        "language": transcript.language_code,
        "language_name": transcript.language,
        "is_generated": transcript.is_generated,
        "requested_language": language,
        "matched_requested_language": transcript.language_code == language,
        "source": "youtube-transcript-api",
        "full_text": " ".join(s["text"] for s in segments),
        "segments": segments,
    }
