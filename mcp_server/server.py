"""Servidor MCP (stdio) sobre la base de conocimiento.

Conecta con el rol kb_reader, que solo tiene SELECT. El servidor no puede
escribir en la base de datos ni aunque se lo pidan.
"""

import pathlib
import re
import sys

from mcp.server.mcpserver import MCPServer

from kb import db, embeddings, formatting
from kb import search as kb_search

mcp = MCPServer("kb-seo", version="0.1.0")


def _error(contexto: str, e: Exception) -> str:
    """Texto para el cliente MCP sin detalles de conexion (host, usuario, DSN).

    El detalle completo va a stderr, que es donde Claude Desktop guarda los logs.
    """
    print(f"[kb-seo] {contexto}: {type(e).__name__}: {e}", file=sys.stderr)
    return f"{contexto}: {type(e).__name__}. Detalle en los logs del servidor MCP."


@mcp.tool()
def buscar_kb(
    query: str,
    plataforma: str | None = None,
    desde: str | None = None,
    fuente: str | list[str] | None = None,
    max_chars: int | None = None,
    k: int = 3,
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
        fuente: Limita la busqueda a documentos concretos. Se compara, sin
            distinguir mayusculas, como subcadena del TITULO o de la URL.
            Ejemplo: fuente="buffer.com" busca solo dentro del articulo de
            Buffer. Acepta tambien una lista, y entonces vale con que coincida
            una: fuente=["hootsuite.com/instagram", "later.com"]. Usa
            listar_fuentes() para ver que hay y con que texto apuntar. En las
            fuentes capturadas a mano como archivo local tambien vale la url de
            la pagina original (la que sale en la cabecera del resultado).
            El filtro se aplica ANTES de la busqueda por similitud, asi que los
            resultados salen de dentro de esos documentos, no de un top global.
        max_chars: Tope de caracteres para el TEXTO de cada bloque. La linea de
            cabecera (titulo | fecha | url) no cuenta, y el titulo y las notas
            de captura del principio del documento nunca se devuelven. Si el
            bloque es mas largo, el recorte se CENTRA en el parrafo que mas se
            parece a la consulta y se amplia hacia los lados en parrafos o
            frases completas; "[…]" marca donde se ha quitado texto antes o
            despues. Asi un max_chars pequeno sigue trayendo la parte
            relevante, no el principio del documento. Ejemplo: max_chars=700
            para confirmar un dato. Si lo omites, devuelve el bloque entero.
        k: Cuantos FRAGMENTOS recuperar antes de fusionar. 3 por defecto. Los
            fragmentos contiguos de un mismo documento se unen en un bloque, asi
            que puedes recibir menos bloques que k. Sube a 8 o 15 para preguntas
            amplias.
    """
    try:
        qvec = embeddings.embed([query])[0] if query.strip() else None
        results = kb_search.search(
            query, platform=plataforma, since=desde, sources=fuente, k=k, qvec=qvec
        )
    except Exception as e:  # noqa: BLE001 - el cliente MCP necesita texto, no un traceback
        return _error("Error al buscar en la base de conocimiento", e)

    if not results:
        return _sin_resultados(query, plataforma, desde, fuente)

    puntuar = kb_search.puntuador(qvec) if max_chars else None
    return formatting.formatear(results, query, max_chars=max_chars, puntuar=puntuar)


def _sin_resultados(
    query: str,
    plataforma: str | None,
    desde: str | None,
    fuente: str | list[str] | None,
) -> str:
    """Mensaje util cuando no hay nada: dice por que y que hay disponible."""
    filtros = []
    if plataforma:
        filtros.append(f"plataforma={plataforma}")
    if desde:
        filtros.append(f"desde={desde}")
    if fuente:
        filtros.append(f"fuente={fuente!r}")
    sufijo = f" ({', '.join(filtros)})" if filtros else ""

    if not fuente:
        return (
            f'Sin resultados para "{query}"{sufijo}.\n'
            "Comprueba el estado con estado_kb()."
        )

    # Con `fuente` lo probable es que el texto no case con ningun documento.
    try:
        disponibles = kb_search.listar_titulos(platform=plataforma, since=desde)
    except Exception:  # noqa: BLE001
        disponibles = []

    if not disponibles:
        return f'Sin resultados para "{query}"{sufijo}. No hay documentos con esos filtros.'

    lineas = [
        f'Ningun documento coincide con fuente={fuente!r}'
        + (f" en plataforma={plataforma}" if plataforma else "")
        + ". Disponibles:",
        "",
    ]
    for titulo, url in disponibles:
        lineas.append(f"- {titulo} | {url}")
    return "\n".join(lineas)


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
        "WHERE (%s::TEXT IS NULL OR platforms @> ARRAY[%s::TEXT]) "
        "ORDER BY published_at DESC NULLS LAST, title"
    )
    try:
        with db.reader() as conn, conn.cursor() as cur:
            cur.execute(sql, (plataforma, plataforma))
            rows = cur.fetchall()
    except Exception as e:  # noqa: BLE001
        return _error("Error al listar fuentes", e)

    if not rows:
        return "No hay ninguna fuente" + (f" para {plataforma}" if plataforma else "") + "."

    lines = [
        f"{len(rows)} fuentes. El texto entre <> sirve como `fuente` en buscar_kb:",
        "",
    ]
    for title, url, published_at, platforms in rows:
        lines.append(f"- <{_identificador(url)}> {title or 'Sin titulo'}")
        lines.append(
            f"  {published_at or 'sin fecha'} | "
            f"{', '.join(platforms or []) or 'sin plataforma'} | {url}"
        )
    return "\n".join(lines)


def _identificador(url: str) -> str:
    """Trozo corto y distintivo de la url, para pasarselo a buscar_kb(fuente=...)."""
    if not url.lower().startswith(("http://", "https://")):
        return pathlib.Path(url).stem          # ruta local
    limpio = re.sub(r"^https?://(www\.)?", "", url)
    dominio, _, resto = limpio.partition("/")
    primer_tramo = resto.split("/")[0].split("?")[0]
    return f"{dominio}/{primer_tramo}" if primer_tramo else dominio


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
            _error("No se pudo consultar la base de conocimiento", e)
            + "\nComprueba que el contenedor esta levantado: docker compose ps"
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
