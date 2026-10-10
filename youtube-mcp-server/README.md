# YouTube MCP Server

A comprehensive [Model Context Protocol](https://modelcontextprotocol.io/) server for the YouTube Data API v3, Analytics API, and Reporting API. Gives AI assistants full access to your YouTube channel — analytics, video management, comments, and more.

**40 tools** covering:
- Channel & video data
- YouTube Analytics (performance, audience, retention, revenue)
- Video publishing & playlist management
- Transcript extraction
- YouTube SEO (search suggestions, trending)
- Comments
- Bulk reporting

## Why This Server?

Existing YouTube MCP servers focus narrowly on transcript scraping or basic search. This server covers **three YouTube APIs** and is the only open-source MCP server that provides:

- **YouTube Analytics API** — channel performance, top videos/Shorts, audience retention curves, traffic sources, demographics, revenue, day-of-week analysis
- **YouTube Reporting API** — schedule and download bulk CSV reports
- **Full Data API coverage** — not just read, but also upload videos, manage playlists, post comments, set thumbnails
- **YouTube SEO tools** — autocomplete suggestions, trending videos, category discovery
- **Dual transcript strategy** — official captions API for your own videos, `youtube-transcript-api` fallback for any public video
- **Local transcription before upload** — `transcribe_local` runs Whisper (faster-whisper) on the file on disk, so the final title/description are ready before `youtube_upload_video`
- **Quota tracking** — client-side tracking with hard-fail protection so you don't silently exhaust your daily quota

| Feature | This server | Others |
|---------|------------|--------|
| Analytics API (watch time, retention, CTR) | Yes | No |
| Reporting API (bulk CSV exports) | Yes | No |
| Video upload & management | Yes | Rare |
| Playlist management | Yes | Rare |
| Comments (read + write) | Yes | No |
| SEO / trending / suggestions | Yes | No |
| Transcript extraction | Yes | Yes |
| Quota tracking | Yes | No |
| Total tools | 41 | 1-5 |

## Prerequisites

- Python 3.11+
- A Google Cloud project with YouTube APIs enabled
- OAuth 2.0 credentials

## Google Cloud Setup

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)

### 2. Enable APIs

Enable all three APIs in **APIs & Services > Library**:

- **YouTube Data API v3**
- **YouTube Analytics API**
- **YouTube Reporting API**

### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services > OAuth consent screen**
2. Set User Type to **External**
3. Fill in the app name and required fields
4. Add the Google account that **owns** your YouTube channel as a **test user**

> **Important:** You must sign in with the Google account that **owns** the YouTube channel, not a manager. Only the owner account can access Analytics data.

### 4. Create OAuth Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Application type: **Desktop app**
4. Download the JSON file
5. Save it as `~/.youtube-mcp/client_secret.json`

Alternatively, set the `YOUTUBE_MCP_CLIENT_SECRET` environment variable to the path of your credentials file.

## Installation

```bash
pip install youtube-studio-mcp
```

Or with uv:

```bash
uv pip install youtube-studio-mcp
```

## MCP Client Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "youtube-studio-mcp"
    }
  }
}
```

### Claude Code

Add to your MCP settings:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "youtube-studio-mcp"
    }
  }
}
```

### With environment variables

```json
{
  "mcpServers": {
    "youtube": {
      "command": "youtube-studio-mcp",
      "env": {
        "YOUTUBE_MCP_CLIENT_SECRET": "/path/to/client_secret.json",
        "YOUTUBE_MCP_ALLOWED_DIRS": "C:\\Videos\\Smooth=en;C:\\Videos\\Candisito=es"
      }
    }
  }
}
```

## First Run

Call the `youtube_auth` tool once. It opens a browser window for Google OAuth consent: sign in with the account that owns your YouTube channel and grant the requested permissions. The token is saved to `~/.youtube-mcp/token.json` and auto-refreshes.

`youtube_auth` is the **only** tool that may open the browser. Every other tool reuses the saved token and, if it is missing or cannot be refreshed (revoked, scopes changed), returns a clear error asking you to run `youtube_auth` again. Use `youtube_auth(reauthorize=True)` to force a new consent flow.

### Multiple channels (profiles)

One token per channel. The default profile uses `token.json`; profile `smooth` uses `token-smooth.json`, and so on.

