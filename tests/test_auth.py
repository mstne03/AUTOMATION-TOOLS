"""Tests for auth module."""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from youtube_mcp.auth import AuthError, YouTubeAuth


def test_default_config_dir(monkeypatch):
    monkeypatch.delenv("YOUTUBE_MCP_PROFILE", raising=False)
    yt_auth = YouTubeAuth()
    assert yt_auth.config_dir == Path.home() / ".youtube-mcp"
    assert yt_auth.token_path == Path.home() / ".youtube-mcp" / "token.json"


def test_custom_config_dir(tmp_path):
    yt_auth = YouTubeAuth(config_dir=tmp_path)
    assert yt_auth.config_dir == tmp_path
    assert yt_auth.token_path == tmp_path / "token.json"


def test_client_secret_from_env(tmp_path, monkeypatch):
    secret_path = tmp_path / "my_secret.json"
    monkeypatch.setenv("YOUTUBE_MCP_CLIENT_SECRET", str(secret_path))
    yt_auth = YouTubeAuth()
    assert yt_auth.client_secret_path == secret_path


def test_client_secret_explicit_overrides_env(tmp_path, monkeypatch):
    monkeypatch.setenv("YOUTUBE_MCP_CLIENT_SECRET", "/env/path.json")
    explicit = tmp_path / "explicit.json"
    yt_auth = YouTubeAuth(client_secret_path=explicit)
    assert yt_auth.client_secret_path == explicit


def test_status_no_token(tmp_path):
    yt_auth = YouTubeAuth(config_dir=tmp_path)
    status = yt_auth.status()
    assert status["authenticated"] is False
    assert status["token_exists"] is False
    assert status["profile"] == "default"
    assert status["profiles"] == []


def test_authenticate_missing_client_secret(tmp_path):
    yt_auth = YouTubeAuth(
        config_dir=tmp_path,
        client_secret_path=tmp_path / "nonexistent.json",
    )
    with pytest.raises(AuthError, match="client_secret.json not found"):
        yt_auth.authenticate(interactive=True)


def test_non_interactive_never_opens_browser(tmp_path):
    """Sin token y sin interactive=True: error claro, nunca el flujo de navegador."""
    yt_auth = YouTubeAuth(config_dir=tmp_path)
    with patch("youtube_mcp.auth.InstalledAppFlow") as flow:
        with pytest.raises(AuthError, match="Run youtube_auth first"):
            yt_auth.credentials
    flow.from_client_secrets_file.assert_not_called()


def test_refresh_failure_is_reported_not_swallowed(tmp_path):
    yt_auth = YouTubeAuth(config_dir=tmp_path)
    creds = MagicMock(valid=False, expired=True, refresh_token="r")
    creds.refresh.side_effect = RuntimeError("invalid_scope")
    with patch.object(yt_auth, "_load_token", return_value=creds), patch(
        "youtube_mcp.auth.InstalledAppFlow"
    ) as flow:
        with pytest.raises(AuthError, match="Token refresh failed.*invalid_scope"):
            yt_auth.authenticate()
    flow.from_client_secrets_file.assert_not_called()


def test_force_consent_ignores_saved_token(tmp_path):
    secret = tmp_path / "client_secret.json"
    secret.write_text("{}")
    yt_auth = YouTubeAuth(config_dir=tmp_path, client_secret_path=secret)
    nuevo = MagicMock(valid=True)
    nuevo.to_json.return_value = "{}"
    with patch.object(yt_auth, "_load_token") as load, patch(
        "youtube_mcp.auth.InstalledAppFlow"
    ) as flow:
        flow.from_client_secrets_file.return_value.run_local_server.return_value = nuevo
        assert yt_auth.authenticate(interactive=True, force_consent=True) is nuevo
    load.assert_not_called()


def test_load_and_save_token(tmp_path):
    yt_auth = YouTubeAuth(config_dir=tmp_path)

    mock_creds = MagicMock()
    mock_creds.to_json.return_value = json.dumps({
        "token": "test-token",
        "refresh_token": "test-refresh",
        "client_id": "test-client-id",
        "client_secret": "test-client-secret",
    })

    yt_auth._save_token(mock_creds)
    assert (tmp_path / "token.json").exists()


class TestProfiles:
    def test_profile_from_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("YOUTUBE_MCP_PROFILE", "smooth")
        yt_auth = YouTubeAuth(config_dir=tmp_path)
        assert yt_auth.profile == "smooth"
        assert yt_auth.token_path == tmp_path / "token-smooth.json"

    def test_switch_profile_drops_credentials(self, tmp_path):
        yt_auth = YouTubeAuth(config_dir=tmp_path)
        yt_auth._credentials = MagicMock(valid=True)
        yt_auth.use_profile("Candisito")
        assert yt_auth.profile == "candisito"
        assert yt_auth.token_path == tmp_path / "token-candisito.json"
        assert yt_auth._credentials is None

    def test_lists_saved_profiles(self, tmp_path):
        (tmp_path / "token.json").write_text("{}")
        (tmp_path / "token-smooth.json").write_text("{}")
        (tmp_path / "token-candisito.json").write_text("{}")
        assert YouTubeAuth(config_dir=tmp_path).profiles() == ["default", "candisito", "smooth"]

    @pytest.mark.parametrize("malo", ["", "../x", "a b", "x" * 40])
    def test_rejects_bad_names(self, tmp_path, malo):
        with pytest.raises(AuthError, match="Invalid profile name"):
            YouTubeAuth(config_dir=tmp_path).use_profile(malo)


@pytest.mark.parametrize(
    "method",
    [
        "build_youtube_service",
        "build_youtube_analytics_service",
        "build_youtube_reporting_service",
    ],
)
def test_build_disables_discovery_cache(tmp_path, method):
    """cache_discovery=False evita el aviso 'file_cache is only supported with oauth2client'."""
    yt_auth = YouTubeAuth(config_dir=tmp_path)
    yt_auth._credentials = MagicMock(valid=True)
    with patch("youtube_mcp.auth.build") as mock_build:
        getattr(yt_auth, method)()
    assert mock_build.call_args.kwargs["cache_discovery"] is False
