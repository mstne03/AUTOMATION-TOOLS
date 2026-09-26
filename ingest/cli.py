"""CLI de ingesta: `uv run ingest all | url <url> | stats`."""

import argparse
import hashlib
import sys
from datetime import date
from pathlib import Path

import yaml

from ingest.extractors import ExtractionError, extract
from kb import chunking, db, embeddings
from kb.config import PROJECT_ROOT

SOURCES_PATH = PROJECT_ROOT / "sources.yaml"
VALID_TYPES = {"web", "youtube", "pdf", "local"}

_HEADER = (
    "# Fuentes de la base de conocimiento. Este archivo es la fuente de verdad.\n"
    "# `uv run ingest all` procesa todas las entradas de aqui.\n"
    "# `uv run ingest url <url> ...` anade una entrada y la ingiere.\n\n"
)


def main() -> int:
    parser = argparse.ArgumentParser(prog="ingest", description="Ingesta de fuentes en la KB")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("all", help="Procesa todo sources.yaml")

    p_url = sub.add_parser("url", help="Anade una fuente a sources.yaml y la ingiere")
    p_url.add_argument("url")
    p_url.add_argument("--type", dest="source_type", default=None,
                       help="web | youtube | pdf | local (se adivina si se omite)")
    p_url.add_argument("--platform", action="append", default=[],
                       help="Repetible: --platform youtube --platform tiktok")
    p_url.add_argument("--date", dest="published_at", default=None, help="YYYY-MM-DD")
    p_url.add_argument("--author", default=None)
    p_url.add_argument("--topic", action="append", default=[], dest="topics")

    sub.add_parser("stats", help="Documentos, chunks y desglose por plataforma")

    args = parser.parse_args()

    if args.command == "all":
        return cmd_all()
    if args.command == "url":
        return cmd_url(args)
    if args.command == "stats":
        return cmd_stats()
    return 1


# ---------------------------------------------------------------- comandos


def cmd_all() -> int:
    sources = load_sources()
    if not sources:
        print(f"{SOURCES_PATH} no tiene ninguna fuente todavia. Nada que hacer.")
        return 0

    done, skipped, failed = [], [], []
    for source in sources:
        location = source.get("url")
        try:
            result = ingest_one(source)
        except ExtractionError as e:
            failed.append((location, str(e)))
            print(f"  ERROR   {location}\n          {e}")
        except Exception as e:  # noqa: BLE001 - un fallo no debe tumbar el lote entero
            failed.append((location, f"{type(e).__name__}: {e}"))
            print(f"  ERROR   {location}\n          {type(e).__name__}: {e}")
        else:
            if result["skipped"]:
                skipped.append(location)
                print(f"  =       {location}  (sin cambios)")
            else:
                done.append(location)
                print(f"  OK      {location}  ({result['chunks']} chunks)")

    print()
    print(f"Resumen: {len(done)} ingeridas, {len(skipped)} saltadas, {len(failed)} con error.")
    if failed:
        print("\nFuentes con error:")
        for location, msg in failed:
            print(f"  - {location}: {msg}")
    return 1 if failed else 0


def cmd_url(args) -> int:
    source_type = args.source_type or guess_type(args.url)
    if source_type not in VALID_TYPES:
        print(f"Tipo invalido: {source_type}. Usa uno de {sorted(VALID_TYPES)}", file=sys.stderr)
        return 1

    source = {
        "url": args.url,
        "type": source_type,
        "platforms": args.platform or ["general"],
    }
    if args.published_at:
        source["published_at"] = args.published_at
    if args.author:
        source["author"] = args.author
    if args.topics:
        source["topics"] = args.topics

    try:
        result = ingest_one(source)
    except ExtractionError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    append_source(source)
    if result["skipped"]:
        print(f"Sin cambios: {args.url}")
    else:
        print(f"Ingerida: {args.url} ({result['chunks']} chunks)")
    print(f"Apuntada en {SOURCES_PATH}")
    return 0


def cmd_stats() -> int:
    with db.reader() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM documents")
        n_docs = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM chunks")
        n_chunks = cur.fetchone()[0]
        cur.execute(
            "SELECT p, count(*) AS docs, max(published_at) AS mas_reciente "
            "FROM documents d, unnest(d.platforms) AS p "
            "GROUP BY p ORDER BY docs DESC"
        )
        rows = cur.fetchall()

    print(f"Documentos: {n_docs}")
    print(f"Chunks:     {n_chunks}")
    if rows:
        print("\nPor plataforma:")
        for platform, docs, newest in rows:
            print(f"  {platform:<12} {docs:>4} docs   mas reciente: {newest or 'sin fecha'}")
    else:
        print("\nSin documentos todavia.")
    return 0


