"""CLI de ingesta: `uv run ingest all | url <url> | prune | stats`.

Escribe en Postgres (KB_BACKEND=postgres) o en el fichero SQLite de KB_SQLITE_PATH
(KB_BACKEND=sqlite, el modo del VPS). `ingest_one(source, target=...)` admite ademas
una ruta SQLite explicita: es lo que usa la KB privada del cliente.
"""

import argparse
import hashlib
import sys
from datetime import date
from pathlib import Path

import yaml

from ingest.extractors import ExtractionError, extract
from kb import chunking, config, db, embeddings, sqlite_kb
from kb.config import PROJECT_ROOT

SOURCES_PATH = PROJECT_ROOT / "sources.yaml"
VALID_TYPES = {"web", "youtube", "pdf", "local", "browser"}

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
                       help="web | youtube | pdf | local | browser (se adivina si se omite)")
    p_url.add_argument("--platform", action="append", default=[],
                       help="Repetible: --platform youtube --platform tiktok")
    p_url.add_argument("--date", dest="published_at", default=None, help="YYYY-MM-DD")
    p_url.add_argument("--author", default=None)
    p_url.add_argument("--topic", action="append", default=[], dest="topics")

    sub.add_parser("prune", help="Borra de la KB los documentos que ya no estan en sources.yaml")
    sub.add_parser("stats", help="Documentos, chunks y desglose por plataforma")

    args = parser.parse_args()

    if args.command == "all":
        return cmd_all()
    if args.command == "url":
        return cmd_url(args)
    if args.command == "prune":
        return cmd_prune()
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

    apuntada = append_source(source)
    if result["skipped"]:
        print(f"Sin cambios: {args.url}")
    else:
        print(f"Ingerida: {args.url} ({result['chunks']} chunks)")
    if apuntada:
        print(f"Apuntada en {SOURCES_PATH}")
    else:
        print(f"Ya estaba apuntada en {SOURCES_PATH}; sus metadatos no se han tocado.")
    return 0


def cmd_prune() -> int:
    """sources.yaml es la fuente de verdad: lo que no esta ahi sale de la KB."""
    vivas = {s.get("url") for s in load_sources()}
    if not vivas:
        print("sources.yaml esta vacio: no se borra nada por seguridad.")
        return 1
    borradas = []
    if _sqlite_target(None):
        conn = sqlite_kb.connect(_sqlite_target(None), readonly=False)
        try:
            sqlite_kb.init_schema(conn)
            urls = [r[0] for r in conn.execute("SELECT url FROM documents").fetchall()]
            for url in urls:
                if url not in vivas and sqlite_kb.delete_document(conn, url):
                    borradas.append(url)
            conn.commit()
        finally:
            conn.close()
    else:
        with db.writer() as conn, conn.cursor() as cur:
            cur.execute("SELECT url FROM documents")
            for (url,) in cur.fetchall():
                if url not in vivas:
                    cur.execute("DELETE FROM documents WHERE url = %s", (url,))
                    borradas.append(url)
            conn.commit()
    for url in borradas:
        print(f"  BORRADA {url}")
    print(f"{len(borradas)} documentos borrados.")
    return 0


def cmd_stats() -> int:
    if _sqlite_target(None):
        conn = sqlite_kb.connect(_sqlite_target(None))
        try:
            e = sqlite_kb.estado(conn)
        finally:
            conn.close()
        n_docs, n_chunks, rows = e["documentos"], e["chunks"], e["por_plataforma"]
        _print_stats(n_docs, n_chunks, rows)
        return 0
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
    _print_stats(n_docs, n_chunks, rows)
    return 0


def _print_stats(n_docs, n_chunks, rows) -> None:
    print(f"Documentos: {n_docs}")
    print(f"Chunks:     {n_chunks}")
    if rows:
        print("\nPor plataforma:")
        for platform, docs, newest in rows:
            print(f"  {platform:<12} {docs:>4} docs   mas reciente: {newest or 'sin fecha'}")
    else:
        print("\nSin documentos todavia.")


# ---------------------------------------------------------------- ingesta


def _sqlite_target(target: str | Path | None) -> Path | None:
    """Ruta SQLite de destino, o None si toca Postgres."""
    if target:
        return Path(target)
    if config.KB_BACKEND == "sqlite":
        if not config.KB_SQLITE_PATH:
            raise ExtractionError("KB_BACKEND=sqlite pero falta KB_SQLITE_PATH")
        return Path(config.KB_SQLITE_PATH)
    return None


