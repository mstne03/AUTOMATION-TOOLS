"""Video publishing tools — upload, update metadata, thumbnails, delete.

Every file read goes through the allowed-folders list (YOUTUBE_MCP_ALLOWED_DIRS):
the model picks the paths, and the model's output is untrusted input.
"""

import time
from datetime import datetime

from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload

from youtube_mcp.server import auth, mcp, quota
from youtube_mcp.utils.paths import AccessDeniedError, resolve_allowed

PRIVACY = ("private", "public", "unlisted")
MAX_TAGS_CHARS = 500  # limite de YouTube para la suma de todas las etiquetas
MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
UPLOAD_MAX_RETRIES = 5
_RETRIABLE_STATUS = (500, 502, 503, 504)


def _validar_publish_at(publish_at: str | None, privacy_status: str) -> str | None:
    """ISO 8601 con zona horaria, y solo con privacidad 'private' (regla de YouTube)."""
    if not publish_at:
        return None
    if privacy_status != "private":
        return (
            "publish_at requires privacy_status='private': YouTube publishes the video "
            "itself at that time."
        )
    try:
        fecha = datetime.fromisoformat(publish_at.replace("Z", "+00:00"))
    except ValueError:
        return f"publish_at '{publish_at}' is not ISO 8601 (e.g. 2026-10-15T18:00:00Z)."
    if fecha.tzinfo is None:
        return f"publish_at '{publish_at}' needs a timezone (append Z or +02:00)."
    return None


def _validar_tags(tags: list[str] | None) -> str | None:
    if tags and sum(len(t) for t in tags) > MAX_TAGS_CHARS:
        return f"tags exceed YouTube's {MAX_TAGS_CHARS}-character total limit."
    return None


def _subir_con_reintentos(request) -> dict:
    """Bucle de subida reanudable: reintenta trozos ante 5xx o cortes de red."""
    response = None
    intentos = 0
    while response is None:
        try:
            _progreso, response = request.next_chunk()
            intentos = 0
        except HttpError as e:
            if e.resp.status not in _RETRIABLE_STATUS or intentos >= UPLOAD_MAX_RETRIES:
                raise
            intentos += 1
            time.sleep(2**intentos)
        except (OSError, ConnectionError):
            if intentos >= UPLOAD_MAX_RETRIES:
                raise
            intentos += 1
            time.sleep(2**intentos)
    return response


