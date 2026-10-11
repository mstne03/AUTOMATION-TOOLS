"""Base de conocimiento en un unico fichero SQLite: esquema, escritura y busqueda.

Es el formato del snapshot publico (exportado en el VPS con `kb-export`, de solo
lectura en el cliente) y de la KB privada del usuario (mismo esquema, escritura
local). La busqueda es un port, con la misma semantica, de `kb/search.py`:

- `filtered` aplica plataforma, fecha y fuente ANTES de las ramas, para que los
  candidatos salgan ya solo de los documentos pedidos.
- Rama vectorial: KNN coseno de sqlite-vec (`vec0`) prefiltrado por `rowid IN`.
- Rama full-text: FTS5 con tokenizador `unicode61` sin stemming, el equivalente
  de la configuracion `simple` de Postgres; la query va como terminos AND, como
  `plainto_tsquery`. El ranking es bm25 (Postgres usa ts_rank), asi que el orden
  dentro de la rama de texto puede variar un poco respecto a Postgres.
- Fusion RRF con las mismas constantes.

Diferencias de representacion respecto a Postgres: `platforms` y `topics` van como
JSON; las fechas como texto ISO (comparan bien como cadenas); `url_original` se
calcula al escribir (la regex sobre el chunk 0 no se puede hacer en SQLite).
"""

import json
import re
import sqlite3
from datetime import UTC, date, datetime
from pathlib import Path

import sqlite_vec

from kb import config
from kb.search import CANDIDATES, RRF_K, _as_date, _as_sources

_ORIGINAL = re.compile(r"(?:^|\n)>[ \t]*Original:[ \t]*(\S+)")
_TOKEN = re.compile(r"\w+", re.UNICODE)

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY,
  url           TEXT UNIQUE NOT NULL,
  title         TEXT,
  source_type   TEXT NOT NULL,
  platforms     TEXT NOT NULL,          -- JSON: ["youtube", ...]
  author        TEXT,
  published_at  TEXT,                   -- YYYY-MM-DD
  lang          TEXT,
  topics        TEXT,                   -- JSON
  content_hash  TEXT NOT NULL,
  ingested_at   TEXT,                   -- ISO 8601 UTC
  url_original  TEXT                    -- `> Original: ...` de un archivo local
);
CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  content      TEXT NOT NULL,
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks (document_id);
CREATE INDEX IF NOT EXISTS documents_published_at ON documents (published_at);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  embedding float[{dim}] distance_metric=cosine
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content, content='chunks', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
  DELETE FROM chunks_vec WHERE rowid = old.id;
