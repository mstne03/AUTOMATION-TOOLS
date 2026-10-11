"""Actualizacion del snapshot publico de la KB con verificacion de firma minisign.

Flujo de `KBUpdater.update()`:

1. Descarga `manifest.json` y `manifest.json.minisig` y verifica la firma ed25519
   con la clave publica embebida. El manifest firmado lleva el SHA-256 del `.sqlite`,
   asi que la firma cubre tambien el fichero de datos.
2. Si el SHA-256 coincide con el del snapshot instalado, no hay nada que hacer.
3. Descarga el `.sqlite` a un temporal dentro del directorio de la KB, comprueba
   tamano y SHA-256 contra el manifest, lo abre en solo lectura y comprueba que
   esta vectorizado con el mismo modelo que usa el cliente y que SQLite lo da por
   integro.
4. Sustituye de forma atomica: el snapshot actual pasa a `.prev` (para `rollback()`)
   y el nuevo ocupa su sitio. Nada se activa sin haber pasado por los pasos 1 a 3.

Seguridad: la URL base y la clave publica vienen de la configuracion, nunca de la
peticion; todo se escribe dentro de `KB_DIR`; el tamano de descarga esta acotado; sin
firma valida el manifest se descarta aunque el hosting este comprometido.

Formato minisign (https://jedisct1.github.io/minisign/): clave publica = base64 de
"Ed" + key_id(8) + pubkey(32). Firma = base64 de alg(2) + key_id(8) + sig(64), donde
alg "Ed" firma el fichero y "ED" firma su BLAKE2b-512 (el formato por defecto de
las versiones actuales). La "trusted comment" va firmada por una segunda firma
global sobre sig + comentario.
"""

import base64
import hashlib
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

MANIFEST = "manifest.json"
SIGNATURE = "manifest.json.minisig"
MAX_DOWNLOAD = 512 * 1024 * 1024
CHECK_INTERVAL = 24 * 3600


class KBUpdateError(Exception):
    """Fallo de actualizacion. El snapshot instalado no se ha tocado."""


# ------------------------------------------------------------------ minisign


def parse_pubkey(pubkey_b64: str) -> tuple[bytes, Ed25519PublicKey]:
    raw = base64.b64decode(pubkey_b64.strip())
    if len(raw) != 42 or raw[:2] != b"Ed":
        raise KBUpdateError("Clave publica minisign con formato invalido.")
    return raw[2:10], Ed25519PublicKey.from_public_bytes(raw[10:])


def verify_minisign(data: bytes, minisig: str, pubkey_b64: str) -> str:
    """Verifica `minisig` sobre `data`. Devuelve la trusted comment si todo es valido."""
    key_id, key = parse_pubkey(pubkey_b64)
    lines = [ln.strip() for ln in minisig.splitlines() if ln.strip()]
    if len(lines) < 4 or not lines[2].startswith("trusted comment:"):
        raise KBUpdateError("Fichero .minisig con formato invalido.")
    try:
        sig_blob = base64.b64decode(lines[1])
        global_sig = base64.b64decode(lines[3])
    except ValueError as e:
        raise KBUpdateError("Firma minisign no es base64.") from e
    if len(sig_blob) != 74 or len(global_sig) != 64:
        raise KBUpdateError("Firma minisign con longitud invalida.")
    alg, sig_key_id, sig = sig_blob[:2], sig_blob[2:10], sig_blob[10:]
    if sig_key_id != key_id:
        raise KBUpdateError("La firma es de otra clave (key id distinto).")
    if alg == b"ED":
        msg = hashlib.blake2b(data, digest_size=64).digest()
    elif alg == b"Ed":
        msg = data
    else:
        raise KBUpdateError(f"Algoritmo minisign desconocido: {alg!r}.")
    trusted = lines[2][len("trusted comment:"):].strip()
    try:
        key.verify(sig, msg)
        key.verify(global_sig, sig + trusted.encode())
    except InvalidSignature as e:
        raise KBUpdateError("Firma minisign invalida.") from e
    return trusted


