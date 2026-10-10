"""Tests de los almacenes de secretos: ficheros y keyring (con backend en memoria)."""

import keyring
import keyring.backend
import pytest

from youtube_mcp.secrets import FileSecretStore, KeyringSecretStore


class MemoryKeyring(keyring.backend.KeyringBackend):
    priority = 1

    def __init__(self):
        self.data: dict[tuple[str, str], str] = {}

    def get_password(self, service, username):
        return self.data.get((service, username))

    def set_password(self, service, username, password):
        self.data[(service, username)] = password

    def delete_password(self, service, username):
        if (service, username) not in self.data:
            raise keyring.errors.PasswordDeleteError(username)
        del self.data[(service, username)]


@pytest.fixture
def memoria(monkeypatch):
    backend = MemoryKeyring()
    monkeypatch.setattr(keyring, "get_password", backend.get_password)
    monkeypatch.setattr(keyring, "set_password", backend.set_password)
    monkeypatch.setattr(keyring, "delete_password", backend.delete_password)
    return backend


class TestFileSecretStore:
    def test_layout_compatible(self, tmp_path):
        store = FileSecretStore(tmp_path)
        store.set("token:default", "a")
        store.set("token:smooth", "b")
        store.set("client_secret", "c")
        assert (tmp_path / "token.json").read_text() == "a"
        assert (tmp_path / "token-smooth.json").read_text() == "b"
        assert (tmp_path / "client_secret.json").read_text() == "c"
        (tmp_path / "quota.json").write_text("{}")  # estado, no secreto
        assert store.keys() == ["client_secret", "token:default", "token:smooth"]
        store.delete("token:smooth")
        assert store.get("token:smooth") is None
        store.delete("token:smooth")  # idempotente

    def test_missing_dir(self, tmp_path):
        store = FileSecretStore(tmp_path / "nope")
        assert store.keys() == []
        assert store.get("token:default") is None


class TestKeyringSecretStore:
    def test_roundtrip_chunked(self, memoria):
        store = KeyringSecretStore(service="test-svc")
        valor = "x" * 3500  # supera el limite del Credential Manager: 4 trozos
        store.set("token:default", valor)
        assert store.get("token:default") == valor
        assert len([k for k in memoria.data if k[1].startswith("token:default#")]) == 4
        assert store.keys() == ["token:default"]

    def test_overwrite_shorter_cleans_old_chunks(self, memoria):
        store = KeyringSecretStore(service="test-svc")
        store.set("k", "y" * 2500)
        store.set("k", "corto")
        assert store.get("k") == "corto"
        assert [u for (_, u) in memoria.data if u.startswith("k#")] == ["k#0"]

    def test_delete_and_missing(self, memoria):
        store = KeyringSecretStore(service="test-svc")
        assert store.get("nada") is None
        store.set("k", "v")
        store.delete("k")
        assert store.get("k") is None
        assert store.keys() == []
        store.delete("k")  # idempotente

    def test_empty_value(self, memoria):
        store = KeyringSecretStore(service="test-svc")
        store.set("k", "")
        assert store.get("k") == ""

    def test_isolated_by_service(self, memoria):
        KeyringSecretStore(service="a").set("k", "1")
        assert KeyringSecretStore(service="b").get("k") is None