END;
"""


# ------------------------------------------------------------------ conexion


def connect(path: str | Path, *, readonly: bool = True) -> sqlite3.Connection:
    """Abre la base con sqlite-vec cargado. En solo lectura salvo que se pida lo contrario."""
    path = Path(path)
    if readonly:
        conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path), timeout=5)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection, dim: int = config.EMBED_DIM) -> None:
    conn.executescript(SCHEMA.format(dim=dim))
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('embed_model', ?), ('embed_dim', ?)",
        (config.EMBED_MODEL, str(dim)),
    )
    conn.commit()


def check_compatible(conn: sqlite3.Connection) -> None:
    """Falla si el fichero se vectorizo con otro modelo: sus vectores no son comparables."""
    meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
    if meta.get("embed_model") != config.EMBED_MODEL or meta.get("embed_dim") != str(config.EMBED_DIM):
        raise RuntimeError(
            f"La base esta vectorizada con {meta.get('embed_model')} ({meta.get('embed_dim')} dims) "
            f"y el cliente usa {config.EMBED_MODEL} ({config.EMBED_DIM})."
        )


# ------------------------------------------------------------------ escritura


def url_original(chunk0: str | None) -> str | None:
    m = _ORIGINAL.search(chunk0 or "")
    return m.group(1) if m else None


def upsert_document(
    conn: sqlite3.Connection,
    doc: dict,
    chunks: list[str],
    vectors: list[list[float]],
) -> int:
    """Inserta o reemplaza un documento con sus chunks y vectores. Devuelve su id.

    `doc` lleva url, title, source_type, platforms (lista), author, published_at,
    lang, topics (lista), content_hash e ingested_at (opcional). No hace commit.
    """
    if len(chunks) != len(vectors):
        raise ValueError(f"{len(chunks)} chunks y {len(vectors)} vectores")
    ingested = doc.get("ingested_at") or datetime.now(UTC).isoformat(timespec="seconds")
    published = doc.get("published_at")
    row = (
        doc["url"], doc.get("title"), doc["source_type"],
        json.dumps(list(doc.get("platforms") or []), ensure_ascii=False),
        doc.get("author"), published.isoformat() if isinstance(published, date) else published,
        doc.get("lang"), json.dumps(list(doc.get("topics") or []), ensure_ascii=False),
        doc["content_hash"], str(ingested), url_original(chunks[0] if chunks else None),
    )
    cur = conn.execute("SELECT id FROM documents WHERE url = ?", (doc["url"],))
    existing = cur.fetchone()
    if existing:
        doc_id = existing[0]
        conn.execute("DELETE FROM chunks WHERE document_id = ?", (doc_id,))
        conn.execute(
            "UPDATE documents SET url=?, title=?, source_type=?, platforms=?, author=?, "
            "published_at=?, lang=?, topics=?, content_hash=?, ingested_at=?, url_original=? "
            "WHERE id=?",
            (*row, doc_id),
        )
    else:
        doc_id = doc.get("id")
        cur = conn.execute(
            "INSERT INTO documents (id, url, title, source_type, platforms, author, published_at, "
            "lang, topics, content_hash, ingested_at, url_original) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (doc_id, *row),
        )
        doc_id = cur.lastrowid

    for i, (text, vec) in enumerate(zip(chunks, vectors)):
        cur = conn.execute(
            "INSERT INTO chunks (document_id, chunk_index, content) VALUES (?,?,?)",
            (doc_id, i, text),
        )
        conn.execute(
            "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
            (cur.lastrowid, sqlite_vec.serialize_float32(vec)),
        )
    return doc_id


def delete_document(conn: sqlite3.Connection, url: str) -> bool:
    cur = conn.execute("DELETE FROM documents WHERE url = ?", (url,))
    return cur.rowcount > 0


# ------------------------------------------------------------------ busqueda

# Mismo `filtered` que en Postgres. Los filtros se pasan dos veces porque SQLite
# no tiene parametros con nombre reutilizables en las CTE de forma portable.
_FILTERED = """
WITH filtered AS (
    SELECT c.id, c.content, c.chunk_index, c.document_id,
           d.title, d.url, d.author, d.published_at, d.platforms, d.url_original
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE (:platform IS NULL OR EXISTS (
              SELECT 1 FROM json_each(d.platforms) WHERE value = :platform))
      AND (:since IS NULL OR d.published_at >= :since)
      AND (:sources IS NULL OR EXISTS (
              SELECT 1 FROM json_each(:sources) AS s
              WHERE instr(lower(COALESCE(d.title, '')), lower(s.value)) > 0
                 OR instr(lower(d.url), lower(s.value)) > 0
                 OR instr(lower(COALESCE(d.url_original, '')), lower(s.value)) > 0
          ))
)
"""

_SQL = _FILTERED + """,
vec AS (
    SELECT v.rowid AS id, ROW_NUMBER() OVER (ORDER BY v.distance) AS rank
    FROM chunks_vec v
    WHERE v.embedding MATCH :qvec AND k = :candidates
      AND v.rowid IN (SELECT id FROM filtered)
),
fts AS (
    SELECT t.rowid AS id, ROW_NUMBER() OVER (ORDER BY bm25(chunks_fts)) AS rank
    FROM chunks_fts t
    WHERE :fts_query <> '' AND chunks_fts MATCH :fts_query
      AND t.rowid IN (SELECT id FROM filtered)
    ORDER BY bm25(chunks_fts)
    LIMIT :candidates
)
SELECT f.content, f.title, f.url, f.author, f.published_at, f.platforms,
       COALESCE(1.0 / (:rrf_k + vec.rank), 0)
     + COALESCE(1.0 / (:rrf_k + fts.rank), 0) AS score,
       vec.rank AS vector_rank,
       fts.rank AS text_rank,
       f.document_id,
       f.chunk_index,
       f.url_original
