"""Response formatting utilities for LLM consumption."""

import re

_ISO_DURATION = re.compile(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?")


def iso_duration_seconds(iso_duration: str) -> int | None:
    """ISO 8601 duration (P1DT1H2M3S) -> total seconds. None if empty or unparseable."""
    m = _ISO_DURATION.fullmatch(iso_duration or "")
    if not iso_duration or not m:
        return None
    d, h, mi, s = (int(g) if g else 0 for g in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + s


def format_duration(iso_duration: str) -> str:
    """Convert ISO 8601 duration (PT1H2M3S) to human-readable format."""
    total = iso_duration_seconds(iso_duration)
    if total is None:
        return "unknown"
    hours, rest = divmod(total, 3600)
    minutes, seconds = divmod(rest, 60)
    parts = []
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    if seconds or not parts:
        parts.append(f"{seconds}s")
    return " ".join(parts)


def format_count(n: int | str) -> str:
    """Format large numbers with K/M/B suffixes."""
    n = int(n)
    if n >= 1_000_000_000:
        return f"{n / 1_000_000_000:.1f}B"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def format_video_summary(video: dict) -> dict:
    """Extract and format key fields from a YouTube Data API video resource."""
    snippet = video.get("snippet", {})
    stats = video.get("statistics", {})
    content = video.get("contentDetails", {})

    return {
        "id": video.get("id"),
        "title": snippet.get("title"),
        "channel": snippet.get("channelTitle"),
        "published_at": snippet.get("publishedAt"),
        "duration": format_duration(content.get("duration", "")),
        "duration_seconds": iso_duration_seconds(content.get("duration", "")),
        "views": int(stats.get("viewCount", 0)),
        "likes": int(stats.get("likeCount", 0)),
        "comments": int(stats.get("commentCount", 0)),
        "description": snippet.get("description", "")[:500],
        "tags": snippet.get("tags", []),
        "thumbnail": snippet.get("thumbnails", {}).get("high", {}).get("url"),
        "is_short": _is_likely_short(content.get("duration", "")),
    }


def _is_likely_short(iso_duration: str) -> bool:
    """Heuristic: videos <= 60 seconds are likely Shorts."""
    total = iso_duration_seconds(iso_duration)
    return total is not None and total <= 60