# ---------------------------------------------------------------- ingesta


def ingest_one(source: dict) -> dict:
    location = source.get("url")
    if not location:
        raise ExtractionError("Fuente sin campo 'url'")

    source_type = source.get("type") or guess_type(location)
    if source_type not in VALID_TYPES:
        raise ExtractionError(f"Tipo invalido '{source_type}' en {location}")

    platforms = source.get("platforms") or ["general"]
    topics = source.get("topics") or []
    extracted = extract(source_type, location)

    content_hash = hashlib.sha256(extracted.text.encode("utf-8")).hexdigest()

    title = source.get("title") or extracted.title
    author = source.get("author") or extracted.author
    published_at = _as_date(source.get("published_at") or extracted.published_at)
    lang = source.get("lang") or extracted.lang

    with db.writer() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, content_hash FROM documents WHERE url = %s", (location,))
            row = cur.fetchone()

            if row and row[1] == content_hash:
                return {"skipped": True, "chunks": 0}

            header = chunking.context_header(title, platforms, published_at)
            if source_type == "youtube" and extracted.segments:
                chunks = chunking.chunk_transcript(extracted.segments, header)
            else:
                chunks = chunking.chunk_text(extracted.text, header)

            if not chunks:
                raise ExtractionError(f"{location}: no salio ningun chunk del texto extraido")

            vectors = embeddings.embed(chunks)

            if row:
                doc_id = row[0]
                cur.execute(
                    "UPDATE documents SET title=%s, source_type=%s, platforms=%s, "
                    "author=%s, published_at=%s, lang=%s, topics=%s, "
                    "content_hash=%s, ingested_at=now() WHERE id=%s",
                    (title, source_type, platforms, author, published_at, lang,
                     topics, content_hash, doc_id),
                )
                # Reemplazo de datos en la BD, no borrado de archivos.
                cur.execute("DELETE FROM chunks WHERE document_id = %s", (doc_id,))
            else:
                cur.execute(
                    "INSERT INTO documents "
                    "(url, title, source_type, platforms, author, published_at, "
                    "lang, topics, content_hash) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                    (location, title, source_type, platforms, author, published_at,
                     lang, topics, content_hash),
                )
                doc_id = cur.fetchone()[0]

            cur.executemany(
                "INSERT INTO chunks (document_id, chunk_index, content, embedding) "
                "VALUES (%s, %s, %s, %s::vector)",
                [
                    (doc_id, i, text, str(vec))
                    for i, (text, vec) in enumerate(zip(chunks, vectors))
                ],
            )
        conn.commit()

    return {"skipped": False, "chunks": len(chunks)}


# ---------------------------------------------------------------- sources.yaml


def load_sources() -> list[dict]:
    if not SOURCES_PATH.exists():
        return []
    data = yaml.safe_load(SOURCES_PATH.read_text(encoding="utf-8"))
    if not data:
        return []
    if not isinstance(data, list):
        raise SystemExit(f"{SOURCES_PATH} deberia ser una lista de fuentes.")
    return data


def append_source(source: dict) -> None:
    sources = load_sources()
    for existing in sources:
        if existing.get("url") == source["url"]:
            existing.update(source)
            break
    else:
        sources.append(source)

    body = yaml.safe_dump(sources, allow_unicode=True, sort_keys=False, default_flow_style=False)
    SOURCES_PATH.write_text(_HEADER + body, encoding="utf-8")


# ---------------------------------------------------------------- utilidades


def guess_type(location: str) -> str:
    low = location.lower()
    if "youtube.com" in low or "youtu.be" in low:
        return "youtube"
    if low.startswith(("http://", "https://")):
        return "pdf" if low.endswith(".pdf") else "web"
    if low.endswith(".pdf"):
        return "pdf"
    if Path(location).suffix.lower() in {".md", ".txt"}:
        return "local"
    return "web"


def _as_date(value) -> date | None:
    if value is None or isinstance(value, date):
        return value
    text = str(value).strip()[:10]
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None
