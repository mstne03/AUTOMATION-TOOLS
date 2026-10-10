"""Almacenes de secretos: tokens OAuth, client_secret.json y otras claves.

Interfaz minima sobre cadenas (``get`` / ``set`` / ``delete`` / ``keys``) con dos
implementaciones:

- ``FileSecretStore``: JSON en claro dentro de ``config_dir``, con el mismo layout
  de siempre (``token.json``, ``token-<perfil>.json``, ``client_secret.json``).
  Para tests y para quien siga usando la fachada MCP a mano.
- ``KeyringSecretStore``: ``keyring``, que en Windows es el Credential Manager
  (cifrado DPAPI ligado a la sesion del usuario). Es el almacen del producto.

Claves usadas por ``youtube_mcp.auth``: ``token:<perfil>`` y ``client_secret``.
"""

import json
from pathlib import Path
from typing import Protocol


class SecretStore(Protocol):
    def get(self, key: str) -> str | None: ...
    def set(self, key: str, value: str) -> None: ...
    def delete(self, key: str) -> None: ...
    def keys(self) -> list[str]: ...


# ----------------------------------------------------------------------- fichero


def secret_file(config_dir: Path, key: str) -> Path:
    """Ruta del fichero que guarda ``key`` en el almacen de ficheros."""
    if key == "token:default":
        return config_dir / "token.json"
    if key.startswith("token:"):
        return config_dir / f"token-{key[len('token:'):]}.json"
    return config_dir / f"{key}.json"


def _key_of(path: Path) -> str | None:
    if path.name == "token.json":
        return "token:default"
    if path.name.startswith("token-"):
        return f"token:{path.stem[len('token-'):]}"
    if path.name.startswith("quota"):
        return None  # estado, no secreto
    return path.stem


class FileSecretStore:
    def __init__(self, config_dir: str | Path):
        self.config_dir = Path(config_dir)

    def get(self, key: str) -> str | None:
        path = secret_file(self.config_dir, key)
        return path.read_text(encoding="utf-8") if path.is_file() else None

    def set(self, key: str, value: str) -> None:
        self.config_dir.mkdir(parents=True, exist_ok=True)
        secret_file(self.config_dir, key).write_text(value, encoding="utf-8")

    def delete(self, key: str) -> None:
        secret_file(self.config_dir, key).unlink(missing_ok=True)

    def keys(self) -> list[str]:
        if not self.config_dir.is_dir():
            return []
        claves = (_key_of(p) for p in self.config_dir.glob("*.json"))
        return sorted(k for k in claves if k)


# ----------------------------------------------------------------------- keyring

# CredWrite admite 2560 bytes de blob y pywin32 lo guarda en UTF-16: 1280 caracteres.
# Troceamos por debajo de ese limite; cada trozo es una credencial ``<clave>#<n>``.
_CHUNK = 1000
_INDEX = "__index__"


class KeyringSecretStore:
    def __init__(self, service: str = "youtube-mcp"):
        import keyring  # import perezoso: el almacen de ficheros no lo necesita

        self._kr = keyring
        self.service = service

    def _index(self) -> dict[str, int]:
        raw = self._kr.get_password(self.service, _INDEX)
        return json.loads(raw) if raw else {}

    def _save_index(self, index: dict[str, int]) -> None:
        self._kr.set_password(self.service, _INDEX, json.dumps(index))

    def _borrar_trozos(self, key: str, n: int) -> None:
        for i in range(n):
            try:
                self._kr.delete_password(self.service, f"{key}#{i}")
            except self._kr.errors.PasswordDeleteError:
                pass

    def get(self, key: str) -> str | None:
        n = self._index().get(key)
        if n is None:
            return None
        trozos = [self._kr.get_password(self.service, f"{key}#{i}") for i in range(n)]
        if any(t is None for t in trozos):
            return None  # entrada incompleta (borrada a mano): tratar como ausente
        return "".join(trozos)

    def set(self, key: str, value: str) -> None:
        index = self._index()
        self._borrar_trozos(key, index.get(key, 0))
        trozos = [value[i : i + _CHUNK] for i in range(0, len(value), _CHUNK)] or [""]
        for i, trozo in enumerate(trozos):
            self._kr.set_password(self.service, f"{key}#{i}", trozo)
        index[key] = len(trozos)
        self._save_index(index)

    def delete(self, key: str) -> None:
        index = self._index()
        self._borrar_trozos(key, index.pop(key, 0))
        self._save_index(index)

    def keys(self) -> list[str]:
        return sorted(self._index())
