"""Formateo compacto de los resultados de busqueda para el cliente MCP.

Tres problemas que resuelve, todos de ahorro de tokens:

- Los chunks llevan grabada dentro una cabecera `[titulo | plataforma | fecha]`
  que la ingesta les pone para que el chunk se entienda suelto. En la respuesta
  es ruido, porque la cabecera ya va fuera.
- El troceado usa 15% de solape a proposito, asi que dos fragmentos contiguos
  del mismo documento comparten texto de verdad. Si los dos entran en el top-k,
  se ve repetido.
- La cabecera de cada resultado ocupaba tres lineas con autor y plataformas.
"""

import re

_CABECERA = re.compile(r"^\[[^\]\n]*\](?:\s*\[[^\]\n]*\])?\s*\n")
_MAX_SOLAPE = 1200


def quitar_cabecera(content: str) -> str:
    """Quita la linea `[titulo | plataforma | fecha]` que la ingesta antepone.

    Tambien cubre la variante de transcripcion, que anade `[0:00-1:30]`.
    """
    return _CABECERA.sub("", content, count=1).strip()


def solape(anterior: str, siguiente: str) -> int:
    """Longitud del mayor sufijo de `anterior` que es prefijo de `siguiente`."""
    tope = min(len(anterior), len(siguiente), _MAX_SOLAPE)
    for n in range(tope, 20, -1):
        if anterior.endswith(siguiente[:n]):
            return n
    return 0


def recortar(texto: str, max_chars: int | None) -> str:
    """Recorta a `max_chars` terminando en frase completa cuando se puede."""
    if not max_chars or len(texto) <= max_chars:
        return texto

    cortado = texto[:max_chars]
    # Ultimo final de frase razonable dentro del recorte.
    fin = max(cortado.rfind(". "), cortado.rfind(".\n"), cortado.rfind("! "),
              cortado.rfind("? "), cortado.rfind(".\r"))
    if fin >= max_chars * 0.4:
        return cortado[: fin + 1].rstrip()
    if cortado.endswith("."):
        return cortado.rstrip()
    # Sin frase utilizable: corta en palabra.
    espacio = cortado.rfind(" ")
    base = cortado[:espacio] if espacio > max_chars * 0.5 else cortado
    return base.rstrip() + " [...]"


def agrupar(results: list[dict]) -> list[dict]:
    """Funde los fragmentos contiguos del mismo documento en un solo bloque.

    Mantiene el orden por score: cada grupo hereda el mejor score de sus
    fragmentos, y los grupos se devuelven en ese orden.
    """
    por_documento: dict[int, list[dict]] = {}
    for r in results:
        por_documento.setdefault(r.get("document_id"), []).append(r)

    grupos: list[dict] = []
    for fragmentos in por_documento.values():
        fragmentos.sort(key=lambda r: r.get("chunk_index") or 0)

        actual: list[dict] = []
        for r in fragmentos:
            contiguo = (
                actual
                and r.get("chunk_index") is not None
                and actual[-1].get("chunk_index") is not None
                and r["chunk_index"] - actual[-1]["chunk_index"] == 1
            )
            if actual and not contiguo:
                grupos.append(_fundir(actual))
                actual = []
            actual.append(r)
        if actual:
            grupos.append(_fundir(actual))

    grupos.sort(key=lambda g: g["score"], reverse=True)
    return grupos


def _fundir(fragmentos: list[dict]) -> dict:
    """Une una tirada de fragmentos contiguos, recortando el solape real."""
    base = max(fragmentos, key=lambda r: r["score"])
    texto = quitar_cabecera(fragmentos[0]["content"])

    for siguiente in fragmentos[1:]:
        limpio = quitar_cabecera(siguiente["content"])
        n = solape(texto, limpio)
        trozo = limpio[n:].lstrip()
        if trozo:
            texto = texto.rstrip() + ("" if n else "\n\n") + (" " if n else "") + trozo

    fundido = dict(base)
    fundido["content"] = texto.strip()
    fundido["fragmentos"] = len(fragmentos)
    fundido["chunk_index"] = fragmentos[0].get("chunk_index")
    return fundido


def formatear(
    results: list[dict],
    query: str,
    max_chars: int | None = None,
) -> str:
    """Respuesta compacta: una linea de cabecera por bloque y el texto debajo."""
    grupos = agrupar(results)

    total = len(grupos)
    etiqueta = "bloque" if total == 1 else "bloques"
    lines = [f'{total} {etiqueta} para "{query}":', ""]

    for i, g in enumerate(grupos, 1):
        fecha = g["published_at"] or "sin fecha"
        lines.append(f"[{i}] {g['title'] or 'Sin titulo'} | {fecha} | {g['url']}")
        lines.append(recortar(g["content"], max_chars))
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"