- Pick the startup profile with `YOUTUBE_MCP_PROFILE=smooth`.
- Switch at runtime with `youtube_auth(profile="smooth")` (runs the consent flow the first time for that profile).
- `youtube_auth_status` lists the profiles that already have a token.

### Allowed folders (required for uploads and local transcription)

The model decides which files to upload, so the server only reads files inside the folders you list in `YOUTUBE_MCP_ALLOWED_DIRS` (separated by `;` on Windows). Each entry may carry a default language for `transcribe_local`:

```
YOUTUBE_MCP_ALLOWED_DIRS=C:\Videos\Smooth=en;C:\Videos\Candisito=es;D:\Thumbnails
```

`youtube_upload_video`, `youtube_set_thumbnail` and `transcribe_local` accept an absolute path inside one of those folders, or a bare file name (`video137` or `video137.mp4`) that is searched in all of them. Anything else is refused before any quota is spent.

## Tools Reference

### Auth & Setup (2 tools)

| Tool | Description |
|------|-------------|
| `youtube_auth` | Run the OAuth 2.0 consent flow, switch profile (`profile=`), or force re-consent (`reauthorize=True`) |
| `youtube_auth_status` | Auth state, active profile, saved profiles and quota usage per bucket |

### Channel & Video (3 tools)

| Tool | Description |
|------|-------------|
| `youtube_get_channel` | Get channel details by ID, handle, or `mine=True` |
| `youtube_list_videos` | List videos from a channel or playlist, with `playlist_item_id` and `next_page_token` for paging |
| `youtube_get_video` | Get detailed video metadata and stats |

### Search & SEO (4 tools)

| Tool | Description |
|------|-------------|
| `youtube_search` | Search YouTube (own quota bucket: 100 calls/day) |
| `youtube_search_suggestions` | Get autocomplete suggestions (no quota cost) |
| `youtube_trending` | Get trending videos by region/category |
| `youtube_get_categories` | List video categories for a region |

### Transcripts (3 tools)

| Tool | Description |
|------|-------------|
| `youtube_get_transcript` | Get video transcript (official API or scraping fallback) |
| `youtube_list_captions` | List caption tracks for own videos |
| `transcribe_local` | Transcribe a local video file with Whisper, before uploading it |

#### `transcribe_local(file, language=None)`

YouTube's automatic captions can take hours, so `youtube_get_transcript` is useless
right after an upload. `transcribe_local` reads the file from disk instead. Use it
**before** `youtube_upload_video`: write the final title, description and tags from
the transcript, then upload once with everything set (including `publish_at`).

- `file`: an absolute path inside an allowed folder, or a bare file name (`video137` or
  `video137.mp4`) searched in every allowed folder (see `YOUTUBE_MCP_ALLOWED_DIRS`).
- `language`: optional; empty means the folder's default language, or autodetect if the
  folder has none.
- Output has the same shape as `youtube_get_transcript` (`video_id: null`,
  `source: "local_whisper"`, `full_text`, `segments` with `text/start/duration`), plus
  `file`, `duration_total`, and `model` / `device` / `compute_type` / `elapsed_seconds`.

Model: faster-whisper `small` by default (`YOUTUBE_MCP_WHISPER_MODEL` to change it),
loaded on the first call and kept in memory; `vad_filter` on. It runs on the GPU
(`cuda`, `float16`) when there is one and on the CPU (`int8`) otherwise, and falls back
to the CPU if the GPU fails at run time. The first call downloads the model (~500 MB
for `small`) from Hugging Face.

GPU on Windows needs cuBLAS 12, which ctranslate2 does not ship: `pip install -e ".[gpu]"`
(installs `nvidia-cublas-cu12`). `av` is pinned below 19 because faster-whisper 1.2.1
uses an `av.open()` argument that PyAV 19 removed.

### Analytics — Performance (4 tools)

| Tool | Description |
|------|-------------|
| `youtube_analytics_overview` | Channel summary (views, watch time, subs, likes) |
| `youtube_analytics_top_videos` | Top videos by views (excludes Shorts) |
| `youtube_analytics_top_shorts` | Top Shorts by views |
| `youtube_analytics_video_detail` | Daily metrics for a specific video |

### Analytics — Audience (3 tools)