FROM filtered f
LEFT JOIN vec ON vec.id = f.id
LEFT JOIN fts ON fts.id = f.id
WHERE vec.id IS NOT NULL OR fts.id IS NOT NULL
ORDER BY score DESC, f.document_id, f.chunk_index
LIMIT :k
"""

_SQL_TITULOS = """
SELECT d.title, d.url
FROM documents d
WHERE (:platform IS NULL OR EXISTS (
          SELECT 1 FROM json_each(d.platforms) WHERE value = :platform))
  AND (:since IS NULL OR d.published_at >= :since)
ORDER BY d.published_at DESC NULLS LAST, d.title
"""


def fts_query(query: str) -> str:
    """Equivalente de plainto_tsquery('simple', q): terminos entre comillas, en AND."""
    tokens = _TOKEN.findall(query.lower())
    return " ".join('"' + t.replace('"', '""') + '"' for t in tokens)


def search(
    conn: sqlite3.Connection,
    query: str,
    qvec: list[float],
    platform: str | None = None,
    since: str | date | None = None,
    sources: str | list[str] | None = None,
    k: int = 8,
) -> list[dict]:
    """Misma firma de salida que `kb.search.search`."""
    if not query.strip():
        return []
    sources_list = _as_sources(sources)
    since_date = _as_date(since)
    params = {
        "qvec": sqlite_vec.serialize_float32(qvec),
        "fts_query": fts_query(query),
        "platform": platform,
        "since": since_date.isoformat() if since_date else None,
        "sources": json.dumps(sources_list) if sources_list else None,
        "candidates": CANDIDATES,
        "rrf_k": RRF_K,
        "k": k,
    }
    rows = conn.execute(_SQL, params).fetchall()
    return [
        {
            "content": r[0],
            "title": r[1],
            "url": r[2],
            "author": r[3],
            "published_at": r[4],
            "platforms": json.loads(r[5] or "[]"),
            "score": float(r[6]),
            "vector_rank": r[7],
            "text_rank": r[8],
            "document_id": r[9],
            "chunk_index": r[10],
            "url_original": r[11],
        }
        for r in rows
    ]


def listar_titulos(
    conn: sqlite3.Connection,
    platform: str | None = None,
    since: str | date | None = None,
) -> list[tuple[str, str]]:
    since_date = _as_date(since)
    params = {"platform": platform, "since": since_date.isoformat() if since_date else None}
    return [(r[0] or "Sin titulo", r[1]) for r in conn.execute(_SQL_TITULOS, params).fetchall()]


def listar_fuentes(conn: sqlite3.Connection, platform: str | None = None) -> list[tuple]:
    """(title, url, published_at, platforms) como la consulta de `listar_fuentes` en Postgres."""
    rows = conn.execute(
        "SELECT title, url, published_at, platforms FROM documents d "
        "WHERE (:platform IS NULL OR EXISTS ("
        "  SELECT 1 FROM json_each(d.platforms) WHERE value = :platform)) "
        "ORDER BY published_at DESC NULLS LAST, title",
        {"platform": platform},
    ).fetchall()
    return [(t, u, p, json.loads(pl or "[]")) for t, u, p, pl in rows]


def estado(conn: sqlite3.Connection) -> dict:
    """Totales, desglose por plataforma y ultima ingesta, como `estado_kb`."""
    n_docs = conn.execute("SELECT count(*) FROM documents").fetchone()[0]
    n_chunks = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
    por_plataforma = conn.execute(
        "SELECT p.value, count(*), max(d.published_at) "
        "FROM documents d, json_each(d.platforms) p "
        "GROUP BY p.value ORDER BY count(*) DESC, p.value"
    ).fetchall()
    last_ingest = conn.execute("SELECT max(ingested_at) FROM documents").fetchone()[0]
    meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
    return {
        "documentos": n_docs,
        "chunks": n_chunks,
        "por_plataforma": por_plataforma,
        "ultima_ingesta": last_ingest,
        "meta": meta,
    }