@mcp.tool()
def youtube_upload_video(
    file_path: str,
    title: str,
    description: str = "",
    tags: list[str] | None = None,
    category_id: str = "22",
    privacy_status: str = "private",
    publish_at: str | None = None,
) -> dict:
    """Upload a video to YouTube.

    Uses the `video_insert` quota bucket (100 uploads per day). The file must be
    inside one of the allowed folders (YOUTUBE_MCP_ALLOWED_DIRS). Uploaded as
    private by default; resumable, with automatic retries on network errors.

    Args:
        file_path: Absolute path, or bare file name searched in the allowed folders
        title: Video title (max 100 characters)
        description: Video description (max 5,000 characters)
        tags: List of tags (500 characters in total)
        category_id: YouTube category ID (default "22" = People & Blogs)
        privacy_status: "private", "public", or "unlisted"
        publish_at: ISO 8601 datetime with timezone to schedule publishing
            (requires privacy_status="private")
    """
    try:
        ruta, _ = resolve_allowed(file_path)
    except AccessDeniedError as e:
        return {"error": str(e)}
    if not title.strip():
        return {"error": "title is required."}
    if privacy_status not in PRIVACY:
        return {"error": f"privacy_status must be one of {PRIVACY}."}
    for error in (_validar_tags(tags), _validar_publish_at(publish_at, privacy_status)):
        if error:
            return {"error": error}

    quota.consume("video_insert")
    youtube = auth.build_youtube_service()

    body = {
        "snippet": {
            "title": title[:100],
            "description": description[:5000],
            "tags": tags or [],
            "categoryId": category_id,
        },
        "status": {
            "privacyStatus": privacy_status,
            "selfDeclaredMadeForKids": False,
        },
    }
    if publish_at:
        body["status"]["publishAt"] = publish_at

    media = MediaFileUpload(str(ruta), chunksize=UPLOAD_CHUNK_BYTES, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = _subir_con_reintentos(request)

    video_id = response.get("id")
    resp_snippet = response.get("snippet", {})
    resp_status = response.get("status", {})

    return {
        "id": video_id,
        "title": resp_snippet.get("title", title[:100]),
        "privacy": resp_status.get("privacyStatus", privacy_status),
        "publish_at": resp_status.get("publishAt", publish_at),
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "file": str(ruta),
        "quota_cost": 1,
        "quota_bucket": "video_insert",
    }


@mcp.tool()
def youtube_update_video(
    video_id: str,
    title: str | None = None,
    description: str | None = None,
    tags: list[str] | None = None,
    category_id: str | None = None,
    privacy_status: str | None = None,
    publish_at: str | None = None,
) -> dict:
    """Update metadata for an existing video.

    Only provided fields are updated; others remain unchanged.

    Args:
        video_id: YouTube video ID
        title: New title (max 100 characters)
        description: New description (max 5,000 characters)
        tags: New tags (replaces existing tags; 500 characters in total)
        category_id: New category ID
        privacy_status: "private", "public", or "unlisted"
        publish_at: ISO 8601 datetime with timezone to (re)schedule publishing.
            The video must be, or be set to, "private".
    """
    updated_fields = [
        name
        for name, value in (
            ("title", title),
            ("description", description),
            ("tags", tags),
            ("category_id", category_id),
            ("privacy_status", privacy_status),
            ("publish_at", publish_at),
        )
        if value is not None
    ]
    if not updated_fields:
        return {"id": video_id, "updated": False, "error": "Nothing to update"}
    if privacy_status is not None and privacy_status not in PRIVACY:
        return {"error": f"privacy_status must be one of {PRIVACY}."}
    if error := _validar_tags(tags):
        return {"error": error}

    quota.consume("list")
    youtube = auth.build_youtube_service()

    # Fetch current video data first
    current = youtube.videos().list(part="snippet,status", id=video_id).execute()
    items = current.get("items", [])
    if not items:
        return {"error": f"Video not found: {video_id}"}

    video = items[0]
    snippet = video["snippet"]
    status = video.get("status", {})

    # Update only provided fields
    if title is not None:
        snippet["title"] = title[:100]
    if description is not None:
        snippet["description"] = description[:5000]
    if tags is not None:
        snippet["tags"] = tags
    if category_id is not None:
        snippet["categoryId"] = category_id

    body = {"id": video_id, "snippet": snippet}

    if privacy_status is not None or publish_at is not None:
        privacidad = privacy_status or status.get("privacyStatus", "private")
        if error := _validar_publish_at(publish_at, privacidad):
            return {"error": error}
        body["status"] = {"privacyStatus": privacidad}
        if publish_at:
            body["status"]["publishAt"] = publish_at

    # Always ask for snippet,status in the response. Requesting only "snippet"
    # made YouTube omit the status block, and reading response["status"] then
    # raised KeyError: 'status' *after* the update had already been applied.
    # Parts are free on writes, so there is no reason to ask for less.
    quota.consume("update")
    response = youtube.videos().update(part="snippet,status", body=body).execute()

    resp_snippet = response.get("snippet", {})
    resp_status = response.get("status", {})

    return {
        "id": response.get("id", video_id),
        "title": resp_snippet.get("title", snippet.get("title")),
        "tags": resp_snippet.get("tags", snippet.get("tags", [])),
        "category_id": resp_snippet.get("categoryId", snippet.get("categoryId")),
        "privacy": resp_status.get("privacyStatus", status.get("privacyStatus")),
        "publish_at": resp_status.get("publishAt", publish_at or status.get("publishAt")),
        "updated_fields": updated_fields,
        "updated": True,
        "url": f"https://www.youtube.com/watch?v={video_id}",
    }


@mcp.tool()
def youtube_set_thumbnail(video_id: str, file_path: str) -> dict:
    """Upload a custom thumbnail for a video.

    Args:
        video_id: YouTube video ID
        file_path: Image inside an allowed folder (JPEG, PNG, GIF, BMP; max 2 MB)
    """
    try:
        ruta, _ = resolve_allowed(file_path)
    except AccessDeniedError as e:
        return {"error": str(e)}
    tamano = ruta.stat().st_size
    if tamano > MAX_THUMBNAIL_BYTES:
        return {"error": f"Thumbnail is {tamano / 1024 / 1024:.1f} MB; YouTube's limit is 2 MB."}

    quota.consume("thumbnail_set")
    youtube = auth.build_youtube_service()

    media = MediaFileUpload(str(ruta))
    response = youtube.thumbnails().set(videoId=video_id, media_body=media).execute()

    items = response.get("items", [])
    if items:
        return {
            "video_id": video_id,
            "thumbnail_url": items[0].get("default", {}).get("url"),
            "updated": True,
        }

    return {"video_id": video_id, "updated": True}


@mcp.tool()
def youtube_delete_video(video_id: str, confirm: bool = False) -> dict:
    """Delete a video. This action is irreversible.

    Nothing is deleted unless `confirm=True`. Ask the user to confirm the exact
    video (title and ID) before calling with confirm=True.

    Args:
        video_id: YouTube video ID to delete
        confirm: Must be True to actually delete
    """
    # ponytail: gate minimo hasta que la UI de la Fase 1 pida la confirmacion al usuario.
    if not confirm:
        return {
            "video_id": video_id,
            "deleted": False,
            "error": (
                "Deletion is irreversible. Confirm with the user and call again "
                "with confirm=True."
            ),
        }
    quota.consume("delete")
    youtube = auth.build_youtube_service()

    youtube.videos().delete(id=video_id).execute()

    return {"video_id": video_id, "deleted": True}
