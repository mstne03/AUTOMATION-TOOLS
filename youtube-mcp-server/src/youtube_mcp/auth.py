"""OAuth 2.0 authentication for YouTube APIs.

Users must provide their own client_secret.json from their Google Cloud project.
The browser consent flow only runs when the `youtube_auth` tool is called
explicitly (`interactive=True`): no other tool may open a browser from inside
the server process. If a token cannot be refreshed, the tools get a clear
AuthError telling the user to re-authorise.

Profiles: one token per YouTube channel. The default profile stores its token in
``token.json``; profile ``smooth`` uses ``token-smooth.json``, and so on. Pick the
startup profile with ``YOUTUBE_MCP_PROFILE`` and switch at runtime with
``youtube_auth(profile=...)``.
"""

import os
import re
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# All scopes we need across all phases
SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
    # Needed for captions.list / captions.download (official transcripts)
    "https://www.googleapis.com/auth/youtube.force-ssl",
]

DEFAULT_CONFIG_DIR = Path.home() / ".youtube-mcp"
DEFAULT_PROFILE = "default"
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


class AuthError(Exception):
    pass


class YouTubeAuth:
    """Manages OAuth 2.0 credentials and builds API service clients."""

    def __init__(
        self,
        client_secret_path: str | Path | None = None,
        config_dir: str | Path | None = None,
        profile: str | None = None,
    ):
        self.config_dir = Path(config_dir) if config_dir else DEFAULT_CONFIG_DIR
        self._credentials: Credentials | None = None
        self.use_profile(profile or os.environ.get("YOUTUBE_MCP_PROFILE") or DEFAULT_PROFILE)

        # Resolve client_secret.json path
        if client_secret_path:
            self.client_secret_path = Path(client_secret_path)
        else:
            env_path = os.environ.get("YOUTUBE_MCP_CLIENT_SECRET")
            if env_path:
                self.client_secret_path = Path(env_path)
            else:
                self.client_secret_path = self.config_dir / "client_secret.json"

    # ---------------------------------------------------------------- perfiles

    def use_profile(self, profile: str) -> None:
        """Switch the active channel profile. Drops in-memory credentials."""
        profile = (profile or "").strip().lower()
        if not _PROFILE_RE.match(profile):
            raise AuthError(
                f"Invalid profile name '{profile}': use letters, digits, '-' or '_' (max 32)."
            )
        self.profile = profile
        self.token_path = self.config_dir / (
            "token.json" if profile == DEFAULT_PROFILE else f"token-{profile}.json"
        )
        self._credentials = None

    def profiles(self) -> list[str]:
        """Profiles that already have a saved token."""
        if not self.config_dir.is_dir():
            return []
        nombres = []
        for p in sorted(self.config_dir.glob("token*.json")):
            if p.name == "token.json":
                nombres.append(DEFAULT_PROFILE)
            elif p.name.startswith("token-"):
                nombres.append(p.stem[len("token-"):])
        return sorted(nombres, key=lambda n: (n != DEFAULT_PROFILE, n))

    # ------------------------------------------------------------------- token

    def _load_token(self) -> Credentials | None:
        """Load saved credentials from token file."""
        if not self.token_path.exists():
            return None
        try:
            return Credentials.from_authorized_user_file(str(self.token_path), SCOPES)
        except Exception:
            return None

    def _save_token(self, creds: Credentials):
        """Save credentials to token file."""
        # TODO Fase 1: keyring (Windows Credential Manager) en vez de JSON en claro.
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.token_path.write_text(creds.to_json())

    def authenticate(self, interactive: bool = False, force_consent: bool = False) -> Credentials:
        """Return valid credentials for the active profile.

        - Reuses the saved token, refreshing it if expired.
        - `interactive=True` (only the `youtube_auth` tool) may open the browser
          consent flow when there is no usable token.
        - `force_consent=True` ignores the saved token and runs the flow again
          (needed when scopes change or the token was revoked).

        Raises AuthError when not interactive and no valid token is available.
        """
        creds = None if force_consent else self._load_token()

        if creds and creds.valid:
            self._credentials = creds
            return creds

        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                self._save_token(creds)
                self._credentials = creds
                return creds
            except Exception as e:
                if not interactive:
                    raise AuthError(
                        f"Token refresh failed for profile '{self.profile}' "
                        f"({type(e).__name__}: {e}). Run youtube_auth to re-authorise."
                    ) from e

        if not interactive:
            raise AuthError(
                f"Not authenticated for profile '{self.profile}'. Run youtube_auth first."
            )

        if not self.client_secret_path.exists():
            raise AuthError(
                f"client_secret.json not found at {self.client_secret_path}. "
                f"Download it from your Google Cloud Console "
                f"(APIs & Services > Credentials > OAuth 2.0 Client IDs) "
                f"and place it at this path, or set YOUTUBE_MCP_CLIENT_SECRET env var."
            )

        try:
            flow = InstalledAppFlow.from_client_secrets_file(
                str(self.client_secret_path), SCOPES
            )
            creds = flow.run_local_server(port=0)
            self._save_token(creds)
            self._credentials = creds
            return creds
        except Exception as e:
            raise AuthError(f"OAuth flow failed: {e}") from e

    @property
    def credentials(self) -> Credentials:
        """Current credentials, refreshed if needed. Never opens a browser."""
        if self._credentials and self._credentials.valid:
            return self._credentials
        return self.authenticate(interactive=False)

    # ---------------------------------------------------------------- clientes

    def build_youtube_service(self):
        """Build a YouTube Data API v3 service client."""
        return build("youtube", "v3", credentials=self.credentials, cache_discovery=False)

    def build_youtube_analytics_service(self):
        """Build a YouTube Analytics API service client."""
        return build(
            "youtubeAnalytics", "v2", credentials=self.credentials, cache_discovery=False
        )

    def build_youtube_reporting_service(self):
        """Build a YouTube Reporting API service client."""
        return build(
            "youtubereporting", "v1", credentials=self.credentials, cache_discovery=False
        )

    def status(self) -> dict:
        """Return current auth status."""
        base = {"profile": self.profile, "profiles": self.profiles()}
        creds = self._load_token()
        if creds and creds.valid:
            return {
                **base,
                "authenticated": True,
                "scopes": creds.scopes or [],
                "token_path": str(self.token_path),
                "expired": False,
            }
        if creds and creds.expired:
            return {
                **base,
                "authenticated": False,
                "expired": True,
                "has_refresh_token": bool(creds.refresh_token),
                "token_path": str(self.token_path),
            }
        return {
            **base,
            "authenticated": False,
            "token_exists": self.token_path.exists(),
            "client_secret_exists": self.client_secret_path.exists(),
            "client_secret_path": str(self.client_secret_path),
        }
