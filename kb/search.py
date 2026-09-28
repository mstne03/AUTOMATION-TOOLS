"""Busqueda hibrida: vectorial + full-text, fusionadas con RRF."""

from datetime import date

from kb import db, embeddings

CANDIDATES = 20   # top-N de cada rama antes de fusionar
RRF_K = 60


# El filtro por fuente va dentro de `filtered`, es decir ANTES de las ramas
# vectorial y full-text. Asi los 20 candidatos de cada rama se eligen ya solo
# entre los documentos pedidos, en vez de filtrar un top-20 global y quedarse
# con las migajas.
_SQL = """
WITH filtered AS (
    SELECT c.id, c.content, c.embedding, c.tsv, c.chunk_index, c.document_id,
           d.title, d.url, d.author, d.published_at, d.platforms
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE (%(platform)s::TEXT IS NULL OR d.platforms @> ARRAY[%(platform)s::TEXT])
      AND (%(since)s::DATE IS NULL OR d.published_at >= %(since)s::DATE)
      AND (%(sources)s::TEXT[] IS NULL OR EXISTS (
              SELECT 1 FROM unnest(%(sources)s::TEXT[]) AS s
              WHERE d.title ILIKE '%%' || s || '%%'
                 OR d.url   ILIKE '%%' || s || '%%'
          ))
),
vec AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> %(qvec)s::vector) AS rank
    FROM filtered
    ORDER BY embedding <=> %(qvec)s::vector
    LIMIT %(candidates)s
),
fts AS (
    SELECT id, ROW_NUMBER() OVER (
               ORDER BY ts_rank(tsv, plainto_tsquery('simple', %(query)s)) DESC
           ) AS rank
    FROM filtered
    WHERE tsv @@ plainto_tsquery('simple', %(query)s)
    ORDER BY ts_rank(tsv, plainto_tsquery('simple', %(query)s)) DESC
    LIMIT %(candidates)s
)
SELECT f.content, f.title, f.url, f.author, f.published_at, f.platforms,
       COALESCE(1.0 / (%(rrf_k)s + vec.rank), 0)
     + COALESCE(1.0 / (%(rrf_k)s + fts.rank), 0) AS score,
       vec.rank AS vector_rank,
       fts.rank AS text_rank,
       f.document_id,
       f.chunk_index
FROM filtered f
LEFT JOIN vec ON vec.id = f.id
LEFT JOIN fts ON fts.id = f.id
WHERE vec.id IS NOT NULL OR fts.id IS NOT NULL
ORDER BY score DESC
LIMIT %(k)s
"""


_SQL_TITULOS = """
SELECT d.title, d.url
FROM documents d
WHERE (%(platform)s::TEXT IS NULL OR d.platforms @> ARRAY[%(platform)s::TEXT])
  AND (%(since)s::DATE IS NULL OR d.published_at >= %(since)s::DATE)
ORDER BY d.published_at DESC NULLS LAST, d.title
"""


def search(
    query: str,
    platform: str | None = None,
    since: str | date | None = None,
    sources: str | list[str] | None = None,
    k: int = 8,
) -> list[dict]:
    """Busca en la base de conocimiento.

    Args:
        query: texto libre, en espanol o ingles.
        platform: filtra por plataforma (youtube | tiktok | instagram | general).
        since: fecha minima de publicacion (date o 'YYYY-MM-DD').
        sources: texto, o lista de textos, que debe aparecer en el titulo o en
            la url del documento. Sin distinguir mayusculas. Con una lista el
            criterio es OR: vale con que coincida uno.
        k: numero de fragmentos.

    Returns:
        Lista de dicts con content, title, url, author, published_at,
        platforms, score, document_id y chunk_index.
    """
    if not query.strip():
        return []

    qvec = embeddings.embed([query])[0]

    params = {
        "qvec": str(qvec),
        "query": query,
        "platform": platform,
        "since": _as_date(since),
        "sources": _as_sources(sources),
        "candidates": CANDIDATES,
        "rrf_k": RRF_K,
        "k": k,
    }

    with db.reader() as conn, conn.cursor() as cur:
        cur.execute(_SQL, params)
        rows = cur.fetchall()

    return [
        {
            "content": r[0],
            "title": r[1],
            "url": r[2],
            "author": r[3],
            "published_at": r[4].isoformat() if r[4] else None,
            "platforms": list(r[5] or []),
            "score": float(r[6]),
            "vector_rank": r[7],
            "text_rank": r[8],
            "document_id": r[9],
            "chunk_index": r[10],
        }
        for r in rows
    ]


def listar_titulos(
    platform: str | None = None,
    since: str | date | None = None,
) -> list[tuple[str, str]]:
    """Titulos y urls disponibles. Para sugerir alternativas cuando `sources` falla."""
    params = {"platform": platform, "since": _as_date(since)}
    with db.reader() as conn, conn.cursor() as cur:
        cur.execute(_SQL_TITULOS, params)
        return [(r[0] or "Sin titulo", r[1]) for r in cur.fetchall()]


def _as_sources(value: str | list[str] | None) -> list[str] | None:
    """Normaliza `sources` a lista, o None si no hay filtro."""
    if value is None:
        return None
    if isinstance(value, str):
        value = [value]
    limpios = [s.strip() for s in value if s and s.strip()]
    return limpios or None


def _as_date(value: str | date | None) -> date | None:
    if value is None or isinstance(value, date):
        return value
    return date.fromisoformat(str(value))
