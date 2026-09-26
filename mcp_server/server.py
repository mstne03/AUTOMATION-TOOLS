"""Servidor MCP (stdio) sobre la base de conocimiento.

Conecta con el rol kb_reader, que solo tiene SELECT. El servidor no puede
escribir en la base de datos ni aunque se lo pidan.
"""

from mcp.server.mcpserver import MCPServer

from kb import db, search as kb_search

mcp = MCPServer("kb-seo")


@mcp.tool()
def buscar_kb(
    query: str,
    plataforma: str | None = None,
    desde: str | None = None,
    k: int = 8,
) -> str:
    """Busca en la base de conocimiento local sobre SEO y algoritmos de redes sociales.

    USA ESTA HERRAMIENTA para cualquier pregunta sobre algoritmos, SEO,
    posicionamiento, retencion, CTR, ganchos, titulos, miniaturas, hashtags,
    horarios de publicacion o crecimiento en YouTube, TikTok o Instagram.
    Consultala ANTES de responder de memoria: contiene fuentes seleccionadas y
    fechadas que pesan mas que el conocimiento general del modelo.

    Los algoritmos cambian cada pocos meses, asi que PRIORIZA las fuentes mas
    recientes y menciona la fecha cuando cites algo. Si dos fuentes se
    contradicen, gana la mas nueva y conviene decirlo.

    Cita siempre el titulo y la URL de donde sale cada afirmacion.

    Args:
        query: La pregunta o el tema, en espanol o ingles. Las fuentes estan en
            ambos idiomas y la busqueda es multilingue, asi que no hace falta
            traducir.
        plataforma: Filtra por plataforma: "youtube", "tiktok", "instagram" o
            "general". Omitelo para buscar en todo.
        desde: Fecha minima de publicacion, formato "YYYY-MM-DD". Util para
            descartar consejos viejos (por ejemplo desde="2024-01-01").
        k: Cuantos fragmentos devolver. 8 por defecto; sube a 15 o 20 para
            preguntas amplias.
    """
    try:
        results = kb_search.search(query, platform=plataforma, since=desde, k=k)
    except Exception as e:  # noqa: BLE001 - el cliente MCP necesita texto, no un traceback
        return f"Error al buscar en la base de conocimiento: {type(e).__name__}: {e}"

    if not results:
        return (
            f'Sin resultados para "{query}"'
            + (f" (plataforma={plataforma})" if plataforma else "")
            + (f" (desde={desde})" if desde else "")
            + ".\nLa base de conocimiento puede estar vacia: comprueba con estado_kb()."
        )

    lines = [f'{len(results)} fragmentos para "{query}":', ""]
    for i, r in enumerate(results, 1):
        lines.append(f"--- [{i}] {r['title'] or 'Sin titulo'}")
        lines.append(f"    Fuente: {r['url']}")
        meta = []
        if r["published_at"]:
            meta.append(f"Publicado: {r['published_at']}")
        else:
            meta.append("Publicado: fecha desconocida")
        if r["author"]:
            meta.append(f"Autor: {r['author']}")
        if r["platforms"]:
            meta.append("Plataformas: " + ", ".join(r["platforms"]))
        lines.append("    " + " | ".join(meta))
        lines.append("")
        lines.append(r["content"])
        lines.append("")

    return "\n".join(lines)


@mcp.tool()
def listar_fuentes(plataforma: str | None = None) -> str:
    """Lista los documentos que hay en la base de conocimiento.

    Sirve para saber que cubre la base antes de buscar, o para comprobar si una
    fuente concreta ya esta ingerida.

    Args:
        plataforma: Filtra por "youtube", "tiktok", "instagram" o "general".
            Omitelo para listarlo todo.
    """
    sql = (
        "SELECT title, url, published_at, platforms FROM documents "
        "WHERE (%s IS NULL OR platforms @> ARRAY[%s]::TEXT[]) "
        "ORDER BY published_at DESC NULLS LAST, title"
    )
    try:
        with db.reader() as conn, conn.cursor() as cur:
            cur.execute(sql, (plataforma, plataforma))
            rows = cur.fetchall()
    except Exception as e:  # noqa: BLE001
        return f"Error al listar fuentes: {type(e).__name__}: {e}"

    if not rows:
        return "No hay ninguna fuente" + (f" para {plataforma}" if plataforma else "") + "."

    lines = [f"{len(rows)} fuentes:", ""]
    for title, url, published_at, platforms in rows:
        lines.append(f"- {title or 'Sin titulo'}")
        lines.append(f"  {url}")
        lines.append(
            f"  Fecha: {published_at or 'desconocida'} | "
            f"Plataformas: {', '.join(platforms or []) or 'ninguna'}"
        )
    return "\n".join(lines)


@mcp.tool()
def estado_kb() -> str:
    """Estado de la base de conocimiento: cuantos documentos y chunks hay, y como de al dia esta.

    Devuelve los totales y, por cada plataforma, la fecha de la fuente mas
    reciente. Util para saber si la base esta desactualizada antes de fiarse de
    ella, o para diagnosticar si esta vacia.
    """
    try:
        with db.reader() as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM documents")
            n_docs = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM chunks")
            n_chunks = cur.fetchone()[0]
            cur.execute(
                "SELECT p, count(*), max(published_at) "
                "FROM documents d, unnest(d.platforms) AS p "
                "GROUP BY p ORDER BY count(*) DESC"
            )
            rows = cur.fetchall()
            cur.execute("SELECT max(ingested_at) FROM documents")
            last_ingest = cur.fetchone()[0]
    except Exception as e:  # noqa: BLE001
        return (
            f"No se pudo consultar la base de conocimiento: {type(e).__name__}: {e}\n"
            "Comprueba que el contenedor esta levantado: docker compose ps"
        )

    lines = [
        "Estado de la base de conocimiento kb-seo",
        f"  Documentos: {n_docs}",
        f"  Chunks:     {n_chunks}",
        f"  Ultima ingesta: {last_ingest or 'nunca'}",
    ]
    if rows:
        lines.append("")
        lines.append("  Por plataforma (fuente mas reciente):")
        for platform, count, newest in rows:
            lines.append(f"    {platform:<12} {count:>4} docs   mas reciente: {newest or 'sin fecha'}")
    else:
        lines.append("")
        lines.append("  La base esta vacia. Anade fuentes a sources.yaml y ejecuta: uv run ingest all")
    return "\n".join(lines)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
