"""`kb-sign`: claves y firmas ed25519 en formato minisign, en Python puro.

    kb-sign keygen --out <dir>          -> <dir>/kb.key (secreta, 0600) y <dir>/kb.pub
    kb-sign sign --key <dir>/kb.key <fichero>  -> <fichero>.minisig

El `.pub` y el `.minisig` siguen el formato de minisign (https://jedisct1.github.io/minisign/),
asi que `minisign -V -p kb.pub -m fichero` los verifica, y el cliente (`app-backend`)
verifica con la clave publica embebida. El `.key` es formato propio (la semilla de 32
bytes en base64, sin cifrar): la firma la ejecuta un timer sin nadie delante, asi que
una contrasena no anadiria proteccion real. Lo que protege la clave es el usuario del
sistema y el modo 0600. La clave secreta NUNCA sale del VPS.

Firma "ED" (prehashed): ed25519 sobre BLAKE2b-512 del fichero, que es lo que hace
minisign por defecto. Trusted comment: `timestamp:<unix>\tfile:<nombre>`, firmada por
la firma global sobre sig + comentario.
"""

import argparse
import base64
import hashlib
import os
import secrets
import sys
import time
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def keygen(out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    key_path, pub_path = out_dir / "kb.key", out_dir / "kb.pub"
    if key_path.exists():
        raise FileExistsError(f"Ya existe {key_path}; no se sobrescribe una clave de firma.")
    priv = Ed25519PrivateKey.generate()
    key_id = secrets.token_bytes(8)
    seed = priv.private_bytes_raw()
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("untrusted comment: kb-seo secret key (seed ed25519, formato propio)\n")
        f.write(base64.b64encode(key_id + seed).decode() + "\n")
    pub_raw = b"Ed" + key_id + priv.public_key().public_bytes_raw()
    pub_path.write_text(
        "untrusted comment: minisign public key kb-seo\n" + base64.b64encode(pub_raw).decode() + "\n",
        encoding="utf-8",
    )
    return key_path, pub_path


def load_key(key_path: Path) -> tuple[bytes, Ed25519PrivateKey]:
    lines = [ln.strip() for ln in key_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    raw = base64.b64decode(lines[-1])
    if len(raw) != 40:
        raise ValueError(f"{key_path}: clave con formato invalido.")
    return raw[:8], Ed25519PrivateKey.from_private_bytes(raw[8:])


def sign(key_path: Path, target: Path) -> Path:
    key_id, priv = load_key(key_path)
    data = target.read_bytes()
    sig = priv.sign(hashlib.blake2b(data, digest_size=64).digest())
    trusted = f"timestamp:{int(time.time())}\tfile:{target.name}"
    global_sig = priv.sign(sig + trusted.encode())
    out = target.with_name(target.name + ".minisig")
    tmp = out.with_suffix(".minisig.tmp")
    tmp.write_text(
        "untrusted comment: signature from kb-seo\n"
        + base64.b64encode(b"ED" + key_id + sig).decode()
        + "\ntrusted comment: " + trusted + "\n"
        + base64.b64encode(global_sig).decode() + "\n",
        encoding="utf-8",
    )
    os.replace(tmp, out)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(prog="kb-sign", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_gen = sub.add_parser("keygen", help="Genera kb.key (secreta) y kb.pub")
    p_gen.add_argument("--out", required=True)
    p_sign = sub.add_parser("sign", help="Firma un fichero y escribe <fichero>.minisig")
    p_sign.add_argument("--key", required=True)
    p_sign.add_argument("file")
    args = parser.parse_args()
    try:
        if args.command == "keygen":
            key, pub = keygen(Path(args.out))
            print(f"Clave secreta: {key}\nClave publica: {pub}\n{pub.read_text(encoding='utf-8')}")
        else:
            print(sign(Path(args.key), Path(args.file)))
    except (OSError, ValueError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
