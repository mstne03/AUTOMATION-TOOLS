"""`kb-export`: vuelca la KB de Postgres a un snapshot SQLite firmable.

Escribe `<out>/kb-public.sqlite` y `<out>/manifest.json`. Los dos se escriben en
un temporal del mismo directorio y se renombran al final, para que nadie pueda
leer un fichero a medias. El manifest lleva version, fecha, tamano, SHA-256 y el
modelo/dimension de los embeddings; la firma minisign se hace fuera, en el VPS.
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from kb import config, db, sqlite_kb

DB_NAME = "kb-public.sqlite"
MANIFEST_NAME = "manifest.json"


def export(out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_db = out_dir / (DB_NAME + ".tmp")
    tmp_db.unlink(missing_ok=True)

    with db.reader() as pg, pg.cursor() as cur:
        cur.execute(
            "SELECT id, url, title, source_type, platforms, author, published_at, lang, "
            "topics, content_hash, ingested_at FROM documents ORDER BY id"
        )
        docs = cur.fetchall()

        conn = sqlite_kb.connect(tmp_db, readonly=False)
        try:
            sqlite_kb.init_schema(conn)
            n_chunks = 0
            for row in docs:
                doc = {
                    "id": row[0], "url": row[1], "title": row[2], "source_type": row[3],
                    "platforms": list(row[4] or []), "author": row[5], "published_at": row[6],
                    "lang": row[7], "topics": list(row[8] or []), "content_hash": row[9],
                    "ingested_at": row[10].astimezone(UTC).isoformat(timespec="seconds")
                    if row[10] else None,
                }
                cur.execute(
                    "SELECT content, embedding FROM chunks WHERE document_id = %s "
                    "ORDER BY chunk_index",
                    (doc["id"],),
                )
                chunks, vectors = [], []
                for content, embedding in cur.fetchall():
                    chunks.append(content)
                    vectors.append([float(x) for x in embedding.to_list()])
                sqlite_kb.upsert_document(conn, doc, chunks, vectors)
                n_chunks += len(chunks)
            conn.commit()
            # Sin fecha dentro del fichero: el mismo corpus debe dar el mismo SHA-256,
            # y asi el cliente no descarga un snapshot que no ha cambiado.
            conn.execute("VACUUM")
        finally:
            conn.close()

    sha = _sha256(tmp_db)
    manifest = {
        "file": DB_NAME,
        "version": sha[:16],
        "exported_at": _now(),
        "size": tmp_db.stat().st_size,
        "sha256": sha,
        "embed_model": config.EMBED_MODEL,
        "embed_dim": config.EMBED_DIM,
        "documents": len(docs),
        "chunks": n_chunks,
    }
    tmp_manifest = out_dir / (MANIFEST_NAME + ".tmp")
    tmp_manifest.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", "utf-8")
    os.replace(tmp_db, out_dir / DB_NAME)
    os.replace(tmp_manifest, out_dir / MANIFEST_NAME)
    return manifest


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def main() -> int:
    parser = argparse.ArgumentParser(prog="kb-export", description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="dist", help="Directorio de salida (por defecto ./dist)")
    args = parser.parse_args()
    try:
        manifest = export(Path(args.out))
    except Exception as e:  # noqa: BLE001 - CLI: mensaje y codigo de salida
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
