"""Channel and video read tools."""

from youtube_mcp.server import auth, mcp, quota
from youtube_mcp.utils.formatting import format_video_summary


@mcp.tool()
def youtube_get_channel(
    channel_id: str | None = None,
    handle: str | None = None,
    mine: bool = False,
) -> dict:
    """Get channel details by channel ID, handle (@username), or the authenticated user's channel.

    Args:
        channel_id: YouTube channel ID (e.g., "UCxxxxxxx")
        handle: Channel handle (e.g., "@mkbhd")
        mine: If True, get the authenticated user's own channel
    """
    quota.consume("list")
    youtube = auth.build_youtube_service()

    params = {"part": "snippet,statistics,contentDetails,brandingSettings"}
    if mine:
        params["mine"] = True
    elif handle:
        params["forHandle"] = handle
    elif channel_id:
        params["id"] = channel_id
    else:
        return {"error": "Provide channel_id, handle, or set mine=True"}

    response = youtube.channels().list(**params).execute()
    items = response.get("items", [])
    if not items:
        return {"error": "Channel not found"}

    ch = items[0]
    snippet = ch.get("snippet", {})
    stats = ch.get("statistics", {})

    return {
        "id": ch["id"],
        "title": snippet.get("title"),
        "handle": snippet.get("customUrl"),
        "description": snippet.get("description", "")[:500],
        "published_at": snippet.get("publishedAt"),
        "subscribers": int(stats.get("subscriberCount", 0)),
        "total_views": int(stats.get("viewCount", 0)),
        "video_count": int(stats.get("videoCount", 0)),
        "thumbnail": snippet.get("thumbnails", {}).get("high", {}).get("url"),
        "uploads_playlist_id": (
            ch.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
        ),
    }


@mcp.tool()
def youtube_list_videos(
    channel_id: str | None = None,
    playlist_id: str | None = None,
    mine: bool = False,
    max_results: int = 20,
    page_token: str | None = None,
) -> dict:
    """List videos from a channel or playlist.

    For a channel, uses the channel's uploads playlist. Returns video summaries
    with stats, sorted by most recent. Each video carries its `playlist_item_id`,
    which is what youtube_remove_from_playlist needs.

    Args:
        channel_id: Channel ID to list videos from
        playlist_id: Playlist ID to list videos from (overrides channel_id)
        mine: If True, list the authenticated user's videos
        max_results: Number of videos per page (max 50)
        page_token: `next_page_token` from a previous call, to get the next page
    """
    youtube = auth.build_youtube_service()
    max_results = min(max_results, 50)

    # Resolve uploads playlist if needed
    if not playlist_id:
        quota.consume("list")
        ch_params = {"part": "contentDetails"}
        if mine:
            ch_params["mine"] = True
        elif channel_id:
            ch_params["id"] = channel_id
        else:
            return {"error": "Provide channel_id, playlist_id, or set mine=True"}

        ch_response = youtube.channels().list(**ch_params).execute()
        ch_items = ch_response.get("items", [])
        if not ch_items:
            return {"error": "Channel not found"}
        playlist_id = (
            ch_items[0].get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
        )

    if not playlist_id:
        return {"error": "Could not resolve uploads playlist"}

    # Get playlist items
    quota.consume("list")
    pl_params = {"part": "contentDetails", "playlistId": playlist_id, "maxResults": max_results}
    if page_token:
        pl_params["pageToken"] = page_token
    pl_response = youtube.playlistItems().list(**pl_params).execute()

    item_ids = {
        item["contentDetails"]["videoId"]: item.get("id")
        for item in pl_response.get("items", [])
    }
    video_ids = list(item_ids)

    if not video_ids:
        return {"videos": [], "total": 0, "next_page_token": None}

    # Get full video details in one batch call
    quota.consume("list")
    videos_response = (
        youtube.videos()
        .list(part="snippet,statistics,contentDetails", id=",".join(video_ids))
        .execute()
    )

    videos = []
    for v in videos_response.get("items", []):
        resumen = format_video_summary(v)
        resumen["playlist_item_id"] = item_ids.get(v.get("id"))
        videos.append(resumen)

    return {
        "videos": videos,
        "total": pl_response.get("pageInfo", {}).get("totalResults", len(videos)),
        "next_page_token": pl_response.get("nextPageToken"),
    }


@mcp.tool()
def youtube_get_video(video_id: str) -> dict:
    """Get detailed metadata and statistics for a specific video.

    Args:
        video_id: YouTube video ID (e.g., "dQw4w9WgXcQ")
    """
    quota.consume("list")
    youtube = auth.build_youtube_service()

    response = (
        youtube.videos()
        .list(part="snippet,statistics,contentDetails,status,topicDetails", id=video_id)
        .execute()
    )

    items = response.get("items", [])
    if not items:
        return {"error": f"Video not found: {video_id}"}

    video = items[0]
    summary = format_video_summary(video)

    # Add extra detail fields not in the summary
    status = video.get("status", {})
    summary["privacy"] = status.get("privacyStatus")
    summary["publish_at"] = status.get("publishAt")
    summary["license"] = status.get("license")
    summary["embeddable"] = status.get("embeddable")
    summary["topic_categories"] = video.get("topicDetails", {}).get("topicCategories", [])

    return summary
