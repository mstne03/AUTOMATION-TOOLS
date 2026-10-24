"""Tests for auth module."""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from youtube_mcp.auth import AuthError, YouTubeAuth

CLIENT_SECRET = '{"installed": {"client_id": "id", "client_secret": "s", "auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": "https://oauth2.googleapis.com/token"}}'


class DictStore:
    """SecretStore en memoria para los tests."""

    def __init__(self):
        self.data: dict[str, str] = {}

    def get(self, key):
        return self.data.get(key)

    def set(self, key, value):
        self.data[key] = value

    def delete(self, key):
        self.data.pop(key, None)

    def keys(self):
        return sorted(self.data)


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


class TestStatusConTokenCaducado:
    """El token de acceso caduca a la hora; con token de refresco el canal sigue autorizado."""

    @staticmethod
    def _caducado(tmp_path, refresh_side_effect=None):
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        creds = MagicMock(valid=False, expired=True, refresh_token="r", scopes=["s"])
        creds.to_json.return_value = '{"renovado": true}'
        creds.refresh.side_effect = refresh_side_effect
        return yt_auth, creds

    def test_se_renueva_y_cuenta_como_autorizado(self, tmp_path):
        yt_auth, creds = self._caducado(tmp_path)
        with patch.object(yt_auth, "_load_token", return_value=creds):
            status = yt_auth.status()
        assert status["authenticated"] is True
        creds.refresh.assert_called_once()
        assert yt_auth.store.get("token:default") == '{"renovado": true}'  # el token nuevo se guarda

    def test_si_google_rechaza_el_refresco_no_esta_autorizado_y_dice_por_que(self, tmp_path):
        from google.auth.exceptions import RefreshError

        yt_auth, creds = self._caducado(tmp_path, RefreshError("invalid_grant: Token has been expired or revoked."))
        with patch.object(yt_auth, "_load_token", return_value=creds):
            status = yt_auth.status()
        assert status["authenticated"] is False
        assert "vuelve a autorizar" in status["reason"]

    def test_sin_red_no_se_da_por_perdida_la_autorizacion(self, tmp_path):
        from google.auth.exceptions import TransportError

        yt_auth, creds = self._caducado(tmp_path, TransportError("sin conexión"))
        with patch.object(yt_auth, "_load_token", return_value=creds):
            status = yt_auth.status()
        assert status["authenticated"] is True
        assert status["unverified"] is True

    def test_sin_token_de_refresco_no_esta_autorizado(self, tmp_path):
        yt_auth, creds = self._caducado(tmp_path)
        creds.refresh_token = None
        with patch.object(yt_auth, "_load_token", return_value=creds):
            status = yt_auth.status()
        assert status["authenticated"] is False
        creds.refresh.assert_not_called()


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
    secret.write_text(CLIENT_SECRET)
    yt_auth = YouTubeAuth(config_dir=tmp_path, client_secret_path=secret)
    nuevo = MagicMock(valid=True)
    nuevo.to_json.return_value = "{}"
    with patch.object(yt_auth, "_load_token") as load, patch(
        "youtube_mcp.auth.InstalledAppFlow"
    ) as flow:
        flow.from_client_config.return_value.run_local_server.return_value = nuevo
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


class TestInjectedStore:
    def test_token_roundtrip_and_profiles(self, tmp_path):
        store = DictStore()
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=store)
        creds = MagicMock()
        creds.to_json.return_value = json.dumps({"token": "t", "refresh_token": "r"})
        yt_auth._save_token(creds)
        yt_auth.use_profile("smooth")
        yt_auth._save_token(creds)
        assert store.keys() == ["token:default", "token:smooth"]
        assert not list(tmp_path.glob("*.json"))  # nada en disco
        assert yt_auth.profiles() == ["default", "smooth"]
        assert yt_auth.status()["store"] == "DictStore"
        yt_auth.delete_token("smooth")
        assert yt_auth.profiles() == ["default"]

    def test_client_secret_from_store_used_in_flow(self, tmp_path):
        store = DictStore()
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=store)
        yt_auth.import_client_secret(CLIENT_SECRET)
        assert yt_auth.has_client_secret()
        nuevo = MagicMock(valid=True)
        nuevo.to_json.return_value = "{}"
        with patch("youtube_mcp.auth.InstalledAppFlow") as flow:
            flow.from_client_config.return_value.run_local_server.return_value = nuevo
            yt_auth.authenticate(interactive=True)
        flow.from_client_config.assert_called_once()
        assert flow.from_client_config.call_args.args[0]["installed"]["client_id"] == "id"
        assert store.get("token:default") == "{}"

    def test_import_client_secret_rejects_garbage(self, tmp_path):
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        with pytest.raises(AuthError, match="'installed' or 'web'"):
            yt_auth.import_client_secret("{}")
        with pytest.raises(AuthError, match="not valid JSON"):
            yt_auth.import_client_secret("{nope")