| Tool | Description |
|------|-------------|
| `youtube_analytics_traffic_sources` | Traffic source breakdown |
| `youtube_analytics_demographics` | Age and gender breakdown |
| `youtube_analytics_geography` | Views by country |

### Analytics — Schedule & Reach (3 tools)

| Tool | Description |
|------|-------------|
| `youtube_analytics_daily` | Daily performance over time |
| `youtube_analytics_day_of_week` | Average performance by weekday |
| `youtube_analytics_content_type_breakdown` | Shorts vs long-form vs live comparison |

### Analytics — Revenue & Retention (3 tools)

| Tool | Description |
|------|-------------|
| `youtube_analytics_revenue` | Revenue breakdown (requires YouTube Partner Program) |
| `youtube_analytics_revenue_by_video` | Per-video revenue |
| `youtube_analytics_retention` | Audience retention curve for a video |

### Publishing (4 tools)

| Tool | Description |
|------|-------------|
| `youtube_upload_video` | Resumable upload with retries; validates `publish_at` (ISO 8601 with timezone, private only) and the 500-char tag limit. Own quota bucket: 100 uploads/day |
| `youtube_update_video` | Update metadata, privacy and `publish_at` (reschedule) |
| `youtube_set_thumbnail` | Upload custom thumbnail (max 2 MB) |
| `youtube_delete_video` | Delete a video. Irreversible: does nothing unless `confirm=True` |

### Playlists (4 tools)

| Tool | Description |
|------|-------------|
| `youtube_list_playlists` | List playlists for a channel |
| `youtube_create_playlist` | Create a new playlist |
| `youtube_add_to_playlist` | Add a video to a playlist |
| `youtube_remove_from_playlist` | Remove a video from a playlist |

### Comments (3 tools)

| Tool | Description |
|------|-------------|
| `youtube_list_comments` | List comments on a video |
| `youtube_post_comment` | Post a top-level comment |
| `youtube_reply_to_comment` | Reply to a comment |

### Bulk Reporting (5 tools)

| Tool | Description |
|------|-------------|
| `youtube_reporting_list_types` | List available report types |
| `youtube_reporting_create_job` | Schedule a daily report job |
| `youtube_reporting_list_jobs` | List active reporting jobs |
| `youtube_reporting_list_reports` | List generated reports for a job |
| `youtube_reporting_download` | Download a report CSV (only `https://*.googleapis.com` URLs: the OAuth token never goes anywhere else) |

## Quota Management

Google splits the YouTube Data API v3 quota into three independent per-project, per-day buckets ([official table](https://developers.google.com/youtube/v3/determine_quota_cost)):

| Bucket | Default limit | What draws from it |
|---|---|---|
| `general` | 10,000 units/day | Everything else: reads 1 unit, writes 50, `captions.list` 50, `captions.insert` 400, `captions.update` 450 |
| `search` | 100 calls/day | `search.list` (`youtube_search`) |
| `video_insert` | 100 calls/day | `videos.insert` (`youtube_upload_video`) |

The Analytics and Reporting APIs do not consume this quota.

This server tracks usage client-side, **before** each call, and hard-fails when a bucket is exhausted. The counters are persisted in `<config dir>/quota.json`, so they survive restarts, and they reset at midnight Pacific Time like Google's. `captions.download` is not listed in Google's table; it is counted as 50 units.

Use `youtube_auth_status` to check current usage per bucket.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `YOUTUBE_MCP_CLIENT_SECRET` | Path to `client_secret.json` |
| `YOUTUBE_MCP_CONFIG_DIR` | Config directory for tokens and `quota.json` (default: `~/.youtube-mcp`) |
| `YOUTUBE_MCP_PROFILE` | Channel profile to load at startup (default: `default`) |
| `YOUTUBE_MCP_ALLOWED_DIRS` | Folders the server may read files from, `path[=lang]` separated by `;` (required for uploads, thumbnails and `transcribe_local`) |
| `YOUTUBE_MCP_WHISPER_MODEL` | Whisper model for `transcribe_local` (default: `small`) |

## Development

```bash
git clone https://github.com/pauling-ai/youtube-studio-mcp.git
cd youtube-studio-mcp
uv sync --extra dev      # reproduces uv.lock exactly
uv run pytest -q
```

## License

MIT