def ingest_text(
    target: str | Path,
    url: str,
    title: str,
    text: str,
    platforms: list[str] | None = None,
    published_at=None,
    author: str | None = None,
    source_type: str = "nota",
) -> dict:
    """Guarda un texto ya en mano (transcripcion, resumen de analiticas) en un SQLite.

    `url` es el identificador del documento: repetirlo reemplaza el contenido. Es la
    entrada de la KB privada que no pasa por los extractores.
    """
    if not text or not text.strip():
        raise ExtractionError("Texto vacio")
    platforms = platforms or ["general"]
    published = _as_date(published_at)
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    conn = sqlite_kb.connect(Path(target), readonly=False)
    try:
        sqlite_kb.init_schema(conn)
        row = conn.execute("SELECT content_hash FROM documents WHERE url = ?", (url,)).fetchone()
        if row and row[0] == content_hash:
            return {"skipped": True, "chunks": 0}
        chunks = chunking.chunk_text(text, chunking.context_header(title, platforms, published))
        if not chunks:
            raise ExtractionError("No salio ningun chunk del texto")
        doc = {
            "url": url, "title": title, "source_type": source_type, "platforms": platforms,
            "author": author, "published_at": published, "lang": None, "topics": [],
            "content_hash": content_hash,
        }
        sqlite_kb.upsert_document(conn, doc, chunks, embeddings.embed(chunks))
        conn.commit()
    finally:
        conn.close()
    return {"skipped": False, "chunks": len(chunks)}


def ingest_one(source: dict, target: str | Path | None = None) -> dict:
    """Extrae, trocea, vectoriza y guarda una fuente. Idempotente por content_hash.

    `target`: fichero SQLite de destino. Sin el, manda KB_BACKEND.
    """
    location = source.get("url")
    if not location:
        raise ExtractionError("Fuente sin campo 'url'")

    source_type = source.get("type") or guess_type(location)
    if source_type not in VALID_TYPES:
        raise ExtractionError(f"Tipo invalido '{source_type}' en {location}")

    platforms = source.get("platforms") or ["general"]
    topics = source.get("topics") or []
    extracted = extract(source_type, resolve_location(source_type, location))

    content_hash = hashlib.sha256(extracted.text.encode("utf-8")).hexdigest()

    title = source.get("title") or extracted.title
    author = source.get("author") or extracted.author
    published_at = _as_date(source.get("published_at") or extracted.published_at)
    lang = source.get("lang") or extracted.lang

    def trocear() -> list[str]:
        header = chunking.context_header(title, platforms, published_at)
        if source_type == "youtube" and extracted.segments:
            chunks = chunking.chunk_transcript(extracted.segments, header)
        else:
            chunks = chunking.chunk_text(extracted.text, header)
        if not chunks:
            raise ExtractionError(f"{location}: no salio ningun chunk del texto extraido")
        return chunks

    sqlite_path = _sqlite_target(target)
    if sqlite_path:
        conn = sqlite_kb.connect(sqlite_path, readonly=False)
        try:
            sqlite_kb.init_schema(conn)
            row = conn.execute(
                "SELECT content_hash FROM documents WHERE url = ?", (location,)
            ).fetchone()
            if row and row[0] == content_hash:
                return {"skipped": True, "chunks": 0}
            chunks = trocear()
            doc = {
                "url": location, "title": title, "source_type": source_type,
                "platforms": platforms, "author": author, "published_at": published_at,
                "lang": lang, "topics": topics, "content_hash": content_hash,
            }
            sqlite_kb.upsert_document(conn, doc, chunks, embeddings.embed(chunks))
            conn.commit()
        finally:
            conn.close()
        return {"skipped": False, "chunks": len(chunks)}

    with db.writer() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, content_hash FROM documents WHERE url = %s", (location,))
            row = cur.fetchone()

            if row and row[1] == content_hash:
                return {"skipped": True, "chunks": 0}

            chunks = trocear()
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


def append_source(source: dict) -> bool:
    """Anade la fuente al final de sources.yaml sin tocar el resto del archivo.

    Reescribir el archivo entero con `yaml.safe_dump` se llevaba por delante
    todos los comentarios (secciones, convenciones de fechas), asi que solo se
    anade texto al final. Si la url ya esta apuntada, no se toca nada y se
    devuelve False: edita la entrada a mano si quieres cambiar sus metadatos.
    """
    sources = load_sources()
    if any(existing.get("url") == source["url"] for existing in sources):
        return False

    entrada = yaml.safe_dump(
        [source], allow_unicode=True, sort_keys=False, default_flow_style=False
    )
    actual = SOURCES_PATH.read_text(encoding="utf-8") if SOURCES_PATH.exists() else _HEADER
    separador = "" if actual.endswith("\n\n") else ("\n" if actual.endswith("\n") else "\n\n")
    SOURCES_PATH.write_text(actual + separador + entrada, encoding="utf-8")
    return True


# ---------------------------------------------------------------- utilidades


def resolve_location(source_type: str, location: str) -> str:
    """Ruta real de una fuente local. Las relativas cuelgan de la raiz del repo.

    `sources.yaml` guarda rutas relativas (`fuentes/x.md`) para que el archivo
    sirva en cualquier maquina; la url que se guarda en la base de datos es esa
    misma cadena relativa.
    """
    if source_type not in {"local", "pdf"} or location.lower().startswith(("http://", "https://")):
        return location
    path = Path(location)
    if path.is_absolute():
        return location
    return str(PROJECT_ROOT / path)


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