CLIENTE_B = json.dumps(
    {
        "installed": {
            "client_id": "123456789012-abcdefghwxyz.apps.googleusercontent.com",
            "client_secret": "s2",
            "project_id": "proyecto-b",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }
)


def _token(client_id: str) -> str:
    """Token guardado válido (caduca en 2099) emitido para `client_id`."""
    return json.dumps({"token": "t", "refresh_token": "r", "client_id": client_id, "client_secret": "s", "token_uri": "https://oauth2.googleapis.com/token", "expiry": "2099-01-01T00:00:00Z"})


class TestProyectoUnico:
    """Un solo proyecto de Google (client_secret) para toda la app; un token por canal (perfil)."""

    def test_muestra_el_proyecto_y_el_cliente_enmascarado(self, tmp_path):
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        assert yt_auth.client_info() is None
        yt_auth.import_client_secret(CLIENTE_B)
        assert yt_auth.client_info() == {"project_id": "proyecto-b", "client_id": "123456…wxyz"}

    def test_volver_a_importar_el_mismo_no_desautoriza_nada(self, tmp_path):
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        yt_auth.import_client_secret(CLIENT_SECRET)
        yt_auth.store.set("token:default", _token("id"))
        assert yt_auth.import_client_secret(CLIENT_SECRET) == {"mismo": True, "desautorizados": []}
        assert yt_auth.profiles() == ["default"]

    def test_otro_proyecto_con_canales_autorizados_pide_confirmacion(self, tmp_path):
        from youtube_mcp.auth import ClientSecretConflict

        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        yt_auth.import_client_secret(CLIENT_SECRET)
        yt_auth.store.set("token:default", _token("id"))
        yt_auth.store.set("token:smooth", _token("id"))
        with pytest.raises(ClientSecretConflict) as e:
            yt_auth.import_client_secret(CLIENTE_B)
        assert e.value.afectados == ["default", "smooth"]
        assert yt_auth.client_info()["project_id"] is None  # sigue el anterior (sin project_id)

    def test_sustituir_confirmado_desautoriza_todos_los_canales(self, tmp_path):
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        yt_auth.import_client_secret(CLIENT_SECRET)
        yt_auth.store.set("token:default", _token("id"))
        yt_auth.store.set("canal:default", '{"id": "UC1", "title": "Canal A", "handle": "@a"}')
        r = yt_auth.import_client_secret(CLIENTE_B, replace=True)
        assert r == {"mismo": False, "desautorizados": ["default"]}
        assert yt_auth.profiles() == []
        assert yt_auth.store.get("canal:default") is None
        assert yt_auth.client_info()["project_id"] == "proyecto-b"

    def test_un_token_de_otro_proyecto_no_cuenta_como_autorizado(self, tmp_path):
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        yt_auth.store.set("client_secret", CLIENTE_B)  # p. ej. sustituido por fuera de la app
        yt_auth.store.set("token:default", _token("id"))
        status = yt_auth.status()
        assert status["authenticated"] is False
        assert "otro proyecto" in status["reason"]

    def test_recuerda_el_canal_autorizado_de_cada_perfil(self, tmp_path):
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        yt_auth.store.set("token:default", _token("id"))  # solo se muestran canales con token
        servicio = MagicMock()
        servicio.channels().list().execute.return_value = {"items": [{"id": "UC1", "snippet": {"title": "Canal A", "customUrl": "@a"}}]}
        with patch.object(yt_auth, "build_youtube_service", return_value=servicio):
            canal = yt_auth.remember_channel()
        assert canal == {"id": "UC1", "title": "Canal A", "handle": "@a"}
        status = yt_auth.status()
        assert status["channel"] == canal
        assert status["channels"] == {"default": canal}

    def test_eliminar_el_proyecto_desautoriza_todo(self, tmp_path):
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        yt_auth.import_client_secret(CLIENT_SECRET)
        yt_auth.store.set("token:default", _token("id"))
        assert yt_auth.remove_client_secret() == ["default"]
        assert not yt_auth.has_client_secret()
        assert yt_auth.profiles() == []

    @pytest.mark.parametrize(
        "error, esperado",
        [
            ("(access_denied) access_denied", "usuario de prueba"),
            ("(invalid_client) The OAuth client was not found.", "no reconoce el cliente OAuth"),
            ("(redirect_uri_mismatch) Bad Request", "Aplicación de escritorio"),
        ],
    )
    def test_los_errores_de_google_se_explican(self, tmp_path, error, esperado):
        yt_auth = YouTubeAuth(config_dir=tmp_path, store=DictStore())
        yt_auth.import_client_secret(CLIENT_SECRET)
        with patch("youtube_mcp.auth.InstalledAppFlow") as flow:
            flow.from_client_config.return_value.run_local_server.side_effect = Exception(error)
            with pytest.raises(AuthError, match=esperado):
                yt_auth.authenticate(interactive=True)


class TestFlujoInterrumpido:
    """El usuario cierra la pestaña de Google: run_local_server no debe esperar para siempre."""

    @staticmethod
    def _autorizar_en_hilo(tmp_path):
        import threading
        import time

        secret = tmp_path / "client_secret.json"
        secret.write_text(CLIENT_SECRET)
        yt_auth = YouTubeAuth(config_dir=tmp_path, client_secret_path=secret, store=DictStore())
        resultado: dict = {}

        def autorizar():
            try:
                yt_auth.authenticate(interactive=True, force_consent=True)
            except AuthError as e:
                resultado["error"] = str(e)

        hilo = threading.Thread(target=autorizar, daemon=True)
        hilo.start()
        limite = time.monotonic() + 5  # hasta que el servidor local escucha y el "navegador" se abre
        while getattr(yt_auth, "_en_curso", None) is None and time.monotonic() < limite:
            time.sleep(0.05)
        return yt_auth, hilo, resultado

    def test_cancelar_corta_el_flujo_en_curso(self, tmp_path):
        with patch("google_auth_oauthlib.flow.webbrowser"):  # nadie visita la URL de Google
            yt_auth, hilo, resultado = self._autorizar_en_hilo(tmp_path)
            assert yt_auth.cancel_interactive() is True
            hilo.join(5)
        assert not hilo.is_alive()
        assert "cancelada" in resultado["error"]
        assert yt_auth.cancel_interactive() is False  # ya no queda ninguno en curso

    def test_sin_respuesta_de_google_se_rinde_al_cabo_del_limite(self, tmp_path, monkeypatch):
        monkeypatch.setattr("youtube_mcp.auth.OAUTH_TIMEOUT_S", 1)
        with patch("google_auth_oauthlib.flow.webbrowser"):
            _, hilo, resultado = self._autorizar_en_hilo(tmp_path)
            hilo.join(5)
        assert not hilo.is_alive()
        assert "no respondió" in resultado["error"]


def test_alta_de_canal_fallida_no_deja_en_uso_el_perfil_nuevo():
    from youtube_mcp import server

    server.auth.use_profile("default")
    with patch.object(server.auth, "authenticate", side_effect=AuthError("Autorización cancelada.")):
        r = server.youtube_auth(profile="smooth", reauthorize=True)
    assert r == {"status": "error", "detail": "Autorización cancelada."}
    assert server.auth.profile == "default"


def test_al_autorizar_recuerda_el_canal_y_avisa_si_ya_esta_en_otro_perfil(monkeypatch):
    from youtube_mcp import server

    monkeypatch.setattr(server.auth, "store", DictStore())
    server.auth.use_profile("default")
    server.auth.import_client_secret(CLIENT_SECRET)
    canal = {"id": "UC1", "title": "Canal A", "handle": "@a"}
    for perfil in ("default", "otro"):
        server.auth.store.set(f"token:{perfil}", _token("id"))
    server.auth.store.set("canal:otro", json.dumps(canal))  # el mismo canal ya estaba en "otro"

    def recordar():
        server.auth.store.set("canal:default", json.dumps(canal))
        return canal

    with patch.object(server.auth, "authenticate"), patch.object(server.auth, "remember_channel", side_effect=recordar):
        r = server.youtube_auth()
    assert r["status"] == "authenticated"
    assert r["duplicated_in"] == ["otro"]