# ------------------------------------------------------------------- updater


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class KBUpdater:
    def __init__(
        self,
        base_url: str,
        pubkey: str,
        public_path: Path,
        *,
        client: httpx.Client | None = None,
    ):
        if not base_url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
            raise KBUpdateError("KB_UPDATE_URL debe ser https:// (http solo contra 127.0.0.1).")
        self.base_url = base_url.rstrip("/") + "/"
        self.pubkey = pubkey
        self.public_path = Path(public_path)
        self.kb_dir = self.public_path.parent
        self.manifest_path = self.kb_dir / MANIFEST
        self.prev_path = self.public_path.with_suffix(".sqlite.prev")
        self.prev_manifest_path = self.kb_dir / (MANIFEST + ".prev")
        self.state_path = self.kb_dir / "update-state.json"
        self._client = client

    # --------------------------------------------------------------- estado

    def _state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text("utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_state(self, **kw) -> None:
        self.kb_dir.mkdir(parents=True, exist_ok=True)
        state = {**self._state(), **kw}
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), "utf-8")
        os.replace(tmp, self.state_path)

    def installed_manifest(self) -> dict | None:
        try:
            return json.loads(self.manifest_path.read_text("utf-8"))
        except (OSError, ValueError):
            return None

    def estado(self) -> dict:
        m = self.installed_manifest()
        return {
            "instalada": self.public_path.exists(),
            "version": m.get("version") if m else None,
            "exportada": m.get("exported_at") if m else None,
            "documentos": m.get("documents") if m else None,
            "chunks": m.get("chunks") if m else None,
            "anterior_disponible": self.prev_path.exists(),
            "url": self.base_url,
            **self._state(),
        }

    def due(self) -> bool:
        """True si toca comprobar: no hay snapshot o la ultima comprobacion es vieja."""
        if not self.public_path.exists():
            return True
        last = self._state().get("ultima_comprobacion_ts") or 0
        return time.time() - last > CHECK_INTERVAL

    # --------------------------------------------------------------- update

    def update(self) -> dict:
        try:
            result = self._update()
        except (httpx.HTTPError, OSError) as e:
            self._save_state(ultimo_error=f"{type(e).__name__}: {e}")
            raise KBUpdateError(f"No se pudo actualizar la KB: {type(e).__name__}: {e}") from e
        except KBUpdateError as e:
            self._save_state(ultimo_error=str(e))
            raise
        self._save_state(
            ultima_comprobacion=datetime.now(UTC).isoformat(timespec="seconds"),
            ultima_comprobacion_ts=time.time(),
            ultimo_error=None,
        )
        return result

    def _update(self) -> dict:
        manifest_bytes = self._get(MANIFEST, MAX_DOWNLOAD)
        minisig = self._get(SIGNATURE, 4096).decode("utf-8", "replace")
        verify_minisign(manifest_bytes, minisig, self.pubkey)
        try:
            manifest = json.loads(manifest_bytes)
            sha, size, filename = manifest["sha256"], int(manifest["size"]), str(manifest["file"])
        except (ValueError, KeyError, TypeError) as e:
            raise KBUpdateError("manifest.json invalido.") from e
        if "/" in filename or "\\" in filename or not filename.endswith(".sqlite"):
            raise KBUpdateError("Nombre de fichero del manifest no permitido.")
        if size <= 0 or size > MAX_DOWNLOAD:
            raise KBUpdateError("Tamano del snapshot fuera de rango.")

        installed = self.installed_manifest()
        if installed and installed.get("sha256") == sha and self.public_path.exists():
            return {"accion": "sin_cambios", "version": manifest.get("version")}

        self.kb_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.kb_dir / (self.public_path.name + ".download")
        try:
            self._download(filename, tmp, size)
            if tmp.stat().st_size != size:
                raise KBUpdateError("El tamano del snapshot no coincide con el manifest.")
            if sha256_file(tmp) != sha:
                raise KBUpdateError("El SHA-256 del snapshot no coincide con el manifest firmado.")
            self._check_snapshot(tmp)
            accion = "actualizada" if self.public_path.exists() else "instalada"
            self._rotate(tmp, manifest_bytes)
        finally:
            tmp.unlink(missing_ok=True)
        return {"accion": accion, "version": manifest.get("version")}

    def rollback(self) -> dict:
        if not self.prev_path.exists():
            raise KBUpdateError("No hay snapshot anterior.")
        _replace_retry(self.prev_path, self.public_path)
        if self.prev_manifest_path.exists():
            os.replace(self.prev_manifest_path, self.manifest_path)
        else:
            self.manifest_path.unlink(missing_ok=True)
        return {"accion": "rollback", **self.estado()}

    # -------------------------------------------------------------- interno

    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=httpx.Timeout(30.0, read=120.0), follow_redirects=False)
        return self._client

    def _get(self, name: str, limit: int) -> bytes:
        r = self._http().get(self.base_url + name)
        r.raise_for_status()
        if len(r.content) > limit:
            raise KBUpdateError(f"{name} demasiado grande.")
        return r.content

    def _download(self, name: str, dest: Path, expected: int) -> None:
        with self._http().stream("GET", self.base_url + name) as r, dest.open("wb") as f:
            r.raise_for_status()
            total = 0
            for block in r.iter_bytes(1 << 20):
                total += len(block)
                if total > expected:
                    raise KBUpdateError("El snapshot descargado es mas grande que lo que dice el manifest.")
                f.write(block)

    def _check_snapshot(self, path: Path) -> None:
        from kb import sqlite_kb

        try:
            conn = sqlite_kb.connect(path)
        except Exception as e:  # cualquier fallo al abrir invalida el fichero
            raise KBUpdateError(f"El snapshot no se puede abrir: {type(e).__name__}: {e}") from e
        try:
            sqlite_kb.check_compatible(conn)
            ok = conn.execute("PRAGMA quick_check").fetchone()[0]
            if ok != "ok":
                raise KBUpdateError(f"El snapshot esta corrupto: {ok}")
            n = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
            if n == 0:
                raise KBUpdateError("El snapshot esta vacio.")
        except RuntimeError as e:
            raise KBUpdateError(str(e)) from e
        finally:
            conn.close()

    def _rotate(self, tmp: Path, manifest_bytes: bytes) -> None:
        if self.public_path.exists():
            _replace_retry(self.public_path, self.prev_path)
            if self.manifest_path.exists():
                os.replace(self.manifest_path, self.prev_manifest_path)
        _replace_retry(tmp, self.public_path)
        self.manifest_path.write_bytes(manifest_bytes)


def _replace_retry(src: Path, dst: Path, attempts: int = 10) -> None:
    """os.replace con reintentos: en Windows falla si una busqueda tiene el fichero abierto."""
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.2)
