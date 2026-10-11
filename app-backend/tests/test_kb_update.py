"""Actualizacion del snapshot: firma, hash, sustitucion atomica y rollback.

El "servidor" es un httpx.MockTransport que sirve lo que haya en un dict, asi
que cada test puede manipular el manifest, la firma o el fichero a voluntad.
"""

import base64
import hashlib
import json

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from kb import config as kb_config
from kb import sqlite_kb

from app_backend import kb_update
from app_backend.kb_update import KBUpdateError, KBUpdater, verify_minisign

URL = "https://kb.example.test/kb/"
KEY_ID = b"\x01\x02\x03\x04\x05\x06\x07\x08"


def minisign_keypair():
    priv = Ed25519PrivateKey.generate()
    pub_raw = priv.public_key().public_bytes_raw()
    return priv, base64.b64encode(b"Ed" + KEY_ID + pub_raw).decode()


def minisign_sign(priv: Ed25519PrivateKey, data: bytes, trusted: str = "timestamp:1", key_id=KEY_ID) -> str:
    """Firma en el formato prehashed ("ED") que usa minisign por defecto."""
    sig = priv.sign(hashlib.blake2b(data, digest_size=64).digest())
    global_sig = priv.sign(sig + trusted.encode())
    return (
        "untrusted comment: test\n"
        + base64.b64encode(b"ED" + key_id + sig).decode()
        + "\ntrusted comment: " + trusted + "\n"
        + base64.b64encode(global_sig).decode() + "\n"
    )


def make_snapshot(path, textos: list[str]) -> bytes:
    conn = sqlite_kb.connect(path, readonly=False)
    sqlite_kb.init_schema(conn)
    doc = {"url": "https://x.test/a", "title": "A", "source_type": "web", "platforms": ["tiktok"],
           "content_hash": "h"}
    sqlite_kb.upsert_document(conn, doc, textos, [[0.1] * kb_config.EMBED_DIM for _ in textos])
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    return path.read_bytes()


class Servidor:
    def __init__(self, priv):
        self.priv = priv
        self.files: dict[str, bytes] = {}

    def publicar(self, db: bytes, version="v1", **overrides):
        manifest = {
            "file": "kb-public.sqlite", "version": version, "exported_at": "2026-10-11T00:00:00+00:00",
            "size": len(db), "sha256": hashlib.sha256(db).hexdigest(),
            "embed_model": kb_config.EMBED_MODEL, "embed_dim": kb_config.EMBED_DIM,
            "documents": 1, "chunks": 1, **overrides,
        }
        mb = json.dumps(manifest).encode()
        self.files = {
            "manifest.json": mb,
            "manifest.json.minisig": minisign_sign(self.priv, mb).encode(),
            "kb-public.sqlite": db,
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        if name not in self.files:
            return httpx.Response(404)
        return httpx.Response(200, content=self.files[name])

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler))


@pytest.fixture
def entorno(tmp_path):
    priv, pub = minisign_keypair()
    srv = Servidor(priv)
    srv.publicar(make_snapshot(tmp_path / "v1.sqlite", ["[A]\nprimera version"]))
    updater = KBUpdater(URL, pub, tmp_path / "kb" / "kb-public.sqlite", client=srv.client())
    return srv, updater, tmp_path


def contenido(updater) -> str:
    conn = sqlite_kb.connect(updater.public_path)
    try:
        return conn.execute("SELECT content FROM chunks").fetchone()[0]
    finally:
        conn.close()


def test_verify_minisign_acepta_y_rechaza():
    priv, pub = minisign_keypair()
    sig = minisign_sign(priv, b"hola", trusted="timestamp:7")
    assert verify_minisign(b"hola", sig, pub) == "timestamp:7"
    with pytest.raises(KBUpdateError):
        verify_minisign(b"hola!", sig, pub)
    otra, _ = minisign_keypair()
    with pytest.raises(KBUpdateError, match="invalida"):
        verify_minisign(b"hola", minisign_sign(otra, b"hola"), pub)
    with pytest.raises(KBUpdateError, match="key id"):
        verify_minisign(b"hola", minisign_sign(priv, b"hola", key_id=b"\x00" * 8), pub)


def test_instala_actualiza_y_no_repite(entorno):
    srv, updater, tmp = entorno
    assert updater.update()["accion"] == "instalada"
    assert contenido(updater) == "[A]\nprimera version"
    assert updater.estado()["version"] == "v1"
    assert updater.update()["accion"] == "sin_cambios"
    assert not updater.due()

    srv.publicar(make_snapshot(tmp / "v2.sqlite", ["[A]\nsegunda version"]), version="v2")
    assert updater.update()["accion"] == "actualizada"
    assert contenido(updater) == "[A]\nsegunda version"
    assert updater.estado()["anterior_disponible"]
    assert not list(updater.kb_dir.glob("*.download"))

    assert updater.rollback()["version"] == "v1"
    assert contenido(updater) == "[A]\nprimera version"
    with pytest.raises(KBUpdateError):
        updater.rollback()


def test_firma_invalida_se_rechaza_y_conserva_la_anterior(entorno):
    srv, updater, tmp = entorno
    updater.update()
    otra, _ = minisign_keypair()
    srv.publicar(make_snapshot(tmp / "v2.sqlite", ["[A]\nmaliciosa"]), version="v2")
    srv.files["manifest.json.minisig"] = minisign_sign(otra, srv.files["manifest.json"]).encode()
    with pytest.raises(KBUpdateError, match="Firma"):
        updater.update()
    assert contenido(updater) == "[A]\nprimera version"
    assert updater.estado()["version"] == "v1"
    assert "Firma" in updater.estado()["ultimo_error"]


def test_snapshot_manipulado_tras_firmar_se_rechaza(entorno):
    srv, updater, tmp = entorno
    updater.update()
    srv.publicar(make_snapshot(tmp / "v2.sqlite", ["[A]\nsegunda version"]), version="v2")
    manipulado = make_snapshot(tmp / "mal.sqlite", ["[A]\ninyectado"])
    srv.files["kb-public.sqlite"] = manipulado[: len(srv.files["kb-public.sqlite"])]
    with pytest.raises(KBUpdateError, match="SHA-256|tamano"):
        updater.update()
    assert contenido(updater) == "[A]\nprimera version"
    assert not updater.public_path.with_suffix(".sqlite.download").exists()


def test_modelo_distinto_se_rechaza(entorno, monkeypatch):
    _, updater, _ = entorno
    monkeypatch.setattr(kb_config, "EMBED_MODEL", "otro-modelo")
    with pytest.raises(KBUpdateError, match="vectorizada"):
        updater.update()
    assert not updater.public_path.exists()


def test_url_insegura_no_se_acepta(tmp_path):
    with pytest.raises(KBUpdateError):
        KBUpdater("http://kb.example.test/kb/", "x", tmp_path / "kb.sqlite")
    KBUpdater("http://127.0.0.1:8000/kb/", "x", tmp_path / "kb.sqlite")


def test_nombre_de_fichero_del_manifest_acotado(entorno):
    srv, updater, _ = entorno
    srv.publicar(srv.files["kb-public.sqlite"], file="../../fuera.sqlite")
    with pytest.raises(KBUpdateError, match="no permitido"):
        updater.update()
    assert kb_update.MAX_DOWNLOAD > 0
