"""OAuth 2.0 authentication for YouTube APIs.

Users must provide their own client_secret.json from their Google Cloud project.
The browser consent flow only runs when the `youtube_auth` tool is called
explicitly (`interactive=True`): no other tool may open a browser from inside
the server process. If a token cannot be refreshed, the tools get a clear
AuthError telling the user to re-authorise.

Profiles: one token per YouTube channel, stored under ``token:<profile>`` in the
injected ``SecretStore`` (file store by default: ``token.json``,
``token-smooth.json``...; keyring in the product). Pick the startup profile with
``YOUTUBE_MCP_PROFILE`` and switch at runtime with ``youtube_auth(profile=...)``.
"""

import json
import os
import re
import threading
import time
import urllib.request
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from youtube_mcp.secrets import FileSecretStore, SecretStore, secret_file

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
# Espera máxima a que Google redirija al servidor local. Si el usuario cierra la pestaña, sin
# límite el hilo (y la petición que lo lanzó) esperaría para siempre.
OAUTH_TIMEOUT_S = 300


class AuthError(Exception):
    pass


def _validar_client_config(raw: str) -> dict:
    try:
        config = json.loads(raw)
    except ValueError as e:
        raise AuthError(f"client_secret.json is not valid JSON: {e}") from e
    if not isinstance(config, dict) or not ({"installed", "web"} & set(config)):
        raise AuthError("client_secret.json must contain an 'installed' or 'web' section.")
    # Las mismas claves que exige google_auth_oauthlib al arrancar el flujo: si faltan,
    # mejor rechazar el fichero al importarlo que fallar al pulsar "Autorizar".
    seccion = config.get("installed") or config.get("web") or {}
    faltan = sorted({"client_id", "client_secret", "auth_uri", "token_uri"} - set(seccion))
    if faltan:
        raise AuthError(
            f"client_secret.json is incomplete (missing {', '.join(faltan)}). "
            "Download the file from Google Cloud Console > APIs & Services > Credentials "
            "and import it without editing it."
        )
    return config


class YouTubeAuth:
    """Manages OAuth 2.0 credentials and builds API service clients."""

    def __init__(
        self,
        client_secret_path: str | Path | None = None,
        config_dir: str | Path | None = None,
        profile: str | None = None,
        store: SecretStore | None = None,
    ):
        self.config_dir = Path(config_dir) if config_dir else DEFAULT_CONFIG_DIR
        self.store: SecretStore = store or FileSecretStore(self.config_dir)
        self._credentials: Credentials | None = None
        # Flujo de consentimiento en curso y su marca de cancelación (ver cancel_interactive).
        self._en_curso: tuple[InstalledAppFlow, threading.Event] | None = None
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
        self._token_key = f"token:{profile}"
        # Ruta que usaria el almacen de ficheros; informativa con otros almacenes.
        self.token_path = secret_file(self.config_dir, self._token_key)
        self._credentials = None

    def profiles(self) -> list[str]:
        """Profiles that already have a saved token."""
        nombres = [k[len("token:"):] for k in self.store.keys() if k.startswith("token:")]
        return sorted(nombres, key=lambda n: (n != DEFAULT_PROFILE, n))

    # ------------------------------------------------------------------- token

    def _load_token(self) -> Credentials | None:
        """Load saved credentials for the active profile."""
        raw = self.store.get(self._token_key)
        if not raw:
            return None
        try:
            return Credentials.from_authorized_user_info(json.loads(raw), SCOPES)
        except Exception:
            return None

    def _save_token(self, creds: Credentials):
        """Save credentials for the active profile."""
        self.store.set(self._token_key, creds.to_json())

    def delete_token(self, profile: str | None = None) -> None:
        """Forget the saved token of a profile (the active one by default)."""
        self.store.delete(f"token:{profile}" if profile else self._token_key)
        if not profile or profile == self.profile:
            self._credentials = None

    # ----------------------------------------------------------- client_secret

    def _client_config(self) -> dict:
        """client_secret.json from the store, or from ``client_secret_path`` as fallback."""
        raw = self.store.get("client_secret")
        if raw is None and self.client_secret_path.is_file():
            raw = self.client_secret_path.read_text(encoding="utf-8")
        if raw is None:
            raise AuthError(
                f"client_secret.json not found at {self.client_secret_path}. "
                f"Download it from your Google Cloud Console "
                f"(APIs & Services > Credentials > OAuth 2.0 Client IDs) "
                f"and import it (or place it at this path / set YOUTUBE_MCP_CLIENT_SECRET)."
            )
        return _validar_client_config(raw)

    def import_client_secret(self, source: str | Path) -> None:
        """Copy a client_secret.json (path or JSON text) into the secret store."""
        texto = str(source)
        if not texto.lstrip().startswith("{"):
            texto = Path(texto).read_text(encoding="utf-8")
        _validar_client_config(texto)
        self.store.set("client_secret", texto)

    def has_client_secret(self) -> bool:
        return self.store.get("client_secret") is not None or self.client_secret_path.is_file()

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

        config = self._client_config()
        self.cancel_interactive()  # un intento nuevo sustituye al que se quedó esperando
        cancelado = threading.Event()
        try:
            flow = InstalledAppFlow.from_client_config(config, SCOPES)
            self._en_curso = (flow, cancelado)
            creds = flow.run_local_server(port=0, timeout_seconds=OAUTH_TIMEOUT_S)
            if cancelado.is_set():  # Google respondió justo mientras se cancelaba: no se guarda
                raise AuthError("Autorización cancelada.")
            self._save_token(creds)
            self._credentials = creds
            return creds
        except AuthError:
            raise
        except Exception as e:
            if cancelado.is_set():
                raise AuthError("Autorización cancelada.") from e
            # Al agotar timeout_seconds, run_local_server lanza AttributeError (1.2) o su
            # subclase WSGITimeoutError (≥ 1.3): el sidecar y este paquete fijan versiones distintas.
            if isinstance(e, AttributeError):
                raise AuthError(
                    f"Google no respondió en {OAUTH_TIMEOUT_S // 60} minutos: ¿se cerró la pestaña "
                    "del navegador? Vuelve a intentarlo."
                ) from e
            raise AuthError(f"OAuth flow failed: {e}") from e
        finally:
            if self._en_curso is not None and self._en_curso[1] is cancelado:
                self._en_curso = None

    def cancel_interactive(self) -> bool:
        """Corta el flujo de consentimiento en curso (el usuario pulsó Cancelar o cerró la pestaña).

        `run_local_server` no expone su servidor, pero sí la `redirect_uri` en la que escucha: se
        le envía la redirección con `error=access_denied`, `handle_request()` vuelve y el flujo
        falla con "Autorización cancelada". Devuelve False si no había ninguno en curso.
        """
        en_curso = self._en_curso
        if en_curso is None:
            return False
        flow, cancelado = en_curso
        cancelado.set()
        # Si se cancela mientras el servidor local aún arranca, todavía no hay redirect_uri:
        # se espera un poco a que escuche (si no, ese intento acabaría por OAUTH_TIMEOUT_S).
        limite = time.monotonic() + 5
        while not (flow.redirect_uri or "").startswith("http://localhost:") and time.monotonic() < limite:
            if self._en_curso is not en_curso:
                return True  # el flujo ya terminó por su cuenta
            time.sleep(0.05)
        if (flow.redirect_uri or "").startswith("http://localhost:"):
            try:
                urllib.request.urlopen(flow.redirect_uri + "?error=access_denied", timeout=5).close()
            except OSError:
                pass  # el servidor ya se había cerrado (respuesta de Google o límite de tiempo)
        return True

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
        base = {
            "profile": self.profile,
            "profiles": self.profiles(),
            "store": type(self.store).__name__,
        }
        creds = self._load_token()
        if creds and creds.valid:
            return {
                **base,
                "authenticated": True,
                "scopes": creds.scopes or [],
                "expired": False,
            }
        if creds and creds.expired:
            return {
                **base,
                "authenticated": False,
                "expired": True,
                "has_refresh_token": bool(creds.refresh_token),
            }
        return {
            **base,
            "authenticated": False,
            "token_exists": self.store.get(self._token_key) is not None,
            "client_secret_exists": self.has_client_secret(),
            "client_secret_path": str(self.client_secret_path),
        }
